/** Critical crash-window checks only. No Stripe or Mindbody calls. */
process.env.NETLIFY = "";
const realBlobs = (process.env.STRIPE_ORDER_STORE_BLOBS_QA || "").trim() === "1";
if (!realBlobs) process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY = "1";

const { newOrderId, openOrderStore, resetOrderStoreMemoryForTests } = await import("../netlify/functions/stripe-order-store.mjs");
const { fulfillSession, ONE_TIME_FULFILLMENT_SENT_GRACE_MS } = await import("../netlify/functions/stripe-webhook.mjs");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`PASS — ${name}`);
  else { failed += 1; console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`); }
}

resetOrderStoreMemoryForTests();
const store = openOrderStore();
if (!store.available) throw new Error(realBlobs ? "Real QA Blobs unavailable" : "Memory store unavailable");
const nowMs = Date.parse("2099-08-18T12:00:00.000Z");

async function claimedSent(label, sentMs) {
  const order = {
    orderId: newOrderId(),
    localSku: "drop_in_single_class",
    amountCents: 4000,
    currency: "usd",
    stripeCheckoutSessionId: `cs_critical_${label}_${Date.now()}`,
    stripePaymentStatus: "paid",
    mindbodySyncStatus: "client_found",
    knownMindbodyClientId: 100002726,
    resolvedMindbodyClientId: 100002726,
    createdAt: new Date(nowMs - 10_000).toISOString(),
    updatedAt: new Date(nowMs - 10_000).toISOString(),
  };
  await store.put(order);
  const attemptId = `ful_${label}_${Date.now()}`;
  const claim = await store.claimOneTimeFulfillment(order.orderId, { attemptId });
  const marked = await store.markOneTimeFulfillmentRequestSent(order.orderId, attemptId,
    claim.etag ? { record: claim.record, etag: claim.etag } : undefined);
  await store.mutate(order.orderId, (current) => ({ ...current, fulfillmentRequestSentAt: new Date(sentMs).toISOString() }));
  return { order: await store.get(order.orderId), attemptId, claim, marked };
}

function session(order) {
  return { id: order.stripeCheckoutSessionId, metadata: { orderId: order.orderId }, payment_status: "paid" };
}

let cartCalls = 0;
const syncFn = async () => { cartCalls += 1; throw new Error("cart must not run"); };
const decision = { stripeLivemode: false, behavior: "skip", mindbodyTest: true };

const recent = await claimedSent("RECENT", nowMs - 1_000);
const recentOut = await fulfillSession(session(recent.order), store, decision, { nowMs, syncFn });
const recentAfter = await store.get(recent.order.orderId);
check("recent claimed+sent is retryable", !recentOut.ok && recentOut.retryable === true);
check("recent claimed+sent preserves owner and sends no cart", cartCalls === 0 && recentAfter.fulfillmentClaimId === recent.attemptId && recentAfter.mindbodySyncStatus === "mindbody_sync_claimed");

const stale = await claimedSent("STALE", nowMs - ONE_TIME_FULFILLMENT_SENT_GRACE_MS - 1);
const staleOut = await fulfillSession(session(stale.order), store, decision, { nowMs, syncFn });
const staleAfter = await store.get(stale.order.orderId);
const reclaim = await store.claimOneTimeFulfillment(stale.order.orderId, { attemptId: `ful_RECLAIM_${Date.now()}` });
check("stale claimed+sent becomes unknown", staleOut.ok && staleOut.status === "mindbody_sync_unknown" && staleAfter.mindbodySyncStatus === "mindbody_sync_unknown");
check("stale claimed+sent sends no cart and cannot reclaim", cartCalls === 0 && reclaim.outcome === "UNKNOWN" && staleAfter.fulfillmentClaimId === stale.attemptId);

if (failed) process.exit(1);
console.log(`Critical crash-window QA passed (${realBlobs ? "real QA Blobs" : "memory"})`);
