#!/usr/bin/env node
/**
 * Patch the official dsh Models settings UI so the `llm-newapi` namespace
 * renders the deepseek editor layout (API key + base URL + model catalog).
 *
 * The official `dsh-client-ui-settings-models` client bundle hardcodes the
 * two namespaces it knows (`llm-deepseek`, `llm-pi-ai`); every other provider
 * namespace falls into the "unknown" layout, which renders a hint and
 * disables saving. This script injects one branch into `layoutOf()`:
 *
 *     if (ns === "llm-newapi") return "deepseek";
 *
 * Usage:
 *   node scripts/patch-web-ui.mjs apply    # patch the profile bundle (idempotent)
 *   node scripts/patch-web-ui.mjs verify   # report whether the patch is applied
 *   node scripts/patch-web-ui.mjs restore  # revert to the pristine bundle
 *
 * NOTE: a DeepSeek Harness upgrade reinstalls the bundle and drops this
 * patch — re-run `apply` after every upgrade.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
const TARGET = join(
  DSH_HOME,
  "profiles",
  "node_modules",
  "@deepseek-ai",
  "dsh-client-ui-settings-models",
  "lib",
  "client.js",
);

const BRANCH = 'if (ns === "llm-newapi") return "deepseek";';
const ANCHOR = 'if (ns === "llm-deepseek") return "deepseek";';

function load() {
  if (!existsSync(TARGET)) throw new Error(`models settings bundle not found: ${TARGET}`);
  return readFileSync(TARGET, "utf8");
}

export function isApplied(source = load()) {
  return source.includes(BRANCH);
}

export function apply() {
  const source = load();
  if (isApplied(source)) {
    console.log("already applied");
    return false;
  }
  if (!source.includes(ANCHOR)) throw new Error(`unexpected bundle layout: cannot find anchor ${JSON.stringify(ANCHOR)}`);
  writeFileSync(TARGET, source.replace(ANCHOR, `${ANCHOR}\n\t\t\t${BRANCH}`));
  console.log(`patched ${TARGET}`);
  return true;
}

export function restore() {
  const source = load();
  if (!isApplied(source)) {
    console.log("not applied");
    return false;
  }
  writeFileSync(TARGET, source.replace(`\n\t\t\t${BRANCH}`, ""));
  console.log(`restored ${TARGET}`);
  return true;
}

const action = process.argv[2] ?? "apply";
if (action === "apply") apply();
else if (action === "verify") console.log(isApplied() ? "applied" : "not applied");
else if (action === "restore") restore();
else {
  console.error("usage: patch-web-ui.mjs <apply|verify|restore>");
  process.exit(1);
}
