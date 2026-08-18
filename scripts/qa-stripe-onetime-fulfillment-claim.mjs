/**
 * Deterministic one-time fulfillment claim tests.
 * Run: node scripts/qa-stripe-onetime-fulfillment-claim.mjs
 *
 * Mocks CheckoutShoppingCart. Does not call Mindbody. Does not enable production.
 */
process.env.NETLIFY = "";
const REAL_BLOBS_QA = (process.env.STRIPE_ORDER_STORE_BLOBS_QA || "").trim() === "1";
if (!REAL_BLOBS_QA) process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY = "1";

const {
  newOrderId,
  openOrderStore,
  resetOrderStoreMemoryForTests,
} = await import("../netlify/functions/stripe-order-store.mjs");
const { fulfillOneTimeMindbodySale } = await import(
  "../netlify/functions/stripe-onetime-fulfillment.mjs"
);

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const ITEM = {
  localSku: "drop_in_single_class",
  amountCents: 4000,
  currency: "usd",
  mindbodyServiceId: 100011,
  displayName: "Drop-In",
};

function seedOrder(store, overrides = {}) {
  const orderId = newOrderId();
  const record = {
    orderId,
    localSku: "drop_in_single_class",
    amountCents: 4000,
    currency: "usd",
    stripeCheckoutSessionId: `cs_test_${orderId.slice(4, 20).toLowerCase()}`,
    mindbodySyncStatus: "client_found",
    knownMindbodyClientId: 100002726,
    resolvedMindbodyClientId: 100002726,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  return store.put(record).then(() => record);
}

function saleInput(store, order, extra = {}) {
  return {
    store,
    orderId: order.orderId,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId,
    localSku: order.localSku,
    clientId: 100002726,
    amountCents: 4000,
    paidAmountCents: 4000,
    discountAmountCents: 0,
    currency: "usd",
    item: ITEM,
    ...extra,
  };
}

function countingSync(saleId = "90001") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        mindbodySaleId: saleId,
        mindbodyTransactionId: null,
        responseSummary: `sale=${saleId}`,
        mode: "custom",
      };
    },
  };
}

resetOrderStoreMemoryForTests();
let store = openOrderStore();
if (!store.available) {
  throw new Error(
    REAL_BLOBS_QA
      ? "Real Netlify Blobs QA store unavailable; refusing memory fallback"
      : "In-memory order QA store unavailable",
  );
}

{
  const order = await seedOrder(store);
  const claim = await store.claimOneTimeFulfillment(order.orderId, { attemptId: "ful_Q1_OWNER" });
  const marked = await store.markOneTimeFulfillmentRequestSent(
    order.orderId,
    "ful_Q1_OWNER",
    claim.ok && claim.outcome === "CLAIMED" && claim.etag
      ? { record: claim.record, etag: claim.etag }
      : undefined,
  );
  const after = await store.get(order.orderId);
  check("Q1 claim -> immediate mark_sent", claim.ok && claim.outcome === "CLAIMED" && marked.ok && !!after?.fulfillmentRequestSentAt);
  const loser = await store.markOneTimeFulfillmentRequestSent(order.orderId, "ful_Q4_LOSER");
  check("Q4 losing worker cannot mark_sent", !loser.ok && loser.reason === "not_claim_owner");
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  const claim = await store.claimOneTimeFulfillment(order.orderId, { attemptId: "ful_WINNER" });
  const loserRelease = await store.releaseOneTimeFulfillmentClaim(order.orderId, "ful_LOSER", "sync_failed_retryable");
  const afterLoser = await store.get(order.orderId);
  const ownerRelease = await store.releaseOneTimeFulfillmentClaim(order.orderId, "ful_WINNER", "sync_failed_retryable");
  const retry = await store.claimOneTimeFulfillment(order.orderId, { attemptId: "ful_RETRY" });
  check(
    "Q5 non-owner cannot release/delete winner claim",
    claim.ok && claim.outcome === "CLAIMED" && !loserRelease.ok && loserRelease.reason === "not_claim_owner" && afterLoser?.fulfillmentClaimId === "ful_WINNER",
  );
  check("Q6 owner pre-send release permits safe retry", ownerRelease.ok && ownerRelease.outcome === "RELEASED" && retry.ok && retry.outcome === "CLAIMED");
  const staleRelease = await store.releaseOneTimeFulfillmentClaim(order.orderId, "ful_WINNER", "sync_failed_retryable");
  const stillLocked = await store.claimOneTimeFulfillment(order.orderId, { attemptId: "ful_THIRD" });
  check(
    "Q5 stale owner cannot delete new owner's claim",
    !staleRelease.ok && staleRelease.reason === "not_claim_owner" && stillLocked.ok && stillLocked.outcome === "IN_PROGRESS",
  );
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  const claim = await store.claimOneTimeFulfillment(order.orderId, { attemptId: "ful_TRANSITION_OWNER" });
  const wrongComplete = await store.completeOneTimeFulfillment(order.orderId, "ful_WRONG", { mindbodySaleId: "should-not-land" });
  const wrongUnknown = await store.markOneTimeFulfillmentUnknown(order.orderId, "ful_WRONG", "wrong_owner");
  const unchanged = await store.get(order.orderId);
  check(
    "Q8 complete with wrong attemptId cannot succeed",
    claim.ok && !wrongComplete.ok && wrongComplete.reason === "not_claim_owner" && unchanged?.mindbodySyncStatus === "mindbody_sync_claimed" && !unchanged?.mindbodySaleId,
  );
  check(
    "Q9 mark unknown with wrong attemptId cannot succeed",
    !wrongUnknown.ok && wrongUnknown.reason === "not_claim_owner" && unchanged?.mindbodySyncStatus === "mindbody_sync_claimed",
  );
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store, { mindbodySyncStatus: "mindbody_synced", fulfillmentClaimId: "ful_SYNCED_OWNER", mindbodySaleId: "25898" });
  const retryRelease = await store.releaseOneTimeFulfillmentClaim(order.orderId, "ful_SYNCED_OWNER", "sync_failed_retryable");
  const nonOwnerRelease = await store.releaseOneTimeFulfillmentClaim(order.orderId, "ful_OTHER", "sync_failed_retryable");
  const after = await store.get(order.orderId);
  check(
    "Q7 already synced retries cannot unlock fulfillment",
    !retryRelease.ok && retryRelease.reason === "already_synced" && !nonOwnerRelease.ok && nonOwnerRelease.reason === "already_synced" && after?.fulfillmentClaimId === "ful_SYNCED_OWNER" && after?.mindbodySyncStatus === "mindbody_synced",
  );
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  let syncCalls = 0;
  const storeWithMarkFailure = { ...store, markOneTimeFulfillmentRequestSent: async () => ({ ok: false, reason: "max_retries_exhausted" }) };
  const result = await fulfillOneTimeMindbodySale(saleInput(storeWithMarkFailure, order, {
    syncFn: async () => {
      syncCalls += 1;
      return { ok: true, mindbodySaleId: "must-not-run" };
    },
  }));
  const after = await store.get(order.orderId);
  check(
    "Q10 pre-request mark_sent CAS failure remains retryable",
    !result.ok && result.retryable === true && result.status === "sync_failed_retryable" && syncCalls === 0 && after?.mindbodySyncStatus === "sync_failed_retryable" && after?.fulfillmentClaimId == null,
  );
}

resetOrderStoreMemoryForTests();
store = openOrderStore();

{
  const order = await seedOrder(store);
  const sync = countingSync("90011");
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      fulfillOneTimeMindbodySale(
        saleInput(store, order, { stripeEventId: "evt_same_completed", syncFn: sync.fn }),
      ),
    ),
  );
  const winners = results.filter((r) => r.status === "mindbody_synced" && !r.noop);
  const dedup = results.filter((r) => r.noop);
  const final = await store.get(order.orderId);
  check("concurrent same event: 1 claim winner", winners.length === 1, `winners=${winners.length}`);
  check("concurrent same event: 1 CheckoutShoppingCart", sync.calls === 1, `calls=${sync.calls}`);
  check("concurrent same event: 1 sale id", final?.mindbodySaleId === "90011", String(final?.mindbodySaleId));
  check("concurrent same event: mindbody_synced", final?.mindbodySyncStatus === "mindbody_synced");
  check("concurrent same event: atomic syncAttempts=1", final?.syncAttempts === 1, String(final?.syncAttempts));
  check("concurrent same event: losers dedup", dedup.length === 7, `dedup=${dedup.length}`);
  const stalePatch = await store.patch(order.orderId, {
    mindbodySaleId: "99999",
    syncAttempts: 0,
    mindbodySyncStatus: "client_found",
    fulfillmentClaimId: "ful_STALE",
  });
  check(
    "last-write-wins removed: sale/status/attempts/claim survive stale patch",
    stalePatch?.mindbodySaleId === "90011" &&
      stalePatch?.mindbodySyncStatus === "mindbody_synced" &&
      stalePatch?.syncAttempts === 1 &&
      stalePatch?.fulfillmentClaimId !== "ful_STALE",
  );
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  const sync = countingSync("90022");
  const [a, b] = await Promise.all([
    fulfillOneTimeMindbodySale(saleInput(store, order, { stripeEventId: "evt_completed_1", syncFn: sync.fn })),
    fulfillOneTimeMindbodySale(saleInput(store, order, { stripeEventId: "evt_async_succeeded_2", syncFn: sync.fn })),
  ]);
  const final = await store.get(order.orderId);
  const synced = [a, b].filter((r) => r.status === "mindbody_synced" && !r.noop);
  check("different event wrappers: 1 CheckoutShoppingCart", sync.calls === 1, `calls=${sync.calls}`);
  check("different event wrappers: 1 winner", synced.length === 1);
  check("different event wrappers: order-scoped sale", final?.mindbodySaleId === "90022");
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  let calls = 0;
  const failThenOk = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, reason: "missing_payment_method_id", message: "pre-request" };
    }
    return { ok: true, mindbodySaleId: "90033", mode: "custom" };
  };
  const first = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_pre_1", syncFn: failThenOk }),
  );
  const afterFail = await store.get(order.orderId);
  const second = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_pre_2", syncFn: failThenOk }),
  );
  const afterOk = await store.get(order.orderId);
  check("pre-request failure releases claim", first.status === "paid_but_not_synced" && afterFail?.mindbodySyncStatus === "paid_but_not_synced");
  check("pre-request failure allows later retry", second.status === "mindbody_synced" && afterOk?.mindbodySaleId === "90033");
  check("pre-request then success: 2 sync attempts, 1 sale", calls === 2 && afterOk?.syncAttempts === 2);
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  let calls = 0;
  const reject = async () => {
    calls += 1;
    return { ok: false, reason: "mindbody_sync_rejected", message: "service not sellable" };
  };
  const first = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_rej", syncFn: reject }),
  );
  const after = await store.get(order.orderId);
  check("explicit Mindbody rejection: no sale", first.status === "paid_but_not_synced" && !after?.mindbodySaleId);
  check("explicit Mindbody rejection: claim released", after?.mindbodySyncStatus === "paid_but_not_synced");
  check("explicit Mindbody rejection: 1 cart call", calls === 1);
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  let calls = 0;
  const timeout = async () => {
    calls += 1;
    return { ok: false, reason: "mindbody_sync_timeout", retryable: true, message: "timeout after send" };
  };
  const first = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_to_1", syncFn: timeout }),
  );
  const second = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_to_2", syncFn: timeout }),
  );
  const after = await store.get(order.orderId);
  check("timeout after request: UNKNOWN", first.status === "mindbody_sync_unknown" && after?.mindbodySyncStatus === "mindbody_sync_unknown");
  check("timeout after request: no automatic second cart", calls === 1 && second.noop === true);
  check("UNKNOWN auto-retry is off", second.status === "mindbody_sync_unknown");
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store);
  const sync = countingSync("90044");
  const crashed = await fulfillOneTimeMindbodySale(
    saleInput(store, order, {
      stripeEventId: "evt_crash",
      syncFn: sync.fn,
      crashAfterMindbodySuccess: true,
    }),
  );
  const mid = await store.get(order.orderId);
  const again = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_crash_retry", syncFn: sync.fn }),
  );
  const after = await store.get(order.orderId);
  check("crash after Mindbody success: local not synced", crashed.reason === "crash_after_mindbody_success" && mid?.mindbodySyncStatus === "mindbody_sync_claimed");
  check("crash after Mindbody success: no second cart", sync.calls === 1 && again.noop === true);
  check("crash after Mindbody success: not blindly reopened", after?.mindbodySyncStatus !== "mindbody_synced");
}

resetOrderStoreMemoryForTests();
store = openOrderStore();
{
  const order = await seedOrder(store, {
    mindbodySyncStatus: "mindbody_synced",
    mindbodySaleId: "25898",
    syncAttempts: 1,
    fulfillmentClaimId: "ful_DONE",
  });
  const sync = countingSync("90055");
  const result = await fulfillOneTimeMindbodySale(
    saleInput(store, order, { stripeEventId: "evt_redeliver", syncFn: sync.fn }),
  );
  const after = await store.get(order.orderId);
  check("already mindbody_synced: no-op", result.noop === true && result.status === "mindbody_synced");
  check("already mindbody_synced: no cart", sync.calls === 0);
  check("already mindbody_synced: sale id unchanged", after?.mindbodySaleId === "25898");
}

if (failed) {
  console.error(`\n${failed} one-time fulfillment claim check(s) failed`);
  process.exit(1);
}
console.log("\nOne-time fulfillment claim QA passed");
