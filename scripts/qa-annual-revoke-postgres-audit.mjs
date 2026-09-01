/**
 * Postgres-only revoke invariant audit (no new Stripe purchase).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./load-env.mjs";
import { adminRevokeAnnualTerm } from "../netlify/functions/annual-membership-admin-actions.mjs";
import {
  annualMembershipQuery,
  openAnnualMembershipStore,
} from "../netlify/functions/annual-membership-store.mjs";

loadLocalEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
if (fs.existsSync(path.join(root, ".cursor-local-db-url.txt"))) {
  process.env.NETLIFY_DB_URL = fs.readFileSync(path.join(root, ".cursor-local-db-url.txt"), "utf8").trim();
}

const store = openAnnualMembershipStore();
if (store.kind !== "postgres") {
  console.error("FAIL — postgres store required");
  process.exit(1);
}

const term = await store.createAnnualTermWithPeriods({
  sku: "annual_monthly_5",
  mindbodyClientId: 100002839,
  stripeSubscriptionId: `sub_pg_revoke_audit_${Date.now()}`,
  stripeInvoiceId: `in_pg_revoke_audit_${Date.now()}`,
  termStartDate: "2026-09-01",
  termEndDate: "2027-09-01",
  annualAmountCents: 127500,
});

const before = await annualMembershipQuery(
  `SELECT period_index, status FROM annual_membership_periods WHERE annual_membership_id = $1 ORDER BY period_index`,
  [term.membership.id],
);

const revoke = await adminRevokeAnnualTerm(term.membership.id, { confirmStop: "STOP" });

const after = await annualMembershipQuery(
  `SELECT period_index, status FROM annual_membership_periods WHERE annual_membership_id = $1 ORDER BY period_index`,
  [term.membership.id],
);

const pending = after.rows.filter((r) => r.status === "pending");
const skipped = after.rows.filter((r) => r.status === "skipped");

console.log(
  JSON.stringify(
    {
      revokeOk: revoke.ok,
      before: before.rows,
      after: after.rows,
      pendingCount: pending.length,
      skippedCount: skipped.length,
      p0Before: before.rows.find((r) => Number(r.period_index) === 0),
      p0After: after.rows.find((r) => Number(r.period_index) === 0),
    },
    null,
    2,
  ),
);

if (!revoke.ok || pending.length !== 0 || skipped.length !== 12) process.exit(1);
