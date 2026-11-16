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

function mock(name) {
  return http.createServer((request, response) => {
    seen[name].push(request.headers.authorization);
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
} finally {
  saved.close();
  other.close();
}
