/**
 * Read-only: OTP table schema + count. No inserts. No secret values.
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
const j = JSON.parse(raw.slice(raw.indexOf("{")));
const url = String(j.database?.connectionString || "").trim();
if (!url.startsWith("postgres")) {
  console.error("FAIL no production connection");
  process.exit(1);
}
const db = getDatabase({ connectionString: url });
async function q(text, values = []) {
  const r = await db.pool.query(text, values);
  return r.rows || [];
}

const exists = await q(`SELECT to_regclass('public.amare_otp_challenges') AS t`);
console.log("TABLE", exists[0]?.t ? "PRESENT" : "MISSING");

const cols = await q(`
  SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'amare_otp_challenges'
   ORDER BY ordinal_position
`);
console.log("COLUMNS", cols.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`).join(","));

const idx = await q(`
  SELECT indexname FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'amare_otp_challenges'
   ORDER BY 1
`);
console.log("INDEXES", idx.map((r) => r.indexname).join(","));

const count = await q(`
  SELECT count(*)::int AS n,
         min(created_at) AS first_at,
         max(created_at) AS last_at
    FROM amare_otp_challenges
`);
console.log("ROW_COUNT", count[0]?.n);
console.log("FIRST_AT", count[0]?.first_at ? "set" : "null");
console.log("LAST_AT", count[0]?.last_at ? "set" : "null");

await db.pool.end();
