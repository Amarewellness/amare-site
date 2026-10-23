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
import { billingAdminEntry } from "../netlify/functions/membership-change-auth.mjs";
import { createMembershipChangeAdminHandler } from "../netlify/functions/membership-change-admin.mjs";

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
 * @param {{ sku: string, unitAmount?: number, remaining?: number, visits?: any[], consentContract?: string | null, daysIntoPeriod?: number, missingProducts?: string[], deferredEnabled?: boolean, recordStatus?: string }} opts
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
    flags: { deferredEnabled: opts.deferredEnabled !== false },
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
  const env = await setup({ sku: "monthly_unlimited", deferredEnabled: false });
  const p = await env.service.preview({ subscriptionRecordId: RECORD_ID, toSku: "monthly_5", policy: "scheduled_no_charge" });
  check("deferred flag off blocks scheduled changes", p.ok === false && p.blockers.some((b) => b.code === "scheduled_changes_disabled"));
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
  process.env.MEMBERSHIP_BILLING_ADMINS = billingAdminEntry("owner1", "owner", "correct-horse-battery-staple");
  const calls = [];
  const stub = {
    getDetails: async (id) => (calls.push(["details", id]), { membership: { subscriptionRecordId: id }, options: [] }),
    preview: async (i) => (calls.push(["preview", i]), { ok: true }),
    execute: async (i) => (calls.push(["execute", i]), { duplicate: false, operation: { id: "op" } }),
    getOperationStatus: async () => ({ id: "op", status: "completed" }),
    cancelScheduled: async () => ({}),
    prepareCatalogProduct: async () => ({}),
  };
  const h = createMembershipChangeAdminHandler({ service: /** @type {any} */ (stub) });
  const base = { headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN }, queryStringParameters: {} };
  const billingHeaders = { ...base.headers, "x-billing-actor": "owner1", "x-billing-key": "correct-horse-battery-staple" };

  process.env.MEMBERSHIP_CHANGE_ADMIN_ENABLED = "";
  check("feature flag off → 404", (await h({ ...base, httpMethod: "GET", queryStringParameters: { subscriptionId: RECORD_ID } })).statusCode === 404);
  process.env.MEMBERSHIP_CHANGE_ADMIN_ENABLED = "1";
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
  process.env.MEMBERSHIP_BILLING_ADMINS = "";
  const unconfigured = await h({ httpMethod: "POST", headers: billingHeaders, body: JSON.stringify({ action: "whoami" }) });
  check("no enrolled billing admins → 403", unconfigured.statusCode === 403 && JSON.parse(unconfigured.body).error === "billing_admins_not_configured");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
