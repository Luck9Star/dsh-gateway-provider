/**
 * TUI settings-section (issue #5 P1) regressions.
 *
 * The plugin only *declares* scalar fields; dsh-tui owns rendering and the
 * revision-fenced `settings.mutate` / credentials writes. These tests pin:
 *
 *   - the section shape (paths, kinds, bilingual labels, 3-way store select);
 *   - parsers reject bad input and empty text/number drafts stage a clear;
 *   - no field carries a credential literal; the secret control is write-only
 *     under `secret.ref`, and an extra gateway that inherits the default key
 *     does not get one (issue #12);
 *   - `apply()` is a no-op — not a crash — when the TUI seam is missing;
 *   - when the seam exists, the section is registered, and a settings update
 *     that changes `apiKeyEnv` or the gateway list disposes and re-registers.
 *
 * Usage: node test/tui-settings.mjs
 */
import assert from "node:assert/strict";
import { apply } from "../index.js";
import {
  buildTuiSettingsSection,
  bindTuiSettings,
  parseKeyEnv,
  parseUrl,
  parseTimeout,
  parseStore,
  formatStore,
} from "../lib/tui-settings.js";

const NS = "llm-newapi";

function fieldMap(section) {
  const map = new Map();
  for (const field of section.fields) map.set(field.path.join("."), field);
  return map;
}

// ---- parsers -----------------------------------------------------------
{
  assert.deepEqual(parseKeyEnv(""), { kind: "clear" });
  assert.deepEqual(parseKeyEnv("  GW_KEY  "), { kind: "set", value: "GW_KEY" });
  assert.equal(parseKeyEnv("MY-KEY"), undefined, "hyphens are not a valid ref");
  assert.equal(parseKeyEnv("9KEY"), undefined, "must not start with a digit");

  assert.deepEqual(parseUrl(""), { kind: "clear" });
  assert.deepEqual(parseUrl("https://gw.example.com/"), { kind: "set", value: "https://gw.example.com" });
  assert.equal(parseUrl("not-a-url"), undefined);
  assert.equal(parseUrl("ftp://gw.example.com"), undefined);

  assert.deepEqual(parseTimeout(""), { kind: "clear" });
  assert.deepEqual(parseTimeout("15000"), { kind: "set", value: 15000 });
  assert.equal(parseTimeout("0"), undefined);
  assert.equal(parseTimeout("15.5"), undefined);
  assert.equal(parseTimeout("nope"), undefined);

  assert.deepEqual(parseStore("inherit"), { kind: "clear" });
  assert.deepEqual(parseStore(""), { kind: "clear" });
  assert.deepEqual(parseStore("false"), { kind: "set", value: false });
  assert.deepEqual(parseStore("true"), { kind: "set", value: true });
  assert.equal(parseStore("yes"), undefined);
  assert.equal(formatStore(undefined), "inherit");
  assert.equal(formatStore(false), "false");
  assert.equal(formatStore(true), "true");
  console.log("[PASS] parsers: clear / set / reject");
}

// ---- section shape: default gateway -----------------------------------
{
  const section = buildTuiSettingsSection({
    ns: NS,
    config: { label: "Main", baseURL: "https://gw.example.com", flavor: "newapi" },
  });
  assert.equal(section.ns, NS);
  assert.equal(section.title, "Gateway Models");
  assert.equal(section.descriptions.zh, "网关模型");
  assert.equal(section.groups[0].id, "default");
  assert.equal(section.groups.length, 1, "no extra gateways → only the default group");

  const fields = fieldMap(section);
  const expected = {
    label: "text",
    baseURL: "text",
    flavor: "select",
    apiKeyEnv: "text",
    apiKey: "text",
    catalogMode: "select",
    catalogTimeoutMs: "number",
    "compat.supportsStore": "select",
    openaiURL: "text",
    responsesURL: "text",
    anthropicURL: "text",
    geminiURL: "text",
  };
  for (const [path, kind] of Object.entries(expected)) {
    const item = fields.get(path);
    assert.ok(item, `missing field ${path}`);
    assert.equal(item.kind, kind, `${path} kind`);
    assert.equal(item.group, "default");
    assert.equal(typeof item.descriptions?.zh, "string", `${path} has a Chinese label`);
  }

  const flavor = fields.get("flavor");
  assert.deepEqual(flavor.options.map((o) => o.value), ["newapi", "litellm", "higress", "openai-compatible", "custom"]);

  const store = fields.get("compat.supportsStore");
  assert.deepEqual(store.options.map((o) => o.value), ["inherit", "false", "true"]);
  assert.equal(store.format(undefined), "inherit");
  assert.deepEqual(store.parse("false"), { kind: "set", value: false });
  assert.deepEqual(store.parse("inherit"), { kind: "clear" });

  const secret = fields.get("apiKey");
  assert.equal(secret.secret.ref, "NEWAPI_API_KEY");
  assert.ok(!JSON.stringify(section).includes("sk-"), "the section must not embed a key literal");
  const serialized = JSON.stringify(section);
  assert.equal(serialized.includes("sk-"), false);
  // No field reads a key out of the settings document.
  assert.ok(section.fields.every((f) => f.secret === undefined || f.kind === "text"));
  console.log("[PASS] default-gateway section shape, bilingual labels, secret ref");
}

// ---- custom apiKeyEnv is the secret ref; extra gateways ----------------
{
  const section = buildTuiSettingsSection({
    ns: NS,
    config: {
      apiKeyEnv: "MAIN_KEY",
      gateways: [
        { id: "lite", label: "Lite", baseURL: "http://localhost:4000", flavor: "litellm" }, // inherits default key
        { id: "work", baseURL: "https://work.example.com", apiKeyEnv: "WORK_KEY" },
        { id: "" }, // skipped: no usable id
        { id: "Beta GW", apiKeyEnv: "BETA_KEY" }, // index 3, group gw-3
      ],
    },
  });
  const fields = fieldMap(section);
  assert.equal(fields.get("apiKey").secret.ref, "MAIN_KEY", "default secret follows apiKeyEnv");
  assert.equal(fields.has("gateways.0.apiKey"), false, "an inheriting extra gateway must not get a secret field");
  assert.equal(fields.get("gateways.1.apiKey").secret.ref, "WORK_KEY");
  assert.equal(fields.has("gateways.2.label"), false, "an empty id is skipped");
  assert.ok(fields.get("gateways.3.label"), "index is the settings-array slot, not a compacted list");
  assert.equal(fields.get("gateways.3.apiKey").secret.ref, "BETA_KEY");
  assert.equal(fields.has("gateways.1.catalogTimeoutMs"), false, "catalogTimeoutMs is a root field only");
  assert.ok(section.groups.some((g) => g.id === "gw-0" && g.mode === "page"));
  assert.ok(section.groups.some((g) => g.id === "gw-3" && g.title.includes("Beta GW")));
  // Paths the host mutates are the same vocabulary as the web settings page.
  assert.deepEqual(fields.get("gateways.1.baseURL").path, ["gateways", "1", "baseURL"]);
  console.log("[PASS] extra gateways: index paths, inherit-no-secret, secret follows own apiKeyEnv");
}

// ---- binding: a cordis-like context -----------------------------------
// cordis throws on `ctx.<service>` a plugin does not inject; `ctx.get` is the
// optional lookup. Reading the property on this stand-in throws the same way.
function fakeContext() {
  const runtime = { host: undefined, listeners: {} };
  const ctx = new Proxy({
    fiber: { entry: { options: { id: "llm-newapi" } } },
    llm: {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: () => ({ replace() {} }),
      registerModelDiscovery() {},
    },
    get: (name) => (name === "tuiSettingsSections" ? runtime.host : undefined),
    on: (name, fn) => { (runtime.listeners[name] ??= []).push(fn); },
    logger: { error() {}, warn() {} },
  }, {
    get(target, prop) {
      if (prop === "tuiSettingsSections") {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return target[prop];
    },
  });
  return {
    ctx,
    provide: (host) => { runtime.host = host; },
    emit: (name, ...args) => { for (const fn of runtime.listeners[name] ?? []) fn(...args); },
  };
}

/** A host whose registrations land in `sections`. */
function fakeHost(sections) {
  return {
    register(section) {
      sections.push(section);
      return () => { section._disposed = true; };
    },
  };
}

// ---- no host: neither bind nor apply() throws or registers -----------
{
  const errors = [];
  const { ctx } = fakeContext();
  ctx.logger.error = (error) => errors.push(error);
  const binding = bindTuiSettings(ctx, { ns: NS, getConfig: () => ({}) });
  binding.refresh();
  binding.dispose();
  apply(ctx, { get: () => ({ baseURL: "https://gw.example.com" }) });
  assert.deepEqual(errors, []);
  console.log("[PASS] no host: bindTuiSettings and apply() are no-ops, no direct service read");
}

// ---- the host arrives after apply(), and again when its row reloads ----
{
  const first = [];
  const second = [];
  const { ctx, provide, emit } = fakeContext();
  apply(ctx, { get: () => ({ baseURL: "https://gw.example.com" }) });

  provide(fakeHost(first));
  emit("internal/service", "tuiSettingsSections");
  assert.equal(first.length, 1, "the section registers when the host arrives");
  assert.equal(first[0].ns, NS);

  // A reloaded service row starts with an empty registry.
  provide(fakeHost(second));
  emit("internal/service", "tuiSettingsSections");
  assert.equal(first[0]._disposed, true, "the old registration is released");
  assert.equal(second.length, 1, "the section registers again with the new host");
  console.log("[PASS] a host that arrives or reloads after apply() gets the section");
}

// ---- apply() registers, and a settings update re-registers ------------
{
  const registered = [];
  const { ctx, provide, emit } = fakeContext();
  provide(fakeHost(registered));
  let settings = { baseURL: "https://gw.example.com", apiKeyEnv: "OLD_KEY" };
  apply(ctx, { get: () => settings });

  assert.equal(registered.length, 1, "the section is registered on apply");
  assert.equal(registered[0].ns, NS);
  const firstSecret = registered[0].fields.find((f) => f.path.join(".") === "apiKey");
  assert.equal(firstSecret.secret.ref, "OLD_KEY");

  settings = {
    baseURL: "https://gw.example.com",
    apiKeyEnv: "NEW_KEY",
    gateways: [{ id: "lite", baseURL: "http://localhost:4000", apiKeyEnv: "LITE_KEY" }],
  };
  emit("loader/volatile-update");
  assert.equal(registered[0]._disposed, true, "the previous section is disposed");
  assert.equal(registered.length, 2, "a new section is registered after the update");
  const next = fieldMap(registered[1]);
  assert.equal(next.get("apiKey").secret.ref, "NEW_KEY");
  assert.equal(next.get("gateways.0.apiKey").secret.ref, "LITE_KEY");

  // An identical snapshot — or another service changing — must not register again.
  emit("loader/volatile-update");
  emit("internal/service", "llm");
  assert.equal(registered.length, 2, "unchanged settings do not re-register");
  console.log("[PASS] apply() registers and re-registers when apiKeyEnv / gateways change");
}

console.log("all tui-settings tests passed");
