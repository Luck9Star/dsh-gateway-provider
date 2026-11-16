/**
 * Regression test: every reasoning effort the picker advertises is one the
 * request actually sends, and Off reaches the gateway as a value it
 * understands ("none") instead of being silently dropped.
 *
 * Drives NewapiAdapter.resolveModel + stream against a mock gateway and
 * inspects the outgoing chat-completions bodies.
 *
 * Usage: node test/reasoning.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { NewapiAdapter } from "../lib/adapter.js";
import { clearCatalogCache } from "../lib/catalog.js";

const REASONER = "zz-reasoner";          // models.dev: reasoning, unknown family
const DEEPSEEK = "deepseek-zz-custom";   // models.dev: reasoning, deepseek family
const PLAIN = "zz-plain";                // models.dev: no reasoning; overridden below

const bodies = [];
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/models.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        [REASONER]: { name: "R", reasoning: true },
        [DEEPSEEK]: { name: "D", reasoning: true, family: "deepseek" },
        [PLAIN]: { name: "P", reasoning: false },
      }));
      return;
    }
    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [REASONER, DEEPSEEK, PLAIN].map((id) => ({ id, supported_endpoint_types: ["openai"] })) }));
      return;
    }
    if (path === "/v1/chat/completions") {
      const body = JSON.parse(raw);
      bodies.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
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

const connection = {
  providerId: "newapi", displayName: "t", apiKeyEnv: "K", baseURL: origin, catalogBase: origin,
  modelsUrl: `${origin}/models.json`, catalogTtlMs: 60_000, streamIdleTimeoutMs: 60_000,
  modelOverrides: { [PLAIN]: { id: PLAIN, reasoningLevels: ["low", "high"] } },
};
const adapter = new NewapiAdapter({
  options: () => connection,
  resolveApiKey: async () => "sk-test-reasoning",
  providerInfo: () => ({ id: "newapi", name: "t" }),
  providerCache: new Map(),
});

/** Send one request and return the body the gateway received. */
async function send(model, reasoningEffort) {
  const it = adapter.stream({ provider: "newapi", model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...reasoningEffort === undefined ? {} : { reasoningEffort } });
  for await (const _ of it) { /* drain */ }
  return bodies.at(-1);
}

try {
  clearCatalogCache();
  const expected = {
    [REASONER]: ["off", "low", "medium", "high"],
    [DEEPSEEK]: ["off", "high", "max"],
    [PLAIN]: ["low", "high"],
  };
  for (const [model, levels] of Object.entries(expected)) {
    const info = await adapter.resolveModel("newapi", model);
    assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), levels, `${model} advertises ${levels}`);
    for (const level of levels) {
      const body = await send(model, level);
      const wire = level === "off" ? "none" : level;
      assert.equal(body.reasoning_effort, wire, `${model}: advertised effort ${level} must be sent as reasoning_effort=${wire}, got ${body.reasoning_effort}`);
    }
  }
  console.log("[PASS] every advertised effort is sent; Off is sent as \"none\"");

  // Without a chosen effort the gateway keeps its own default (unchanged behavior).
  const unchosen = await send(REASONER, undefined);
  assert.equal(unchosen.reasoning_effort, undefined, "no chosen effort must not force Off");
  console.log("[PASS] no chosen effort leaves the gateway default");
} finally {
  server.close();
}
