/**
 * Gateway-list resolution regressions (index.js resolveGateways):
 * entries that cannot form a usable route are skipped with a warning
 * instead of failing the whole plugin.
 *
 * Usage: node test/gateway-config.mjs
 */
import assert from "node:assert/strict";
import { resolveGateways } from "../index.js";

const env = { get: () => undefined };
const BASE = "https://gw.example.com";

// ---- Ids that sanitize to one route keep only the first entry ----------
{
  const warnings = [];
  const gateways = resolveGateways({
    baseURL: BASE,
    gateways: [
      { id: "My GW", baseURL: "https://a.example.com" },
      { id: "my-gw", baseURL: "https://b.example.com" },
      { id: "other", baseURL: "https://c.example.com" },
    ],
  }, env, (message) => warnings.push(message));
  const providers = gateways.map((g) => g.provider);
  assert.deepEqual(providers, ["newapi", "gateway:my-gw", "gateway:other"], "duplicate routes must be dropped, not registered twice");
  assert.equal(gateways[1].connection.baseURL, "https://a.example.com", "the first entry owns the route");
  assert.equal(warnings.length, 1, "the skipped entry is reported once");
  assert.match(warnings[0], /my-gw/);
  console.log("[PASS] colliding gateway ids keep one route and warn");
}

// ---- Root headers stay on the default gateway --------------------------
{
  const gateways = resolveGateways({
    baseURL: BASE,
    headers: { "X-Default-Token": "test-default" },
    gateways: [
      { id: "third", baseURL: "https://third.example.com" },
      { id: "own", baseURL: "https://own.example.com", headers: { "X-Own": "test-own" } },
    ],
  }, env);
  const byId = Object.fromEntries(gateways.map((g) => [g.provider, g.connection.headers]));
  assert.deepEqual(byId.newapi, { "X-Default-Token": "test-default" }, "the default gateway keeps the root headers");
  assert.equal(byId["gateway:third"], undefined, "root headers must not leak to another gateway");
  assert.deepEqual(byId["gateway:own"], { "X-Own": "test-own" }, "a gateway sends its own headers");
  console.log("[PASS] root headers stay on the default gateway; gateways carry their own");
}
