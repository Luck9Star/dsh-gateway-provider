/**
 * Regression test for issues #12 and #13: the model-catalog cache must be
 * per gateway route + credential, never per discovery URL alone.
 *
 * Two gateways (A, B) point at the SAME base URL with different API keys.
 * The mock gateway returns a different `/v1/models` list per key: A only
 * sees a plain chat model, B only sees a reasoning model that pi-ai's
 * built-in catalog does not know (models.dev marks it `reasoning: true`).
 *
 * Before the fix the catalog slot was keyed by the base URL alone, so:
 *  - #12: B's picker showed A's list (one `/v1/models` call, with key A);
 *  - #13: resolveModel() on B's reasoning model found no catalog entry, had
 *    no reasoning metadata, and dropped `reasoning.efforts` (DSH then hides
 *    the Effort row).
 *
 * Drives the real catalog + adapter against a local HTTP server. No
 * credentials or external network access are required.
 *
 * Usage: node test/catalog-cache.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { NewapiAdapter } from "../lib/adapter.js";
import { clearCatalogCache, listPickerModels } from "../lib/catalog.js";

const KEY_A = "sk-test-gateway-a";
const KEY_B = "sk-test-gateway-b";
const KEY_A2 = "sk-test-gateway-a-rotated";
const CHAT_MODEL = "zz-plain-chat-a";
const REASONING_MODEL = "zz-reasoner-b";
const ROTATED_MODEL = "zz-plain-chat-a2";

const listsByKey = {
  [KEY_A]: [CHAT_MODEL],
  [KEY_B]: [REASONING_MODEL],
  [KEY_A2]: [ROTATED_MODEL],
};
/** `/v1/models` calls seen, as the bearer key used. */
const catalogCalls = [];

const modelsDev = {
  [CHAT_MODEL]: { name: "Plain Chat A", reasoning: false, limit: { context: 64000, output: 4096 } },
  [REASONING_MODEL]: { name: "Reasoner B", reasoning: true, limit: { context: 200000, output: 32000 } },
  [ROTATED_MODEL]: { name: "Plain Chat A2", reasoning: false },
};

const server = http.createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (request.method === "GET" && path === "/models.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(modelsDev));
    return;
  }
  if (request.method === "GET" && path === "/v1/models") {
    const key = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    catalogCalls.push(key);
    const ids = listsByKey[key];
    if (ids === undefined) {
      response.writeHead(401).end("bad key");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, object: "model", owned_by: "test", supported_endpoint_types: ["openai"] })),
    }));
    return;
  }
  response.writeHead(404).end(`unexpected ${request.method} ${request.url}`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function connection(providerId, apiKeyEnv, baseURL) {
  return {
    providerId,
    displayName: providerId,
    apiKeyEnv,
    baseURL,
    catalogBase: baseURL,
    catalogMode: "v1",
    useModelsDev: true,
    modelsUrl: `${origin}/models.json`,
    catalogTtlMs: 30 * 60 * 1000,
    defaultContextWindow: 128000,
    maxTokens: 1024,
    modelOverrides: {},
    sortModelsByRelease: false,
  };
}

// Same discovery base for both: "/v1" is stripped by discovery, so the two
// spellings must still be told apart by route + credential, not by URL.
const gwA = connection("newapi", "NEWAPI_API_KEY", origin);
const gwB = connection("gateway:b", "NEWAPI_API_KEY_B", `${origin}/v1`);
const keys = { NEWAPI_API_KEY: KEY_A, NEWAPI_API_KEY_B: KEY_B };

const adapter = new NewapiAdapter({
  options: (provider) => (provider === gwB.providerId ? gwB : gwA),
  resolveApiKey: async (conn) => keys[conn.apiKeyEnv],
  providerInfo: (provider) => ({ id: provider, name: provider }),
  providerCache: new Map(),
  resolveAttachments: () => undefined,
});

try {
  clearCatalogCache();

  // ---- #12: each gateway gets its own catalog -----------------------------
  const listA = await adapter.listModels(gwA.providerId);
  const listB = await adapter.listModels(gwB.providerId);
  assert.deepEqual(listA.map((m) => m.id), [CHAT_MODEL], "gateway A lists its own models");
  assert.deepEqual(listB.map((m) => m.id), [REASONING_MODEL], "gateway B must not reuse A's catalog on the same URL");
  assert.deepEqual(catalogCalls, [KEY_A, KEY_B], "one /v1/models call per gateway, each with its own key");

  // Cached reads stay per gateway (no extra network, no cross-talk).
  assert.deepEqual((await adapter.listModels(gwB.providerId)).map((m) => m.id), [REASONING_MODEL]);
  assert.deepEqual((await adapter.listModels(gwA.providerId)).map((m) => m.id), [CHAT_MODEL]);
  assert.equal(catalogCalls.length, 2, "cache hits must not refetch");

  // ---- #13: reasoning metadata survives a second gateway ------------------
  const resolvedB = await adapter.resolveModel(gwB.providerId, REASONING_MODEL);
  assert.ok(resolvedB.reasoning !== undefined, "B's reasoning model must keep its reasoning metadata");
  assert.deepEqual(
    resolvedB.reasoning.efforts.map((e) => e.id),
    ["off", "low", "medium", "high"],
    "B's exact model advertises off/low/medium/high",
  );
  assert.equal(resolvedB.name, "Reasoner B", "B's model is resolved from B's own catalog");
  assert.equal(resolvedB.context.contextWindow, 200000, "B's models.dev context window is used");
  const resolvedA = await adapter.resolveModel(gwA.providerId, CHAT_MODEL);
  assert.equal(resolvedA.reasoning, undefined, "A's non-reasoning model advertises no efforts");

  // ---- Key rotation refreshes only that gateway ---------------------------
  keys.NEWAPI_API_KEY = KEY_A2;
  assert.deepEqual((await adapter.listModels(gwA.providerId)).map((m) => m.id), [ROTATED_MODEL], "a new key refreshes A's catalog immediately");
  assert.equal(catalogCalls.at(-1), KEY_A2, "the refresh uses the new key");
  const before = catalogCalls.length;
  assert.deepEqual((await adapter.listModels(gwB.providerId)).map((m) => m.id), [REASONING_MODEL], "B is unaffected by A's key change");
  assert.equal(catalogCalls.length, before, "B's cached catalog is not refetched");

  // A failing fetch under a new key must not serve the old key's snapshot.
  keys.NEWAPI_API_KEY = "sk-test-unknown";
  await assert.rejects(() => listPickerModels(gwA, keys.NEWAPI_API_KEY), "an unusable new key must not fall back to another key's list");

  console.log("[PASS] catalog cache is per gateway + credential (issues #12, #13)");
} finally {
  server.close();
}
