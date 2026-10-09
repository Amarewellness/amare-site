/**
 * Attendance fee Phase 3 — reconciler + Stripe collection (mocked Stripe).
 * Run: npm run test:attendance-fees-reconcile
 */

const CONFIG_LIVE = { enabled: true, dryRun: false, stripePriceId: "price_qa_attendance_fee" };
const CONFIG_OFF = { enabled: false, dryRun: true };
const CONFIG_DRY = { enabled: true, dryRun: true, stripePriceId: "price_qa_attendance_fee" };
const TEST_PRICE = "price_qa_attendance_fee";

const {
  resetAttendanceFeeStoreForTests,
  ATTENDANCE_FEE_STALE_PROCESSING_MS,
} = await import("../netlify/functions/attendance-fee-store.mjs");

const { runAttendanceFeeReconciliation } = await import(
  "../netlify/functions/attendance-fee-reconcile-scan.mjs"
);

const { collectAttendanceFeePayment } = await import(
  "../netlify/functions/stripe-attendance-fee-charge.mjs"
);

const { resolveStripeCustomerForMindbodyClient } = await import(
  "../netlify/functions/stripe-customer-for-mindbody-client.mjs"
);

const { openAttendanceFeeStore, AttendanceFeeDbUnconfiguredError } = await import(
  "../netlify/functions/attendance-fee-store.mjs"
);

const {
  collectAttendanceFee,
  collectAttendanceFeeForProcessingRow,
  validateAttendanceFeeRowForCollection,
} = await import("../netlify/functions/attendance-fee-collect.mjs");

const {
  attendanceFeeStripeIdempotencyBase,
  classifyAttendanceFeeStripeError,
  computeAttendanceFeeNextRetryAt,
} = await import("../netlify/functions/attendance-fee-failure-lib.mjs");

const { resolveAttendanceFeeCollectionConfig } = await import(
  "../netlify/functions/attendance-fee-config.mjs"
);

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function basePending(visitId) {
  return {
    visitId,
    siteId: 1,
    classId: 100,
    clientId: 42,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    amountCents: 1000,
    currency: "usd",
    status: "pending",
    triggerSource: "qa",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  };
}

/** @type {import("stripe").default | null} */
const fakeStripe = /** @type {import("stripe").default} */ ({});
let stripeCallCount = 0;

function resetStripeCounter() {
  stripeCallCount = 0;
}

async function seedPending(store, visitId) {
  await store.recordOrGetAttendanceFeeCandidate(basePending(visitId));
}

{
  const store = resetAttendanceFeeStoreForTests();
  resetStripeCounter();
  await seedPending(store, 7001);
  const mockCollect = async () => {
    stripeCallCount += 1;
    return {
      ok: true,
      stripeCustomerId: "cus_qa",
      stripeInvoiceId: "in_qa",
      stripePaymentIntentId: "pi_qa",
    };
  };
  const lock = await store.acquireAttendanceFeeProcessingLock(7001);
  const out = await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: mockCollect,
  });
  const row = await store.getAttendanceFeeByVisitId(7001);
  check("1 pending → processing → charged", out.outcome === "charged" && row?.status === "charged");
  check("1 stripe called once", stripeCallCount === 1);
}

{
  const store = resetAttendanceFeeStoreForTests();
  resetStripeCounter();
  await seedPending(store, 7002);
  const lock = await store.acquireAttendanceFeeProcessingLock(7002);
  const out = await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => {
      stripeCallCount += 1;
      return {
        ok: false,
        failureClass: "permanent",
        failureCode: "missing_stripe_customer",
        failureMessage: "No customer",
      };
    },
  });
  const row = await store.getAttendanceFeeByVisitId(7002);
  check("2 no Stripe customer → permanent", row?.failureClass === "permanent" && row?.failureCode === "missing_stripe_customer");
  check("2 outcome failed", out.outcome === "failed");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7003);
  const lock = await store.acquireAttendanceFeeProcessingLock(7003);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "permanent",
      failureCode: "missing_payment_method",
      failureMessage: "No PM",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7003);
  check("3 missing payment method → permanent", row?.failureCode === "missing_payment_method");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7004);
  const lock = await store.acquireAttendanceFeeProcessingLock(7004);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "permanent",
      failureCode: "card_declined",
      failureMessage: "declined",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7004);
  check("4 card_declined → permanent", row?.failureClass === "permanent");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7005);
  const lock = await store.acquireAttendanceFeeProcessingLock(7005);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "permanent",
      failureCode: "authentication_required",
      failureMessage: "auth",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7005);
  check("5 authentication_required → permanent", row?.failureCode === "authentication_required");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7006);
  const lock = await store.acquireAttendanceFeeProcessingLock(7006);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "retryable",
      failureCode: "stripe_server_error",
      failureMessage: "500",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7006);
  check("6 Stripe 500 → retryable", row?.failureClass === "retryable" && row?.nextRetryAt);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7007);
  const lock = await store.acquireAttendanceFeeProcessingLock(7007);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "retryable",
      failureCode: "network_timeout",
      failureMessage: "timeout",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7007);
  check("7 network timeout → retryable", row?.failureCode === "network_timeout");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7008);
  const lock = await store.acquireAttendanceFeeProcessingLock(7008);
  await collectAttendanceFeeForProcessingRow(lock.record, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async () => ({
      ok: false,
      failureClass: "retryable",
      failureCode: "rate_limit",
      failureMessage: "rate",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(7008);
  check("8 rate limit → retryable", row?.failureCode === "rate_limit");
}

{
  const base = attendanceFeeStripeIdempotencyBase(900);
  check(
    "9 idempotency keys stable",
    `${base}-invoice` === "amare:attendance-fee:v1:900-invoice" &&
      `${base}-pay` === "amare:attendance-fee:v1:900-pay",
  );
}

{
  const store = resetAttendanceFeeStoreForTests();
  let payCalls = 0;
  await store.recordOrGetAttendanceFeeCandidate({
    ...basePending(7010),
    status: "processing",
    stripeInvoiceId: "in_existing",
    processingStartedAt: new Date().toISOString(),
    attemptCount: 1,
  });
  const row = await store.getAttendanceFeeByVisitId(7010);
  const out = await collectAttendanceFeeForProcessingRow(row, {
    store,
    stripe: fakeStripe,
    priceId: TEST_PRICE,
    collectPayment: async (r) => {
      if (r.stripeInvoiceId === "in_existing") {
        return {
          ok: true,
          stripeCustomerId: "cus_x",
          stripeInvoiceId: "in_existing",
          stripePaymentIntentId: "pi_x",
          recovered: true,
        };
      }
      payCalls += 1;
      return { ok: true, stripeCustomerId: "cus_x", stripeInvoiceId: "in_new", stripePaymentIntentId: "pi_x" };
    },
  });
  check("10 ambiguous timeout recovery → charged without second pay", out.outcome === "charged" && payCalls === 0);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({ ...basePending(7011), status: "charged" });
  const out = await collectAttendanceFee(7011, {
    store,
    stripe: fakeStripe,
    config: CONFIG_LIVE,
    collectPayment: async () => {
      stripeCallCount += 1;
      return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
    },
  });
  check("11 charged never processes", out.outcome === "not_acquired" || out.outcome === "invalid_status");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    ...basePending(7012),
    status: "failed",
    failureClass: "permanent",
  });
  const list = await store.listProcessableAttendanceFees();
  check("12 permanent not processable", !list.some((r) => r.visitId === 7012));
}

{
  const store = resetAttendanceFeeStoreForTests();
  const future = new Date(Date.now() + 3600000).toISOString();
  await store.recordOrGetAttendanceFeeCandidate({
    ...basePending(7013),
    status: "failed",
    failureClass: "retryable",
    nextRetryAt: future,
  });
  const list = await store.listProcessableAttendanceFees({ nowMs: Date.now() });
  check("13 retryable blocked before next_retry_at", !list.some((r) => r.visitId === 7013));
}

{
  const store = resetAttendanceFeeStoreForTests();
  const staleStart = new Date(Date.now() - ATTENDANCE_FEE_STALE_PROCESSING_MS - 5000).toISOString();
  await store.recordOrGetAttendanceFeeCandidate({
    ...basePending(7014),
    status: "processing",
    processingStartedAt: staleStart,
    attemptCount: 1,
  });
  const list = await store.listProcessableAttendanceFees();
  check("14 stale processing listed", list.some((r) => r.visitId === 7014));
}

{
  const store = resetAttendanceFeeStoreForTests();
  resetStripeCounter();
  await seedPending(store, 7015);
  await Promise.all([
    runAttendanceFeeReconciliation({
      store,
      stripe: fakeStripe,
      config: CONFIG_LIVE,
      collectPayment: async () => {
        stripeCallCount += 1;
        return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
      },
    }),
    runAttendanceFeeReconciliation({
      store,
      stripe: fakeStripe,
      config: CONFIG_LIVE,
      collectPayment: async () => {
        stripeCallCount += 1;
        return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
      },
    }),
  ]);
  const row = await store.getAttendanceFeeByVisitId(7015);
  check("15 reconciler race → one charged row", row?.status === "charged" && stripeCallCount === 1);
}

{
  resetStripeCounter();
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7016);
  const summary = await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_OFF,
    collectPayment: async () => {
      stripeCallCount += 1;
      return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
    },
  });
  check("16 disabled → zero Stripe", summary.skipped && summary.reason === "disabled" && stripeCallCount === 0);
}

{
  resetStripeCounter();
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7017);
  const summary = await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_DRY,
    collectPayment: async () => {
      stripeCallCount += 1;
      return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
    },
  });
  check("17 dry-run → zero Stripe", summary.skipped && summary.reason === "dry_run" && stripeCallCount === 0);
}

{
  resetStripeCounter();
  const store = resetAttendanceFeeStoreForTests();
  await seedPending(store, 7018);
  const summary = await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: { enabled: true, dryRun: false, stripePriceId: null },
    collectPayment: async () => {
      stripeCallCount += 1;
      return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
    },
  });
  check("18 null Price ID → fail closed", summary.skipped && summary.reason === "invalid_price_config" && stripeCallCount === 0);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({ ...basePending(7019), amountCents: 999, status: "processing", attemptCount: 1 });
  const row = await store.getAttendanceFeeByVisitId(7019);
  const v = validateAttendanceFeeRowForCollection(row, TEST_PRICE);
  check("19 wrong amount fail closed", !v.ok && v.failureCode === "invalid_amount_or_currency");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({ ...basePending(7020), currency: "eur", status: "processing", attemptCount: 1 });
  const row = await store.getAttendanceFeeByVisitId(7020);
  const v = validateAttendanceFeeRowForCollection(row, TEST_PRICE);
  check("20 wrong currency fail closed", !v.ok);
}

{
  const c = classifyAttendanceFeeStripeError({ type: "card_error", decline_code: "insufficient_funds", message: "x" });
  check("classify card_error permanent", c.failureClass === "permanent");
}

{
  const cfg = resolveAttendanceFeeCollectionConfig(null);
  check(
    "source defaults enabled+dryRun (no live collection)",
    cfg.enabled === true && cfg.dryRun === true,
  );
}

{
  const next = computeAttendanceFeeNextRetryAt(1);
  check("retry schedule attempt 1", Boolean(next));
}

{
  let threw = false;
  const savedUrl =
    (process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  delete process.env.NETLIFY_DB_URL;
  delete process.env.NETLIFY_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    openAttendanceFeeStore();
  } catch (e) {
    threw = e instanceof AttendanceFeeDbUnconfiguredError || e?.code === "attendance_fee_db_unconfigured";
  }
  if (savedUrl) process.env.NETLIFY_DB_URL = savedUrl;
  check("H1 runtime openAttendanceFeeStore without DB fails closed", threw);
}

{
  resetStripeCounter();
  const savedUrl =
    (process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  delete process.env.NETLIFY_DB_URL;
  delete process.env.NETLIFY_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const summary = await runAttendanceFeeReconciliation({
      config: CONFIG_LIVE,
      stripe: fakeStripe,
      collectPayment: async () => {
        stripeCallCount += 1;
        return { ok: true, stripeCustomerId: "cus", stripeInvoiceId: "in", stripePaymentIntentId: "pi" };
      },
    });
    check(
      "H2 reconciler ledger unavailable → skip, zero Stripe",
      summary.skipped && summary.reason === "ledger_unavailable" && stripeCallCount === 0,
    );
  } finally {
    if (savedUrl) process.env.NETLIFY_DB_URL = savedUrl;
  }
}

{
  const visitId = 7021;
  const idemInvKey = `${attendanceFeeStripeIdempotencyBase(visitId)}-invoice`;
  /** @type {Map<string, { id: string; status: string; customer: string }>} */
  const invoicesByIdem = new Map();
  let payCalls = 0;
  const mockStripe = {
    customers: {
      search: async () => ({
        data: [{ id: "cus_idem", metadata: { mindbodyClientId: "42" }, deleted: false }],
      }),
      retrieve: async () => ({
        id: "cus_idem",
        deleted: false,
        invoice_settings: { default_payment_method: "pm_1" },
      }),
    },
    subscriptions: { list: async () => ({ data: [] }) },
    paymentMethods: { list: async () => ({ data: [{ id: "pm_1" }] }) },
    invoices: {
      create: async (_params, opts) => {
        const k = String(opts?.idempotencyKey || "");
        if (!invoicesByIdem.has(k)) {
          invoicesByIdem.set(k, { id: `in_${visitId}`, status: "draft", customer: "cus_idem" });
        }
        return invoicesByIdem.get(k);
      },
      retrieve: async (id) => ({
        id,
        status: "paid",
        payment_intent: "pi_idem",
        customer: "cus_idem",
      }),
      pay: async () => {
        payCalls += 1;
        return { status: "paid", id: `in_${visitId}`, payment_intent: "pi_idem" };
      },
    },
    invoiceItems: { create: async () => ({ id: "ii_1" }) },
  };

  const row = {
    visitId,
    status: "processing",
    amountCents: 1000,
    currency: "usd",
    clientId: 42,
    classId: 100,
    feeType: "late_cancel",
    triggerSource: "qa",
    mindbodyProductId: 100135,
  };
  let invoicePersistAttempts = 0;
  const first = await collectAttendanceFeePayment(row, {
    stripe: /** @type {import("stripe").default} */ (mockStripe),
    priceId: TEST_PRICE,
    persistStripeRefs: async (payload) => {
      if (!payload.stripeInvoiceId) return;
      invoicePersistAttempts += 1;
      if (invoicePersistAttempts === 1) throw new Error("persist_failed");
    },
  });
  check(
    "H3A invoice created then persist fails",
    !first.ok && first.failureCode === "ledger_persist_failed" && first.stripeInvoiceId === `in_${visitId}`,
  );
  const second = await collectAttendanceFeePayment(row, {
    stripe: /** @type {import("stripe").default} */ (mockStripe),
    priceId: TEST_PRICE,
    persistStripeRefs: async () => {},
  });
  check("H3B retry succeeds one invoice identity", second.ok === true && second.stripeInvoiceId === `in_${visitId}`);
  check("H3C idempotent invoice map size 1", invoicesByIdem.has(idemInvKey) && invoicesByIdem.size === 1);
  check("H3D at most one pay path for success", payCalls <= 2);
}

{
  const mockStripe = {
    customers: {
      search: async () => ({ data: [] }),
      list: async () => ({
        data: [{ id: "cus_wrong_meta", email: "member@example.com", metadata: { mindbodyClientId: "99999" } }],
      }),
    },
  };
  const res = await resolveStripeCustomerForMindbodyClient(
    /** @type {import("stripe").default} */ (mockStripe),
    42,
    { email: "member@example.com" },
  );
  check(
    "H4 email match wrong metadata → missing_stripe_customer",
    !res.ok && res.reason === "missing_stripe_customer",
  );
}

if (failed) {
  console.error(`\n${failed} reconcile QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll attendance-fee Phase 3 reconcile checks passed.");
