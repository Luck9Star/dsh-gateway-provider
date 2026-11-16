/**
 * Model-discovery (settings Test / Sync / draft) regressions, driven through
 * the plugin's real apply() with a minimal host context and a local mock
 * gateway.
 *
 * Usage: node test/discovery.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { apply } from "../index.js";

const STORED_KEY = "sk-test-stored";
/** Authorization headers seen per mock host ("saved" / "other"). */
const seen = { saved: [], other: [] };
/** How the "other" host answers: "ok", "401", or "stall". */
let otherMode = "ok";

function mock(name) {
  return http.createServer((request, response) => {
    seen[name].push(request.headers.authorization);
    if (name === "other" && otherMode === "stall") return;
    if (name === "other" && otherMode === "401") { response.writeHead(401).end("bad key"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: `${name}-model`, supported_endpoint_types: ["openai"] }] }));
  });
}
const saved = mock("saved");
const other = mock("other");
await Promise.all([saved, other].map((s) => new Promise((resolve) => s.listen(0, "127.0.0.1", resolve))));
const savedURL = `http://127.0.0.1:${saved.address().port}`;
const otherURL = `http://127.0.0.1:${other.address().port}`;

/** Start the plugin against a fake host; returns the registered discovery. */
function start(config) {
  let discover;
  apply({
    fiber: { entry: { options: { id: "llm-newapi" } } },
    get: (name) => (name === "credentials" ? { resolve: async () => ({ value: STORED_KEY }) } : undefined),
    llm: {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: () => ({ replace() {} }),
      registerModelDiscovery: (_ns, fn) => { discover = fn; },
    },
    on() {},
    logger: { error() {}, warn() {} },
  }, config);
  return discover;
}

try {
  const discover = start({ baseURL: savedURL, useModelsDev: false });

  // ---- The saved key goes only to the saved address ----------------------
  await discover({ provider: "newapi" });
  await discover({ provider: "newapi", baseURL: `${savedURL}/v1/` });
  assert.deepEqual(seen.saved, [`Bearer ${STORED_KEY}`, `Bearer ${STORED_KEY}`], "the saved address (any /v1 or slash form) uses the saved key");

  await discover({ baseURL: otherURL });
  await discover({ provider: "newapi", baseURL: otherURL });
  assert.deepEqual(seen.other, [undefined, undefined], "a draft at another address must not receive the saved key");

  await discover({ provider: "newapi", baseURL: otherURL, apiKey: "sk-test-draft" });
  assert.equal(seen.other.at(-1), "Bearer sk-test-draft", "a draft's own key is used for its address");
  console.log("[PASS] discovery sends the saved key only to the saved address");

  // ---- Failures are thrown with a code, not swallowed into [] -------------
  otherMode = "401";
  await assert.rejects(discover({ baseURL: otherURL, apiKey: "sk-test-wrong" }), (error) => error.code === "AUTH", "a 401 must surface as AUTH");
  await assert.rejects(discover({ provider: "gateway:missing" }), (error) => error.code === "INVALID_DISCOVERY", "an unknown route must be reported");
  console.log("[PASS] discovery failures surface as LlmError codes");

  // ---- The host's signal (second argument) cancels discovery ---------------
  otherMode = "stall";
  const controller = new AbortController();
  const pending = discover({ baseURL: otherURL, apiKey: "sk-test-draft" }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const outcome = await Promise.race([
    pending.then(() => "resolved", (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 2000)),
  ]);
  assert.equal(outcome, "ABORTED", `an aborted discovery must settle as ABORTED, got ${outcome}`);
  console.log("[PASS] discovery honors the host's cancellation signal");
} finally {
  for (const server of [saved, other]) { server.closeAllConnections(); server.close(); }
}
