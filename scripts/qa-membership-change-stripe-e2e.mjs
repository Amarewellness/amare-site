/**
 * Admin Change Membership — Stripe TEST MODE end-to-end.
 *
 * Uses the real membership-change service against Stripe test mode (sk_test_ only), with
 * Stripe test clocks so renewals can be fast-forwarded. Mindbody is faked; the subscription
 * store and ledger are in memory. Every test customer lives on a test clock that is deleted
 * at the end, which deletes its customers and subscriptions.
 *
 * Run: node scripts/qa-membership-change-stripe-e2e.mjs
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.NODE_ENV = "test";

import Stripe from "stripe";
import "./load-env.mjs";
import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import { openSubscriptionStore, resetSubscriptionStoreMemoryForTests } from "../netlify/functions/stripe-subscription-store.mjs";
import { executeMonthlyRenewalSync } from "../netlify/functions/stripe-monthly-period-sync.mjs";
import { createMemoryMembershipChangeStore } from "../netlify/functions/membership-change-store.mjs";
import { createMembershipChangeService } from "../netlify/functions/membership-change-service.mjs";
import { applyPendingPlanChangeOnInvoicePaid } from "../netlify/functions/membership-change-webhook.mjs";
import { matchPendingPlanChangeToInvoice } from "../netlify/functions/membership-change-lib.mjs";
import {
  ensureActiveStripeProductForCatalogSku,
  findActiveStripeProductForLocalSku,
} from "../netlify/functions/stripe-membership-stripe-product-lib.mjs";

const key = (process.env.STRIPE_SECRET_KEY || "").trim();
if (!key.startsWith("sk_test_")) {
  console.error("Refusing to run: STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_…).");
  process.exit(2);
}
const stripe = new Stripe(key, { apiVersion: "2025-08-27.basil" });

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL — ${name}${detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)})` : ""}`);
  }
}

const M5 = getCatalogItem("monthly_5");
const M8 = getCatalogItem("monthly_8");
const UNL = getCatalogItem("monthly_unlimited");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clocks = [];
let recordSeq = 0;

async function waitClockReady(clockId) {
  for (let i = 0; i < 90; i += 1) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === "ready") return c;
    await sleep(2000);
  }
  throw new Error(`test_clock_not_ready:${clockId}`);
}

async function advanceClock(clockId, toSec) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toSec });
  return waitClockReady(clockId);
}

/**
 * Create a subscription the way checkout leaves it: inline price on a product that is then archived.
 * @param {{ sku: string, card?: string }} opts
 */
async function createMember(opts) {
  const plan = getCatalogItem(opts.sku);
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: `amare-mc-e2e-${opts.sku}`,
  });
  clocks.push(clock.id);
  const customer = await stripe.customers.create({
    email: `mc-e2e-${clock.id}@example.com`,
    name: "Change Membership E2E",
    test_clock: clock.id,
  });
  const pm = await stripe.paymentMethods.attach(opts.card || "pm_card_visa", { customer: customer.id });
  const checkoutProduct = await stripe.products.create({ name: `QA checkout ${plan.displayName}`, metadata: { qa: "membership-change-e2e" } });
  recordSeq += 1;
  const recordId = `sub_amare_E2E${String(recordSeq).padStart(5, "0")}${clock.id.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price_data: { currency: "usd", product: checkoutProduct.id, unit_amount: plan.amountCents, recurring: { interval: "month" } } }],
    default_payment_method: pm.id,
    metadata: { localSku: plan.localSku, subscriptionId: recordId, membershipConsentId: "qa_consent" },
  });
  await stripe.products.update(checkoutProduct.id, { active: false });
  const subStore = openSubscriptionStore();
  await subStore.put({
    id: recordId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: customer.id,
    stripeCheckoutSessionId: `cs_e2e_${recordSeq}`,
    localSku: plan.localSku,
    displayName: plan.displayName,
    monthlyAmountCents: plan.amountCents,
    currency: "usd",
    mindbodyClientId: 900000000 + recordSeq,
    mindbodyServiceId: plan.mindbodyServiceId,
    mindbodyContractProductId: plan.mindbodyContractProductId,
    minimumCommitmentMonths: 3,
    earlyCancellationFeePercent: 50,
    commitmentStartDate: "2026-10-01T00:00:00.000Z",
    commitmentEndDate: "2027-01-01T00:00:00.000Z",
    membershipConsentId: "qa_consent",
    agreementTextHash: "qa_hash",
    status: "active",
    invoices: [],
  });
  return { clock, customer, sub, recordId, subStore, pmId: pm.id };
}

function makeService(subStore, mbRows, timeOffset = { ms: 0 }) {
  return createMembershipChangeService({
    stripe,
    subStore,
    ledger: createMemoryMembershipChangeStore(),
    io: {
      clientServices: async () => mbRows,
      futureVisits: async () => [],
      consentContractProductId: async () => null,
    },
    previewSecret: "e2e-preview-secret-0123456789abcdef",
    now: () => Date.now() + timeOffset.ms,
    sleep: async () => {},
    syncWaitMs: 0,
    log: () => {},
  });
}

const ACKS = { target_agreement_not_on_file: true, future_bookings_after_effective: true, unused_credits_with_stripe_credit: true };

async function previewAndExecute(service, recordId, toSku, policy) {
  const preview = await service.preview({ subscriptionRecordId: recordId, toSku, policy });
  if (!preview.ok) return { preview, result: null };
  const result = await service.execute({
    previewToken: preview.previewToken,
    confirmAmountCents: preview.billing.chargeTodayCents,
    requestId: `e2e_${recordId}_${policy}`.slice(0, 80),
    actor: { id: "e2e-owner", role: "owner" },
    acknowledgements: ACKS,
  });
  return { preview, result };
}

/** Mirror the production invoice.paid path (pending hook + shared Mindbody sync with a fake cart). */
async function simulateWebhook(subStore, recordId, invoiceId, mbRows, paymentDateIso) {
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["lines.data"] });
  let record = await subStore.get(recordId);
  let hook = null;
  if (record.pendingPlanChange) {
    hook = await applyPendingPlanChangeOnInvoicePaid({ stripe, subStore, record, invoice });
    record = hook.record;
  }
  /** @type {any} */
  let syncInput = null;
  const outcome = await executeMonthlyRenewalSync({
    subStore,
    record,
    invoice,
    existingEntry: null,
    item: getCatalogItem(record.localSku),
    retrieveInvoice: async () => invoice,
    syncFn: async (input) => {
      syncInput = input;
      return { ok: true, mindbodySaleId: `E2E_${invoiceId.slice(-8)}`, mindbodyClientServiceId: "E2E_CS" };
    },
    claimAlreadyAcquired: true,
    lostClaim: false,
  });
  mbRows.push({ Id: 1, ProductId: getCatalogItem(record.localSku).mindbodyServiceId, PaymentDate: paymentDateIso, Current: true });
  return { invoice, outcome, syncInput, hook, record };
}

async function ensureCatalogProductsSearchable() {
  for (const sku of ["monthly_5", "monthly_8", "monthly_unlimited"]) {
    await ensureActiveStripeProductForCatalogSku(stripe, sku);
    for (let i = 0; i < 40; i += 1) {
      if (await findActiveStripeProductForLocalSku(stripe, sku)) break;
      await sleep(3000);
    }
  }
}

async function run() {
  resetSubscriptionStoreMemoryForTests();
  await ensureCatalogProductsSearchable();
  const catalogProduct = {
    monthly_8: (await findActiveStripeProductForLocalSku(stripe, "monthly_8"))?.id,
    monthly_unlimited: (await findActiveStripeProductForLocalSku(stripe, "monthly_unlimited"))?.id,
  };
  check("test-mode catalog products resolvable by localSku", Boolean(catalogProduct.monthly_8 && catalogProduct.monthly_unlimited), catalogProduct);

  /* A — immediate upgrade, new cycle, no credit */
  {
    const m = await createMember({ sku: "monthly_5" });
    const rows = [];
    const service = makeService(m.subStore, rows);
    const { preview, result } = await previewAndExecute(service, m.recordId, "monthly_8", "new_cycle_no_credit");
    check("A: preview ok", preview.ok, preview.blockers);
    check("A: Stripe preview amount = full M8 price", preview.billing?.chargeTodayCents === M8.amountCents, preview.billing);
    check("A: real Stripe lines classified (target only, no unexpected)", preview.billing?.lines?.every((l) => l.kind === "target_plan"), preview.billing?.lines);
    check("A: operation syncing after paid update", result?.operation?.status === "syncing", result?.operation);
    check("A: charged amount equals preview", result?.operation?.amountChargedCents === preview.billing.chargeTodayCents);
    const sub = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    const item = sub.items.data[0];
    check("A: same subscription and item updated in place", sub.id === m.sub.id && item.id === m.sub.items.data[0].id);
    check("A: Stripe price = M8 on catalog product", item.price.unit_amount === M8.amountCents && item.price.product === catalogProduct.monthly_8);
    check("A: Stripe metadata switched, consent kept", sub.metadata.localSku === "monthly_8" && sub.metadata.membershipConsentId === "qa_consent");
    check("A: billing anchor reset (period starts now)", Math.abs(item.current_period_start - m.clock.frozen_time) < 300, {
      start: item.current_period_start,
      clock: m.clock.frozen_time,
    });
    const upcoming = await stripe.invoices.createPreview({ customer: m.customer.id, subscription: m.sub.id });
    check("A: next renewal = M8 price", upcoming.amount_due === M8.amountCents, upcoming.amount_due);
    const sim = await simulateWebhook(m.subStore, m.recordId, result.operation.stripeInvoiceId, rows, new Date().toISOString());
    check("A: webhook path issues M8 Mindbody service", sim.syncInput?.item?.mindbodyServiceId === M8.mindbodyServiceId);
    const done = await service.getOperationStatus(result.operation.id);
    check("A: completed after payment + Mindbody verified", done.status === "completed", done);
  }

  /* B — immediate upgrade with Stripe credit (10 days into the period) */
  {
    const m = await createMember({ sku: "monthly_5" });
    await advanceClock(m.clock.id, m.clock.frozen_time + 10 * 24 * 3600);
    const rows = [];
    const service = makeService(m.subStore, rows);
    const preview = await service.preview({ subscriptionRecordId: m.recordId, toSku: "monthly_unlimited", policy: "new_cycle_with_credit" });
    check("B: with-credit preview ok", preview.ok, preview.blockers);
    check("B: real Stripe credit line detected", (preview.billing?.creditCents ?? 0) < 0, preview.billing?.lines);
    check("B: charge = Unlimited minus credit", preview.billing?.chargeTodayCents === UNL.amountCents + preview.billing?.creditCents, preview.billing);
    const result = await service.execute({
      previewToken: preview.previewToken,
      confirmAmountCents: preview.billing.chargeTodayCents,
      requestId: `e2e_credit_${m.recordId}`.slice(0, 80),
      actor: { id: "e2e-owner", role: "owner" },
      acknowledgements: ACKS,
    });
    check("B: charged exactly the previewed amount", result.operation.amountChargedCents === preview.billing.chargeTodayCents, result.operation);
    const inv = await stripe.invoices.retrieve(result.operation.stripeInvoiceId);
    check("B: invoice is subscription_update and paid", inv.billing_reason === "subscription_update" && inv.status === "paid");
  }

  /* C — declined card */
  {
    const m = await createMember({ sku: "monthly_5" });
    const bad = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: m.customer.id });
    await stripe.subscriptions.update(m.sub.id, { default_payment_method: bad.id });
    const service = makeService(m.subStore, []);
    const { result } = await previewAndExecute(service, m.recordId, "monthly_8", "new_cycle_no_credit");
    check("C: declined card → payment_required", result?.operation?.status === "payment_required", result?.operation);
    const sub = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    check("C: Stripe subscription unchanged after decline", sub.items.data[0].price.unit_amount === M5.amountCents && sub.metadata.localSku === "monthly_5");
    check("C: record restored after decline", (await m.subStore.get(m.recordId)).localSku === "monthly_5");
    const open = await stripe.invoices.list({ subscription: m.sub.id, status: "open", limit: 5 });
    console.log(`INFO — C: open invoices left after decline: ${open.data.length}`);
  }

  /* D — card requiring authentication (3D Secure) */
  {
    const m = await createMember({ sku: "monthly_5" });
    const sca = await stripe.paymentMethods.attach("pm_card_authenticationRequired", { customer: m.customer.id });
    await stripe.subscriptions.update(m.sub.id, { default_payment_method: sca.id });
    const service = makeService(m.subStore, []);
    const { result } = await previewAndExecute(service, m.recordId, "monthly_unlimited", "new_cycle_no_credit");
    check("D: 3DS card → payment_required (never success)", result?.operation?.status === "payment_required", result?.operation);
    console.log(`INFO — D: errorCode=${result?.operation?.errorCode}`);
    const sub = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    check("D: Stripe subscription unchanged after 3DS refusal", sub.items.data[0].price.unit_amount === M5.amountCents);
  }

  /* E — scheduled downgrade through a real renewal (test clock) */
  {
    const m = await createMember({ sku: "monthly_unlimited" });
    const rows = [];
    const offset = { ms: 0 };
    const service = makeService(m.subStore, rows, offset);
    const { preview, result } = await previewAndExecute(service, m.recordId, "monthly_8", "scheduled_no_charge");
    check("E: scheduled preview charges nothing today", preview.ok && preview.billing.chargeTodayCents === 0, preview.blockers);
    check("E: operation scheduled", result?.operation?.status === "scheduled", result?.operation);
    const schedule = await stripe.subscriptionSchedules.retrieve(result.operation.stripeScheduleId);
    check("E: Stripe schedule accepted archived checkout price in phase 0", schedule.phases.length === 2 && schedule.end_behavior === "release");
    const rec = await m.subStore.get(m.recordId);
    check("E: localSku unchanged until renewal", rec.localSku === "monthly_unlimited" && rec.pendingPlanChange?.toSku === "monthly_8");
    const periodEnd = m.sub.items.data[0].current_period_end;
    await advanceClock(m.clock.id, periodEnd + 2 * 3600);
    const sub = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    check("E: Stripe switched to M8 at renewal", sub.items.data[0].price.unit_amount === M8.amountCents && sub.metadata.localSku === "monthly_8");
    const invs = await stripe.invoices.list({ subscription: m.sub.id, limit: 5 });
    const renewal = invs.data.find((i) => i.billing_reason === "subscription_cycle");
    check("E: renewal invoice paid at M8 price", renewal?.status === "paid" && renewal?.amount_paid === M8.amountCents, renewal && { status: renewal.status, paid: renewal.amount_paid });
    const match = matchPendingPlanChangeToInvoice({ pending: rec.pendingPlanChange, invoice: renewal, subscriptionMetadataSku: sub.metadata.localSku });
    check("E: real renewal invoice matches pending change", match.apply === true, match);
    offset.ms = renewal.period_end * 1000 - Date.now() + 3600 * 1000;
    const paidDay = new Date(sub.items.data[0].current_period_start * 1000).toISOString();
    const sim = await simulateWebhook(m.subStore, m.recordId, renewal.id, rows, paidDay);
    check("E: webhook hook switched record to M8 before sync", sim.hook?.applied === true && sim.record.localSku === "monthly_8");
    check("E: renewal sync issues M8 service at M8 price", sim.syncInput?.item?.mindbodyServiceId === M8.mindbodyServiceId && sim.syncInput?.paidAmountCents === M8.amountCents);
    const done = await service.getOperationStatus(result.operation.id);
    check("E: scheduled downgrade completed", done.status === "completed", done);
    check("E: commitment unchanged", (await m.subStore.get(m.recordId)).commitmentEndDate === "2027-01-01T00:00:00.000Z");
  }

  /* F — cancel a scheduled change */
  {
    const m = await createMember({ sku: "monthly_8" });
    const service = makeService(m.subStore, []);
    const { result } = await previewAndExecute(service, m.recordId, "monthly_5", "scheduled_no_charge");
    check("F: scheduled", result?.operation?.status === "scheduled", result?.operation);
    const canceled = await service.cancelScheduled({ operationId: result.operation.id, actor: { id: "e2e-owner" } });
    check("F: canceled", canceled.status === "canceled");
    const sub = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    check("F: schedule released, price unchanged", !sub.schedule && sub.items.data[0].price.unit_amount === M8.amountCents && sub.metadata.localSku === "monthly_8");
    const periodEnd = m.sub.items.data[0].current_period_end;
    await advanceClock(m.clock.id, periodEnd + 2 * 3600);
    const after = await stripe.subscriptions.retrieve(m.sub.id, { expand: ["items.data.price"] });
    check("F: renewal after cancel stays M8", after.items.data[0].price.unit_amount === M8.amountCents);
  }
}

try {
  await run();
} catch (e) {
  failed += 1;
  console.error("FATAL —", e?.message || e);
} finally {
  for (const id of clocks) {
    await stripe.testHelpers.testClocks.del(id).catch((e) => console.warn(`cleanup failed for ${id}: ${e?.message}`));
  }
  console.log(`\n${passed} passed, ${failed} failed (test clocks cleaned: ${clocks.length})`);
  process.exit(failed ? 1 : 0);
}
