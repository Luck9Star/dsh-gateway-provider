/**
 * Regression test: catalog requests honor caller cancellation and a hard
 * timeout. A gateway (or models.dev mirror) that accepts the connection but
 * never answers must not hang a chat request past its abort, nor the model
 * picker forever.
 *
 * Usage: node test/timeouts.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { NewapiAdapter } from "../lib/adapter.js";
import { clearCatalogCache, listPickerModels } from "../lib/catalog.js";

/** Paths the mock answers; anything else stalls forever. */
let answer = new Set();
const server = http.createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (!answer.has(path)) return; // stall: never respond
  response.writeHead(200, { "content-type": "application/json" });
  response.end(path === "/v1/models" ? JSON.stringify({ data: [{ id: "zz-m", supported_endpoint_types: ["openai"] }] }) : "{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const connection = {
  providerId: "newapi", displayName: "t", apiKeyEnv: "K", baseURL: origin, catalogBase: origin,
  modelsUrl: `${origin}/models.json`, catalogTimeoutMs: 300, catalogTtlMs: 60_000,
  streamIdleTimeoutMs: 60_000, modelOverrides: {},
};
const adapter = new NewapiAdapter({
  options: () => connection,
  resolveApiKey: async () => "sk-test-timeouts",
  providerInfo: () => ({ id: "newapi", name: "t" }),
  providerCache: new Map(),
});

/** Settle `promise` or report that it is still pending after `ms`. */
const within = (promise, ms) => Promise.race([
  promise.then((v) => ({ value: v }), (error) => ({ error })),
  new Promise((resolve) => setTimeout(() => resolve({ pending: true }), ms)),
]);

try {
  // 1. A caller abort ends a chat request stuck in catalog discovery.
  clearCatalogCache();
  connection.catalogTimeoutMs = 60_000; // only the caller's abort can end it
  const controller = new AbortController();
  const streaming = (async () => {
    const it = adapter.stream({ provider: "newapi", model: "zz-m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], signal: controller.signal });
    for await (const _ of it) { /* drain */ }
  })();
  setTimeout(() => controller.abort(), 50);
  const aborted = await within(streaming, 2000);
  assert.ok(!aborted.pending, "stream must settle promptly after the caller aborts");
  assert.equal(aborted.error?.code, "ABORTED", `aborted stream should fail ABORTED, got ${aborted.error?.code}`);
  console.log("[PASS] caller abort ends a stream stuck in catalog discovery");

  // 2. The picker's listModels (no caller signal) is bounded by catalogTimeoutMs.
  clearCatalogCache();
  connection.catalogTimeoutMs = 300;
  const listed = await within(adapter.listModels("newapi"), 3000);
  assert.ok(!listed.pending, "listModels must not hang on a stalled gateway");
  assert.equal(listed.error?.code, "TIMEOUT", `stalled model list should fail TIMEOUT, got ${listed.error?.code}`);
  console.log("[PASS] stalled /v1/models times out instead of hanging the picker");

  // 3. A stalled models.dev mirror only skips enrichment.
  clearCatalogCache();
  answer = new Set(["/v1/models"]);
  const models = await within(listPickerModels(connection, "sk-test-timeouts"), 3000);
  assert.ok(!models.pending, "a stalled models.dev must not hang discovery");
  assert.deepEqual(models.value?.map((m) => m.id), ["zz-m"], "the gateway list still loads without enrichment");
  console.log("[PASS] stalled models.dev times out and discovery continues");
} finally {
  server.closeAllConnections();
  server.close();
}
