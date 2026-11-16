/**
 * Regression test: each extra gateway's settingsPath must lead the host to
 * that gateway's own settings object. dsh walks the path with Reflect.get
 * over the resolved settings value (dsh-api-session-controller, e.g. to find
 * which providers have a configured key), and `gateways` is an array, so the
 * step must be the array index, not the id. A delete shifts the indices, so
 * the directory must be re-registered.
 *
 * Usage: node test/settings-path.mjs
 */
import assert from "node:assert/strict";
import { apply } from "../index.js";

let settings = {
  baseURL: "https://gw.example.com",
  gateways: [
    { id: "bad", baseURL: "https://bad.example.com", apiKeyEnv: "MY-KEY" }, // skipped: invalid ref
    { id: "alpha", baseURL: "https://a.example.com", apiKeyEnv: "ALPHA_KEY" },
    { id: "Beta GW", baseURL: "https://b.example.com", apiKeyEnv: "BETA_KEY" },
  ],
};
let entries;
const listeners = {};
apply({
  fiber: { entry: { options: { id: "llm-newapi" } } },
  get: () => undefined,
  llm: {
    registerConfigurableProviders: (next) => { entries = next; return { replace(n) { entries = n; } }; },
    registerAdapter: () => ({ replace() {} }),
    registerModelDiscovery() {},
  },
  on: (name, fn) => { listeners[name] = fn; },
  logger: { error() {}, warn() {} },
}, { get: () => settings });

/** What the host reads at a provider's settingsPath. */
const profileAt = (entry) => entry.settingsPath.reduce((node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined), settings);

function check(expected) {
  for (const [provider, keyEnv] of Object.entries(expected)) {
    const entry = entries.find((e) => e.provider === provider);
    assert.ok(entry, `${provider} is registered`);
    assert.equal(profileAt(entry)?.apiKeyEnv, keyEnv, `${provider}: settingsPath ${JSON.stringify(entry.settingsPath)} must reach its own settings`);
  }
}

check({ "gateway:alpha": "ALPHA_KEY", "gateway:beta-gw": "BETA_KEY" });
console.log("[PASS] settingsPath reaches each gateway's own settings");

// Delete "alpha": "Beta GW" moves up one slot; its path must follow.
settings = { ...settings, gateways: settings.gateways.filter((g) => g.id !== "alpha") };
listeners["loader/volatile-update"]();
assert.equal(entries.some((e) => e.provider === "gateway:alpha"), false, "the deleted gateway is gone");
check({ "gateway:beta-gw": "BETA_KEY" });
console.log("[PASS] deleting a gateway re-registers the shifted settingsPath");
