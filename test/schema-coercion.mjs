/**
 * Schema tolerance regression tests for the `llm-newapi` settings section.
 *
 * `settings.yaml` is a hand-editable YAML document, and the settings seam
 * refuses to register a namespace whose stored section fails its schema —
 * one stray scalar anywhere bricks the whole namespace (every web-UI write
 * then answers `settings-rejected: settings namespace "llm-newapi" is not
 * registered`). These tests pin the coercion contract:
 *
 *   - unquoted YAML tokens that parse as booleans / finite numbers
 *     (`true`/`false`, `1`→number, …) coerce to their string form on every
 *     plain string field of the section — root fields, per-gateway fields,
 *     per-model fields, and the string-array fields (`reasoningLevels`,
 *     `excludePatterns`, `endpointPriority`);
 *   - anything else (objects, arrays, null) still fails loud with
 *     schemastery's union diagnostic;
 *   - a coerced junk level ("false") is dropped downstream by the
 *     reasoning-level vocabulary, never surfaced to the picker.
 *
 * Usage: node test/schema-coercion.mjs — exit code 0 = all passed.
 */
import { Config } from "../index.js";
import { effortsFromLevels } from "../lib/thinking.js";

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function accepts(name, input, probe) {
  try {
    const resolved = Config(input);
    check(name, true, probe ? probe(resolved) : "");
  } catch (error) {
    check(name, false, error?.message ?? String(error));
  }
}

function rejects(name, input) {
  try {
    Config(input);
    check(name, false, "schema accepted a hostile value");
  } catch {
    check(name, true);
  }
}

// --- tolerated: unquoted YAML scalars (boolean / number round-trips) ---

accepts(
  "boolean reasoningLevels entry coerces to string",
  { models: [{ id: "glm", reasoningLevels: [false, "low", "high", "max"] }] },
  (r) => `levels=${JSON.stringify(r.models[0].reasoningLevels)}`,
);
accepts(
  "numeric gateway id coerces to string",
  { gateways: [{ id: 7, baseURL: "http://gw.internal:3000" }] },
  (r) => `gateways=${JSON.stringify(r.gateways.map((g) => g.id))}`,
);
accepts(
  "numeric userId coerces to string",
  { userId: 2 },
  (r) => `userId=${JSON.stringify(r.userId)}`,
);
accepts(
  "boolean label coerces to string",
  { label: true },
  (r) => `label=${JSON.stringify(r.label)}`,
);
accepts(
  "boolean modelsUrl coerces to string",
  { modelsUrl: false },
  (r) => `modelsUrl=${JSON.stringify(r.modelsUrl)}`,
);
accepts(
  "numeric apiKeyEnv coerces to string",
  { apiKeyEnv: 12345 },
  (r) => `apiKeyEnv=${JSON.stringify(r.apiKeyEnv)}`,
);
accepts(
  "boolean entry in excludePatterns coerces to string",
  { excludePatterns: [true, "(^|/)bge-"] },
  (r) => `patterns=${JSON.stringify(r.excludePatterns)}`,
);
accepts(
  "numeric entries in endpointPriority coerce to strings",
  { endpointPriority: [1, "anthropic"] },
  (r) => `priority=${JSON.stringify(r.endpointPriority)}`,
);
accepts(
  "per-gateway apiKeyEnv / endpointPriority tolerate scalars",
  { gateways: [{ id: "g", apiKeyEnv: 99, endpointPriority: [false, "openai"] }] },
  (r) => `gw=${JSON.stringify(r.gateways.map((g) => [g.apiKeyEnv, g.endpointPriority]))}`,
);
accepts(
  "plain strings still pass untouched",
  { baseURL: "http://127.0.0.1:3000", models: [{ id: "m", reasoningLevels: ["off", "high"] }] },
  (r) => `baseURL=${r.baseURL}`,
);

// --- still loud: shapes no string field could mean ---

rejects("object baseURL rejected", { baseURL: {} });
rejects("array name rejected", { models: [{ id: "x", name: [] }] });
rejects("object reasoningLevels entry rejected", { models: [{ id: "x", reasoningLevels: [{}] }] });
rejects("null protocol-ish scalar on a string field rejected", { models: [{ id: null }] });
rejects("object excludePatterns entry rejected", { excludePatterns: [{}] });
rejects("object endpointPriority entry rejected", { endpointPriority: [{}] });
rejects("array modelsUrl rejected", { modelsUrl: [] });

// --- downstream: coerced junk levels are dropped, never crash ---

check(
  "coerced \"false\" level is dropped by the effort vocabulary",
  JSON.stringify(effortsFromLevels(["false", "low", "high", "max"]).map((e) => e.id))
    === JSON.stringify(["low", "high", "max"]),
);
check(
  "clean off/low/high/max set survives",
  JSON.stringify(effortsFromLevels(["off", "low", "high", "max"]).map((e) => e.id))
    === JSON.stringify(["off", "low", "high", "max"]),
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
