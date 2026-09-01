/**
 * AMARÉ Annual Membership Phase 2 — allocation engine matrix.
 * Run: npm run test:annual-membership-phase2
 *
 * No live Mindbody writes. Mocks Mindbody API for issue-engine tests.
 */

process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";

const {
  ANNUAL_SKU_DEFINITIONS,
  buildAnnualAllocationPayNote,
  validateAnnualAllocationAmounts,
} = await import("../netlify/functions/annual-membership-lib.mjs");

const {
  resetAnnualMembershipStoreMemoryForTests,
  openAnnualMembershipStoreForTests,
} = await import("../netlify/functions/annual-membership-store.mjs");

const {
  issueAnnualMembershipPeriod,
  reconcileAmbiguousAnnualPeriod,
  reconcileAnnualPeriodCandidates,
  currentBusinessDate,
} = await import("../netlify/functions/annual-membership-issue.mjs");

const { __testing: syncTesting } = await import("../netlify/functions/stripe-mindbody-sync-lib.mjs");

let failed = 0;
let mbCallCount = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function mockStaff() {
  return async () => ({ ok: true, headers: { Authorization: "Bearer test" } });
}

function termInput(overrides = {}) {
  return {
    amareUserId: "usr_ANNUALP200000000000001",
    mindbodyClientId: 100002753,
    stripeCustomerId: "cus_phase2",
    stripeSubscriptionId: "sub_phase2",
    stripeInvoiceId: overrides.stripeInvoiceId || `in_phase2_${Math.random().toString(36).slice(2, 8)}`,
    stripePriceId: "price_phase2",
    sku: overrides.sku || "annual_monthly_5",
    termStartDate: overrides.termStartDate || "2026-09-17",
    termEndDate: overrides.termEndDate || "2027-09-17",
    ...overrides,
  };
}

async function seedTerm(store, overrides = {}) {
  return store.createAnnualTermWithPeriods(termInput(overrides));
}

function mockSyncSuccess(ids = { saleId: "90001", clientServiceId: "91001" }) {
  mbCallCount += 1;
  return {
    ok: true,
    mindbodySaleId: ids.saleId,
    mindbodyClientServiceId: ids.clientServiceId,
    mindbodyTransactionId: null,
    responseSummary: "{}",
    mode: "custom",
    paymentMethodName: "Stripe",
    payNote: "test",
  };
}

function mockSyncFn(result) {
  return async () => {
    if (typeof result === "function") return result();
    return result ?? mockSyncSuccess();
  };
}

function mockSyncTimeoutFn() {
  return async () => {
    mbCallCount += 1;
    return { ok: false, reason: "mindbody_sync_timeout", mode: "custom", retryable: true };
  };
}

function servicesMock(services) {
  return async () => ({ ok: true, status: 200, services });
}

// ── A. SKU validation (sync wrapper rejects before MB) ─────────────────────

const badProduct = validateAnnualAllocationAmounts({
  sku: "annual_monthly_5",
  productId: 99999,
  listAmountCents: 12500,
  discountAmountCents: 1875,
  netAmountCents: 10625,
});
check("A wrong ProductId rejected", badProduct.ok === false && badProduct.reason === "annual_product_id_mismatch");

const badDisc = validateAnnualAllocationAmounts({
  sku: "annual_monthly_5",
  productId: 100133,
  listAmountCents: 12500,
  discountAmountCents: 1800,
  netAmountCents: 10625,
});
check("A wrong discount rejected", badDisc.ok === false && badDisc.reason === "annual_discount_amount_mismatch");

const badNet = validateAnnualAllocationAmounts({
  sku: "annual_monthly_5",
  productId: 100133,
  listAmountCents: 12500,
  discountAmountCents: 1875,
  netAmountCents: 10000,
});
check("A wrong net rejected", badNet.ok === false && badNet.reason === "annual_net_amount_mismatch");

const payNote = buildAnnualAllocationPayNote({
  annualMembershipId: "abc-123",
  stripeInvoiceId: "in_test",
  periodIndex: 2,
  sku: "annual_monthly_5",
  netAmountCents: 10625,
});
check(
  "A PayNote shape",
  payNote.includes("annual=abc-123") &&
    payNote.includes("p=3/12") &&
    payNote.includes("alloc=prepaid") &&
    payNote.includes("net=106.25"),
);

// ── B–K store + issue engine ───────────────────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const store = openAnnualMembershipStoreForTests();
const seeded = await seedTerm(store, { stripeInvoiceId: "in_issue_engine" });
const p0 = seeded.periods.find((p) => p.period_index === 0);
const p1 = seeded.periods.find((p) => p.period_index === 1);

mbCallCount = 0;
const notDue = await issueAnnualMembershipPeriod(p0.id, {
  store,
  businessDate: "2026-09-16",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([]),
  syncFn: mockSyncFn(),
});
check("B period not due", notDue.outcome === "PERIOD_NOT_DUE" && mbCallCount === 0);

mbCallCount = 0;
const issued = await issueAnnualMembershipPeriod(p0.id, {
  store,
  businessDate: "2026-09-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([{ Id: 1, ProductId: 100133, Remaining: 0 }]),
  syncFn: mockSyncFn(() => {
    mbCallCount += 1;
    return {
      ok: true,
      mindbodySaleId: "88001",
      mindbodyClientServiceId: "88002",
      mindbodyTransactionId: null,
      responseSummary: "{}",
      mode: "custom",
      paymentMethodName: "Stripe",
      payNote: "test",
    };
  }),
});
check(
  "D successful issue",
  issued.outcome === "ISSUED" &&
    mbCallCount === 1 &&
    issued.period?.status === "issued" &&
    issued.period?.mindbody_sale_id === 88001 &&
    issued.period?.mindbody_client_service_id === 88002,
);

const racePeriod = seeded.periods.find((p) => p.period_index === 2);
mbCallCount = 0;
const race = await Promise.all(
  Array.from({ length: 4 }, () =>
    issueAnnualMembershipPeriod(racePeriod.id, {
      store,
      businessDate: "2026-11-17",
      staffHeadersFn: mockStaff(),
      fetchClientServicesFn: servicesMock([]),
      syncFn: mockSyncFn(() => {
        mbCallCount += 1;
        return {
          ok: true,
          mindbodySaleId: "88100",
          mindbodyClientServiceId: "88101",
          mindbodyTransactionId: null,
          responseSummary: "{}",
          mode: "custom",
          paymentMethodName: "Stripe",
          payNote: "test",
        };
      }),
    }),
  ),
);
const raceWinners = race.filter((r) => r.outcome === "ISSUED");
const raceLost = race.filter((r) => r.outcome === "CLAIM_LOST" || r.outcome === "PERIOD_NOT_ISSUABLE");
check("C claim race one MB call", mbCallCount === 1 && raceWinners.length === 1, `mb=${mbCallCount} winners=${raceWinners.length}`);
check("C claim race losers", raceLost.length === 3, `lost=${raceLost.length}`);

// Overlap tests on fresh term
resetAnnualMembershipStoreMemoryForTests();
const store2 = openAnnualMembershipStoreForTests();
const seeded2 = await seedTerm(store2, { stripeInvoiceId: "in_overlap" });
const o0 = seeded2.periods.find((p) => p.period_index === 0);
const o1 = seeded2.periods.find((p) => p.period_index === 1);

await issueAnnualMembershipPeriod(o0.id, {
  store: store2,
  businessDate: "2026-09-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([]),
  syncFn: mockSyncFn(() => {
    mbCallCount += 1;
    return {
      ok: true,
      mindbodySaleId: "87001",
      mindbodyClientServiceId: "87002",
      mindbodyTransactionId: null,
      responseSummary: "{}",
      mode: "custom",
      paymentMethodName: "Stripe",
      payNote: "test",
    };
  }),
});

const defer = await issueAnnualMembershipPeriod(o1.id, {
  store: store2,
  businessDate: "2026-10-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([
    { Id: 999, ProductId: 100133, Remaining: 2 },
    { Id: 87002, ProductId: 100133, Remaining: 2, ExpirationDate: "2026-11-18T00:00:00" },
  ]),
  fetchLinkedClientServiceFn: async () => ({
    ok: true,
    service: { Id: 87002, ProductId: 100133, Remaining: 2, ExpirationDate: "2026-11-18T00:00:00" },
  }),
  syncFn: mockSyncFn(),
  mockPreviousClientService: { Id: 87002, Remaining: 2, ExpirationDate: "2026-11-18T00:00:00" },
});
check("E overlap defer previous annual", defer.outcome === "DEFERRED_PREVIOUS_PERIOD_ACTIVE");

const allowExhausted = await issueAnnualMembershipPeriod(o1.id, {
  store: store2,
  businessDate: "2026-10-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([{ Id: 87002, ProductId: 100133, Remaining: 0 }]),
  fetchLinkedClientServiceFn: async () => ({
    ok: true,
    service: { Id: 87002, ProductId: 100133, Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
  }),
  syncFn: mockSyncFn(() => mockSyncSuccess({ saleId: "87003", clientServiceId: "87004" })),
  mockPreviousClientService: { Id: 87002, Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
});
check("E overlap allow exhausted", allowExhausted.outcome === "ISSUED");

resetAnnualMembershipStoreMemoryForTests();
const store3 = openAnnualMembershipStoreForTests();
const seeded3 = await seedTerm(store3, { stripeInvoiceId: "in_unrelated" });
const u0 = seeded3.periods.find((p) => p.period_index === 0);
const u1 = seeded3.periods.find((p) => p.period_index === 1);
await issueAnnualMembershipPeriod(u0.id, {
  store: store3,
  businessDate: "2026-09-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([]),
  syncFn: mockSyncFn(() => mockSyncSuccess({ saleId: "86001", clientServiceId: "86002" })),
});
mbCallCount = 0;
const unrelatedAllow = await issueAnnualMembershipPeriod(u1.id, {
  store: store3,
  businessDate: "2026-10-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([
    { Id: 55555, ProductId: 100133, Remaining: 5, ExpirationDate: "2027-01-01T00:00:00" },
    { Id: 86002, ProductId: 100133, Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
  ]),
  fetchLinkedClientServiceFn: async () => ({
    ok: true,
    service: { Id: 86002, ProductId: 100133, Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
  }),
  syncFn: mockSyncFn(() => mockSyncSuccess({ saleId: "86003", clientServiceId: "86004" })),
  mockPreviousClientService: { Id: 86002, Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
});
check("E unrelated same-product does not block", unrelatedAllow.outcome === "ISSUED" && mbCallCount === 1);

// Ambiguous + recovery
resetAnnualMembershipStoreMemoryForTests();
const store4 = openAnnualMembershipStoreForTests();
const seeded4 = await seedTerm(store4, { stripeInvoiceId: "in_ambig" });
const a0 = seeded4.periods.find((p) => p.period_index === 0);
mbCallCount = 0;
const amb = await issueAnnualMembershipPeriod(a0.id, {
  store: store4,
  businessDate: "2026-09-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([{ Id: 1, ProductId: 100133 }]),
  syncFn: mockSyncTimeoutFn(),
});
check("F ambiguous timeout", amb.outcome === "AMBIGUOUS" && mbCallCount === 1);
const ambPeriod = await store4.getAnnualPeriod(a0.id);
check("F no second checkout yet", ambPeriod?.status === "ambiguous");

mbCallCount = 0;
const ambRetry = await issueAnnualMembershipPeriod(a0.id, {
  store: store4,
  businessDate: "2026-09-17",
  staffHeadersFn: mockStaff(),
  fetchClientServicesFn: servicesMock([]),
  syncFn: mockSyncFn(),
});
check("F ambiguous blocks blind retry", ambRetry.outcome === "PERIOD_NOT_ISSUABLE" && mbCallCount === 0);

const recoveryDecision = reconcileAnnualPeriodCandidates({
  period: { mindbody_product_id: 100133, expected_net_amount_cents: 10625 },
  membership: {},
  preIssueIds: [1, 2],
  currentServices: [
    { Id: 1, ProductId: 100133 },
    { Id: 2, ProductId: 100133 },
    { Id: 3, ProductId: 100133 },
  ],
  purchases: [
    {
      Sale: {
        Id: 99001,
        PurchasedItems: [{ Id: 100133, TotalAmount: 106.25, PaymentRefId: 3 }],
        Payments: [{ Method: 17 }],
      },
    },
  ],
  paymentMethodId: 17,
  claimStartedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
});
check("G recovery single candidate", recoveryDecision.outcome === "attach" && recoveryDecision.candidate?.clientServiceId === 3);

const multi = reconcileAnnualPeriodCandidates({
  period: { mindbody_product_id: 100133, expected_net_amount_cents: 10625 },
  membership: {},
  preIssueIds: [1],
  currentServices: [
    { Id: 1, ProductId: 100133 },
    { Id: 2, ProductId: 100133 },
    { Id: 3, ProductId: 100133 },
  ],
  purchases: [],
  paymentMethodId: 17,
  claimStartedAt: new Date().toISOString(),
});
check("H multiple candidates manual_review", multi.outcome === "manual_review");

const zeroFresh = reconcileAnnualPeriodCandidates({
  period: { mindbody_product_id: 100133, expected_net_amount_cents: 10625 },
  membership: {},
  preIssueIds: [1, 2],
  currentServices: [{ Id: 1, ProductId: 100133 }, { Id: 2, ProductId: 100133 }],
  purchases: [],
  paymentMethodId: 17,
  claimStartedAt: new Date().toISOString(),
});
check("I zero candidate fresh", zeroFresh.outcome === "remain_ambiguous" && zeroFresh.fresh === true);

const zeroStale = reconcileAnnualPeriodCandidates({
  period: { mindbody_product_id: 100133, expected_net_amount_cents: 10625 },
  membership: {},
  preIssueIds: [1, 2],
  currentServices: [{ Id: 1, ProductId: 100133 }, { Id: 2, ProductId: 100133 }],
  purchases: [],
  paymentMethodId: 17,
  claimStartedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  nowMs: Date.now(),
});
check("J zero candidate stale safe retry", zeroStale.outcome === "safe_retry" && zeroStale.fresh === false);

// Crash simulation K
resetAnnualMembershipStoreMemoryForTests();
const store5 = openAnnualMembershipStoreForTests();
const seeded5 = await seedTerm(store5, { stripeInvoiceId: "in_crash" });
const c0 = seeded5.periods.find((p) => p.period_index === 0);
await store5.claimPeriod(c0.id);
await store5.persistPreIssueSnapshot(c0.id, {
  clientServiceIds: [1, 2],
  claimStartedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
});
await store5.markPeriodAmbiguous(c0.id, { error: "simulated_crash" });
const reloaded = openAnnualMembershipStoreForTests();
const rec = await reconcileAmbiguousAnnualPeriod({
  store: reloaded,
  periodId: c0.id,
  headers: { Authorization: "Bearer test" },
  fetchMbFn: async (method, path) => {
    if (path.includes("clientservices")) {
      return {
        ok: true,
        status: 200,
        data: {
          ClientServices: [
            { Id: 1, ProductId: 100133 },
            { Id: 2, ProductId: 100133 },
            { Id: 77, ProductId: 100133 },
          ],
        },
      };
    }
    if (path.includes("clientpurchases")) {
      return {
        ok: true,
        status: 200,
        data: {
          Purchases: [
            {
              Sale: {
                Id: 77001,
                PurchasedItems: [{ Id: 100133, TotalAmount: 106.25, PaymentRefId: 77 }],
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
check("K crash snapshot reconcile issued", rec.outcome === "issued" && rec.period?.mindbody_client_service_id === 77);

// ── Monthly regression (payload unchanged) ─────────────────────────────────

const monthlyPayload = syncTesting.buildSyncPayload({
  clientId: 100,
  serviceId: 100133,
  listAmountUsd: 125,
  discountAmountUsd: 0,
  paidAmountUsd: 125,
  payNote: "orderId=test; session=test; sku=monthly_5",
  mode: "custom",
  mindbodyTest: false,
  paymentMethodName: "Stripe",
  paymentMethodId: 17,
});
check("monthly SendEmail live unchanged", monthlyPayload.SendEmail === true);

const annualPayload = syncTesting.buildSyncPayload({
  clientId: 100,
  serviceId: 100133,
  listAmountUsd: 125,
  discountAmountUsd: 18.75,
  paidAmountUsd: 106.25,
  payNote: "annual=test",
  mode: "custom",
  mindbodyTest: false,
  sendEmail: false,
  paymentMethodName: "Stripe",
  paymentMethodId: 17,
});
check(
  "annual SendEmail false",
  annualPayload.SendEmail === false &&
    annualPayload.Items[0].DiscountAmount === 18.75 &&
    annualPayload.Payments[0].Metadata.Amount === 106.25,
);

check(
  "monthly no forced annual discount default",
  monthlyPayload.Items[0].DiscountAmount === undefined,
);

if (failed) {
  console.error(`\n${failed} annual membership phase 2 check(s) failed`);
  process.exit(1);
}

console.log("\nAnnual membership Phase 2 QA passed");
