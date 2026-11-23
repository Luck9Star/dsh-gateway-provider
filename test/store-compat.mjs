/**
 * Regression test for issue #20: a gateway can turn off pi-ai's `store`
 * parameter. pi-ai's openai-completions protocol sends `"store": false`
 * whenever its resolved compat says `supportsStore`, and its URL-based
 * auto-detection says yes for any host it does not recognize (a LiteLLM
 * proxy included). LiteLLM forwarding to Anthropic rejects the field (502).
 *
 * Drives the real config path (Config schema → resolveGateways →
 * NewapiAdapter.stream) against a mock gateway and inspects the outgoing
 * chat-completions bodies.
 *
 * Usage: node test/store-compat.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Config, resolveGateways } from "../index.js";
import { NewapiAdapter } from "../lib/adapter.js";
import { clearCatalogCache } from "../lib/catalog.js";
import { buildModel } from "../lib/pi-provider.js";

const MODEL = "claude-sonnet-zz"; // not in pi-ai's catalog: compat comes from config only

const bodies = [];
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/models.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (path === "/v1/models") {
      // LiteLLM's list carries no supported_endpoint_types.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
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

/** Resolve a settings section through the real schema + gateway resolution. */
function gatewaysOf(section) {
  const resolved = Config({ modelsUrl: `${origin}/models.json`, ...section });
  const value = typeof resolved?.get === "function" ? resolved.get() : resolved;
  return resolveGateways(value, { get: () => undefined });
}

// One cache for every send, like the plugin's: a compat-only settings edit
// must rebuild the pi-ai Provider instead of reusing stale models.
const providerCache = new Map();

/** Send one request on `route` and return the body the gateway received. */
async function send(section, route) {
  clearCatalogCache();
  const gateways = gatewaysOf(section);
  const gw = gateways.find((g) => g.provider === route);
  assert.ok(gw, `route ${route} resolves`);
  const adapter = new NewapiAdapter({
    options: () => gw.connection,
    resolveApiKey: async () => "sk-test-store",
    providerInfo: () => ({ id: gw.provider, name: gw.label }),
    providerCache,
  });
  const it = adapter.stream({ provider: route, model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  for await (const _ of it) { /* drain */ }
  return bodies.at(-1);
}

const gw = (extra) => ({ gateways: [{ id: "lite", baseURL: origin, ...extra }] });

try {
  // pi-ai's own default for an unrecognized host: `store` IS sent.
  const plain = await send(gw({ flavor: "openai-compatible" }), "gateway:lite");
  assert.equal(plain.store, false, "pi-ai sends store:false to an unknown host by default");
  console.log("[PASS] unknown host without compat: pi-ai sends store (its default)");

  // The LiteLLM template drops it by default…
  const lite = await send(gw({ flavor: "litellm" }), "gateway:lite");
  assert.equal("store" in lite, false, "litellm gateways must not send store by default");
  console.log("[PASS] litellm gateway: store omitted by default");

  // …and the user can turn it back on.
  const liteOn = await send(gw({ flavor: "litellm", compat: { supportsStore: true } }), "gateway:lite");
  assert.equal(liteOn.store, false, "compat.supportsStore: true re-enables store on litellm");
  console.log("[PASS] litellm gateway: compat.supportsStore true sends store again");

  // Gateway-level compat on any template.
  const off = await send(gw({ compat: { supportsStore: false } }), "gateway:lite");
  assert.equal("store" in off, false, "gateway compat.supportsStore: false omits store");
  console.log("[PASS] gateways[].compat.supportsStore false omits store");

  // Per-model override beats the gateway.
  const modelOn = await send(gw({ compat: { supportsStore: false }, models: [{ id: MODEL, compat: { supportsStore: true } }] }), "gateway:lite");
  assert.equal(modelOn.store, false, "model override wins over the gateway");
  const modelOff = await send(gw({ flavor: "openai-compatible", models: [{ id: MODEL, compat: { supportsStore: false } }] }), "gateway:lite");
  assert.equal("store" in modelOff, false, "model override alone omits store");
  console.log("[PASS] models[].compat overrides the gateway");

  // The default (root) gateway takes the same fields.
  const root = await send({ baseURL: origin, compat: { supportsStore: false } }, "newapi");
  assert.equal("store" in root, false, "root compat applies to the default gateway");
  const rootLite = await send({ baseURL: origin, flavor: "litellm" }, "newapi");
  assert.equal("store" in rootLite, false, "root flavor litellm omits store by default");
  console.log("[PASS] default gateway: root compat / litellm flavor omit store");
} finally {
  server.close();
}

// Field-by-field merge: config compat must not wipe pi-ai's built-in compat
// (deepseek-flash carries thinkingFormat etc. in pi-ai's catalog).
{
  const entry = { id: "deepseek-flash", endpointTypes: ["openai"] };
  const builtin = buildModel(entry, "p", "https://gw.example.com", undefined, {}, undefined).compat;
  assert.ok(builtin?.thinkingFormat, "pi-ai ships compat for deepseek-flash");
  const merged = buildModel(entry, "p", "https://gw.example.com", undefined, { compat: { supportsStore: true, supportsDeveloperRole: false } }, { id: "deepseek-flash", compat: { supportsStore: false } }).compat;
  assert.equal(merged.thinkingFormat, builtin.thinkingFormat, "built-in fields survive");
  assert.equal(merged.supportsDeveloperRole, false, "gateway field beats built-in");
  assert.equal(merged.supportsStore, false, "model field beats gateway");
  const none = buildModel({ id: "zz-unknown", endpointTypes: ["openai"] }, "p", "https://gw.example.com", undefined, {}, undefined);
  assert.equal("compat" in none, false, "no compat anywhere leaves pi-ai's auto-detection alone");
  console.log("[PASS] compat merges field by field: pi-ai built-in < gateway < model override");
}
