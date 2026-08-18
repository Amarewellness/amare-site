/**
 * Read-only production schema check. Prints table/index/constraint names only.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "@netlify/database";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const raw = spawnSync(
  process.execPath,
  [cli, "database", "status", "--branch", "production", "--show-credentials", "--json"],
  { cwd: root, encoding: "utf8", windowsHide: true },
).stdout;
const start = raw.indexOf("{");
const j = JSON.parse(raw.slice(start));
const url = String(j.database?.connectionString || "").trim();
if (!url.startsWith("postgres")) {
  console.error("FAIL no production connection");
  process.exit(1);
}
const db = getDatabase({ connectionString: url });
async function q(text) {
  const r = await db.pool.query(text);
  return r.rows || [];
}
const tables = await q(`
  SELECT tablename FROM pg_tables
   WHERE schemaname = 'public' AND tablename LIKE 'amare_%'
   ORDER BY 1
`);
const idx = await q(`
  SELECT indexname FROM pg_indexes
   WHERE schemaname = 'public' AND indexname LIKE 'amare_%'
   ORDER BY 1
`);
const cons = await q(`
  SELECT conname FROM pg_constraint
   WHERE conname LIKE 'amare_%'
   ORDER BY 1
`);
console.log("TABLES " + tables.map((r) => r.tablename).join(","));
console.log("INDEXES " + idx.map((r) => r.indexname).join(","));
console.log("CONSTRAINTS " + cons.map((r) => r.conname).join(","));
await db.pool.end();
