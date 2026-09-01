/**
 * QA cleanup: revoke dedicated test annual terms for client 100002839 only.
 * Run after admin revoke action is implemented. Requires local Postgres proxy.
 *
 *   node scripts/qa-annual-membership-qa-revoke-cleanup.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import {
  annualMembershipQuery,
} from "../netlify/functions/annual-membership-store.mjs";
import { adminRevokeAnnualTerm } from "../netlify/functions/annual-membership-admin-actions.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";

loadLocalEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const QA_CLIENT = 100002839;
const QA_SKUS = ["annual_monthly_5", "annual_monthly_8"];

async function ensureDb() {
  const file = path.join(root, ".cursor-local-db-url.txt");
  if (fs.existsSync(file)) {
    process.env.NETLIFY_DB_URL = fs.readFileSync(file, "utf8").trim();
  }
  if (!process.env.NETLIFY_DB_URL) throw new Error("NETLIFY_DB_URL required");
}

async function applyRevokedMigration() {
  const sql = fs.readFileSync(
    path.join(root, "netlify/database/migrations/20260901190000_annual_memberships_revoked_status.sql"),
    "utf8",
  );
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
  for (const stmt of statements) {
    try {
      await annualMembershipQuery(stmt, []);
    } catch (err) {
      const msg = String(/** @type {{ message?: string }} */ (err)?.message ?? err);
      if (!msg.includes("already exists") && !msg.includes("does not exist")) throw err;
    }
  }
}

async function snapshotTerms() {
  const r = await annualMembershipQuery(
    `SELECT m.id, m.sku, m.status, m.stripe_subscription_id,
            (SELECT COUNT(*) FILTER (WHERE p.status = 'pending') FROM annual_membership_periods p WHERE p.annual_membership_id = m.id) AS pending_count,
            (SELECT COUNT(*) FILTER (WHERE p.status = 'skipped') FROM annual_membership_periods p WHERE p.annual_membership_id = m.id) AS skipped_count,
            (SELECT COUNT(*) FILTER (WHERE p.status = 'issued') FROM annual_membership_periods p WHERE p.annual_membership_id = m.id) AS issued_count
       FROM annual_memberships m
      WHERE m.mindbody_client_id = $1
        AND m.sku = ANY($2::text[])
      ORDER BY m.created_at ASC`,
    [QA_CLIENT, QA_SKUS],
  );
  return r.rows;
}

async function main() {
  await ensureDb();
  await applyRevokedMigration();

  const before = await snapshotTerms();
  console.log(JSON.stringify({ event: "qa_revoke_cleanup_before", rows: before }, null, 2));

  /** @type {Record<string, unknown>} */
  const results = {};

  for (const sku of QA_SKUS) {
    const rows = before.filter((r) => String(r.sku) === sku && String(r.status) !== "revoked");
    if (!rows.length) {
      results[sku] = { status: "NOT_FOUND_OR_ALREADY_REVOKED" };
      continue;
    }
    if (rows.length > 1) {
      results[sku] = { status: "MULTIPLE_ACTIVE_TERMS", count: rows.length, ids: rows.map((r) => r.id) };
      continue;
    }
    const row = rows[0];
    const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (sk && row.stripe_subscription_id) {
      const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
      try {
        const sub = await stripe.subscriptions.retrieve(String(row.stripe_subscription_id));
        if (sub.status !== "canceled") {
          await stripe.subscriptions.cancel(String(row.stripe_subscription_id));
        }
      } catch {
        /* test sub may already be gone */
      }
    }
    const revoked = await adminRevokeAnnualTerm(String(row.id), { confirmStop: "STOP", reason: "qa_cleanup" });
    results[sku] = revoked;
  }

  const after = await snapshotTerms();
  const rec1 = await runAnnualMembershipReconciliation();
  const rec2 = await runAnnualMembershipReconciliation();

  console.log(
    JSON.stringify(
      {
        event: "qa_revoke_cleanup_complete",
        results,
        after,
        pendingRemaining: after.reduce((n, r) => n + Number(r.pending_count || 0), 0),
        reconciler: { first: rec1, second: rec2 },
        mindbodyWrites: (rec1.issued?.length ?? 0) + (rec2.issued?.length ?? 0),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  const message =
    err instanceof Error
      ? err.message || err.stack || String(err)
      : String(err ?? "unknown_error");
  console.error(JSON.stringify({ event: "qa_revoke_cleanup_failed", error: message }));
  process.exitCode = 1;
});
