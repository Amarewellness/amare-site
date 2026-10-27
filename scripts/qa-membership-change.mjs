/**
 * Admin Change Membership — policy, service, webhook hook and API tests.
 * Memory subscription store + memory ledger + fake Stripe + fake Mindbody.
 * No network, no real Stripe/Mindbody/Blobs/Postgres writes.
 *
 * Run: node scripts/qa-membership-change.mjs
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.NODE_ENV = "test";

import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import {
  openSubscriptionStore,
  resetSubscriptionStoreMemoryForTests,
} from "../netlify/functions/stripe-subscription-store.mjs";
import { executeMonthlyRenewalSync } from "../netlify/functions/stripe-monthly-period-sync.mjs";
import { createMemoryMembershipChangeStore } from "../netlify/functions/membership-change-store.mjs";
import {
  allowedPoliciesForDirection,
  changeDirection,
  matchPendingPlanChangeToInvoice,
  signPreviewToken,
  verifyPreviewToken,
} from "../netlify/functions/membership-change-lib.mjs";
import { createMembershipChangeService } from "../netlify/functions/membership-change-service.mjs";
import { applyPendingPlanChangeOnInvoicePaid } from "../netlify/functions/membership-change-webhook.mjs";
import { hashBillingKey, RATE_LIMIT } from "../netlify/functions/membership-change-auth.mjs";
import { createMemoryBillingAuthStore } from "../netlify/functions/membership-billing-auth-store.mjs";
import { createMembershipChangeAdminHandler } from "../netlify/functions/membership-change-admin.mjs";
import { createAdminLoginHandler } from "../netlify/functions/admin-login.mjs";
import { ADMIN_SESSION_COOKIE, issueSessionMaterial } from "../netlify/functions/membership-admin-session.mjs";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL — ${name}${detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  }
}

const M5 = getCatalogItem("monthly_5");
const M8 = getCatalogItem("monthly_8");
const UNL = getCatalogItem("monthly_unlimited");
const DAY = 24 * 60 * 60;
const RECORD_ID = "sub_amare_TESTCHANGE0000001";
const SECRET = "test-preview-secret-0123456789abcdef";

/* ------------------------------------------------------------------ fakes */

/** @param {string} sku */
function productIdFor(sku) {
  return `prod${sku.replace(/_/g, "")}`.replace(/^prod/, "prod_");
}

/** @param {{ sku: string, unitAmount?: number, daysIntoPeriod?: number, missingProducts?: string[] }} opts */
function createFakeStripe(opts) {
  const plan = getCatalogItem(opts.sku);
  const nowSec = () => Math.floor(Date.now() / 1000) + Math.floor(clock.offsetMs / 1000);
  const periodStart = nowSec() - (opts.daysIntoPeriod ?? 10) * DAY;
  const products = ["monthly_5", "monthly_8", "monthly_unlimited"]
    .filter((s) => !(opts.missingProducts || []).includes(s))
    .map((s) => ({ id: productIdFor(s), active: true, livemode: true, created: 1, metadata: { localSku: s } }));
  const state = {
    sub: {
      id: "sub_TESTCHANGE1",
      object: "subscription",
      status: "active",
      livemode: true,
      customer: "cus_TEST1",
      default_payment_method: "pm_TEST1",
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: null,
      pause_collection: null,
      pending_update: null,
      discounts: [],
      latest_invoice: "in_prev",
      metadata: { localSku: opts.sku, subscriptionId: RECORD_ID, membershipConsentId: "consent_1" },
      items: {
        data: [
          {
            id: "si_TEST1",
            quantity: 1,
            current_period_start: periodStart,
            current_period_end: periodStart + 30 * DAY,
            price: {
              id: "price_checkout_current",
              product: "prod_checkoutInactive",
              unit_amount: opts.unitAmount ?? plan.amountCents,
              recurring: { interval: "month" },
            },
          },
        ],
      },
    },
    products,
    invoices: new Map(),
    openInvoices: /** @type {any[]} */ ([]),
    pendingInvoiceItems: /** @type {any[]} */ ([]),
    schedules: new Map(),
    updateBehavior: /** @type {string | null} */ (null),
    scheduleUpdateFails: false,
    updateCalls: 0,
    idem: new Map(),
    seq: 0,
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function previewLines(params) {
    const item = state.sub.items.data[0];
    const pd = params.items[0].price_data;
    const now = nowSec();
    const lines = [];
    if (params.proration_behavior === "always_invoice") {
      const total = item.current_period_end - item.current_period_start;
      const remaining = Math.max(0, item.current_period_end - now);
      lines.push({
        description: "Unused time on current plan",
        amount: -Math.round((item.price.unit_amount * remaining) / total),
        proration: true,
        pricing: { price_details: { product: item.price.product, price: item.price.id } },
        period: { start: now, end: item.current_period_end },
      });
    }
    lines.push({
      description: "1 × New plan",
      amount: pd.unit_amount,
      proration: false,
      pricing: { price_details: { product: pd.product, price: "price_preview" } },
      period: { start: now, end: now + 30 * DAY },
    });
    for (const extra of state.pendingInvoiceItems) lines.push(extra);
    return lines;
  }

  function invoiceFrom(lines, reason) {
    const total = lines.reduce((s, l) => s + l.amount, 0);
    return { amount_due: Math.max(0, total), subtotal: total, total, starting_balance: 0, billing_reason: reason, lines: { data: lines } };
  }

  function applyUpdate(params) {
    const item = state.sub.items.data[0];
    const pd = params.items[0].price_data;
    const lines = previewLines(params);
    const inv = invoiceFrom(lines, "subscription_update");
    state.seq += 1;
    const invoice = { id: `in_change_${state.seq}`, status: "paid", amount_paid: inv.amount_due, ...inv, currency: "usd" };
    state.invoices.set(invoice.id, invoice);
    const now = nowSec();
    item.price = { id: `price_new_${state.seq}`, product: pd.product, unit_amount: pd.unit_amount, recurring: { interval: "month" } };
    item.current_period_start = now;
    item.current_period_end = now + 30 * DAY;
    state.sub.metadata = { ...params.metadata };
    state.sub.latest_invoice = invoice.id;
    if (params.default_payment_method) state.sub.default_payment_method = params.default_payment_method;
  }

  function stripeError(type, message, extra = {}) {
    return Object.assign(new Error(message), { type, ...extra });
  }

  const api = {
    state,
    subscriptions: {
      async retrieve(id, o = {}) {
        if (state.retrieveFails) throw stripeError("StripeConnectionError", "connection reset");
        const s = clone(state.sub);
        if ((o.expand || []).includes("latest_invoice") && state.invoices.has(s.latest_invoice)) {
          s.latest_invoice = clone(state.invoices.get(s.latest_invoice));
        }
        return s;
      },
      async update(id, params, reqOpts = {}) {
        const key = reqOpts.idempotencyKey;
        if (key && state.idem.has(key)) return state.idem.get(key);
        state.updateCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        const b = state.updateBehavior;
        if (b === "decline") {
          throw stripeError("StripeCardError", "Your card has insufficient funds.", { code: "card_declined", decline_code: "insufficient_funds" });
        }
        if (b === "3ds") {
          throw stripeError("StripeCardError", "This payment requires authentication.", { code: "authentication_required", decline_code: "authentication_required" });
        }
        if (b === "invalid") throw stripeError("StripeInvalidRequestError", "Invalid price_data");
        if (b === "timeout_not_applied") throw stripeError("StripeConnectionError", "Request timed out");
        applyUpdate(params);
        if (b === "timeout_applied") throw stripeError("StripeConnectionError", "Request timed out");
        const out = await api.subscriptions.retrieve(id, { expand: ["latest_invoice"] });
        if (key) state.idem.set(key, out);
        return out;
      },
    },
    invoices: {
      async list(p) {
        return { data: p.status === "open" ? state.openInvoices : [] };
      },
      async retrieve(id) {
        return clone(state.invoices.get(id));
      },
      async createPreview(p) {
        return invoiceFrom(previewLines(p.subscription_details), "subscription_update");
      },
    },
    products: {
      async search({ query }) {
        const sku = /metadata\['localSku'\]:'([a-z0-9_]+)'/.exec(query)?.[1];
        return { data: state.products.filter((p) => p.active && p.metadata.localSku === sku) };
      },
      async create(params) {
        const p = { id: `${productIdFor(params.metadata.localSku)}Created`, active: true, livemode: true, created: 2, metadata: params.metadata };
        state.products.push(p);
        return p;
      },
    },
    customers: {
      async retrieve() {
        return { id: "cus_TEST1", invoice_settings: { default_payment_method: null } };
      },
    },
    paymentMethods: {
      async list() {
        return { data: [{ id: "pm_saved_card" }] };
      },
    },
    subscriptionSchedules: {
      async create({ from_subscription }) {
        const item = state.sub.items.data[0];
        state.seq += 1;
        const sch = {
          id: `sub_sched_${state.seq}`,
          status: "active",
          subscription: from_subscription,
          phases: [{ start_date: item.current_period_start, end_date: item.current_period_end, items: [{ price: item.price.id, quantity: 1 }] }],
        };
        state.schedules.set(sch.id, sch);
        state.sub.schedule = sch.id;
        return clone(sch);
      },
      async update(id, params) {
        if (state.scheduleUpdateFails) throw stripeError("StripeInvalidRequestError", "phase invalid");
        const sch = state.schedules.get(id);
        sch.phases = clone(params.phases);
        sch.end_behavior = params.end_behavior;
        return clone(sch);
      },
      async release(id) {
        const sch = state.schedules.get(id);
        sch.status = "released";
        state.sub.schedule = null;
        return clone(sch);
      },
      async retrieve(id) {
        return clone(state.schedules.get(id));
      },
    },
    /** Simulate Stripe moving to the next schedule phase at renewal and paying the renewal invoice. */
    renew() {
      const item = state.sub.items.data[0];
      const sch = state.sub.schedule ? state.schedules.get(state.sub.schedule) : null;
      const next = sch?.phases?.[1];
      if (next) {
        const pd = next.items[0].price_data;
        item.price = { id: "price_phase1", product: pd.product, unit_amount: pd.unit_amount, recurring: { interval: "month" } };
        state.sub.metadata = { ...next.metadata };
        sch.status = "released";
        state.sub.schedule = null;
      }
      const start = item.current_period_end;
      item.current_period_start = start;
      item.current_period_end = start + 30 * DAY;
      state.seq += 1;
      const invoice = {
        id: `in_renewal_${state.seq}`,
        status: "paid",
        amount_paid: item.price.unit_amount,
        currency: "usd",
        billing_reason: "subscription_cycle",
        lines: { data: [{ amount: item.price.unit_amount, proration: false, period: { start, end: start + 30 * DAY } }] },
      };
      state.invoices.set(invoice.id, invoice);
      state.sub.latest_invoice = invoice.id;
      return clone(invoice);
    },
  };
  return api;
}

const clock = { offsetMs: 0 };

function createFakeMindbody(opts = {}) {
  const state = {
    down: false,
    rows: [
      {
        Id: 500,
        ProductId: opts.serviceId,
        Name: "current package",
        Remaining: opts.remaining ?? 0,
        PaymentDate: "2026-01-01T00:00:00",
        Current: true,
      },
    ],
    visits: opts.visits ?? [],
    consentContract: opts.consentContract ?? null,
    retryCalls: 0,
  };
  return {
    state,
    io: {
      async clientServices() {
        return state.down ? null : state.rows;
      },
      async futureVisits() {
        return state.down ? null : state.visits;
      },
      async consentContractProductId() {
        return state.consentContract;
      },
      async retryInvoiceSync(record, invoiceId) {
        state.retryCalls += 1;
        const store = openSubscriptionStore();
        await store.updateInvoiceSync(record.id, invoiceId, { status: "synced", mindbodySaleId: "SALE_RETRY", adminRetryRequired: false });
        state.rows.push({ Id: 777, ProductId: getCatalogItem(record.localSku).mindbodyServiceId, PaymentDate: new Date().toISOString(), Current: true });
        return { status: "synced" };
      },
    },
  };
}

/**
 * @param {{ sku: string, unitAmount?: number, remaining?: number, visits?: any[], consentContract?: string | null, daysIntoPeriod?: number, missingProducts?: string[], recordStatus?: string }} opts
 */
async function setup(opts) {
  resetSubscriptionStoreMemoryForTests();
  clock.offsetMs = 0;
  const subStore = openSubscriptionStore();
  const plan = getCatalogItem(opts.sku);
  const stripe = createFakeStripe(opts);
  await subStore.put({
    id: RECORD_ID,
    stripeSubscriptionId: stripe.state.sub.id,
    stripeCustomerId: "cus_TEST1",
    stripeCheckoutSessionId: "cs_test_change",
    localSku: plan.localSku,
    displayName: plan.displayName,
    monthlyAmountCents: plan.amountCents,
    currency: "usd",
    mindbodyClientId: 100009999,
    mindbodyServiceId: plan.mindbodyServiceId,
    mindbodyContractProductId: plan.mindbodyContractProductId,
    minimumCommitmentMonths: 3,
    earlyCancellationFeePercent: 50,
    commitmentStartDate: "2026-10-01T00:00:00.000Z",
    commitmentEndDate: "2027-01-01T00:00:00.000Z",
    earlyCancellationFeeCents: Math.round(plan.amountCents / 2),
    membershipConsentId: "consent_1",
    agreementVersion: "v-test",
    agreementTextHash: "hash_test",
    status: opts.recordStatus || "active",
    invoices: [],
    customerEmail: "member@example.com",
    customerName: "Test Member",
  });
  const mb = createFakeMindbody({
    serviceId: plan.mindbodyServiceId,
    remaining: opts.remaining,
    visits: opts.visits,
    consentContract: opts.consentContract === undefined ? null : opts.consentContract,
  });
  const ledger = createMemoryMembershipChangeStore();
  const service = createMembershipChangeService({
    stripe,
    subStore,
    ledger,
    io: mb.io,
    previewSecret: SECRET,
    now: () => Date.now() + clock.offsetMs,
    sleep: async () => {},
    syncWaitMs: 0,
    log: () => {},
  });
  return { subStore, stripe, mb, ledger, service };
}

const ALL_ACKS = {
  grandfathered_price: true,
  subscription_discount_present: true,
  target_agreement_not_on_file: true,
  future_bookings_after_effective: true,
  unused_credits_with_stripe_credit: true,
};

/** Simulate the production `invoice.paid` path: pending-change hook, then the shared Mindbody sync. */
async function simulateInvoicePaid(env, invoiceId, syncResult) {
  const invoice = await env.stripe.invoices.retrieve(invoiceId);
  let record = await env.subStore.get(RECORD_ID);
  if (record.pendingPlanChange) {
    record = (await applyPendingPlanChangeOnInvoicePaid({ stripe: env.stripe, subStore: env.subStore, record, invoice })).record;
  }
  /** @type {any} */
  let syncInput = null;
  const outcome = await executeMonthlyRenewalSync({
    subStore: env.subStore,
    record,
    invoice,
    existingEntry: (record.invoices || []).find((e) => e.invoiceId === invoiceId) || null,
    item: getCatalogItem(record.localSku),
    retrieveInvoice: async () => invoice,
    syncFn: async (input) => {
      syncInput = input;
      return syncResult || { ok: true, mindbodySaleId: `SALE_${invoiceId}`, mindbodyClientServiceId: `CS_${invoiceId}` };
    },
    claimAlreadyAcquired: true,
    lostClaim: false,
  });
  if (outcome.status === "synced") {
    env.mb.state.rows.push({
      Id: 900 + env.mb.state.rows.length,
      ProductId: getCatalogItem(record.localSku).mindbodyServiceId,
      PaymentDate: new Date(Date.now() + clock.offsetMs).toISOString(),
      Current: true,
      Remaining: record.localSku === "monthly_unlimited" ? 99999 : 5,
    });
  }
  return { outcome, syncInput, record };
}

async function previewAndExecute(env, toSku, policy, extra = {}) {
  const preview = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku, policy });
  if (!preview.ok) return { preview, result: null, error: null };
  try {
    const result = await env.service.execute({
      previewToken: preview.previewToken,
      confirmAmountCents: preview.billing.chargeTodayCents,
      requestId: extra.requestId || `req_${toSku}_${policy}_${Math.random().toString(36).slice(2, 12)}`,
      actor: { id: "owner1", role: "owner" },
      acknowledgements: extra.acknowledgements ?? ALL_ACKS,
    });
    return { preview, result, error: null };
  } catch (error) {
    return { preview, result: null, error };
  }
}

/* ------------------------------------------------------------------ policy */

check("direction from catalog prices: M5 → M8 upgrade", changeDirection("monthly_5", "monthly_8") === "upgrade");
check("direction: Unlimited → M5 downgrade", changeDirection("monthly_unlimited", "monthly_5") === "downgrade");
check("direction: unsupported SKU is null", changeDirection("annual_monthly_5", "monthly_8") === null);
check(
  "downgrades only allow scheduled change",
  JSON.stringify(allowedPoliciesForDirection("downgrade")) === JSON.stringify(["scheduled_no_charge"]),
);
check("upgrades allow immediate and scheduled", allowedPoliciesForDirection("upgrade").length === 3);

{
  const now = Date.now();
  const tok = signPreviewToken({ sid: RECORD_ID, amountDueCents: 100, exp: now + 1000 }, SECRET);
  check("preview token verifies", verifyPreviewToken(tok, SECRET, now).ok === true);
  const [body, sig] = tok.split(".");
  const tampered = Buffer.from(JSON.stringify({ v: 1, sid: RECORD_ID, amountDueCents: 1, exp: now + 1000 })).toString("base64url");
  check("tampered preview token rejected", verifyPreviewToken(`${tampered}.${sig}`, SECRET, now).ok === false);
  check("expired preview token rejected", verifyPreviewToken(tok, SECRET, now + 5000).reason === "expired");
  check("wrong secret rejected", verifyPreviewToken(`${body}.${sig}`, "another-secret-0123456789", now).ok === false);
}

{
  const eff = "2026-11-08T21:25:12.000Z";
  const effSec = Date.parse(eff) / 1000;
  const pending = { toSku: "monthly_5", effectiveAt: eff, operationId: "op1" };
  const renewal = (amount, start = effSec, reason = "subscription_cycle") => ({
    billing_reason: reason,
    lines: { data: [{ amount, proration: false, period: { start, end: start + 30 * DAY } }] },
  });
  check("pending match: renewal at target amount", matchPendingPlanChangeToInvoice({ pending, invoice: renewal(M5.amountCents) }).apply === true);
  check(
    "pending match: renewal still at old amount is not applied",
    matchPendingPlanChangeToInvoice({ pending, invoice: renewal(UNL.amountCents) }).apply === false,
  );
  check(
    "pending match: subscription_update invoice ignored",
    matchPendingPlanChangeToInvoice({ pending, invoice: renewal(M5.amountCents, effSec, "subscription_update") }).apply === false,
  );
  check(
    "pending match: renewal before effective date ignored",
    matchPendingPlanChangeToInvoice({ pending, invoice: renewal(M5.amountCents, effSec - 30 * DAY) }).apply === false,
  );
  check(
    "pending match: subscription metadata alone suffices (discounted line)",
    matchPendingPlanChangeToInvoice({ pending, invoice: renewal(9999), subscriptionMetadataSku: "monthly_5" }).apply === true,
  );
}

/* ------------------------------------------------------------------ immediate upgrades */

{
  const env = await setup({ sku: "monthly_5" });
  const { preview, result, error } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  check("M5 → M8 no-credit preview charges full M8 price", preview.ok && preview.billing.chargeTodayCents === M8.amountCents, preview.billing);
  check("M5 → M8 preview: new cycle starts now, renews at M8 price", preview.billing.nextRenewalAmountCents === M8.amountCents && !!preview.billing.newPeriodEnd);
  check("M5 → M8 executes and waits for Mindbody", !error && result.operation.status === "syncing", error?.message || result?.operation);
  const rec = await env.subStore.get(RECORD_ID);
  check("record switched to M8 before invoice sync", rec.localSku === "monthly_8" && rec.mindbodyServiceId === M8.mindbodyServiceId && !rec.planChangeInFlight);
  const sim = await simulateInvoicePaid(env, result.operation.stripeInvoiceId);
  check("webhook sync issues M8 service, not M5", sim.syncInput?.item?.mindbodyServiceId === M8.mindbodyServiceId && sim.syncInput?.localSku === "monthly_8");
  const status = await env.service.getOperationStatus(result.operation.id);
  check("M5 → M8 completed after payment + Mindbody verified", status.status === "completed" && !!status.mindbodySaleId, status);
  check("Stripe update called exactly once", env.stripe.state.updateCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  const { preview, result } = await previewAndExecute(env, "monthly_unlimited", "new_cycle_no_credit");
  check("M5 → Unlimited no-credit preview = $229 catalog price", preview.billing.chargeTodayCents === UNL.amountCents);
  check("no credit lines in no-credit preview", preview.billing.creditCents === 0 && preview.billing.lines.every((l) => l.kind === "target_plan"));
  await simulateInvoicePaid(env, result.operation.stripeInvoiceId);
  const status = await env.service.getOperationStatus(result.operation.id);
  check("M5 → Unlimited completed", status.status === "completed");
  const rec = await env.subStore.get(RECORD_ID);
  check("commitment end preserved", rec.commitmentEndDate === "2027-01-01T00:00:00.000Z" && rec.commitmentStartDate === "2026-10-01T00:00:00.000Z");
  check("consent pointer and agreement hash preserved", rec.membershipConsentId === "consent_1" && rec.agreementTextHash === "hash_test");
  check("plan change history recorded with actor", rec.planChangeHistory?.[0]?.actorId === "owner1" && rec.planChangeHistory[0].toSku === "monthly_unlimited");
  const stripeMeta = env.stripe.state.sub.metadata;
  check("Stripe metadata keeps consent id and switches SKU", stripeMeta.membershipConsentId === "consent_1" && stripeMeta.localSku === "monthly_unlimited");
  check("existing subscription item updated in place", env.stripe.state.sub.id === "sub_TESTCHANGE1" && env.stripe.state.sub.items.data[0].id === "si_TEST1");

  const renewal = env.stripe.renew();
  const renewSim = await simulateInvoicePaid(env, renewal.id);
  check("ordinary renewal after change syncs Unlimited at $229", renewSim.syncInput?.localSku === "monthly_unlimited" && renewSim.syncInput?.paidAmountCents === UNL.amountCents);
}

{
  const env = await setup({ sku: "monthly_8", remaining: 0 });
  const { preview, result, error } = await previewAndExecute(env, "monthly_unlimited", "new_cycle_with_credit", {
    acknowledgements: { ...ALL_ACKS, unused_credits_with_stripe_credit: false },
  });
  check("M8 → Unlimited with credit: credit line present", preview.ok && preview.billing.creditCents < 0, preview.billing);
  check(
    "with-credit charge = $229 minus Stripe credit",
    preview.billing.chargeTodayCents === UNL.amountCents + preview.billing.creditCents,
  );
  check("all credits consumed → no unused-credit acknowledgement needed", !error && result.operation.status === "syncing", error?.message);
}

{
  const env = await setup({ sku: "monthly_5", remaining: 3 });
  const { preview, error } = await previewAndExecute(env, "monthly_unlimited", "new_cycle_with_credit", { acknowledgements: {} });
  check("credits remaining + Stripe credit requires acknowledgement", preview.ackRequired.includes("unused_credits_with_stripe_credit"));
  check("execute without acknowledgement refused", error?.code === "acknowledgement_required", error?.code);
  check("refused execute did not touch Stripe", env.stripe.state.updateCalls === 0);
  const noCredit = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" });
  check("credits remaining with no-credit policy is informational", noCredit.warnings.some((w) => w.code === "unused_credits_remaining" && !w.ackRequired));
}

/* ------------------------------------------------------------------ payment failures */

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.updateBehavior = "decline";
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  check("declined card → payment_required", result.operation.status === "payment_required" && result.operation.errorCode === "payment_declined");
  const rec = await env.subStore.get(RECORD_ID);
  check("declined card → record restored to M5", rec.localSku === "monthly_5" && rec.mindbodyServiceId === M5.mindbodyServiceId && !rec.planChangeInFlight);
  check("declined card → Stripe price unchanged", env.stripe.state.sub.items.data[0].price.unit_amount === M5.amountCents);
  const again = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("lock released after payment failure", again.ok === true);
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.updateBehavior = "3ds";
  const { result } = await previewAndExecute(env, "monthly_unlimited", "new_cycle_no_credit");
  check("3DS required → payment_required with authentication message", result.operation.status === "payment_required" && result.operation.errorCode === "payment_requires_authentication");
  check("3DS → never reported as success", result.operation.status !== "completed" && result.operation.amountChargedCents == null);
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.updateBehavior = "timeout_applied";
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  check("timeout but Stripe applied → forward recovery to syncing", result.operation.status === "syncing" && !!result.operation.stripeInvoiceId);
  check("forward recovery keeps record on target plan", (await env.subStore.get(RECORD_ID)).localSku === "monthly_8");
  check("forward recovery did not re-send the update", env.stripe.state.updateCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.updateBehavior = "timeout_not_applied";
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  check("uncertain outcome → needs_reconciliation, lock held", result.operation.status === "needs_reconciliation");
  const blocked = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("uncertain operation blocks a second change", blocked.ok === false && blocked.blockers.some((b) => b.code === "operation_in_progress"));
  clock.offsetMs = 5 * 60 * 1000;
  const after = await env.service.getOperationStatus(result.operation.id);
  check("reconcile after grace: not applied → failed, nothing charged", after.status === "failed" && after.amountChargedCents == null, after);
  check("reconcile restored record to M5", (await env.subStore.get(RECORD_ID)).localSku === "monthly_5");
  check("reconcile never retried the Stripe update", env.stripe.state.updateCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.updateBehavior = "invalid";
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  check("Stripe validation error → failed + record restored", result.operation.status === "failed" && (await env.subStore.get(RECORD_ID)).localSku === "monthly_5");
}

/* ------------------------------------------------------------------ concurrency + idempotency */

{
  const env = await setup({ sku: "monthly_5" });
  const preview = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  const input = {
    previewToken: preview.previewToken,
    confirmAmountCents: preview.billing.chargeTodayCents,
    requestId: "req_duplicate_click_000001",
    actor: { id: "owner1", role: "owner" },
    acknowledgements: ALL_ACKS,
  };
  const first = await env.service.execute(input);
  const second = await env.service.execute(input);
  check("duplicate click returns the same operation", second.duplicate === true && second.operation.id === first.operation.id);
  check("duplicate click charged once", env.stripe.state.updateCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  const pa = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  const pb = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" });
  const run = (p, id, actor) =>
    env.service
      .execute({ previewToken: p.previewToken, confirmAmountCents: p.billing.chargeTodayCents, requestId: id, actor: { id: actor, role: "owner" }, acknowledgements: ALL_ACKS })
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  const [a, b] = await Promise.all([run(pa, "req_admin_a_00000000001", "owner1"), run(pb, "req_admin_b_00000000001", "owner2")]);
  const winners = [a, b].filter((x) => x.ok);
  const losers = [a, b].filter((x) => !x.ok);
  check("two admins at once: exactly one change proceeds", winners.length === 1 && losers.length === 1, { a: a.ok, b: b.ok });
  check(
    "two admins at once: loser gets a conflict, not a charge",
    ["operation_in_progress", "change_blocked", "stale_preview"].includes(losers[0]?.e?.code),
    losers[0]?.e?.code,
  );
  check("two admins at once: Stripe updated once", env.stripe.state.updateCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  const preview = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  env.stripe.state.sub.items.data[0].current_period_end += DAY;
  let err = null;
  try {
    await env.service.execute({ previewToken: preview.previewToken, confirmAmountCents: preview.billing.chargeTodayCents, requestId: "req_stale_preview_0001", actor: { id: "owner1", role: "owner" }, acknowledgements: ALL_ACKS });
  } catch (e) {
    err = e;
  }
  check("stale preview (subscription changed) rejected", err?.code === "stale_preview", err?.code);
  let err2 = null;
  const p2 = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  try {
    await env.service.execute({ previewToken: p2.previewToken, confirmAmountCents: p2.billing.chargeTodayCents + 100, requestId: "req_wrong_amount_0001", actor: { id: "owner1", role: "owner" }, acknowledgements: ALL_ACKS });
  } catch (e) {
    err2 = e;
  }
  check("confirmed amount must equal preview amount", err2?.code === "amount_not_confirmed");
  let err3 = null;
  clock.offsetMs = 11 * 60 * 1000;
  try {
    await env.service.execute({ previewToken: p2.previewToken, confirmAmountCents: p2.billing.chargeTodayCents, requestId: "req_expired_preview_01", actor: { id: "owner1", role: "owner" }, acknowledgements: ALL_ACKS });
  } catch (e) {
    err3 = e;
  }
  check("expired preview rejected", err3?.code === "preview_expired");
  check("no Stripe update for stale/expired previews", env.stripe.state.updateCalls === 0);
}

/* ------------------------------------------------------------------ scheduled downgrades */

{
  const env = await setup({ sku: "monthly_unlimited", visits: [] });
  const imm = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("Unlimited → M8 immediate is refused", imm.ok === false && imm.blockers.some((b) => b.code === "policy_not_allowed"));
  const { preview, result } = await previewAndExecute(env, "monthly_8", "scheduled_no_charge");
  check("Unlimited → M8 scheduled: nothing charged today", preview.ok && preview.billing.chargeTodayCents === 0);
  check("scheduled change → status scheduled with Stripe schedule", result.operation.status === "scheduled" && !!result.operation.stripeScheduleId);
  const rec = await env.subStore.get(RECORD_ID);
  check("scheduled change does NOT switch localSku early", rec.localSku === "monthly_unlimited" && rec.pendingPlanChange?.toSku === "monthly_8");
  const sch = env.stripe.state.schedules.get(result.operation.stripeScheduleId);
  check("schedule phase 0 keeps current price until period end", sch.phases[0].items[0].price === "price_checkout_current" && sch.phases[0].end_date === env.stripe.state.sub.items.data[0].current_period_end);
  check("schedule phase 1 uses catalog M8 price + product", sch.phases[1].items[0].price_data.unit_amount === M8.amountCents && sch.phases[1].items[0].price_data.product === productIdFor("monthly_8"));
  check("schedule releases after transition", sch.end_behavior === "release");

  const second = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_5", policy: "scheduled_no_charge" });
  check("pending schedule blocks another change", second.ok === false && second.blockers.some((b) => b.code === "operation_in_progress"));

  clock.offsetMs = Date.parse(rec.pendingPlanChange.effectiveAt) - Date.now() + 60 * 60 * 1000;
  const renewal = env.stripe.renew();
  const sim = await simulateInvoicePaid(env, renewal.id);
  check("renewal invoice switches record to M8 before sync", sim.record.localSku === "monthly_8" && !sim.record.pendingPlanChange);
  check("renewal sync issues M8 service at M8 price", sim.syncInput?.item?.mindbodyServiceId === M8.mindbodyServiceId && sim.syncInput?.amountCents === M8.amountCents);
  const redelivery = await applyPendingPlanChangeOnInvoicePaid({ stripe: env.stripe, subStore: env.subStore, record: await env.subStore.get(RECORD_ID), invoice: renewal });
  check("webhook redelivery is a no-op", redelivery.applied === false && redelivery.reason === "no_pending_change");
  const status = await env.service.getOperationStatus(result.operation.id);
  check("scheduled downgrade completes after renewal + Mindbody", status.status === "completed" && status.stripeInvoiceId === renewal.id, status);
  const finalRec = await env.subStore.get(RECORD_ID);
  check("downgrade keeps commitment end", finalRec.commitmentEndDate === "2027-01-01T00:00:00.000Z");
}

{
  const env = await setup({ sku: "monthly_unlimited" });
  const { result } = await previewAndExecute(env, "monthly_5", "scheduled_no_charge");
  const canceled = await env.service.cancelScheduled({ operationId: result.operation.id, actor: { id: "owner2" } });
  check("cancel scheduled change → canceled", canceled.status === "canceled" && canceled.recoveryNote.includes("owner2"));
  check("cancel releases Stripe schedule", env.stripe.state.sub.schedule === null);
  const rec = await env.subStore.get(RECORD_ID);
  check("cancel clears pending marker, plan unchanged", !rec.pendingPlanChange && rec.localSku === "monthly_unlimited");
  const renewal = env.stripe.renew();
  const sim = await simulateInvoicePaid(env, renewal.id);
  check("renewal after cancel stays Unlimited", sim.syncInput?.localSku === "monthly_unlimited");
}

{
  const env = await setup({ sku: "monthly_unlimited" });
  env.stripe.state.scheduleUpdateFails = true;
  const { result } = await previewAndExecute(env, "monthly_5", "scheduled_no_charge");
  check("schedule phase failure → failed + schedule released", result.operation.status === "failed" && env.stripe.state.sub.schedule === null);
  check("schedule failure leaves record untouched", !(await env.subStore.get(RECORD_ID)).pendingPlanChange);
}

{
  delete process.env.MEMBERSHIP_CHANGE_ADMIN_ENABLED;
  delete process.env.MEMBERSHIP_CHANGE_DEFERRED_ENABLED;
  const env = await setup({ sku: "monthly_unlimited" });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_5", policy: "scheduled_no_charge" });
  check("scheduled changes available with no feature flags set", p.ok === true, p.blockers);
}

/* ------------------------------------------------------------------ guards */

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.sub.pause_collection = { behavior: "void" };
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("frozen (paused) membership blocked", p.ok === false && p.blockers.some((b) => b.code === "membership_frozen"));
}

{
  const env = await setup({ sku: "monthly_5", recordStatus: "past_due" });
  env.stripe.state.sub.status = "past_due";
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("past-due membership blocked", p.ok === false && p.blockers.some((b) => b.code === "membership_not_active"));
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.sub.cancel_at_period_end = true;
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("cancel-at-period-end blocked", p.ok === false && p.blockers.some((b) => b.code === "cancellation_scheduled"));
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.sub.schedule = "sub_sched_external";
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("existing Stripe schedule blocked", p.ok === false && p.blockers.some((b) => b.code === "existing_stripe_schedule"));
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.openInvoices = [{ id: "in_open" }];
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("outstanding invoice blocked", p.ok === false && p.blockers.some((b) => b.code === "outstanding_invoice"));
}

{
  const env = await setup({ sku: "monthly_5" });
  env.stripe.state.pendingInvoiceItems = [{ description: "Late fee", amount: 1000, proration: false, pricing: { price_details: { product: "prod_fee" } }, period: {} }];
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("unexpected invoice items blocked", p.ok === false && p.blockers.some((b) => b.code === "unexpected_invoice_lines"));
}

{
  const env = await setup({ sku: "monthly_5", daysIntoPeriod: 29.97 });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("immediate change blocked within 2h of renewal", p.ok === false && p.blockers.some((b) => b.code === "too_close_to_renewal"));
}

{
  const env = await setup({ sku: "monthly_5", missingProducts: ["monthly_8"] });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("missing catalog product blocks preview (no silent write)", p.ok === false && p.blockers.some((b) => b.code === "catalog_product_not_prepared"));
  const prep = await env.service.prepareCatalogProduct({ toSku: "monthly_8", actor: { id: "owner1" } });
  check("explicit prepare creates catalog-aligned product", prep.action === "created" && prep.productMetadata.localSku === "monthly_8");
  const p2 = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("after prepare, preview succeeds", p2.ok === true);
}

{
  const env = await setup({ sku: "monthly_5", unitAmount: 11000 });
  const { preview, error } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit", { acknowledgements: {} });
  check("grandfathered price flagged for acknowledgement", preview.ackRequired.includes("grandfathered_price"));
  check("grandfathered price not silently overwritten", error?.code === "acknowledgement_required" && env.stripe.state.updateCalls === 0);
}

{
  const env = await setup({ sku: "monthly_5", consentContract: String(M5.mindbodyContractProductId) });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" });
  check("target agreement not on file → acknowledgement", p.ackRequired.includes("target_agreement_not_on_file"));
  const env2 = await setup({ sku: "monthly_5", consentContract: String(UNL.mindbodyContractProductId) });
  const p2 = await env2.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" });
  check("target agreement on file → no consent acknowledgement", !p2.ackRequired.includes("target_agreement_not_on_file"));
}

{
  const future = new Date(Date.now() + 40 * DAY * 1000).toISOString();
  const env = await setup({ sku: "monthly_unlimited", visits: [{ startDateTime: future, name: "Pilates" }] });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_5", policy: "scheduled_no_charge" });
  check("future bookings after downgrade date flagged", p.ackRequired.includes("future_bookings_after_effective"));
}

{
  const env = await setup({ sku: "monthly_5" });
  env.mb.state.down = true;
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("Mindbody outage → bookings unknown warning, preview still allowed", p.ok && p.warnings.some((w) => w.code === "future_bookings_unknown"));
}

/* ------------------------------------------------------------------ Mindbody recovery */

{
  const env = await setup({ sku: "monthly_5" });
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  env.mb.state.down = true;
  await simulateInvoicePaid(env, result.operation.stripeInvoiceId);
  const during = await env.service.getOperationStatus(result.operation.id);
  check("Mindbody read outage keeps syncing (not success)", during.status === "syncing");
  env.mb.state.down = false;
  const after = await env.service.getOperationStatus(result.operation.id);
  check("after outage, completes", after.status === "completed");
}

{
  const env = await setup({ sku: "monthly_5" });
  const { result } = await previewAndExecute(env, "monthly_unlimited", "new_cycle_no_credit");
  const invId = result.operation.stripeInvoiceId;
  await env.subStore.appendInvoiceSync(RECORD_ID, {
    invoiceId: invId,
    amountPaidCents: UNL.amountCents,
    currency: "usd",
    paidAt: new Date().toISOString(),
    status: "paid_but_not_synced",
    mindbodySaleId: null,
    mindbodyTransactionId: null,
    retryCount: 2,
    firstAttemptAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastError: "mindbody_5xx",
    adminRetryRequired: true,
  });
  const st = await env.service.getOperationStatus(invId ? result.operation.id : "");
  check("paid but Mindbody failed → needs_reconciliation (not success)", st.status === "needs_reconciliation" && st.errorCode === "mindbody_sync_failed");
  check("payment is recorded even though Mindbody failed", st.amountChargedCents === UNL.amountCents);
  const fixed = await env.service.getOperationStatus(result.operation.id, { retryMindbodySync: true });
  check("retry Mindbody sync completes without a new charge", fixed.status === "completed" && env.stripe.state.updateCalls === 1 && env.mb.state.retryCalls === 1);
}

{
  const env = await setup({ sku: "monthly_5" });
  const origPatch = env.subStore.patch;
  env.subStore.patch = async () => null;
  const { result } = await previewAndExecute(env, "monthly_8", "new_cycle_no_credit");
  env.subStore.patch = origPatch;
  check("Blob write failure → failed before any Stripe call", result.operation.status === "failed" && result.operation.errorCode === "blob_patch_failed" && env.stripe.state.updateCalls === 0);
}

/* ------------------------------------------------------------------ API auth */

{
  process.env.ADMIN_DEBUG_TOKEN = "admin-token-for-tests-0123456789";
  delete process.env.MEMBERSHIP_CHANGE_ADMIN_ENABLED;
  delete process.env.MEMBERSHIP_CHANGE_DEFERRED_ENABLED;
  delete process.env.MEMBERSHIP_BILLING_ADMINS;
  const OWNER_KEY = "correct-horse-battery-staple";
  const billingStore = createMemoryBillingAuthStore();
  await billingStore.enrollAdmin({ actorId: "owner1", role: "owner", createdBy: "test", ...hashBillingKey(OWNER_KEY) });
  const calls = [];
  const stub = {
    getDetails: async (id) => (calls.push(["details", id]), { membership: { subscriptionRecordId: id }, options: [] }),
    preview: async (i) => (calls.push(["preview", i]), { ok: true }),
    execute: async (i) => (calls.push(["execute", i]), { duplicate: false, operation: { id: "op", status: "syncing" } }),
    getOperationStatus: async () => ({ id: "op", status: "completed" }),
    cancelScheduled: async () => ({}),
    prepareCatalogProduct: async () => ({}),
  };
  const h = createMembershipChangeAdminHandler({ service: /** @type {any} */ (stub), billingStore });
  const base = { headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN, "x-nf-client-connection-ip": "203.0.113.5" }, queryStringParameters: {} };
  const billingHeaders = { ...base.headers, "x-billing-actor": "owner1", "x-billing-key": OWNER_KEY };
  const post = (headers, body) => h({ httpMethod: "POST", headers, body: JSON.stringify(body) });

  check("feature available with no flags set (details 200)", (await h({ ...base, httpMethod: "GET", queryStringParameters: { subscriptionId: RECORD_ID } })).statusCode === 200);
  check("missing admin token → 401", (await h({ httpMethod: "GET", headers: {}, queryStringParameters: {} })).statusCode === 401);
  check("details readable with admin token only", (await h({ ...base, httpMethod: "GET", queryStringParameters: { subscriptionId: RECORD_ID } })).statusCode === 200);
  const noBilling = await h({ ...base, httpMethod: "POST", body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" }) });
  check("preview without billing credential → 403", noBilling.statusCode === 403);
  const wrongKey = await h({ httpMethod: "POST", headers: { ...billingHeaders, "x-billing-key": "wrong-key-wrong-key" }, body: JSON.stringify({ action: "whoami" }) });
  check("wrong billing key → 403", wrongKey.statusCode === 403);
  const who = await h({ httpMethod: "POST", headers: billingHeaders, body: JSON.stringify({ action: "whoami" }) });
  check("valid billing credential → actor id", who.statusCode === 200 && JSON.parse(who.body).actor.id === "owner1");
  const badSku = await h({ httpMethod: "POST", headers: billingHeaders, body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "annual_monthly_5", policy: "new_cycle_no_credit" }) });
  check("non-monthly target SKU rejected", badSku.statusCode === 400);
  const exec = await h({
    httpMethod: "POST",
    headers: billingHeaders,
    body: JSON.stringify({ action: "execute", previewToken: "t", confirmAmountCents: 100, requestId: "req_api_000000000001", amountCents: 1, actor: { id: "attacker" } }),
  });
  const execCall = calls.find((c) => c[0] === "execute");
  check("execute actor comes from credential, not body", exec.statusCode === 200 && execCall?.[1]?.actor?.id === "owner1");
  check("execute ignores client-supplied amount fields", !("amountCents" in (execCall?.[1] || {})));
  const getMutation = await h({ ...base, httpMethod: "DELETE" });
  check("unsupported method → 405", getMutation.statusCode === 405);
  const opt = await h({ httpMethod: "OPTIONS", headers: {} });
  check("no CORS allow-origin header (same-origin only)", !Object.keys(opt.headers || {}).some((k) => k.toLowerCase() === "access-control-allow-origin"));

  check("execute recorded in audit log under the real admin", billingStore.audit.some((a) => a.action === "execute" && a.actorId === "owner1"));
  check("audit log never stores the billing key", !JSON.stringify(billingStore.audit).includes(OWNER_KEY));
  const storedAdmin = await billingStore.getAdmin("owner1");
  check("only a salted hash is stored", storedAdmin.keyHash.length === 64 && storedAdmin.keySalt.length >= 32 && !JSON.stringify(storedAdmin).includes(OWNER_KEY));

  const unknown = await post({ ...base.headers, "x-billing-actor": "nobody", "x-billing-key": "some-long-key-123" }, { action: "whoami" });
  check("unknown billing admin → 403", unknown.statusCode === 403);

  // Enrollment rules
  const enrollSuper = await post(billingHeaders, { action: "billing-admin-enroll", actorId: "super1", role: "superadmin", key: "super-secret-key-1" });
  check("owner enrolls a superadmin", enrollSuper.statusCode === 200);
  const superHeaders = { ...base.headers, "x-billing-actor": "super1", "x-billing-key": "super-secret-key-1" };
  const superWho = await post(superHeaders, { action: "whoami" });
  check(
    "owner-enrolled admin signs in but must rotate the initial key",
    superWho.statusCode === 200 && JSON.parse(superWho.body).actor.role === "superadmin" && JSON.parse(superWho.body).actor.mustRotate === true,
  );
  const blockedUntilRotate = await post(superHeaders, { action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" });
  check("billing actions blocked until the initial key is rotated", blockedUntilRotate.statusCode === 403 && JSON.parse(blockedUntilRotate.body).error === "key_rotation_required");
  const superRotate = await post(superHeaders, { action: "billing-key-rotate", newKey: "super-own-key-0001" });
  superHeaders["x-billing-key"] = "super-own-key-0001";
  const superAfter = await post(superHeaders, { action: "whoami" });
  check("after rotation the admin is fully enabled", superRotate.statusCode === 200 && JSON.parse(superAfter.body).actor.mustRotate === false);

  const expStore = createMemoryBillingAuthStore();
  await expStore.enrollAdmin({
    actorId: "temp1",
    role: "superadmin",
    createdBy: "test",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    ...hashBillingKey("temporary-key-0001"),
  });
  const expHandler = createMembershipChangeAdminHandler({ service: /** @type {any} */ (stub), billingStore: expStore });
  const expired = await expHandler({ httpMethod: "POST", headers: { ...base.headers, "x-billing-actor": "temp1", "x-billing-key": "temporary-key-0001" }, body: JSON.stringify({ action: "whoami" }) });
  check("expired credential is refused", expired.statusCode === 403 && expStore.attempts.some((a) => a.reason === "expired"));
  const escalate = await post(superHeaders, { action: "billing-admin-enroll", actorId: "owner2", role: "owner", key: "owner-two-secret-1" });
  check("superadmin cannot enroll an owner (no escalation)", escalate.statusCode === 403);
  const superRevoke = await post(superHeaders, { action: "billing-admin-revoke", actorId: "owner1" });
  check("superadmin cannot revoke", superRevoke.statusCode === 403);
  const superEscalateAfterRotate = await post(superHeaders, { action: "billing-admin-enroll", actorId: "owner3", role: "owner", key: "owner-three-key-1" });
  check("rotated superadmin still cannot enroll an owner", superEscalateAfterRotate.statusCode === 403 && JSON.parse(superEscalateAfterRotate.body).error === "owner_required");
  const dupEnroll = await post(billingHeaders, { action: "billing-admin-enroll", actorId: "super1", role: "superadmin", key: "another-key-12345" });
  check("re-enrolling an active admin is refused", dupEnroll.statusCode === 409);
  const shortKey = await post(billingHeaders, { action: "billing-admin-enroll", actorId: "super2", role: "superadmin", key: "short" });
  check("short billing key refused", shortKey.statusCode === 400);
  const lastOwner = await post(billingHeaders, { action: "billing-admin-revoke", actorId: "owner1" });
  check("last active owner cannot be revoked", lastOwner.statusCode === 409 && JSON.parse(lastOwner.body).error === "last_owner");
  const revokeSuper = await post(billingHeaders, { action: "billing-admin-revoke", actorId: "super1" });
  const revokedUse = await post(superHeaders, { action: "whoami" });
  check("revoked credential stops working immediately", revokeSuper.statusCode === 200 && revokedUse.statusCode === 403);
  const list = JSON.parse((await post(billingHeaders, { action: "billing-admins-list" })).body);
  check("admin list never exposes salt/hash", list.admins.length === 2 && !JSON.stringify(list).includes(storedAdmin.keyHash));
  const rotate = await post(billingHeaders, { action: "billing-key-rotate", newKey: "rotated-owner-key-99" });
  const oldKey = await post(billingHeaders, { action: "whoami" });
  const newKey = await post({ ...billingHeaders, "x-billing-key": "rotated-owner-key-99" }, { action: "whoami" });
  check("key rotation: old key refused, new key accepted", rotate.statusCode === 200 && oldKey.statusCode === 403 && newKey.statusCode === 200);
  check("enroll/revoke/rotate audited with actor", ["billing-admin-enroll", "billing-admin-revoke", "billing-key-rotate"].every((a) => billingStore.audit.some((e) => e.action === a && e.actorId)));

  // Rate limiting
  const rlStore = createMemoryBillingAuthStore();
  await rlStore.enrollAdmin({ actorId: "owner9", role: "owner", createdBy: "test", ...hashBillingKey("owner-nine-key-123") });
  const rl = createMembershipChangeAdminHandler({ service: /** @type {any} */ (stub), billingStore: rlStore });
  const rlHeaders = { ...base.headers, "x-billing-actor": "owner9" };
  for (let i = 0; i < RATE_LIMIT.perActor; i += 1) {
    await rl({ httpMethod: "POST", headers: { ...rlHeaders, "x-billing-key": `wrong-guess-${i}-xx` }, body: JSON.stringify({ action: "whoami" }) });
  }
  const locked = await rl({ httpMethod: "POST", headers: { ...rlHeaders, "x-billing-key": "owner-nine-key-123" }, body: JSON.stringify({ action: "whoami" }) });
  check(`after ${RATE_LIMIT.perActor} failures the admin is rate limited (429) even with the right key`, locked.statusCode === 429);
  check("every attempt recorded", rlStore.attempts.length === RATE_LIMIT.perActor + 1);
  const otherIpStore = createMemoryBillingAuthStore();
  const ipLimited = createMembershipChangeAdminHandler({ service: /** @type {any} */ (stub), billingStore: otherIpStore });
  for (let i = 0; i < RATE_LIMIT.perIp; i += 1) {
    await ipLimited({ httpMethod: "POST", headers: { ...base.headers, "x-billing-actor": `guess${i}`, "x-billing-key": "wrong-guess-key-1" }, body: JSON.stringify({ action: "whoami" }) });
  }
  const ipBlocked = await ipLimited({ httpMethod: "POST", headers: { ...base.headers, "x-billing-actor": "fresh-id", "x-billing-key": "wrong-guess-key-1" }, body: JSON.stringify({ action: "whoami" }) });
  check(`after ${RATE_LIMIT.perIp} failures from one IP, further attempts are rate limited`, ipBlocked.statusCode === 429);

  const tokenOnly = await post(base.headers, { action: "execute", previewToken: "t", confirmAmountCents: 1, requestId: "req_token_only_0001" });
  check("shared admin token alone cannot execute", tokenOnly.statusCode === 403);
}

{
  process.env.ADMIN_USERNAME = "amare1995";
  process.env.ADMIN_PASSWORD = "primary-admin-pass-1";
  process.env.ADMIN_DEBUG_TOKEN = "admin-token-for-tests-0123456789";
  const OWNER_KEY = "correct-horse-battery-staple";
  const store = createMemoryBillingAuthStore();
  await store.enrollAdmin({ actorId: "owner1", role: "owner", displayName: "Studio Owner", createdBy: "test", ...hashBillingKey(OWNER_KEY) });
  await store.enrollAdmin({ actorId: "super1", role: "superadmin", displayName: "Desk Lead", createdBy: "owner1", mustRotate: false, ...hashBillingKey("super-secret-key-1") });
  const login = createAdminLoginHandler({ billingStore: store });
  const api = createMembershipChangeAdminHandler({
    billingStore: store,
    service: /** @type {any} */ ({
      getDetails: async () => ({ membership: { subscriptionRecordId: RECORD_ID }, options: [] }),
      preview: async () => ({ ok: true, billing: { chargeTodayCents: 22900 } }),
      execute: async () => ({ duplicate: false, operation: { id: "op", status: "syncing" } }),
      getOperationStatus: async () => ({ id: "op", status: "completed" }),
      cancelScheduled: async () => ({}),
      prepareCatalogProduct: async () => ({}),
    }),
  });
  const ip = { "x-nf-client-connection-ip": "203.0.113.50", "x-forwarded-proto": "https" };
  /** @param {string} user @param {string} pass */
  const signIn = (user, pass) =>
    login({ httpMethod: "POST", path: "/api/admin/login", headers: ip, body: JSON.stringify({ username: user, password: pass }) });
  const cookieOf = (res) => {
    const set = String(res.headers?.["Set-Cookie"] || "");
    const m = set.match(new RegExp(`${ADMIN_SESSION_COOKIE}=([^;]+)`));
    return m ? m[1] : "";
  };

  const ownerLogin = await signIn("owner1", OWNER_KEY);
  const ownerBody = JSON.parse(ownerLogin.body);
  const ownerCookie = cookieOf(ownerLogin);
  check("owner password login returns the shared read token and a session cookie", ownerLogin.statusCode === 200 && ownerBody.token === process.env.ADMIN_DEBUG_TOKEN && ownerCookie.length > 20);
  check("owner session cookie is HttpOnly, Secure, and SameSite", /HttpOnly/i.test(ownerLogin.headers["Set-Cookie"]) && /Secure/i.test(ownerLogin.headers["Set-Cookie"]) && /SameSite=Lax/i.test(ownerLogin.headers["Set-Cookie"]));
  check("session id is not in the login JSON", !ownerLogin.body.includes(ownerCookie));
  check("owner can bill without a separate billing key", ownerBody.canBill === true && ownerBody.actor.id === "owner1" && ownerBody.actor.role === "owner");

  const sessionGet = await login({ httpMethod: "GET", path: "/api/admin/session", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${ownerCookie}` } });
  const sessionBody = JSON.parse(sessionGet.body);
  check("session endpoint restores the owner without a billing key", sessionGet.statusCode === 200 && sessionBody.canBill === true && sessionBody.csrfToken === ownerBody.csrfToken);

  const previewHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=${ownerCookie}`, "x-csrf-token": ownerBody.csrfToken, "x-admin-token": process.env.ADMIN_DEBUG_TOKEN };
  const preview = await api({ httpMethod: "POST", headers: previewHeaders, body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" }) });
  check("Stripe preview is allowed for an owner session", preview.statusCode === 200 && JSON.parse(preview.body).ok === true);
  const noCsrf = await api({ httpMethod: "POST", headers: { cookie: previewHeaders.cookie, "x-admin-token": process.env.ADMIN_DEBUG_TOKEN }, body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" }) });
  check("cookie mutation without CSRF is refused", noCsrf.statusCode === 403 && JSON.parse(noCsrf.body).error === "csrf_invalid");
  const tokenAndKeyIgnored = await api({
    httpMethod: "POST",
    headers: { ...previewHeaders, "x-csrf-token": "not-the-token", "x-billing-actor": "owner1", "x-billing-key": OWNER_KEY },
    body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" }),
  });
  check("a billing key cannot bypass a missing CSRF token on a session", tokenAndKeyIgnored.statusCode === 403);

  const wrongPrimary = await signIn("amare1995", "not-the-admin-password");
  check("wrong password does not create the owner", wrongPrimary.statusCode === 401 && !(await store.getAdmin("amare1995")));
  const primary = await signIn("amare1995", "primary-admin-pass-1");
  const primaryBody = JSON.parse(primary.body);
  const primaryAdmin = await store.getAdmin("amare1995");
  check(
    "amare1995 sign-in enrolls the owner and can change memberships",
    primary.statusCode === 200 && primaryBody.actor?.id === "amare1995" && primaryBody.actor?.role === "owner" && primaryBody.canBill === true,
  );
  check(
    "owner password is stored only as a hash",
    primaryAdmin?.keyHash?.length === 64 && !JSON.stringify(primaryAdmin).includes("primary-admin-pass-1") && !primary.body.includes("primary-admin-pass-1"),
  );
  const primaryAgain = await signIn("amare1995", "primary-admin-pass-1");
  check("second sign-in resolves the same owner", primaryAgain.statusCode === 200 && JSON.parse(primaryAgain.body).actor.role === "owner");
  const primaryPreview = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookieOf(primary)}`, "x-csrf-token": primaryBody.csrfToken },
    body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_unlimited", policy: "new_cycle_no_credit" }),
  });
  check("owner session can preview without a billing key", primaryPreview.statusCode === 200 && JSON.parse(primaryPreview.body).actor.id === "amare1995");

  const deskMaterial = issueSessionMaterial();
  await store.createSession({
    sessionHash: deskMaterial.sessionHash,
    actorId: null,
    role: "frontdesk",
    csrfToken: deskMaterial.csrfToken,
    expiresAt: deskMaterial.expiresAt,
    ipHash: null,
  });
  const deskWrite = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${deskMaterial.token}`, "x-csrf-token": deskMaterial.csrfToken, "x-billing-actor": "owner1", "x-billing-key": OWNER_KEY },
    body: JSON.stringify({ action: "execute", previewToken: "t", confirmAmountCents: 22900, requestId: "req_desk_blocked_0001" }),
  });
  check("a front-desk session cannot execute, even with a billing key attached", deskWrite.statusCode === 403 && JSON.parse(deskWrite.body).error === "access_denied");
  const afterOwnerLogin = await signIn("amare1995", "primary-admin-pass-1");
  const staleDesk = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${deskMaterial.token}`, "x-csrf-token": deskMaterial.csrfToken },
    body: JSON.stringify({ action: "whoami" }),
  });
  check("owner sign-in revokes leftover front-desk sessions", afterOwnerLogin.statusCode === 200 && staleDesk.statusCode === 401);

  const rotated = hashBillingKey("rotated-primary-pass-1");
  await store.rotateKey("amare1995", rotated.keySalt, rotated.keyHash);
  const oldEnv = await signIn("amare1995", "primary-admin-pass-1");
  const newPass = await signIn("amare1995", "rotated-primary-pass-1");
  check(
    "rotated password replaces the original for the same username",
    oldEnv.statusCode === 401 && newPass.statusCode === 200 && JSON.parse(newPass.body).actor.role === "owner",
  );

  const superLogin = await signIn("super1", "super-secret-key-1");
  const superBody = JSON.parse(superLogin.body);
  check("superadmin session can bill", superLogin.statusCode === 200 && superBody.canBill === true && superBody.actor.role === "superadmin");

  const bad = await signIn("owner1", "wrong-password-xx");
  check("wrong owner password is refused", bad.statusCode === 401);
  const noSession = await api({ httpMethod: "POST", headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN }, body: JSON.stringify({ action: "execute", previewToken: "t", confirmAmountCents: 1, requestId: "req_nosess_00000001" }) });
  check("shared admin token still cannot execute without a session or billing key", noSession.statusCode === 403);

  const expiredMaterial = issueSessionMaterial(-1000);
  await store.createSession({ sessionHash: expiredMaterial.sessionHash, actorId: "owner1", role: "owner", csrfToken: expiredMaterial.csrfToken, expiresAt: expiredMaterial.expiresAt, ipHash: null });
  const expired = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${expiredMaterial.token}`, "x-csrf-token": expiredMaterial.csrfToken },
    body: JSON.stringify({ action: "whoami" }),
  });
  check("expired session is refused", expired.statusCode === 401);

  await store.revokeAdmin("super1", "owner1");
  const revoked = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookieOf(superLogin)}`, "x-csrf-token": superBody.csrfToken },
    body: JSON.stringify({ action: "whoami" }),
  });
  check("revoked administrator session stops working immediately", revoked.statusCode === 401);

  const loggedOut = await login({
    httpMethod: "POST",
    path: "/api/admin/logout",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${ownerCookie}`, "x-csrf-token": ownerBody.csrfToken },
  });
  const afterLogout = await login({ httpMethod: "GET", path: "/api/admin/session", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${ownerCookie}` } });
  check("logout revokes the session and clears the cookie", loggedOut.statusCode === 200 && /Max-Age=0/i.test(loggedOut.headers["Set-Cookie"]) && afterLogout.statusCode === 401);

  const direct = await api({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "execute", previewToken: "t", confirmAmountCents: 1, requestId: "req_direct_000000001" }) });
  check("direct billing API call without authorization is refused", direct.statusCode === 401);

  await store.enrollAdmin({ actorId: "fresh1", role: "superadmin", createdBy: "owner1", mustRotate: true, ...hashBillingKey("fresh-admin-key-1") });
  const fresh = await signIn("fresh1", "fresh-admin-key-1");
  const freshBody = JSON.parse(fresh.body);
  const freshPreview = await api({
    httpMethod: "POST",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookieOf(fresh)}`, "x-csrf-token": freshBody.csrfToken },
    body: JSON.stringify({ action: "preview", subscriptionId: RECORD_ID, toSku: "monthly_8", policy: "new_cycle_no_credit" }),
  });
  check("first-login password must be changed before a session can preview", fresh.statusCode === 200 && freshBody.canBill === false && freshPreview.statusCode === 403 && JSON.parse(freshPreview.body).error === "key_rotation_required");
}

{
  const fs = await import("node:fs");
  const files = [
    "../netlify/functions/membership-change-admin.mjs",
    "../netlify/functions/membership-change-service.mjs",
    "../netlify/functions/membership-change-lib.mjs",
    "../netlify/functions/membership-change-auth.mjs",
    "../src/js/admin-monthly-memberships.js",
    "../netlify.toml",
  ].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8"));
  check(
    "no feature-flag or env-credential references remain",
    files.every((src) => !/MEMBERSHIP_CHANGE_ADMIN_ENABLED|MEMBERSHIP_CHANGE_DEFERRED_ENABLED|MEMBERSHIP_BILLING_ADMINS/.test(src)),
  );
}

{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../netlify/functions/membership-change-admin.mjs", import.meta.url), "utf8");
  check(
    "admin function uses modern runtime (Netlify Database binding)",
    src.includes("export default withLambda(lambdaHandler)") && !/export (const|async function) handler\b/.test(src),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
