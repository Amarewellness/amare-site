/**
 * invoice.paid retry / recovery behavior for monthly memberships.
 *
 * Drives the real `handleInvoicePaid` (memory subscription store, fake Stripe, fake Mindbody cart)
 * and checks that retryable failures are not acknowledged with 2xx, that every retry path is
 * idempotent per invoice, and that abandoned claims / pre-request failures recover without a
 * second Mindbody sale.
 *
 * Run: node scripts/qa-webhook-invoice-retry.mjs
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.NODE_ENV = "test";

import { __testing, invoicePaidHttpStatus } from "../netlify/functions/stripe-webhook.mjs";
import { openSubscriptionStore, resetSubscriptionStoreMemoryForTests } from "../netlify/functions/stripe-subscription-store.mjs";
import { executeMonthlyRenewalSync, monthlyInvoicePaidAction } from "../netlify/functions/stripe-monthly-period-sync.mjs";
import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL — ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  }
}

const RECORD_ID = "sub_amare_RETRYTEST0000001";
const STRIPE_SUB = "sub_RETRYTEST1";
const INVOICE_ID = "in_RETRYTEST0001";
const LIVE = { stripeLivemode: true, behavior: "live", mindbodyTest: false };

function invoice(overrides = {}) {
  return {
    id: INVOICE_ID,
    object: "invoice",
    subscription: STRIPE_SUB,
    billing_reason: "subscription_cycle",
    status: "paid",
    amount_paid: 12500,
    subtotal: 12500,
    total: 12500,
    currency: "usd",
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    lines: { data: [{ amount: 12500, proration: false, period: { start: 1, end: 2 } }] },
    ...overrides,
  };
}

async function setup() {
  resetSubscriptionStoreMemoryForTests();
  const subStore = openSubscriptionStore();
  const m5 = getCatalogItem("monthly_5");
  await subStore.put({
    id: RECORD_ID,
    stripeSubscriptionId: STRIPE_SUB,
    stripeCustomerId: "cus_RETRY",
    stripeCheckoutSessionId: "cs_retry",
    localSku: "monthly_5",
    displayName: m5.displayName,
    monthlyAmountCents: m5.amountCents,
    currency: "usd",
    mindbodyClientId: 100009001,
    mindbodyServiceId: m5.mindbodyServiceId,
    mindbodyContractProductId: m5.mindbodyContractProductId,
    status: "active",
    invoices: [],
  });
  await subStore.bindStripeSubscription(STRIPE_SUB, RECORD_ID);
  const state = { retrieveFails: 0, carts: 0, sales: 0, cartResults: /** @type {any[]} */ ([]) };
  const stripe = {
    invoices: {
      async retrieve() {
        if (state.retrieveFails > 0) {
          state.retrieveFails -= 1;
          throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
        }
        return invoice();
      },
    },
    subscriptions: { async retrieve() { return { id: STRIPE_SUB, metadata: {} }; } },
  };
  __testing.setMonthlySyncIo({
    async syncFn() {
      state.carts += 1;
      const next = state.cartResults.shift() || { ok: true, mindbodySaleId: `SALE_${state.carts}` };
      if (next.ok && next.mindbodySaleId) state.sales += 1;
      await new Promise((r) => setTimeout(r, 5));
      return next;
    },
  });
  return { subStore, stripe, state };
}

async function deliver(env) {
  const outcome = await __testing.handleInvoicePaid(env.stripe, invoice(), env.subStore, LIVE, { sourceEventId: "evt_test" });
  return { outcome, http: invoicePaidHttpStatus(outcome) };
}

async function entry(env) {
  const r = await env.subStore.get(RECORD_ID);
  return (r.invoices || []).find((e) => e.invoiceId === INVOICE_ID) || null;
}

/* ------------------------------------------------------------ HTTP mapping */

check("retryable failure → 503 (Stripe redelivers)", invoicePaidHttpStatus({ ok: false, retryable: true, status: "claim_in_progress" }) === 503);
check("success → 200", invoicePaidHttpStatus({ ok: true, status: "synced" }) === 200);
check("terminal non-retryable → 200", invoicePaidHttpStatus({ ok: true, status: "mindbody_sale_uncertain" }) === 200);
check("noop redelivery → 200", invoicePaidHttpStatus({ ok: true, status: "synced", noop: true }) === 200);

/* ------------------------------------------------------------ scenarios */

{
  const env = await setup();
  const first = await deliver(env);
  const second = await deliver(env);
  check("normal renewal: one sale, 200", first.http === 200 && first.outcome.status === "synced" && env.state.sales === 1);
  check("redelivery of synced invoice: noop, no second sale", second.http === 200 && second.outcome.noop === true && env.state.carts === 1);
}

{
  const env = await setup();
  env.state.retrieveFails = 1;
  const first = await deliver(env);
  check("Stripe read failure after claim → 503", first.http === 503 && first.outcome.status === "stripe_retrieve_failed", first.outcome);
  check("no cart sent before the retry", env.state.carts === 0 && !(await entry(env)));
  const second = await deliver(env);
  check("redelivery recovers (claim was released) with exactly one sale", second.http === 200 && second.outcome.status === "synced" && env.state.sales === 1, second.outcome);
}

{
  const env = await setup();
  const realClaim = env.subStore.claimInvoiceSlot;
  env.subStore.claimInvoiceSlot = async () => ({ ok: false, reason: "store_unavailable" });
  const first = await deliver(env);
  env.subStore.claimInvoiceSlot = realClaim;
  check("claim store outage → 503, nothing written", first.http === 503 && first.outcome.status === "claim_store_unavailable" && !(await entry(env)));
  const second = await deliver(env);
  check("redelivery after outage → one sale", second.outcome.status === "synced" && env.state.sales === 1);
}

{
  const env = await setup();
  env.state.cartResults.push({ ok: false, reason: "staff_headers_unavailable" });
  const first = await deliver(env);
  const row = await entry(env);
  check("pre-request Mindbody failure → 503", first.http === 503, first.outcome);
  check(
    "pre-request failure recorded as retryable with no cart sent",
    row?.status === "paid_but_not_synced" && row.retryOnRedelivery === true && !row.checkoutRequestSentAt && !row.mindbodySaleId,
    row,
  );
  check("pre-request row retries on redelivery", monthlyInvoicePaidAction(row) === "sync");
  const second = await deliver(env);
  check("redelivery syncs once", second.http === 200 && second.outcome.status === "synced" && env.state.sales === 1, second.outcome);
  const third = await deliver(env);
  check("further redelivery is a noop", third.outcome.noop === true && env.state.sales === 1);
}

{
  const env = await setup();
  env.state.cartResults.push({ ok: false, reason: "mindbody_sync_timeout" });
  const first = await deliver(env);
  const row = await entry(env);
  check("timeout after cart sent → uncertain, acknowledged (admin path)", first.http === 200 && row?.status === "mindbody_sale_uncertain" && !!row.checkoutRequestSentAt);
  await deliver(env);
  await deliver(env);
  check("redeliveries never post a second cart after an uncertain send", env.state.carts === 1 && env.state.sales === 0);
}

{
  const env = await setup();
  const results = await Promise.all([deliver(env), deliver(env), deliver(env)]);
  check("three concurrent deliveries → exactly one sale", env.state.sales === 1 && env.state.carts === 1, results.map((r) => r.outcome.status));
  check("concurrent losers are retried or deduped, never double-sold", results.every((r) => r.http === 200 || r.http === 503));
}

{
  const env = await setup();
  const claim = await env.subStore.claimInvoiceSlot(RECORD_ID, INVOICE_ID, {});
  check("simulated abandoned claim held", claim.acquired === true);
  const fresh = await deliver(env);
  check("fresh claim with no record → 503 claim_in_progress", fresh.http === 503 && fresh.outcome.status === "claim_in_progress" && env.state.carts === 0);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  let late;
  try {
    late = await deliver(env);
  } finally {
    Date.now = realNow;
  }
  check("abandoned claim (>10 min, no record) is taken over → one sale", late.outcome.status === "synced" && env.state.sales === 1, late.outcome);
}

{
  const env = await setup();
  const claim = await env.subStore.claimInvoiceSlot(RECORD_ID, INVOICE_ID, {});
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    const [a, b] = await Promise.all([
      env.subStore.takeOverStaleInvoiceClaim(RECORD_ID, INVOICE_ID, { staleMs: 10 * 60 * 1000 }),
      env.subStore.takeOverStaleInvoiceClaim(RECORD_ID, INVOICE_ID, { staleMs: 10 * 60 * 1000 }),
    ]);
    check("two concurrent takeovers → exactly one wins", claim.acquired && [a.acquired, b.acquired].filter(Boolean).length === 1, { a, b });
  } finally {
    Date.now = realNow;
  }
}

{
  const env = await setup();
  await env.subStore.claimInvoiceSlot(RECORD_ID, INVOICE_ID, {});
  await env.subStore.appendInvoiceSync(RECORD_ID, {
    invoiceId: INVOICE_ID,
    amountPaidCents: 12500,
    currency: "usd",
    paidAt: new Date().toISOString(),
    status: "paid_but_not_synced",
    mindbodySaleId: null,
    mindbodyTransactionId: null,
    retryCount: 0,
    firstAttemptAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastError: "catalog_sku_missing",
    adminRetryRequired: true,
  });
  const redelivery = await deliver(env);
  check("legacy paid_but_not_synced stays admin-only on redelivery", redelivery.http === 200 && redelivery.outcome.noop === true && env.state.carts === 0);
  const record = await env.subStore.get(RECORD_ID);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 1000;
  let outcome;
  try {
    outcome = await executeMonthlyRenewalSync({
      subStore: env.subStore,
      record,
      invoice: { id: INVOICE_ID, currency: "usd" },
      existingEntry: await entry(env),
      item: getCatalogItem("monthly_5"),
      retrieveInvoice: async () => invoice(),
      syncFn: async () => {
        env.state.carts += 1;
        env.state.sales += 1;
        return { ok: true, mindbodySaleId: "ADMIN_SALE" };
      },
      claimAlreadyAcquired: false,
      lostClaim: false,
      adminRetry: true,
    });
  } finally {
    Date.now = realNow;
  }
  check("admin retry recovers paid_but_not_synced (no cart had been sent)", outcome.status === "synced" && env.state.sales === 1, outcome);
  const again = await executeMonthlyRenewalSync({
    subStore: env.subStore,
    record: await env.subStore.get(RECORD_ID),
    invoice: { id: INVOICE_ID, currency: "usd" },
    existingEntry: await entry(env),
    item: getCatalogItem("monthly_5"),
    retrieveInvoice: async () => invoice(),
    syncFn: async () => {
      env.state.carts += 1;
      return { ok: true, mindbodySaleId: "SHOULD_NOT" };
    },
    adminRetry: true,
  });
  check("second admin retry is a noop", again.noop === true && env.state.carts === 1);
}

{
  const env = await setup();
  await env.subStore.appendInvoiceSync(RECORD_ID, {
    invoiceId: INVOICE_ID,
    amountPaidCents: 12500,
    currency: "usd",
    paidAt: new Date().toISOString(),
    status: "paid_but_not_synced",
    mindbodySaleId: null,
    mindbodyTransactionId: null,
    checkoutRequestSentAt: new Date().toISOString(),
    retryCount: 2,
    firstAttemptAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastError: "mindbody_5xx",
    adminRetryRequired: true,
  });
  const outcome = await executeMonthlyRenewalSync({
    subStore: env.subStore,
    record: await env.subStore.get(RECORD_ID),
    invoice: { id: INVOICE_ID, currency: "usd" },
    existingEntry: await entry(env),
    item: getCatalogItem("monthly_5"),
    retrieveInvoice: async () => invoice(),
    syncFn: async () => {
      env.state.carts += 1;
      return { ok: true, mindbodySaleId: "DUPLICATE" };
    },
    adminRetry: true,
  });
  check("admin retry never re-posts a cart that may have been sent", outcome.status === "mindbody_sale_uncertain" && env.state.carts === 0, outcome);
}

{
  const env = await setup();
  await env.subStore.patch(RECORD_ID, { pendingPlanChange: { operationId: "op1", toSku: "monthly_8", effectiveAt: new Date(0).toISOString() } });
  env.stripe.subscriptions.retrieve = async () => ({ id: STRIPE_SUB, metadata: { localSku: "monthly_8" } });
  const realPatch = env.subStore.patch;
  env.subStore.patch = async () => null;
  let threw = false;
  try {
    await deliver(env);
  } catch {
    threw = true;
  }
  env.subStore.patch = realPatch;
  check("pending plan-change write failure throws (route answers 500 → Stripe retries)", threw && env.state.carts === 0);
}

__testing.setMonthlySyncIo(null);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
