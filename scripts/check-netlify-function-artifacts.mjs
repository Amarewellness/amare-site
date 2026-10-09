/**
 * Pre-deploy guard: Netlify CLI can package prebuilt *.zip instead of bundling
 * the matching .mjs/.js source when both share a basename (e.g. cancel 502 incident).
 *
 * Run: npm run check:function-artifacts
 * Does not delete files — remove conflicting zips locally before deploy.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = path.join(root, "netlify", "functions");

/** @type {string[]} */
const entries = readdirSync(functionsDir);
const names = new Set(entries);

/** @type {Array<{ zip: string; source: string }>} */
const conflicts = [];

for (const name of entries) {
  if (!name.endsWith(".zip")) continue;
  const base = name.slice(0, -".zip".length);
  const mjs = `${base}.mjs`;
  const js = `${base}.js`;
  if (names.has(mjs)) conflicts.push({ zip: name, source: mjs });
  else if (names.has(js)) conflicts.push({ zip: name, source: js });
}

if (conflicts.length === 0) {
  console.log("OK — no netlify/functions/*.zip basename collisions with .mjs/.js sources.");
  process.exit(0);
}

console.error(
  `FAIL — ${conflicts.length} function artifact collision(s) in netlify/functions (remove stale .zip before deploy):`,
);
for (const c of conflicts.sort((a, b) => a.zip.localeCompare(b.zip))) {
  console.error(`  ${c.zip}  shadows  ${c.source}`);
}
process.exit(1);
