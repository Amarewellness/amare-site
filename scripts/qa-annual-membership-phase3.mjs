/**
 * AMARÉ Annual Membership Phase 3 — Stripe backend + webhook + reconciler matrix.
 * Run: npm run test:annual-membership-phase3
 *
 * No production Stripe charges. No live Mindbody writes (mocked/skipped at boundary).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedDir = path.join(root, "netlify/functions/_embedded");
fs.mkdirSync(embeddedDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "src/content/stripe-mindbody-catalog.config.json"),
  path.join(embeddedDir, "stripe-mindbody-catalog.config.json"),
);

process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";

const {
  loadStripeMindbodyCatalog,
  getCatalogItem,
  isAnnualMembershipCatalogItem,
  isMonthlyMembershipCatalogItem,
} = await import("../netlify/functions/stripe-catalog-lib.mjs");

const {
  resetAnnualMembershipStoreMemoryForTests,
  openAnnualMembershipStoreForTests,
} = await import("../netlify/functions/annual-membership-store.mjs");

const {
  issueAnnualMembershipPeriod,
  recoverStaleAnnualClaims,
  currentBusinessDate,
} = await import("../netlify/functions/annual-membership-issue.mjs");

const {
  handleAnnualInvoicePaid,
  handleAnnualInvoicePaymentFailed,
  describeAnnualCancellationSemantics,
  extractAnnualTermFromInvoice,
  resolveAnnualCatalogSku,
  __testing: webhookTesting,
} = await import("../netlify/functions/annual-membership-webhook-lib.mjs");

const { runAnnualMembershipReconciliation } = await import(
  "../netlify/functions/annual-membership-reconciler.mjs"
);

const { __testing: annualLibTesting } = await import("../netlify/functions/annual-membership-lib.mjs");

let failed = 0;
let period0IssueCount = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function mockInvoice(overrides = {}) {
  const start = overrides.periodStart ?? 1737072000; // 2025-01-17 UTC-ish
  const end = overrides.periodEnd ?? 1768608000; // 2026-01-17
  return {
    id: overrides.id || "in_annual_test_1",
    subscription:
      overrides.subscription !== undefined ? overrides.subscription : "sub_annual_test",
    customer: "cus_annual_test",
    currency: "usd",
    period_start: start,
    period_end: end,
    billing_reason: overrides.billing_reason || "subscription_create",
    lines: {
      data: [
        {
          period: { start, end },
          price: { id: "price_annual_test" },
        },
      ],
    },
    ...overrides.extra,
  };
}

function subRecord(overrides = {}) {
  return {
    id: "subrec_phase3",
    localSku: overrides.localSku || "annual_monthly_5",
    mindbodyClientId: overrides.mindbodyClientId ?? 100002839,
    stripeSubscriptionId: "sub_annual_test",
    stripeCustomerId: "cus_annual_test",
    amareUserId: "usr_phase3",
    status: "active",
    currency: "usd",
    invoices: [],
    ...overrides,
  };
}

function mockIssueFn(outcome = "ISSUED", storeRef = null) {
  return async (periodId, opts = {}) => {
    period0IssueCount += 1;
    const activeStore = opts.store ?? storeRef;
    if (outcome === "ISSUED") {
      if (activeStore) {
        await activeStore.claimPeriod(periodId);
        await activeStore.markPeriodIssued(periodId, {
          mindbodySaleId: 99001,
          mindbodyClientServiceId: 99002,
        });
      }
      return {
        outcome: "ISSUED",
        mindbodySaleId: "99001",
        mindbodyClientServiceId: "99002",
      };
    }
    if (outcome === "FAILED") {
      if (activeStore) {
        await activeStore.claimPeriod(periodId);
        await activeStore.markPeriodFailed(periodId, { error: "simulated_mb_failure" });
      }
      return { outcome: "FAILED", reason: "simulated_mb_failure" };
    }
    if (outcome === "AMBIGUOUS") {
      if (activeStore) {
        await activeStore.claimPeriod(periodId);
        await activeStore.markPeriodAmbiguous(periodId, { error: "simulated_ambiguous" });
      }
      return { outcome: "AMBIGUOUS", reason: "simulated_ambiguous" };
    }
    if (outcome === "DEFERRED") {
      return { outcome: "DEFERRED_PREVIOUS_PERIOD_ACTIVE" };
    }
    return { outcome };
  };
}

function mockSubStore() {
  /** @type {Record<string, unknown>[]} */
  const appended = [];
  const patches = [];
  return {
    appended,
    patches,
    async appendInvoiceSync(_id, entry) {
      appended.push(entry);
      return { ok: true };
    },
    async patch(_id, patch) {
      patches.push(patch);
      return { ok: true };
    },
    async get(id) {
      return { id, invoices: appended };
    },
  };
}

// ── Catalog / classification ────────────────────────────────────────────────

loadStripeMindbodyCatalog();
const annual5 = getCatalogItem("annual_monthly_5");
const monthly5 = getCatalogItem("monthly_5");
check("catalog annual_monthly_5 loads", annual5?.amountCents === 127500 && annual5?.recurringInterval === "year");
check("catalog annual_monthly_8 loads", getCatalogItem("annual_monthly_8")?.amountCents === 182580);
check("catalog annual_monthly_unlimited loads", getCatalogItem("annual_monthly_unlimited")?.amountCents === 233580);
check("catalog monthly_5 unchanged", monthly5?.recurringInterval === "month" && monthly5?.amountCents === 12500);
check(
  "classification monthly SKUs",
  ["monthly_5", "monthly_8", "monthly_unlimited"].every((sku) =>
    isMonthlyMembershipCatalogItem(getCatalogItem(sku)),
  ),
);
check(
  "classification annual SKUs",
  ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"].every((sku) =>
    isAnnualMembershipCatalogItem(getCatalogItem(sku)),
  ),
);
check(
  "classification monthly not annual",
  !isAnnualMembershipCatalogItem(monthly5) && isMonthlyMembershipCatalogItem(monthly5),
);

const term = extractAnnualTermFromInvoice(mockInvoice({ periodStart: 1705449600, periodEnd: 1737072000 }));
check(
  "stripe term from invoice line period",
  term.stripePeriodStartAt && term.stripePeriodEndAt && term.termStartDate && term.termEndDate,
);

// ── 2. Annual first invoice ─────────────────────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const store = openAnnualMembershipStoreForTests();
period0IssueCount = 0;

const first = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_first_annual" }),
  subscriptionRecord: subRecord(),
  store,
  issueFn: mockIssueFn("ISSUED", store),
  skipMindbodyIssue: false,
});
check("first invoice creates term", first.ok === true && first.created === true);
check("first invoice 12 periods", first.periods?.length === 12);
check("first invoice period 0 requested once", period0IssueCount === 1);

// ── 3. Replay idempotency ───────────────────────────────────────────────────

period0IssueCount = 0;
const replay = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_first_annual" }),
  subscriptionRecord: subRecord(),
  store,
  issueFn: mockIssueFn("ISSUED", store),
});
check("replay same invoice idempotent", replay.ok === true && replay.created === false);
check("replay no second period 0 issue", period0IssueCount === 0);
check(
  "replay one term only",
  !!(await store.getAnnualMembershipByInvoiceId("in_first_annual")) &&
    !(await store.getAnnualMembershipByInvoiceId("in_first_annual_duplicate")),
);

// ── 4. Annual renewal boundary ──────────────────────────────────────────────

const renewalStart = 1768608000;
const renewalEnd = 1800144000;
const renewal = await handleAnnualInvoicePaid({
  invoice: mockInvoice({
    id: "in_renewal_annual",
    billing_reason: "subscription_cycle",
    periodStart: renewalStart,
    periodEnd: renewalEnd,
  }),
  subscriptionRecord: subRecord(),
  store,
  issueFn: mockIssueFn("ISSUED", store),
  skipMindbodyIssue: true,
});
check("renewal creates second term", renewal.ok === true && renewal.created === true);
check(
  "renewal two terms total",
  !!(await store.getAnnualMembershipByInvoiceId("in_first_annual")) &&
    !!(await store.getAnnualMembershipByInvoiceId("in_renewal_annual")),
);
const y1p11 = first.periods.find((p) => p.period_index === 11);
const y2p0 = renewal.periods.find((p) => p.period_index === 0);
check(
  "renewal boundary contiguous",
  y1p11 && y2p0 && String(y1p11.period_end_date) === String(y2p0.period_start_date),
);

// ── 5. Renewal payment_failed — no new term ─────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeFail = openAnnualMembershipStoreForTests();
await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_paid_y1" }),
  subscriptionRecord: subRecord(),
  store: storeFail,
  skipMindbodyIssue: true,
});
const beforeFail = await storeFail.getAnnualMembershipByInvoiceId("in_paid_y1");
const subStoreMock = mockSubStore();
await handleAnnualInvoicePaymentFailed({
  invoice: mockInvoice({ id: "in_renewal_failed", billing_reason: "subscription_cycle" }),
  subscriptionRecord: subRecord(),
  subStore: subStoreMock,
});
const afterFail = await storeFail.getAnnualMembershipByInvoiceId("in_renewal_failed");
check("payment_failed no new term", !!beforeFail && !afterFail);
check("payment_failed logged entry", subStoreMock.appended.some((e) => e.status === "skipped_payment_failed"));

// ── 6. Cancellation semantics ───────────────────────────────────────────────

const cancelSem = describeAnnualCancellationSemantics({
  subscriptionRecord: { status: "canceled_admin" },
  stripeSubscription: { status: "canceled", cancel_at_period_end: true },
});
check(
  "cancellation paid term remains",
  cancelSem.dbEntitlement === "paid_annual_term_remains_until_term_end_date" &&
    cancelSem.stripeRenewal === "canceled_subscription_prevents_future_yearly_invoice",
);

// ── 7. Unknown SKU fail closed ──────────────────────────────────────────────

const unknown = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_unknown" }),
  subscriptionRecord: subRecord({ localSku: "not_a_real_sku" }),
  store: storeFail,
  skipMindbodyIssue: true,
});
check("unknown SKU fail closed", unknown.ok === false && unknown.status === "unknown_annual_sku");

// ── 8. Period 0 MB failure — term remains ───────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeMbFail = openAnnualMembershipStoreForTests();
const mbFail = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_mb_fail" }),
  subscriptionRecord: subRecord(),
  store: storeMbFail,
  issueFn: mockIssueFn("FAILED", storeMbFail),
});
check("MB failure term remains", mbFail.ok === true && mbFail.membership?.id);
const p0fail = mbFail.periods.find((p) => p.period_index === 0);
check("MB failure period recoverable", p0fail?.status === "failed" || mbFail.period0Issue?.outcome === "FAILED");

// ── 9. Period 0 ambiguous — no blind retry on replay ────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeAmb = openAnnualMembershipStoreForTests();
period0IssueCount = 0;
const amb = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_ambiguous" }),
  subscriptionRecord: subRecord(),
  store: storeAmb,
  issueFn: mockIssueFn("AMBIGUOUS", storeAmb),
});
check("ambiguous first pass", amb.ok === true);
period0IssueCount = 0;
await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_ambiguous" }),
  subscriptionRecord: subRecord(),
  store: storeAmb,
  issueFn: mockIssueFn("AMBIGUOUS", storeAmb),
});
check("ambiguous replay no re-issue", period0IssueCount === 0);

// ── 10–15. Reconciler matrix ────────────────────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeRec = openAnnualMembershipStoreForTests();
const seeded = await storeRec.createAnnualTermWithPeriods({
  amareUserId: "usr_rec",
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_rec",
  stripeSubscriptionId: "sub_rec",
  stripeInvoiceId: "in_rec",
  stripePriceId: "price_rec",
  sku: "annual_monthly_5",
  termStartDate: "2026-01-01",
  termEndDate: "2027-01-01",
  stripePeriodStartAt: "2026-01-01T05:00:00.000Z",
  stripePeriodEndAt: "2027-01-01T05:00:00.000Z",
  annualAmountCents: 127500,
});
const recP1 = seeded.periods.find((p) => p.period_index === 1);
const recP2 = seeded.periods.find((p) => p.period_index === 2);

let recIssueCount = 0;
const recSummary = await runAnnualMembershipReconciliation({
  store: storeRec,
  businessDate: "2025-12-31",
  issueFn: async () => {
    recIssueCount += 1;
    return { outcome: "ISSUED", mindbodySaleId: "1", mindbodyClientServiceId: "2" };
  },
});
check("future period not issued early", recIssueCount === 0 && recSummary.issued.length === 0);

function mockStaff() {
  return async () => ({ ok: true, headers: { Authorization: "Bearer test" } });
}
function servicesMock(services) {
  return async () => ({ ok: true, status: 200, services });
}

const dueSummary = await runAnnualMembershipReconciliation({
  store: storeRec,
  businessDate: "2026-02-01",
  issueFn: async (periodId, opts) =>
    issueAnnualMembershipPeriod(periodId, {
      store: storeRec,
      businessDate: "2026-02-01",
      staffHeadersFn: mockStaff(),
      fetchClientServicesFn: servicesMock([]),
      syncFn: async () => ({
        ok: true,
        mindbodySaleId: "1",
        mindbodyClientServiceId: "2",
        mindbodyTransactionId: null,
        responseSummary: "{}",
        mode: "custom",
        paymentMethodName: "Stripe",
        payNote: "test",
      }),
      ...opts,
    }),
});
check("reconciler issues due pending", dueSummary.issued.length >= 1);

resetAnnualMembershipStoreMemoryForTests();
const storeCas = openAnnualMembershipStoreForTests();
const casSeed = await storeCas.createAnnualTermWithPeriods({
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_cas",
  stripeSubscriptionId: "sub_cas",
  stripeInvoiceId: "in_cas",
  sku: "annual_monthly_5",
  termStartDate: "2026-03-01",
  termEndDate: "2027-03-01",
  stripePeriodStartAt: "2026-03-01T05:00:00.000Z",
  stripePeriodEndAt: "2027-03-01T05:00:00.000Z",
  annualAmountCents: 127500,
});
const casP0 = casSeed.periods.find((p) => p.period_index === 0);
let casWinners = 0;
await Promise.all([
  issueAnnualMembershipPeriod(casP0.id, {
    store: storeCas,
    businessDate: "2026-03-01",
    staffHeadersFn: mockStaff(),
    fetchClientServicesFn: servicesMock([]),
    syncFn: async () => {
      casWinners += 1;
      return {
        ok: true,
        mindbodySaleId: "1",
        mindbodyClientServiceId: "2",
        mindbodyTransactionId: null,
        responseSummary: "{}",
        mode: "custom",
        paymentMethodName: "Stripe",
        payNote: "test",
      };
    },
  }),
  issueAnnualMembershipPeriod(casP0.id, {
    store: storeCas,
    businessDate: "2026-03-01",
    staffHeadersFn: mockStaff(),
    fetchClientServicesFn: servicesMock([]),
    syncFn: async () => {
      casWinners += 1;
      return {
        ok: true,
        mindbodySaleId: "9",
        mindbodyClientServiceId: "9",
        mindbodyTransactionId: null,
        responseSummary: "{}",
        mode: "custom",
        paymentMethodName: "Stripe",
        payNote: "test",
      };
    },
  }),
]);
check("concurrent CAS one winner", casWinners <= 1);

resetAnnualMembershipStoreMemoryForTests();
const storeStale = openAnnualMembershipStoreForTests();
const staleSeed = await storeStale.createAnnualTermWithPeriods({
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_stale",
  stripeSubscriptionId: "sub_stale",
  stripeInvoiceId: "in_stale",
  sku: "annual_monthly_5",
  termStartDate: "2026-04-01",
  termEndDate: "2027-04-01",
  stripePeriodStartAt: "2026-04-01T04:00:00.000Z",
  stripePeriodEndAt: "2027-04-01T04:00:00.000Z",
  annualAmountCents: 127500,
});
const staleP0 = staleSeed.periods.find((p) => p.period_index === 0);
await storeStale.claimPeriod(staleP0.id);
await storeStale.persistPreIssueSnapshot(staleP0.id, {
  clientServiceIds: [1],
  claimStartedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
});
const staleRec = await recoverStaleAnnualClaims({
  store: storeStale,
  headers: { Authorization: "Bearer test" },
  fetchMbFn: async (method, p) => {
    if (p.includes("clientservices")) {
      return {
        ok: true,
        status: 200,
        data: { ClientServices: [{ Id: 1, ProductId: 100133 }, { Id: 88, ProductId: 100133 }] },
      };
    }
    if (p.includes("clientpurchases")) {
      return {
        ok: true,
        status: 200,
        data: {
          Purchases: [
            {
              Sale: {
                Id: 88001,
                PurchasedItems: [{ Id: 100133, TotalAmount: 106.25, PaymentRefId: 88 }],
                Payments: [{ Method: 17 }],
              },
            },
          ],
        },
      };
    }
    return { ok: false, status: 404, data: {} };
  },
});
check("stale claiming recovered", staleRec.reconciled.length >= 1);

resetAnnualMembershipStoreMemoryForTests();
const storeManual = openAnnualMembershipStoreForTests();
const manualSeed = await storeManual.createAnnualTermWithPeriods({
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_manual",
  stripeSubscriptionId: "sub_manual",
  stripeInvoiceId: "in_manual",
  sku: "annual_monthly_5",
  termStartDate: "2026-05-01",
  termEndDate: "2027-05-01",
  stripePeriodStartAt: "2026-05-01T04:00:00.000Z",
  stripePeriodEndAt: "2027-05-01T04:00:00.000Z",
  annualAmountCents: 127500,
});
const manualP0 = manualSeed.periods.find((p) => p.period_index === 0);
await storeManual.markPeriodManualReview(manualP0.id, { error: "ops_hold" });
const manualSummary = await runAnnualMembershipReconciliation({
  store: storeManual,
  businessDate: "2026-05-01",
  issueFn: async () => ({ outcome: "ISSUED" }),
});
check(
  "manual_review untouched",
  !manualSummary.issued.some((e) => e.periodId === manualP0.id),
);

resetAnnualMembershipStoreMemoryForTests();
const storeDefer = openAnnualMembershipStoreForTests();
const deferSeed = await storeDefer.createAnnualTermWithPeriods({
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_defer",
  stripeSubscriptionId: "sub_defer",
  stripeInvoiceId: "in_defer",
  sku: "annual_monthly_5",
  termStartDate: "2026-06-01",
  termEndDate: "2027-06-01",
  stripePeriodStartAt: "2026-06-01T04:00:00.000Z",
  stripePeriodEndAt: "2027-06-01T04:00:00.000Z",
  annualAmountCents: 127500,
});
const deferP0 = deferSeed.periods.find((p) => p.period_index === 0);
const deferP1 = deferSeed.periods.find((p) => p.period_index === 1);
await issueAnnualMembershipPeriod(deferP0.id, {
  store: storeDefer,
  businessDate: "2026-06-01",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([]),
  syncFn: async () => ({
    ok: true,
    mindbodySaleId: "1",
    mindbodyClientServiceId: "5001",
    mindbodyTransactionId: null,
    responseSummary: "{}",
    mode: "custom",
    paymentMethodName: "Stripe",
    payNote: "test",
  }),
});
const deferResult = await issueAnnualMembershipPeriod(deferP1.id, {
  store: storeDefer,
  businessDate: "2026-07-01",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([{ Id: 5001, ProductId: 100133, Remaining: 3 }]),
  fetchLinkedClientServiceFn: async () => ({
    ok: true,
    service: { Id: 5001, Remaining: 3, ExpirationDate: "2026-12-31T00:00:00" },
  }),
  mockPreviousClientService: { Id: 5001, Remaining: 3, ExpirationDate: "2026-12-31T00:00:00" },
  syncFn: async () => {
    throw new Error("should_not_call_mindbody_on_defer");
  },
});
check("previous overlap DEFER", deferResult.outcome === "DEFERRED_PREVIOUS_PERIOD_ACTIVE");

check("resolveAnnualCatalogSku", resolveAnnualCatalogSku("annual_monthly_5")?.localSku === "annual_monthly_5");
check("resolveAnnualCatalogSku monthly null", resolveAnnualCatalogSku("monthly_5") === null);

// ── 16. Stripe subscription id persistence + civil dates ─────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeSub = openAnnualMembershipStoreForTests();
const realSub = "sub_annual_real_backfill_1";
const pendingSub = "pending_sub_amare_test_abc";

const basilInvoice = mockInvoice({
  id: "in_sub_backfill",
  subscription: "",
  extra: {
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: realSub },
    },
  },
});
const firstRealSub = await handleAnnualInvoicePaid({
  invoice: basilInvoice,
  subscriptionRecord: subRecord({ stripeSubscriptionId: pendingSub }),
  store: storeSub,
  skipMindbodyIssue: true,
});
check(
  "A basil invoice + pending record stores real sub_*",
  firstRealSub.ok === true &&
    firstRealSub.created === true &&
    annualLibTesting.isRealStripeSubscriptionId(firstRealSub.membership?.stripe_subscription_id),
  String(firstRealSub.membership?.stripe_subscription_id),
);

resetAnnualMembershipStoreMemoryForTests();
const storeSub2 = openAnnualMembershipStoreForTests();
const seededPending = await storeSub2.createAnnualTermWithPeriods({
  mindbodyClientId: 100002839,
  stripeCustomerId: "cus_bf",
  stripeSubscriptionId: pendingSub,
  stripeInvoiceId: "in_sub_backfill2",
  sku: "annual_monthly_5",
  termStartDate: "2026-09-01",
  termEndDate: "2027-09-01",
  annualAmountCents: 127500,
});
const backfill = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_sub_backfill2", subscription: realSub }),
  subscriptionRecord: subRecord({ stripeSubscriptionId: pendingSub }),
  store: storeSub2,
  skipMindbodyIssue: true,
});
const afterBf = await storeSub2.getAnnualMembershipByInvoiceId("in_sub_backfill2");
check(
  "B pending → real sub backfill same term",
  backfill.created === false &&
    afterBf?.stripe_subscription_id === realSub &&
    backfill.membership?.id === seededPending.membership.id,
  String(afterBf?.stripe_subscription_id),
);

const replayReal = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_sub_backfill2", subscription: realSub }),
  subscriptionRecord: subRecord({ stripeSubscriptionId: realSub }),
  store: storeSub2,
  skipMindbodyIssue: true,
});
check(
  "C webhook replay keeps real sub_* unchanged",
  replayReal.created === false && replayReal.membership?.stripe_subscription_id === realSub,
);

check(
  "H formatAnnualBusinessDate preserves civil 2026-09-01",
  annualLibTesting.formatAnnualBusinessDate(new Date("2026-09-01T00:00:00.000Z")) === "2026-09-01",
);
check(
  "H formatAnnualBusinessDate DST boundary 2026-11-01",
  annualLibTesting.formatAnnualBusinessDate(new Date("2026-11-01T00:00:00.000Z")) === "2026-11-01",
);
const dueNov = await storeSub2.listDuePeriods("2026-11-01", { statuses: ["pending"] });
check(
  "H listDuePeriods uses civil dates across DST",
  dueNov.some((p) => p.period_start_date === "2026-11-01"),
  JSON.stringify(dueNov.map((p) => p.period_start_date)),
);

if (failed) {
  console.error(`\n${failed} annual membership phase 3 check(s) failed`);
  process.exit(1);
}

console.log("\nAnnual membership Phase 3 QA passed");
