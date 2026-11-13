/**
 * Regression test for issue #10: a protocol-only model override must take
 * effect on the next request without restarting or waiting for catalog TTL.
 *
 * The adapter keeps an in-memory pi-ai Provider cache. Before the fix that
 * cache was keyed only by providerId / baseURL / apiBases, so a settings
 * edit that pinned a model from Auto/OpenAI to `gemini` reused a Provider
 * assembled with the OpenAI Chat Completions client.
 *
 * This drives the real adapter and pi-ai protocol layer against a local HTTP
 * server. No credentials or external network access are required.
 *
 * Usage: node test/provider-cache.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { NewapiAdapter, providerCacheKey } from "../lib/adapter.js";

const MODEL = "gemini-flash";
const OTHER_MODEL = "other-chat";

/** Incoming request log: { method, url, model }. */
const requests = [];
/** Resolvers waiting for the next OpenAI completions request to arrive. */
const openaiArrived = [];
/** When set, the OpenAI handler waits for this promise before responding. */
let holdOpenAI = undefined;

function openaiSse(text) {
  const first = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const last = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

function geminiSse(text) {
  const chunk = {
    candidates: [{
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const catalog = {
  object: "list",
  data: [
    { id: MODEL, object: "model", owned_by: "test", supported_endpoint_types: ["openai", "gemini"] },
    { id: OTHER_MODEL, object: "model", owned_by: "test", supported_endpoint_types: ["openai", "gemini"] },
  ],
};

const server = http.createServer(async (request, response) => {
  const url = request.url ?? "/";
  const path = url.split("?")[0];

  if (request.method === "GET" && path === "/v1/models") {
    requests.push({ method: "GET", url, model: undefined });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(catalog));
    return;
  }

  let raw = "";
  for await (const chunk of request) raw += chunk;
  let model;
  try { model = JSON.parse(raw).model; } catch { model = undefined; }
  // Gemini's generateContent body carries the model in the path, not the JSON.
  const geminiMatch = path.match(/\/v1beta\/models\/([^/:]+)/);
  if (model === undefined && geminiMatch) model = decodeURIComponent(geminiMatch[1]);
  requests.push({ method: request.method, url, model });

  if (request.method === "POST" && path === "/v1/chat/completions") {
    for (const resolve of openaiArrived.splice(0)) resolve();
    if (holdOpenAI !== undefined) await holdOpenAI;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(openaiSse("openai-ok"));
    return;
  }

  if (request.method === "POST" && path.startsWith("/v1beta/models/") && path.includes(":streamGenerateContent")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(geminiSse("gemini-ok"));
    return;
  }

  response.writeHead(404).end(`unexpected ${request.method} ${url}`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

function makeConnection(providerId, displayName, overrides = {}) {
  return {
    providerId,
    displayName,
    baseURL,
    catalogMode: "v1",
    useModelsDev: false,
    catalogTtlMs: 30 * 60 * 1000,
    endpointPriority: ["openai-response", "anthropic", "openai", "gemini"],
    modelOverrides: overrides,
    defaultContextWindow: 128000,
    maxTokens: 1024,
    streamIdleTimeoutMs: 10_000,
    headers: {},
  };
}

const primary = makeConnection("gateway:primary", "Primary gateway", { [MODEL]: { protocol: "openai" } });
const other = makeConnection("gateway:other", "Other gateway", { [OTHER_MODEL]: { protocol: "openai" } });
const connections = { [primary.providerId]: primary, [other.providerId]: other };
const providerCache = new Map();

const adapter = new NewapiAdapter({
  options: (provider) => connections[provider],
  resolveApiKey: async () => "test-key",
  providerInfo: (provider) => ({ id: provider, name: connections[provider].displayName }),
  providerCache,
});

async function collect(provider, model) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider,
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    maxTokens: 16,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks) {
  return chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join("");
}

function postsSince(start) {
  return requests.slice(start).filter((entry) => entry.method === "POST");
}

try {
  // --- cache key identity: protocol is part of the key, catalog TTL is not ---
  const openaiKey = providerCacheKey(primary);
  const ttlOnly = providerCacheKey({ ...primary, catalogTtlMs: 1_000 });
  assert.equal(ttlOnly, openaiKey, "catalog TTL is not part of the provider-cache identity");
  const geminiShaped = providerCacheKey({ ...primary, modelOverrides: { [MODEL]: { protocol: "gemini" } } });
  assert.notEqual(geminiShaped, openaiKey, "a protocol-only edit must change the provider-cache key");
  assert.equal(
    providerCacheKey({ ...primary, modelOverrides: { [MODEL]: { protocol: "openai" } } }),
    openaiKey,
    "override object key order must not change the cache identity",
  );

  // --- warm the primary gateway with an explicit OpenAI protocol ---
  const warmed = await collect(primary.providerId, MODEL);
  assert.equal(textOf(warmed), "openai-ok", "the warming request should complete over OpenAI");
  const afterWarm = requests.length;
  const warmPosts = postsSince(0);
  assert.equal(warmPosts.length, 1, "the warming request should hit the mock gateway once");
  assert.equal(warmPosts[0].url.split("?")[0], "/v1/chat/completions", "Auto/OpenAI should use Chat Completions");
  const catalogGets = requests.filter((entry) => entry.method === "GET" && entry.url.split("?")[0] === "/v1/models");
  assert.equal(catalogGets.length, 1, "catalog discovery should run once while warming");
  const openaiProvider = await adapter.piProviderOf(primary, "test-key");
  assert.equal(
    openaiProvider.getModels().find((model) => model.id === MODEL)?.api,
    "openai-completions",
    "the cached provider should be assembled with the OpenAI client",
  );

  // --- protocol-only edit: next request must use Gemini immediately ---
  primary.modelOverrides = { [MODEL]: { protocol: "gemini" } };
  const afterEdit = await collect(primary.providerId, MODEL);
  assert.equal(textOf(afterEdit), "gemini-ok", "the next request should complete over Gemini");
  const editPosts = postsSince(afterWarm);
  assert.equal(editPosts.length, 1, "the post-edit request should hit the mock gateway once");
  assert.match(
    editPosts[0].url,
    /^\/v1beta\/models\/gemini-flash:streamGenerateContent/,
    "a protocol-only edit must use the native Gemini /v1beta/models path without restart",
  );
  const geminiProvider = await adapter.piProviderOf(primary, "test-key");
  assert.notEqual(geminiProvider, openaiProvider, "the next request must not reuse the stale OpenAI provider object");
  assert.equal(
    geminiProvider.getModels().find((model) => model.id === MODEL)?.api,
    "google-generative-ai",
    "the rebuilt provider should dispatch the model through google-generative-ai",
  );
  const catalogGetsAfter = requests.filter((entry) => entry.method === "GET" && entry.url.split("?")[0] === "/v1/models");
  assert.equal(catalogGetsAfter.length, 1, "rebuilding the provider must not bust the catalog-discovery cache");

  // --- an unaffected gateway on the same cache keeps its OpenAI provider ---
  const afterPrimary = requests.length;
  const otherChunks = await collect(other.providerId, OTHER_MODEL);
  assert.equal(textOf(otherChunks), "openai-ok", "an unaffected gateway should still complete over OpenAI");
  const otherPosts = postsSince(afterPrimary);
  assert.equal(otherPosts.length, 1, "the unaffected gateway should hit the mock once");
  assert.equal(otherPosts[0].url.split("?")[0], "/v1/chat/completions", "the unaffected gateway must not be forced onto Gemini");
  assert.equal(otherPosts[0].model, OTHER_MODEL);
  const catalogGetsOther = requests.filter((entry) => entry.method === "GET" && entry.url.split("?")[0] === "/v1/models");
  assert.equal(catalogGetsOther.length, 1, "a second gateway sharing the discovery base should reuse the catalog cache");

  // --- in-flight OpenAI request keeps its already-resolved provider ---
  // Flip the primary back to OpenAI, warm that provider, then hold the next
  // OpenAI response while a concurrent protocol edit serves a new Gemini call.
  primary.modelOverrides = { [MODEL]: { protocol: "openai" } };
  await collect(primary.providerId, MODEL);
  const afterRewarm = requests.length;

  let releaseOpenAI;
  holdOpenAI = new Promise((resolve) => { releaseOpenAI = resolve; });
  const arrived = new Promise((resolve) => openaiArrived.push(resolve));
  const inFlight = collect(primary.providerId, MODEL);
  await arrived;
  primary.modelOverrides = { [MODEL]: { protocol: "gemini" } };
  const concurrent = await collect(primary.providerId, MODEL);
  assert.equal(textOf(concurrent), "gemini-ok", "a new request after the edit must use Gemini even while an older call is in flight");
  releaseOpenAI();
  const completed = await inFlight;
  assert.equal(textOf(completed), "openai-ok", "an in-flight request must finish on the provider it already resolved");
  const racePosts = postsSince(afterRewarm);
  assert.equal(racePosts.length, 2, "the in-flight OpenAI call and the new Gemini call should each hit the mock once");
  const paths = racePosts.map((entry) => entry.url.split("?")[0]);
  assert.equal(paths[0], "/v1/chat/completions", "the in-flight call should have been dispatched to Chat Completions");
  assert.match(paths[1], /^\/v1beta\/models\/gemini-flash:streamGenerateContent/, "the concurrent call should use the Gemini endpoint");

  console.log("[PASS] protocol-only edit rebuilds the pi-ai provider for the next request (issue #10)");
  console.log("[PASS] catalog discovery cache stays independent of the provider cache");
  console.log("[PASS] unaffected gateways and in-flight requests remain usable");
} finally {
  holdOpenAI = undefined;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
