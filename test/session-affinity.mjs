/**
 * Regression test for OpenAI Responses cache affinity.
 *
 * Runs the real adapter and pi-ai Responses protocol against a local HTTP
 * server, then inspects the request bodies sent to the gateway. No credentials
 * or external network access are required.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { NewapiAdapter } from "../lib/adapter.js";

const requests = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }

  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));

  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })}\n\n`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseURL = `http://127.0.0.1:${address.port}`;

const connection = {
  providerId: "gateway:test",
  displayName: "Test gateway",
  baseURL,
  apiBases: { "openai-responses": `${baseURL}/v1` },
  availableTypes: ["openai-response"],
  catalogBase: null,
  endpointPriority: ["openai-response"],
  modelOverrides: { "test-responses": { protocol: "openai-response" } },
  defaultContextWindow: 128000,
  maxTokens: 1024,
  streamIdleTimeoutMs: 10_000,
  headers: {},
};

const adapter = new NewapiAdapter({
  options: () => connection,
  resolveApiKey: async () => "test-key",
  providerInfo: () => ({ id: connection.providerId, name: connection.displayName }),
  providerCache: new Map(),
});

async function request(sessionId) {
  for await (const _chunk of adapter.stream({
    provider: connection.providerId,
    model: "test-responses",
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    maxTokens: 16,
    ...sessionId === undefined ? {} : { sessionId },
  })) {
    // Exhaust the stream so the local gateway receives and completes the call.
  }
}

try {
  await request(12345);
  await request(12345);
  await request(undefined);

  assert.equal(requests.length, 3, "each adapter call should reach the mock gateway");
  assert.equal(requests[0].prompt_cache_key, "12345", "numeric session IDs are stringified for pi-ai");
  assert.equal(requests[1].prompt_cache_key, "12345", "one session keeps a stable cache key across requests");
  assert.equal("prompt_cache_key" in requests[2], false, "requests without a session ID omit the cache key");
  console.log("[PASS] Responses session affinity forwards a stable prompt_cache_key");
} finally {
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
