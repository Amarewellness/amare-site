import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NETLIFY_DB_URL = fs.readFileSync(path.join(root, ".cursor-local-db-url.txt"), "utf8").trim();

const { annualMembershipQuery } = await import("../netlify/functions/annual-membership-store.mjs");

await annualMembershipQuery("ALTER TABLE annual_memberships DROP CONSTRAINT IF EXISTS annual_memberships_status_chk", []);
await annualMembershipQuery(
  "ALTER TABLE annual_memberships ADD CONSTRAINT annual_memberships_status_chk CHECK (status IN ('pending','active','past_due','canceled','refunded','completed','revoked'))",
  [],
);
const chk = await annualMembershipQuery(
  "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'annual_memberships_status_chk'",
  [],
);
console.log(JSON.stringify({ applied: true, constraint: chk.rows[0]?.def }, null, 2));
