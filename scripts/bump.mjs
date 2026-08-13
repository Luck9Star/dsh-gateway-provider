#!/usr/bin/env node
/**
 * Version the relative ESM imports of this package (`./lib/*.js`, `../lib/*.js`)
 * with a `?v=<mark>` query string, so the harness loader (which caches modules
 * by full URL) reloads the whole plugin graph when the composition row's `name`
 * is bumped to `index.js?v=<mark>`.
 *
 * Usage: node scripts/bump.mjs [mark]
 *   mark defaults to the current epoch millis; the mark is persisted to
 *   `.dsh-version` so the cordis.patch.yml row can be updated to match.
 *
 * The versioned files are gitignored by convention: run this before mounting,
 * never commit the `?v=` queries (published sources keep clean specifiers).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILES = [join(ROOT, "index.js"), ...["adapter", "catalog", "modelsdev", "serialize", "sse", "translate", "wire"].map((n) => join(ROOT, "lib", `${n}.js`))];

const mark = process.argv[2] ?? String(Date.now());
const RE = /(from\s+|import\s*)(["'])(\.[^"']+?)(["'])/g;

let changed = 0;
for (const file of FILES) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  const next = source.replace(RE, (match, prefix, q, spec, q2) => {
    if (spec.includes("?v=")) return match;
    changed += 1;
    return `${prefix}${q}${spec}?v=${mark}${q2}`;
  });
  if (next !== source) writeFileSync(file, next);
}

writeFileSync(join(ROOT, ".dsh-version"), `${mark}\n`);
console.log(`versioned ${changed} import(s) with ?v=${mark}`);
console.log(`patch name: index.js?v=${mark}`);
