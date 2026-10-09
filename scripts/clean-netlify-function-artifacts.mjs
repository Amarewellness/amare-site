/**
 * Remove local Netlify CLI esbuild cache zips that can shadow *.mjs on deploy.
 * Only deletes netlify/functions/*.zip (non-recursive).
 *
 * Run: npm run clean:function-artifacts
 */
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = path.join(root, "netlify", "functions");

/** @type {string[]} */
const zips = readdirSync(functionsDir)
  .filter((name) => name.endsWith(".zip"))
  .sort();

if (zips.length === 0) {
  console.log("No Netlify function zip artifacts to clean.");
  process.exit(0);
}

console.log(`Cleaning ${zips.length} Netlify function zip artifacts...`);

for (const name of zips) {
  unlinkSync(path.join(functionsDir, name));
}

console.log(`Removed ${zips.length} file(s) from netlify/functions/`);
