#!/usr/bin/env node
/**
 * OBSOLETE — do not use.
 *
 * This script used to version the package's relative ESM imports with
 * `?v=<mark>` query strings and tell you to mount the plugin as
 * `index.js?v=<mark>` in the profile's cordis.patch.yml. That mechanism is
 * wrong and actively harmful in current DeepSeek Harness:
 *
 * - dsh resolves a plugin row's CLIENT half (the "Gateway Models" settings
 *   section) through `require.resolve('<name>/package.json')` from the
 *   profile directory. A path-style `name` (with or without a query string)
 *   can never contribute the client bundle, so the settings UI silently
 *   never appears — no matter how many times the profile is restarted.
 * - The host half re-imports everything on every profile restart anyway, so
 *   the query string buys nothing; it only creates duplicate module
 *   instances (e.g. `catalog.js?v=X` static imports vs. the plain
 *   `./lib/catalog.js` dynamic import), doubling caches and risking
 *   identity bugs.
 * - Client-bundle edits already hot-apply: the boot graph's `rev` is the
 *   bundle content hash and `/plugins/<id>/client.js?rev=...` is
 *   cache-busted automatically.

 * Correct local-checkout mount (see README "方式二 / Local checkout"):
 *   1. bash scripts/link.sh
 *   2. profiles/web/package.json dependencies:
 *        "dsh-newapi-provider": "link:/absolute/path/to/dsh-newapi-provider"
 *      then `pnpm install` in the profile dir.
 *   3. cordis.patch.yml row:  name: 'dsh-newapi-provider'
 *   4. Restart the profile; host edits need another restart, client edits
 *      only a browser reload.
 */
console.error("scripts/bump.mjs is obsolete — remove this invocation.");
console.error("Mount by package name instead; see README (方式二 / Local checkout).");
process.exit(1);
