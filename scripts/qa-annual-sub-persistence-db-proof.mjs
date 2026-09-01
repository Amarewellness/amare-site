/**
 * DB-backed final proof: real Stripe TEST invoice → Postgres stores sub_*.
 *
 * Does NOT run full Annual E2E. Does NOT touch revoked QA Annual 5/8 terms.
 * Mindbody issuance suppressed via skipMindbodyIssue.
 *
 * Run: node scripts/qa-annual-sub-persistence-db-proof.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import {
  extractStripeInvoiceSubscriptionId,
  isPendingStripeSubscriptionId,
  isRealStripeSubscriptionId,
} from "../netlify/functions/annual-membership-lib.mjs";
import {
  adminCancelAnnualRenewal,
  adminRevokeAnnualTerm,
} from "../netlify/functions/annual-membership-admin-actions.mjs";
import {
  annualMembershipQuery,
  openAnnualMembershipStore,
} from "../netlify/functions/annual-membership-store.mjs";
import { handleAnnualInvoicePaid } from "../netlify/functions/annual-membership-webhook-lib.mjs";

loadLocalEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const QA_CLIENT = 100002839;
const REVOKED_TERM_IDS = new Set([
  "f7a7db5b-60d2-4deb-8a7b-579e659826e5",
  "13b27288-49da-41e2-9c5b-fa35436266af",
]);

/** @type {Record<string, unknown>} */
const report = {
  startedAt: new Date().toISOString(),
  phase: "db_sub_persistence_proof",
};

let failed = 0;
/** @type {string | null} */
let tempMembershipId = null;
/** @type {string | null} */
let tempInvoiceId = null;
/** @type {string | null} */
let tempSubId = null;
/** @type {import("stripe").Stripe | null} */
let stripe = null;

function check(name, ok, detail) {
  report[name] = ok ? "PASS" : { status: "FAIL", detail: detail ?? null };
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function loadDbUrl() {
  delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
  const file = path.join(root, ".cursor-local-db-url.txt");
  if (fs.existsSync(file)) {
    const url = fs.readFileSync(file, "utf8").trim();
    if (url) {
      process.env.NETLIFY_DB_URL = url;
      return url;
    }
  }
  const envUrl = (process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || "").trim();
  if (!envUrl) throw new Error("postgres_qa_db_url_required");
  return envUrl;
}

async function queryTermByInvoice(invoiceId) {
  const r = await annualMembershipQuery(
    `SELECT m.id,
            m.stripe_invoice_id,
            m.stripe_subscription_id,
            m.status,
            m.sku,
            (
              SELECT COUNT(*)::int
                FROM annual_membership_periods p
               WHERE p.annual_membership_id = m.id
            ) AS period_count
       FROM annual_memberships m
      WHERE m.stripe_invoice_id = $1
      LIMIT 1`,
    [invoiceId],
  );
  return r.rows[0] ?? null;
}

async function assertRevokedTermsUntouched() {
  const r = await annualMembershipQuery(
    `SELECT id, status, stripe_subscription_id
       FROM annual_memberships
      WHERE id = ANY($1::uuid[])`,
    [[...REVOKED_TERM_IDS]],
  );
  for (const row of r.rows) {
    check(
      `revoked QA term untouched ${row.id}`,
      row.status === "revoked" && REVOKED_TERM_IDS.has(String(row.id)),
      JSON.stringify(row),
    );
  }
}

async function createStripeTestSubscription() {
  const customer = await stripe.customers.create({
    email: `annual-db-proof-${Date.now()}@amare-qa.test`,
    metadata: { purpose: "annual_sub_db_proof" },
  });
  const pm = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_visa" },
  });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const product = await stripe.products.create({
    name: "Annual DB Proof QA (temp)",
    metadata: { localSku: "annual_monthly_5", kind: "annualMembership" },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 127500,
    recurring: { interval: "year" },
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    metadata: {
      subscriptionId: `subrec_db_proof_${Date.now()}`,
      localSku: "annual_monthly_5",
      mindbodyClientId: String(QA_CLIENT),
      purpose: "annual_sub_db_proof",
    },
    expand: ["latest_invoice"],
  });

  const latest = subscription.latest_invoice;
  const invoiceId = typeof latest === "string" ? latest : latest?.id;
  if (!invoiceId) throw new Error("missing_latest_invoice");

  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["subscription"] });
  const invoiceSub = extractStripeInvoiceSubscriptionId(invoice);
  if (!isRealStripeSubscriptionId(invoiceSub)) {
    throw new Error(`invoice_missing_real_sub:${invoiceSub || "(empty)"}`);
  }

  return {
    customerId: customer.id,
    subscription,
    subscriptionId: subscription.id,
    invoice,
    invoiceSub,
    pendingPlaceholder: `pending_sub_amare_dbproof_${Date.now()}`,
  };
}

async function main() {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk.startsWith("sk_test_")) throw new Error("stripe_not_test_mode");
  report.stripeMode = "TEST";

  const dbUrl = loadDbUrl();
  report.db = dbUrl.replace(/:[^:@/]+@/, ":***@");

  const store = openAnnualMembershipStore();
  check("postgres store selected", store.kind === "postgres", store.kind);

  stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });

  await assertRevokedTermsUntouched();

  const created = await createStripeTestSubscription();
  tempInvoiceId = created.invoice.id;
  tempSubId = created.invoiceSub;
  report.testInvoice = tempInvoiceId;
  report.expectedSubscriptionId = tempSubId;

  const pendingPlaceholder = created.pendingPlaceholder;
  report.pendingPlaceholderUsed = pendingPlaceholder;

  const first = await handleAnnualInvoicePaid({
    invoice: created.invoice,
    subscriptionRecord: {
      id: created.subscription.metadata?.subscriptionId || "subrec_db_proof",
      localSku: "annual_monthly_5",
      mindbodyClientId: QA_CLIENT,
      stripeSubscriptionId: pendingPlaceholder,
      stripeCustomerId: created.customerId,
      amareUserId: null,
    },
    store,
    skipMindbodyIssue: true,
  });

  const row1 = await queryTermByInvoice(tempInvoiceId);
  tempMembershipId = row1?.id ? String(row1.id) : null;
  report.annualMembershipId = tempMembershipId;
  report.storedSubscriptionId = row1?.stripe_subscription_id ?? null;
  report.initialWrite = {
    created: first.created === true,
    status: row1?.status ?? null,
    periodCount: row1?.period_count ?? null,
  };

  check(
    "DB initial write created term",
    first.ok === true && first.created === true && !!tempMembershipId,
    JSON.stringify(first),
  );
  check(
    "DB stores real sub_* not pending",
    isRealStripeSubscriptionId(row1?.stripe_subscription_id) &&
      row1?.stripe_subscription_id === tempSubId &&
      !isPendingStripeSubscriptionId(row1?.stripe_subscription_id),
    String(row1?.stripe_subscription_id),
  );
  check("DB period count is 12", Number(row1?.period_count) === 12, String(row1?.period_count));

  const p0 = await annualMembershipQuery(
    `SELECT status, mindbody_sale_id, mindbody_client_service_id
       FROM annual_membership_periods
      WHERE annual_membership_id = $1::uuid AND period_index = 0
      LIMIT 1`,
    [tempMembershipId],
  );
  const p0row = p0.rows[0];
  check(
    "period 0 pending — no Mindbody write",
    p0row?.status === "pending" &&
      (p0row?.mindbody_sale_id == null || p0row?.mindbody_sale_id === null) &&
      (p0row?.mindbody_client_service_id == null || p0row?.mindbody_client_service_id === null),
    JSON.stringify(p0row),
  );
  report.newMindbodyWrite = "NO";

  const replay = await handleAnnualInvoicePaid({
    invoice: created.invoice,
    subscriptionRecord: {
      id: "subrec_db_proof_replay",
      localSku: "annual_monthly_5",
      mindbodyClientId: QA_CLIENT,
      stripeSubscriptionId: tempSubId,
      stripeCustomerId: created.customerId,
    },
    store,
    skipMindbodyIssue: true,
  });
  const row2 = await queryTermByInvoice(tempInvoiceId);
  check(
    "replay same term id",
    replay.created === false && String(row2?.id) === tempMembershipId,
    `${row1?.id} vs ${row2?.id}`,
  );
  check(
    "replay keeps real sub_*",
    row2?.stripe_subscription_id === tempSubId,
    String(row2?.stripe_subscription_id),
  );
  check(
    "replay still 12 periods",
    Number(row2?.period_count) === 12,
    String(row2?.period_count),
  );

  const conflictSub = `${tempSubId}_conflict_fake`;
  const conflict = await store.createAnnualTermWithPeriods({
    mindbodyClientId: QA_CLIENT,
    stripeCustomerId: created.customerId,
    stripeSubscriptionId: conflictSub,
    stripeInvoiceId: tempInvoiceId,
    sku: "annual_monthly_5",
    termStartDate: "2026-09-01",
    termEndDate: "2027-09-01",
    annualAmountCents: 127500,
  });
  const row3 = await queryTermByInvoice(tempInvoiceId);
  check(
    "conflict does not overwrite real sub_A with sub_B",
    conflict.created === false &&
      row3?.stripe_subscription_id === tempSubId &&
      row3?.stripe_subscription_id !== conflictSub,
    `${row3?.stripe_subscription_id} vs ${conflictSub}`,
  );

  const pendingTerm = await store.createAnnualTermWithPeriods({
    mindbodyClientId: QA_CLIENT,
    stripeSubscriptionId: `pending_sub_amare_admin_guard_${Date.now()}`,
    stripeInvoiceId: `in_pending_admin_guard_${Date.now()}`,
    sku: "annual_monthly_5",
    termStartDate: "2026-09-01",
    termEndDate: "2027-09-01",
    annualAmountCents: 127500,
  });
  let pendingStripeMutated = false;
  process.env.STRIPE_SECRET_KEY = sk;
  const pendingCancel = await adminCancelAnnualRenewal(pendingTerm.membership.id, {
    stripe: {
      subscriptions: {
        retrieve: async () => {
          pendingStripeMutated = true;
          return {};
        },
        update: async () => {
          pendingStripeMutated = true;
          return {};
        },
      },
    },
  });
  check(
    "pending admin cancel blocked",
    pendingCancel.ok === false &&
      pendingCancel.error === "REAL_STRIPE_SUBSCRIPTION_ID_MISSING" &&
      pendingStripeMutated === false,
    JSON.stringify(pendingCancel),
  );
  await store.revokeAnnualMembershipTerm(pendingTerm.membership.id, {
    reason: "db_proof_pending_guard_cleanup",
  });

  let realStripeUpdate = false;
  const realCancelEligible = await adminCancelAnnualRenewal(tempMembershipId, {
    stripe: {
      subscriptions: {
        retrieve: async (id) => ({
          id,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        }),
        update: async (id, patch) => {
          realStripeUpdate = patch.cancel_at_period_end === true;
          return {
            id,
            status: "active",
            cancel_at_period_end: true,
            cancel_at: null,
            current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          };
        },
      },
    },
  });
  check(
    "real sub admin cancel eligible",
    realCancelEligible.ok === true && realStripeUpdate === true,
    JSON.stringify(realCancelEligible),
  );

  const alreadyCanceled = await adminCancelAnnualRenewal(tempMembershipId, {
    stripe: {
      subscriptions: {
        retrieve: async (id) => ({
          id,
          status: "active",
          cancel_at_period_end: true,
          cancel_at: null,
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        }),
        update: async () => {
          throw new Error("stripe_update_should_not_run");
        },
      },
    },
  });
  check(
    "cancel_at_period_end active subscription treated as renewal canceled",
    alreadyCanceled.ok === true &&
      alreadyCanceled.idempotent === true &&
      alreadyCanceled.stripe?.cancelAtPeriodEnd === true &&
      alreadyCanceled.stripe?.status === "active",
    JSON.stringify(alreadyCanceled),
  );

  try {
    await stripe.subscriptions.cancel(created.subscriptionId);
    report.stripeSubscriptionCanceled = true;
  } catch (err) {
    report.stripeSubscriptionCanceled = false;
    report.stripeCancelError = String(/** @type {{ message?: string }} */ (err)?.message ?? err);
  }

  const revoke = await adminRevokeAnnualTerm(tempMembershipId, { confirmStop: "STOP" });
  check("temp term revoked", revoke.ok === true, JSON.stringify(revoke));
  const afterRevoke = await annualMembershipQuery(
    `SELECT status FROM annual_memberships WHERE id = $1::uuid`,
    [tempMembershipId],
  );
  const skipped = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n
       FROM annual_membership_periods
      WHERE annual_membership_id = $1::uuid AND status = 'skipped'`,
    [tempMembershipId],
  );
  const pendingAfter = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n
       FROM annual_membership_periods
      WHERE annual_membership_id = $1::uuid AND status = 'pending'`,
    [tempMembershipId],
  );
  check(
    "temp term cleanup revoked + all unissued periods skipped",
    afterRevoke.rows[0]?.status === "revoked" &&
      Number(skipped.rows[0]?.n) === 12 &&
      Number(pendingAfter.rows[0]?.n) === 0,
    JSON.stringify({
      status: afterRevoke.rows[0]?.status,
      skipped: skipped.rows[0]?.n,
      pending: pendingAfter.rows[0]?.n,
    }),
  );

  await assertRevokedTermsUntouched();

  report.finishedAt = new Date().toISOString();
  report.failedChecks = failed;
  const outPath = path.join(root, "scripts/qa-annual-sub-persistence-db-proof-output.json");
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  if (failed) {
    console.error(`\n${failed} failure(s). Evidence: ${outPath}`);
    process.exit(1);
  }
  console.log(`\nDB-backed sub_* persistence proof passed. Evidence: ${outPath}`);
}

main().catch((err) => {
  report.error = String(/** @type {{ message?: string }} */ (err)?.message ?? err);
  report.failedChecks = failed + 1;
  const outPath = path.join(root, "scripts/qa-annual-sub-persistence-db-proof-output.json");
  try {
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* ignore */
  }
  console.error(err);
  process.exit(1);
});
