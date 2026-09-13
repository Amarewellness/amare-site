/**
 * DIJANA annual ledger backfill — Step 1 only (Postgres durable ledger).
 * Usage:
 *   node scripts/repair-dijana-annual-ledger-step1.mjs --verify
 *   node scripts/repair-dijana-annual-ledger-step1.mjs --execute
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./load-env.mjs";

import { buildAnnualMembershipPeriods, stripeInstantToBusinessDate } from "../netlify/functions/annual-membership-lib.mjs";
import {
  annualMembershipQuery,
  closeAnnualMembershipDb,
  openAnnualMembershipStore,
  withAnnualMembershipTransaction,
} from "../netlify/functions/annual-membership-store.mjs";
import { issueAnnualMembershipPeriod } from "../netlify/functions/annual-membership-issue.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";
import { fetchClientPurchasesInWindow } from "../netlify/functions/annual-membership-issue.mjs";
import { resolveStaffAuthHeaders } from "../netlify/functions/mindbody-class-book-lib.mjs";
import { getStore } from "@netlify/blobs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const mode = process.argv.includes("--execute") ? "execute" : "verify";

const CLIENT_ID = 100003742;
const CHECKOUT_ID = "cs_live_a1vKDWsY4B8V86x0E2RIh6UWqp6OaWDV5oF3fiqFkf0f69KFgeS3FwJGYy";
const INTERNAL_SUB_ID = "sub_amare_A3HV7VJ32Q8AY0JZ";
const KEEPER_SALE_ID = 37485;
const KEEPER_SERVICE_ID = 33341;
const SITE_ID = "f315d80d-f61e-4fef-9a06-68bb09192d56";
const STRIPE_READONLY_URL =
  "https://www.amarewellness.com/.netlify/functions/_repair-dijana-stripe-readonly";

function netlifyCliToken() {
  const configPath =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "netlify", "Config", "config.json")
      : path.join(os.homedir(), ".config", "netlify", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const user of Object.values(cfg?.users || {})) {
      const token = String(/** @type {{ auth?: { token?: string } }} */ (user)?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function resolveProductionDbUrl() {
  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();
  if (existing) return existing;

  const child = spawn(process.execPath, [cli, "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("netlify_database_connect_timeout"));
    }, 30000);
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
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`netlify_database_connect_exited:${code}`));
    });
  });
}

async function fetchProductionSubscriptionBlob() {
  const token = netlifyCliToken();
  if (!token) throw new Error("missing_netlify_cli_token");
  const bySession = getStore({
    name: "stripe-mindbody-subscriptions-by-session",
    siteID: SITE_ID,
    token,
    consistency: "strong",
  });
  const subs = getStore({
    name: "stripe-mindbody-subscriptions",
    siteID: SITE_ID,
    token,
    consistency: "strong",
  });
  const idx = await bySession.get(`v1/${CHECKOUT_ID}`, { type: "json" });
  if (!idx?.subscriptionId) throw new Error("missing_session_index");
  const record = await subs.get(`v1/${idx.subscriptionId}`, { type: "json" });
  if (!record) throw new Error("missing_subscription_record");
  return record;
}

async function fetchCanonicalStripeFromProduction() {
  const adminToken = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!adminToken) throw new Error("missing_ADMIN_DEBUG_TOKEN_in_local_env");

  const res = await fetch(STRIPE_READONLY_URL, {
    headers: { "x-admin-token": adminToken, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`stripe_readonly_failed:${res.status}:${JSON.stringify(body).slice(0, 240)}`);
  }
  return body;
}

async function fetchKeeperIssuedAtIso() {
  const staff = await resolveStaffAuthHeaders();
  const purchases = await fetchClientPurchasesInWindow(
    staff,
    CLIENT_ID,
    "2026-09-01T00:00:00",
    "2026-09-30T23:59:59",
  );
  if (!purchases.ok) throw new Error("mindbody_purchases_failed");
  const row = (purchases.purchases || []).find((p) => Number((p?.Sale || p)?.Id) === KEEPER_SALE_ID);
  if (!row) throw new Error("keeper_sale_not_found");
  const sale = row.Sale || row;
  const dt = sale.SaleDateTime || sale.OriginalSaleDateTime || sale.SaleDate;
  if (!dt) throw new Error("keeper_sale_missing_timestamp");
  return new Date(dt).toISOString();
}

async function preWriteChecks() {
  const count = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n FROM annual_memberships WHERE mindbody_client_id = $1::bigint`,
    [CLIENT_ID],
  );
  const n = count.rows[0]?.n ?? -1;
  if (n !== 0) throw new Error(`pre_write_count_not_zero:${n}`);
  return n;
}

async function executeBackfill(canonical, issuedAtIso) {
  const periodDefs = buildAnnualMembershipPeriods({
    termStartDate: canonical.termStartDate,
    termEndDate: canonical.termEndDate,
    sku: canonical.localSku,
  });

  return withAnnualMembershipTransaction(async (client) => {
    const dup = await client.query(
      `SELECT id FROM annual_memberships WHERE stripe_invoice_id = $1 LIMIT 1 FOR UPDATE`,
      [canonical.stripeInvoiceId],
    );
    if (dup.rows[0]) throw new Error("invoice_already_exists");

    const dupSub = await client.query(
      `SELECT id FROM annual_memberships
        WHERE stripe_subscription_id = $1 AND term_start_date = $2::date
        LIMIT 1 FOR UPDATE`,
      [canonical.stripeSubscriptionId, canonical.termStartDate],
    );
    if (dupSub.rows[0]) throw new Error("subscription_term_already_exists");

    const clientCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM annual_memberships WHERE mindbody_client_id = $1::bigint`,
      [CLIENT_ID],
    );
    if (clientCount.rows[0]?.n !== 0) throw new Error("client_count_changed_during_tx");

    const inserted = await client.query(
      `INSERT INTO annual_memberships (
         mindbody_client_id,
         stripe_customer_id,
         stripe_subscription_id,
         stripe_invoice_id,
         stripe_price_id,
         sku,
         status,
         term_start_date,
         term_end_date,
         stripe_period_start_at,
         stripe_period_end_at,
         annual_amount_cents,
         timezone
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,'America/New_York')
       RETURNING *`,
      [
        CLIENT_ID,
        canonical.stripeCustomerId,
        canonical.stripeSubscriptionId,
        canonical.stripeInvoiceId,
        canonical.stripePriceId,
        canonical.localSku,
        canonical.termStartDate,
        canonical.termEndDate,
        canonical.stripePeriodStartAt,
        canonical.stripePeriodEndAt,
        canonical.annualAmountCents,
      ],
    );
    const membership = inserted.rows[0];

    /** @type {Record<string, unknown>[]} */
    const periods = [];
    for (const def of periodDefs) {
      const isZero = def.periodIndex === 0;
      const r = await client.query(
        `INSERT INTO annual_membership_periods (
           annual_membership_id,
           period_index,
           period_start_date,
           period_end_date,
           status,
           mindbody_product_id,
           expected_list_amount_cents,
           expected_discount_amount_cents,
           expected_net_amount_cents,
           mindbody_sale_id,
           mindbody_client_service_id,
           issued_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          membership.id,
          def.periodIndex,
          def.periodStartDate,
          def.periodEndDate,
          isZero ? "issued" : "pending",
          def.mindbodyProductId,
          def.expectedListAmountCents,
          def.expectedDiscountAmountCents,
          def.expectedNetAmountCents,
          isZero ? KEEPER_SALE_ID : null,
          isZero ? KEEPER_SERVICE_ID : null,
          isZero ? issuedAtIso : null,
        ],
      );
      periods.push(r.rows[0]);
    }

    if (periods.length !== 12) throw new Error("period_count_invalid");
    return { membership, periods };
  });
}

async function postWriteVerify(canonical) {
  const memRows = await annualMembershipQuery(
    `SELECT * FROM annual_memberships WHERE mindbody_client_id = $1::bigint ORDER BY created_at DESC`,
    [CLIENT_ID],
  );
  const periods = await annualMembershipQuery(
    `SELECT p.*
       FROM annual_membership_periods p
       INNER JOIN annual_memberships m ON m.id = p.annual_membership_id
      WHERE m.mindbody_client_id = $1::bigint
      ORDER BY p.period_index ASC`,
    [CLIENT_ID],
  );

  const invoiceDup = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n FROM annual_memberships WHERE stripe_invoice_id = $1`,
    [canonical.stripeInvoiceId],
  );
  const subDup = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n FROM annual_memberships
      WHERE stripe_subscription_id = $1 AND term_start_date = $2::date`,
    [canonical.stripeSubscriptionId, canonical.termStartDate],
  );

  const p0 = periods.rows.find((p) => p.period_index === 0);
  const indices = periods.rows.map((p) => p.period_index).sort((a, b) => a - b);

  const store = openAnnualMembershipStore();
  const today = stripeInstantToBusinessDate(new Date());
  const dueToday = await store.listDuePeriods(today, { statuses: ["pending", "failed"] });
  const membershipIds = new Set(memRows.rows.map((m) => m.id));
  const dijanaDue = dueToday.filter((p) => membershipIds.has(p.annual_membership_id));

  let issueSim = null;
  if (p0) {
    issueSim = await issueAnnualMembershipPeriod(String(p0.id), {
      store,
      syncFn: async () => {
        throw new Error("must_not_reach_mindbody_sync");
      },
    });
  }

  const period1 = periods.rows.find((p) => p.period_index === 1);
  const recon = await runAnnualMembershipReconciliation({
    store,
    issueFn: async () => {
      throw new Error("must_not_reach_reconciler_issue");
    },
    businessDate: today,
  });

  let adminShows = false;
  const adminToken = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (adminToken) {
    const adminRes = await fetch(
      `https://www.amarewellness.com/api/admin/annual-memberships?mindbodyClientId=${CLIENT_ID}`,
      { headers: { "x-admin-token": adminToken, Accept: "application/json" } },
    );
    const adminBody = await adminRes.json().catch(() => ({}));
    adminShows =
      adminRes.ok &&
      Array.isArray(adminBody.memberships) &&
      adminBody.memberships.some(
        (m) =>
          Number(m.mindbody_client_id) === CLIENT_ID &&
          m.status === "active" &&
          m.sku === "annual_monthly_unlimited",
      );
  }

  return {
    membershipCount: memRows.rows.length,
    periodCount: periods.rows.length,
    indices,
    p0,
    pendingLater: periods.rows.filter((p) => p.period_index > 0).every((p) => p.status === "pending"),
    invoiceDup: invoiceDup.rows[0]?.n,
    subDup: subDup.rows[0]?.n,
    period0Due: dijanaDue.some((p) => p.period_index === 0),
    period1DueToday: dijanaDue.some((p) => p.period_index === 1),
    period1Future: period1 && period1.period_start_date > today,
    period1Start: period1?.period_start_date,
    issueSim,
    reconIssued: recon.issued?.length ?? 0,
    adminShows,
  };
}

process.env.NETLIFY = "true";
delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
const dbUrl = await resolveProductionDbUrl();
process.env.NETLIFY_DB_URL = dbUrl;
process.env.NETLIFY_DATABASE_URL = dbUrl;
process.env.DATABASE_URL = dbUrl;

/** @type {Record<string, unknown>} */
const report = { mode, clientId: CLIENT_ID };

try {
  const blob = await fetchProductionSubscriptionBlob();
  report.blobSubscriptionId = blob.id;
  report.blobStripeSubscriptionId = blob.stripeSubscriptionId;
  report.blobStripeCustomerId = blob.stripeCustomerId;
  report.blobLocalSku = blob.localSku;
  report.blobMonthlyAmountCents = blob.monthlyAmountCents;

  const canonical = await fetchCanonicalStripeFromProduction();
  if (blob.stripeSubscriptionId !== canonical.stripeSubscriptionId) {
    throw new Error("blob_stripe_subscription_mismatch");
  }
  if (blob.stripeCustomerId !== canonical.stripeCustomerId) {
    throw new Error("blob_customer_mismatch");
  }
  if (blob.localSku !== canonical.localSku) {
    throw new Error("blob_sku_mismatch");
  }
  if (canonical.annualAmountCents !== 233580) {
    throw new Error(`unexpected_annual_amount:${canonical.annualAmountCents}`);
  }

  report.stripeSubscriptionId = canonical.stripeSubscriptionId;
  report.stripeInvoiceId = canonical.stripeInvoiceId;
  report.termStart = canonical.termStartDate;
  report.termEnd = canonical.termEndDate;
  report.sku = canonical.localSku;
  report.annualAmountCents = canonical.annualAmountCents;
  report.subscriptionStatus = canonical.subscriptionStatus;

  console.log("=== CANONICAL STRIPE (production read-only) ===");
  console.log(JSON.stringify(report, null, 2));

  const preCount = await preWriteChecks();
  report.preWriteClientCount = preCount;
  console.log("PRE_WRITE_CLIENT_COUNT:", preCount);

  const issuedAtIso = await fetchKeeperIssuedAtIso();
  report.period0IssuedAt = issuedAtIso;
  console.log("PERIOD0_ISSUED_AT:", issuedAtIso);

  if (mode === "execute") {
    const result = await executeBackfill(canonical, issuedAtIso);
    report.membershipId = result.membership.id;
    console.log("BACKFILL_COMMITTED:", result.membership.id);
    report.verify = await postWriteVerify(canonical);
    report.backfill =
      report.verify.membershipCount === 1 && report.verify.periodCount === 12 ? "PASS" : "FAIL";
  } else {
    console.log("VERIFY_ONLY — pass --execute to commit backfill");
    report.backfill = "NOT_RUN";
  }
} finally {
  await closeAnnualMembershipDb();
}

console.log("\n=== FINAL REPORT ===");
console.log(JSON.stringify(report, null, 2));
