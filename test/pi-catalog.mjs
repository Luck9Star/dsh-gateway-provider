/**
 * Regression test: the bundled pi-ai catalog knows the models dsh itself
 * ships with. On pi-ai 0.84.x (the old pin) dsh's own default model
 * `deepseek-flash` was missing, so its native thinking levels (e.g. max)
 * fell back to inference; dsh uses pi-ai 1.x, and so must this plugin.
 *
 * Usage: node test/pi-catalog.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { NewapiAdapter } from "../lib/adapter.js";
import { clearCatalogCache } from "../lib/catalog.js";
import { findPiModel } from "../lib/thinking.js";

const MODEL = "deepseek-flash"; // dsh 0.2.2's default model

const piModel = findPiModel(MODEL);
assert.ok(piModel, `pi-ai's catalog must know ${MODEL}`);
const native = getSupportedThinkingLevels(piModel);
assert.ok(native.includes("max"), `${MODEL} supports max natively (got ${native})`);

const bodies = [];
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (c) => { raw += c; }).on("end", () => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: MODEL, supported_endpoint_types: ["openai"] }] }));
      return;
    }
    if (path === "/v1/chat/completions") {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "ok" }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const adapter = new NewapiAdapter({
  options: () => ({ providerId: "newapi", displayName: "t", apiKeyEnv: "K", baseURL: origin, catalogBase: origin, useModelsDev: false, catalogTtlMs: 60_000, streamIdleTimeoutMs: 60_000 }),
  resolveApiKey: async () => "sk-test-pi-catalog",
  providerInfo: () => ({ id: "newapi", name: "t" }),
  providerCache: new Map(),
});

try {
  clearCatalogCache();
  const info = await adapter.resolveModel("newapi", MODEL);
  assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), native.filter((l) => l !== "minimal"), "the picker offers pi-ai's native levels");
  for await (const _ of adapter.stream({ provider: "newapi", model: MODEL, reasoningEffort: "max", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) { /* drain */ }
  assert.equal(bodies.at(-1)?.reasoning_effort, "max", `choosing max must send it (got ${bodies.at(-1)?.reasoning_effort})`);
  console.log(`[PASS] pi-ai catalog knows ${MODEL}; its native levels are offered and max is sent`);
} finally {
  server.close();
}
