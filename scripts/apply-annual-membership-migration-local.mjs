import fs from "node:fs";
import "./load-env.mjs";

process.env.NETLIFY_DB_URL = fs.readFileSync(".cursor-local-db-url.txt", "utf8").trim();
const { annualMembershipQuery } = await import("../netlify/functions/annual-membership-store.mjs");
const sql = fs.readFileSync("netlify/database/migrations/20260901183000_annual_memberships.sql", "utf8");

const statements = [];
let buf = "";
for (const line of sql.split(/\r?\n/)) {
  const t = line.trim();
  if (t.startsWith("--") || !t) continue;
  buf += `${line}\n`;
  if (t.endsWith(";")) {
    statements.push(buf.trim());
    buf = "";
  }
}

const check = await annualMembershipQuery("SELECT to_regclass('public.annual_memberships') AS t", []);
if (check.rows[0]?.t) {
  console.log("migration_already_present");
  process.exit(0);
}

for (let i = 0; i < statements.length; i += 1) {
  const stmt = statements[i];
  try {
    await annualMembershipQuery(stmt, []);
    console.log(`ok ${i + 1}/${statements.length}: ${stmt.split("\n")[0].slice(0, 60)}`);
  } catch (err) {
    console.error(`fail ${i + 1}: ${stmt.slice(0, 120)}`);
    throw err;
  }
}
console.log("migration_applied");
