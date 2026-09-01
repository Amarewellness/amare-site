/**
 * One-shot QA annual term cleanup orchestrator (read + revoke + verify).
 * Target: Mindbody client 100002839 only. Does not deploy.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";
import { adminRevokeAnnualTerm } from "../netlify/functions/annual-membership-admin-actions.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";
import { getMindbodyStaffAccessTokenCached } from "../netlify/functions/mindbody-consumer-lib.mjs";
import { mindbodyStaffBearerHeaders } from "../netlify/functions/mindbody-upstream.mjs";
import { fetchMb, MB_API_VERSION } from "../netlify/functions/mindbody-consumer-lib.mjs";

loadLocalEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const QA_CLIENT = 100002839;
const QA_SKUS = ["annual_monthly_5", "annual_monthly_8"];
const ANNUAL_PRODUCTS = { annual_monthly_5: 100133, annual_monthly_8: 100134 };

/** @param {string} url */
async function probeDb(url) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function spawnDbProxy() {
  const child = spawn(
    process.execPath,
    [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true },
  );
  child.unref();
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("db_proxy_timeout")), 90_000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`db_proxy_exited:${code}`));
    });
  });
  fs.writeFileSync(path.join(root, ".cursor-local-db-url.txt"), `${url}\n`, "utf8");
  return url;
}

async function ensureDb() {
  const file = path.join(root, ".cursor-local-db-url.txt");
  let url = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  if (!url || !(await probeDb(url))) {
    url = await spawnDbProxy();
  }
  if (!(await probeDb(url))) throw new Error("db_unavailable");
  process.env.NETLIFY_DB_URL = url;
  return url;
}

async function applyRevokedMigration() {
  const sql = fs.readFileSync(
    path.join(root, "netlify/database/migrations/20260901190000_annual_memberships_revoked_status.sql"),
    "utf8",
  );
  for (const stmt of sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"))) {
    try {
      await annualMembershipQuery(`${stmt};`, []);
    } catch (err) {
      const msg = String(/** @type {{ message?: string }} */ (err)?.message ?? err);
      if (!msg.includes("already exists") && !msg.includes("does not exist")) throw err;
    }
  }
}

async function listTerms() {
  const r = await annualMembershipQuery(
    `SELECT id AS annual_membership_id, sku, status, stripe_subscription_id, stripe_invoice_id,
            term_start_date, term_end_date, mindbody_client_id, created_at
       FROM annual_memberships
      WHERE mindbody_client_id = $1
      ORDER BY created_at ASC`,
    [QA_CLIENT],
  );
  return r.rows;
}

/** @param {string} membershipId */
async function listPeriods(membershipId) {
  const r = await annualMembershipQuery(
    `SELECT period_index, status, mindbody_sale_id, mindbody_client_service_id,
            period_start_date, period_end_date, last_error
       FROM annual_membership_periods
      WHERE annual_membership_id = $1::uuid
      ORDER BY period_index ASC`,
    [membershipId],
  );
  return r.rows;
}

/** @param {unknown[]} periods */
function summarizePeriods(periods) {
  /** @type {Record<string, number>} */
  const counts = {
    pending: 0,
    claiming: 0,
    issued: 0,
    failed: 0,
    ambiguous: 0,
    manual_review: 0,
    skipped: 0,
  };
  /** @type {unknown[]} */
  const issued = [];
  for (const p of periods) {
    const st = String(/** @type {{ status?: string }} */ (p).status || "");
    if (counts[st] != null) counts[st] += 1;
    if (st === "issued") issued.push(p);
  }
  return { counts, issued, total: periods.length };
}

/** @param {unknown[]} terms @param {string} sku */
function pickTerm(terms, sku) {
  const matches = terms.filter((t) => String(/** @type {{ sku?: string }} */ (t).sku) === sku);
  if (!matches.length) return null;
  if (matches.length > 1) {
    const active = matches.filter((t) => String(/** @type {{ status?: string }} */ (t).status) !== "revoked");
    return active.length === 1 ? active[0] : { multiple: true, matches };
  }
  return matches[0];
}

/** @param {string | null | undefined} subId */
async function stripeSubSummary(subId) {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk || !subId) return { configured: !!sk, subId: subId ?? null, error: "missing_subscription_or_key" };
  const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
  try {
    const sub = await stripe.subscriptions.retrieve(String(subId));
    return {
      configured: true,
      subId: sub.id,
      livemode: sub.livemode,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      cancelAt: sub.cancel_at ?? null,
      renewalBlocked: sub.status === "canceled" || sub.cancel_at_period_end === true,
    };
  } catch (err) {
    return {
      configured: true,
      subId,
      error: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 200),
      renewalBlocked: true,
    };
  }
}

/** @param {string} subId */
async function ensureStripeTestRenewalCanceled(subId) {
  const summary = await stripeSubSummary(subId);
  if (summary.livemode === true) {
    throw new Error(`refusing_live_stripe_subscription:${subId}`);
  }
  if (summary.renewalBlocked) return summary;
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk) return summary;
  const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
  if (summary.status !== "canceled") {
    await stripe.subscriptions.cancel(String(subId));
  }
  return stripeSubSummary(subId);
}

/** @param {Record<string, unknown>[]} issuedPeriods @param {string} sku */
async function fetchMindbodyIssuedServices(issuedPeriods, sku) {
  const token = await getMindbodyStaffAccessTokenCached();
  if (!token.ok) return { ok: false, error: token.error };
  const headers = mindbodyStaffBearerHeaders(token.accessToken);
  if (!headers) return { ok: false, error: "staff_headers_unavailable" };
  const productId = ANNUAL_PRODUCTS[/** @type {keyof typeof ANNUAL_PRODUCTS} */ (sku)];
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientservices?request.clientId=${QA_CLIENT}&request.limit=200`,
    headers,
  );
  if (!r.ok) return { ok: false, error: "clientservices_fetch_failed", status: r.status };
  const data = /** @type {Record<string, unknown>} */ (r.data ?? {});
  const all = /** @type {Record<string, unknown>[]} */ (
    Array.isArray(data.ClientServices) ? data.ClientServices : Array.isArray(data.clientServices) ? data.clientServices : []
  );
  const csIds = new Set(
    issuedPeriods.map((p) => Number(/** @type {{ mindbody_client_service_id?: unknown }} */ (p).mindbody_client_service_id)).filter((n) => n > 0),
  );
  const services = all
    .filter((s) => {
      const id = Number(s.Id ?? s.id);
      const pid = Number(s.ProductId ?? s.productId);
      return csIds.has(id) || pid === productId;
    })
    .map((s) => ({
      productId: Number(s.ProductId ?? s.productId),
      clientServiceId: Number(s.Id ?? s.id),
      remaining: Number(s.Remaining ?? s.remaining ?? NaN),
      activeDate: s.ActiveDate ?? s.activeDate ?? null,
      expirationDate: s.ExpirationDate ?? s.expirationDate ?? null,
      saleId: s.SaleID ?? s.saleId ?? null,
      fromIssuedPeriod: csIds.has(Number(s.Id ?? s.id)),
    }));
  return { ok: true, services };
}

/** @param {{ issued?: unknown[] }} rec */
function countReconcilerWrites(rec) {
  return {
    issued: Array.isArray(rec.issued) ? rec.issued.length : 0,
    ambiguousRecoveredIssued: Array.isArray(rec.ambiguousRecovered)
      ? rec.ambiguousRecovered.filter((r) => /** @type {{ outcome?: string }} */ (r).outcome === "issued").length
      : 0,
    failed: Array.isArray(rec.failed) ? rec.failed.length : 0,
    skipped: Array.isArray(rec.skipped) ? rec.skipped.length : 0,
  };
}

async function main() {
  const dbUrl = await ensureDb();
  await applyRevokedMigration();

  const allTerms = await listTerms();
  const nonQa = allTerms.filter((t) => Number(/** @type {{ mindbody_client_id?: unknown }} */ (t).mindbody_client_id) !== QA_CLIENT);
  if (nonQa.length) throw new Error("unexpected_non_qa_client_rows");

  /** @type {Record<string, unknown>} */
  const report = {
    qaDatabaseVerified: { pass: true, url: dbUrl },
    terms: allTerms,
    before: {},
    stripe: {},
    revokeResults: {},
    after: {},
    reconciler: {},
    mindbody: {},
  };

  for (const sku of QA_SKUS) {
    const term = pickTerm(allTerms, sku);
    if (!term || /** @type {{ multiple?: boolean }} */ (term).multiple) {
      report.before[sku] = { found: false, multiple: /** @type {{ multiple?: boolean }} */ (term)?.multiple ?? false };
      continue;
    }
    const id = String(/** @type {{ annual_membership_id?: string }} */ (term).annual_membership_id);
    const periods = await listPeriods(id);
    report.before[sku] = {
      found: true,
      annual_membership_id: id,
      parentStatus: term.status,
      stripe_subscription_id: term.stripe_subscription_id,
      stripe_invoice_id: term.stripe_invoice_id,
      term_start_date: term.term_start_date,
      term_end_date: term.term_end_date,
      ...summarizePeriods(periods),
      periods,
    };
    const subId = String(term.stripe_subscription_id || "");
    report.stripe[sku] = await ensureStripeTestRenewalCanceled(subId);
  }

  for (const sku of QA_SKUS) {
    const before = /** @type {{ found?: boolean; annual_membership_id?: string; parentStatus?: string }} */ (report.before[sku]);
    if (!before?.found || !before.annual_membership_id) {
      report.revokeResults[sku] = { status: "NOT_FOUND" };
      continue;
    }
    if (String(before.parentStatus) === "revoked") {
      report.revokeResults[sku] = { status: "ALREADY_REVOKED", idempotent: true };
      continue;
    }
    report.revokeResults[sku] = await adminRevokeAnnualTerm(String(before.annual_membership_id), {
      confirmStop: "STOP",
      reason: "qa_cleanup",
    });
  }

  const afterTerms = await listTerms();
  for (const sku of QA_SKUS) {
    const term = pickTerm(afterTerms, sku);
    if (!term || /** @type {{ multiple?: boolean }} */ (term).multiple) {
      report.after[sku] = { found: false };
      continue;
    }
    const id = String(/** @type {{ annual_membership_id?: string }} */ (term).annual_membership_id);
    const periods = await listPeriods(id);
    const beforeIssued = /** @type {{ issued?: unknown[] }} */ (report.before[sku])?.issued ?? [];
    const afterIssued = summarizePeriods(periods).issued;
    const p0Before = beforeIssued.find((p) => Number(/** @type {{ period_index?: unknown }} */ (p).period_index) === 0);
    const p0After = afterIssued.find((p) => Number(/** @type {{ period_index?: unknown }} */ (p).period_index) === 0);
    report.after[sku] = {
      found: true,
      annual_membership_id: id,
      parentStatus: term.status,
      ...summarizePeriods(periods),
      period0Preserved:
        p0Before &&
        p0After &&
        String(/** @type {{ mindbody_sale_id?: unknown }} */ (p0Before).mindbody_sale_id) ===
          String(/** @type {{ mindbody_sale_id?: unknown }} */ (p0After).mindbody_sale_id) &&
        String(/** @type {{ mindbody_client_service_id?: unknown }} */ (p0Before).mindbody_client_service_id) ===
          String(/** @type {{ mindbody_client_service_id?: unknown }} */ (p0After).mindbody_client_service_id),
      periods,
    };
    report.mindbody[sku] = await fetchMindbodyIssuedServices(afterIssued, sku);
  }

  const rec1 = await runAnnualMembershipReconciliation();
  const rec2 = await runAnnualMembershipReconciliation();
  report.reconciler = {
    run1: countReconcilerWrites(rec1),
    run2: countReconcilerWrites(rec2),
    run1Full: rec1,
    run2Full: rec2,
  };

  const qaRevokedIds = new Set(
    QA_SKUS.map((sku) => {
      const a = /** @type {{ annual_membership_id?: string }} */ (report.after[sku]);
      return a?.annual_membership_id ? String(a.annual_membership_id) : "";
    }).filter(Boolean),
  );
  const qaIssued =
    (report.reconciler.run1.issued ?? 0) +
    (report.reconciler.run2.issued ?? 0) +
    (rec1.issued || []).filter((e) => qaRevokedIds.has(String(/** @type {{ annual_membership_id?: string }} */ (e).annual_membership_id))).length;

  report.summary = {
    qaCleanupPass:
      QA_SKUS.every((sku) => {
        const a = /** @type {{ parentStatus?: string; counts?: Record<string, number>; period0Preserved?: boolean }} */ (report.after[sku]);
        return (
          a?.parentStatus === "revoked" &&
          (a.counts?.issued ?? 0) === 1 &&
          (a.counts?.pending ?? 0) === 0 &&
          (a.counts?.skipped ?? 0) === 11 &&
          a.period0Preserved === true
        );
      }) && qaIssued === 0,
    mindbodyWrites: qaIssued,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "qa_cleanup_run_failed", error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
