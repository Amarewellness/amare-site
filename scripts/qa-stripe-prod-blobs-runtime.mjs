/**
 * Reproduces the production Netlify Functions Blobs transport: an implicit
 * edge store with no uncachedEdgeURL. All external side effects are mocked.
 */
import http from "node:http";

const siteID = "runtime-qa-site";
/** @type {Map<string, { body: string; etag: string }>} */
const blobs = new Map();
/** @type {Array<{ method: string; key: string; ifMatch: string; ifNoneMatch: string; resultEtag?: string }>} */
const requests = [];
const rejectMatchedWrites = new Set();
/** @type {Map<string, number>} */
const transientReadMisses = new Map();
let etagSequence = 0;

function nextEtag() {
  etagSequence += 1;
  return `"runtime-${etagSequence}"`;
}

/** @param {http.IncomingMessage} req */
async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const requestSiteID = parts.shift();
  const storeName = parts.shift();
  const blobKey = parts.join("/");
  if (requestSiteID !== siteID || !storeName || !blobKey) {
    res.writeHead(400).end("invalid runtime QA path");
    return;
  }
  const key = `${storeName}/${blobKey}`;
  const method = String(req.method || "GET").toUpperCase();
  const ifMatch = String(req.headers["if-match"] || "");
  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  const log = { method, key, ifMatch, ifNoneMatch };
  requests.push(log);

  if (method === "GET" || method === "HEAD") {
    const misses = transientReadMisses.get(key) || 0;
    if (misses > 0) {
      transientReadMisses.set(key, misses - 1);
      res.writeHead(404).end();
      return;
    }
    const current = blobs.get(key);
    if (!current) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("etag", current.etag);
    res.setHeader("content-type", "application/json");
    res.writeHead(200).end(method === "HEAD" ? undefined : current.body);
    return;
  }

  if (method === "PUT") {
    const current = blobs.get(key);
    if (
      (ifNoneMatch === "*" && current) ||
      (ifMatch && (!current || current.etag !== ifMatch)) ||
      (ifMatch && rejectMatchedWrites.has(key))
    ) {
      res.writeHead(412).end();
      return;
    }
    const etag = nextEtag();
    blobs.set(key, { body: await requestBody(req), etag });
    log.resultEtag = etag;
    res.setHeader("etag", etag);
    res.writeHead(200).end();
    return;
  }

  if (method === "DELETE") {
    blobs.delete(key);
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("runtime QA server did not bind");
globalThis.netlifyBlobsContext = Buffer.from(
  JSON.stringify({
    edgeURL: `http://127.0.0.1:${address.port}`,
    siteID,
    token: "runtime-qa-token",
    // Deliberately no uncachedEdgeURL: this matches the failing production runtime.
  }),
).toString("base64");
process.env.NETLIFY = "1";
delete process.env.STRIPE_ORDER_STORE_BLOBS_QA;
delete process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY;

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

try {
  const { newOrderId, openOrderStore } = await import("../netlify/functions/stripe-order-store.mjs");
  const { fulfillOneTimeMindbodySale } = await import(
    "../netlify/functions/stripe-onetime-fulfillment.mjs"
  );
  const { fulfillSession } = await import("../netlify/functions/stripe-webhook.mjs");
  const { handler: orderStatusHandler } = await import(
    "../netlify/functions/stripe-order-status.mjs"
  );

  const store = openOrderStore({});
  if (!store.available) throw new Error("implicit Function Blob store unavailable");

  async function seedOrder(status = "client_found", overrides = {}) {
    const orderId = newOrderId();
    const sessionId = `cs_runtime_${orderId.slice(4).toLowerCase()}`;
    const record = {
      orderId,
      localSku: "drop_in_single_class",
      amountCents: 4000,
      currency: "usd",
      stripeCheckoutSessionId: sessionId,
      stripePaymentStatus: status === "checkout_created" ? undefined : "paid",
      mindbodySyncStatus: status,
      knownMindbodyClientId: 100002726,
      resolvedMindbodyClientId: 100002726,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    const put = await store.put(record, { onlyIfNew: true });
    await store.bindSession(sessionId, orderId);
    return { record, put };
  }

  function saleInput(order, syncFn) {
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
      item: {
        localSku: "drop_in_single_class",
        amountCents: 4000,
        currency: "usd",
        mindbodyServiceId: 100011,
        displayName: "Drop-In",
      },
      syncFn,
    };
  }

  const pending = await seedOrder("checkout_created");
  const pendingById = await store.get(pending.record.orderId);
  const pendingRead = await store.getByCheckoutSessionId(pending.record.stripeCheckoutSessionId);
  check(
    "A implicit Function store reads without strong transport",
    pending.put.ok && pendingRead?.orderId === pending.record.orderId,
  );
  check(
    "lookup by orderId uses supported consistency",
    pendingById?.orderId === pending.record.orderId,
  );
  check(
    "lookup by checkoutSessionId uses supported consistency",
    pendingRead?.orderId === pending.record.orderId,
  );

  {
    const { getStore } = await import("@netlify/blobs");
    let strongThrew = false;
    let strongDetail = "";
    try {
      const raw = getStore({ name: "stripe-mindbody-orders", consistency: "eventual" });
      await raw.get(`v1/${pending.record.orderId}`, { type: "json", consistency: "strong" });
    } catch (e) {
      strongThrew = true;
      strongDetail = String(/** @type {{ message?: string }} */ (e)?.message ?? e);
    }
    check(
      "implicit runtime rejects unsupported strong reads",
      strongThrew && /uncachedEdgeURL|strong consistency/i.test(strongDetail),
      strongDetail.slice(0, 180),
    );
  }

  const statusResponse = await orderStatusHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { session_id: pending.record.stripeCheckoutSessionId },
  });
  const statusBody = JSON.parse(statusResponse.body || "null");
  check(
    "F pending order-status returns order, package and amount",
    statusResponse.statusCode === 200 &&
      statusBody?.order?.orderId === pending.record.orderId &&
      statusBody?.order?.localSku === "drop_in_single_class" &&
      statusBody?.order?.amountCents === 4000 &&
      statusBody?.order?.bucket !== "synced",
  );

  const statusByOrderId = await orderStatusHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { orderId: pending.record.orderId },
  });
  const statusByOrderBody = JSON.parse(statusByOrderId.body || "null");
  check(
    "order-status lookup by orderId returns the existing order",
    statusByOrderId.statusCode === 200 &&
      statusByOrderBody?.order?.orderId === pending.record.orderId &&
      statusByOrderBody?.order?.amountCents === 4000,
  );

  const transient = await seedOrder();
  const transientOrderKey = `site:stripe-mindbody-orders/v1/${transient.record.orderId}`;
  const transientIndexKey =
    `site:stripe-mindbody-orders-by-session/v1/${transient.record.stripeCheckoutSessionId}`;
  transientReadMisses.set(transientOrderKey, 1);
  transientReadMisses.set(transientIndexKey, 1);
  let transientCartCalls = 0;
  const transientOutcome = await fulfillSession(
    {
      id: transient.record.stripeCheckoutSessionId,
      payment_status: "paid",
      metadata: {
        orderId: transient.record.orderId,
        localSku: transient.record.localSku,
      },
    },
    store,
    { stripeLivemode: true, behavior: "live", mindbodyTest: false },
    {
      syncFn: async () => {
        transientCartCalls += 1;
        return { ok: true, mindbodySaleId: "must-not-run" };
      },
    },
  );
  check(
    "A transient read miss does not throw an unsupported strong-read error",
    transientOutcome != null &&
      transientOutcome.reason !== "fulfill_exception" &&
      !/uncachedEdgeURL|strong consistency/i.test(String(transientOutcome.reason || "")) &&
      transientCartCalls === 0,
    transientOutcome.reason || "",
  );

  const handoff = await seedOrder();
  const claim = await store.claimOneTimeFulfillment(handoff.record.orderId, {
    attemptId: "ful_RUNTIME_HANDOFF",
  });
  const marked = await store.markOneTimeFulfillmentRequestSent(
    handoff.record.orderId,
    "ful_RUNTIME_HANDOFF",
    claim.ok && claim.outcome === "CLAIMED" && claim.etag
      ? { record: claim.record, etag: claim.etag }
      : undefined,
  );
  const completed = await store.completeOneTimeFulfillment(
    handoff.record.orderId,
    "ful_RUNTIME_HANDOFF",
    { mindbodySaleId: "runtime-handoff-sale", resolvedMindbodyClientId: 100002726 },
    marked.ok && marked.etag ? { record: marked.record, etag: marked.etag } : undefined,
  );
  const handoffAfter = await store.get(handoff.record.orderId);
  const claimKey = `site:stripe-mindbody-order-fulfillment-claims/claim/v1/${handoff.record.orderId}`;
  const orderKey = `site:stripe-mindbody-orders/v1/${handoff.record.orderId}`;
  const claimCreate = requests.find((entry) => entry.key === claimKey && entry.method === "PUT");
  const orderCasWrites = requests.filter(
    (entry) => entry.key === orderKey && entry.method === "PUT" && entry.ifMatch,
  );
  check(
    "B new order claim uses onlyIfNew mutex",
    claim.ok && claim.outcome === "CLAIMED" && claimCreate?.ifNoneMatch === "*",
  );
  check(
    "C fresh claim ETag is handed directly to mark-request-sent",
    marked.ok &&
      Boolean(claim.etag) &&
      orderCasWrites.length >= 2 &&
      orderCasWrites[1].ifMatch === claim.etag &&
      Boolean(handoffAfter?.fulfillmentRequestSentAt),
  );
  check(
    "C fresh mark-request-sent ETag is handed directly to completion",
    completed.ok &&
      Boolean(marked.etag) &&
      orderCasWrites.length >= 3 &&
      orderCasWrites[2].ifMatch === marked.etag &&
      handoffAfter?.mindbodySyncStatus === "mindbody_synced",
  );

  const autoBookOrder = await seedOrder("client_found", {
    purchaseSource: "classes",
    selectedClassContext: {
      classId: 14956,
      reportedClassStartIso: "2099-08-28T11:00:00",
      className: "Runtime QA Class",
      capturedAt: new Date().toISOString(),
    },
    classesAutoBook: { status: "pending" },
  });
  let autoBookCalls = 0;
  let autoBookSawSynced = false;
  const autoBookOutcome = await fulfillSession(
    {
      id: autoBookOrder.record.stripeCheckoutSessionId,
      payment_status: "paid",
      payment_intent: "pi_runtime_autobook",
      amount_total: 4000,
      amount_subtotal: 4000,
      total_details: { amount_discount: 0 },
      metadata: { orderId: autoBookOrder.record.orderId, localSku: autoBookOrder.record.localSku },
      customer_details: { email: "runtime-qa@example.com", name: "Runtime QA" },
    },
    store,
    { stripeLivemode: true, behavior: "live", mindbodyTest: false },
    {
      resolveMindbodyClient: async () => ({
        ok: true,
        clientId: 100002726,
        clientCreated: false,
        email: "runtime-qa@example.com",
      }),
      syncFn: async () => ({ ok: true, mindbodySaleId: "runtime-auto-book-sale", mode: "custom" }),
      autoBookAfterSyncFn: async (autoBookStore, orderId) => {
        autoBookCalls += 1;
        const current = await autoBookStore.get(orderId);
        autoBookSawSynced = current?.mindbodySyncStatus === "mindbody_synced";
        return { attempted: true, status: "booked" };
      },
    },
  );
  const autoBookAfter = await store.get(autoBookOrder.record.orderId);
  check(
    "successful purchase persists synced on implicit runtime",
    autoBookOutcome.ok &&
      autoBookOutcome.status === "mindbody_synced" &&
      autoBookAfter?.mindbodySyncStatus === "mindbody_synced",
  );

  const dupOrder = await seedOrder();
  let dupCart = 0;
  const dupSession = {
    id: dupOrder.record.stripeCheckoutSessionId,
    payment_status: "paid",
    payment_intent: "pi_runtime_dup",
    amount_total: 4000,
    amount_subtotal: 4000,
    total_details: { amount_discount: 0 },
    metadata: { orderId: dupOrder.record.orderId, localSku: dupOrder.record.localSku },
    customer_details: { email: "runtime-qa@example.com", name: "Runtime QA" },
  };
  const dupCtx = { stripeLivemode: true, behavior: "live", mindbodyTest: false };
  const dupDeps = {
    resolveMindbodyClient: async () => ({
      ok: true,
      clientId: 100002726,
      clientCreated: false,
      email: "runtime-qa@example.com",
    }),
    syncFn: async () => {
      dupCart += 1;
      return { ok: true, mindbodySaleId: "runtime-dup-sale", mode: "custom" };
    },
  };
  const firstDup = await fulfillSession(dupSession, store, dupCtx, dupDeps);
  const secondDup = await fulfillSession(dupSession, store, dupCtx, dupDeps);
  const dupAfter = await store.get(dupOrder.record.orderId);
  check(
    "duplicate webhook is idempotent",
    firstDup.ok &&
      secondDup.ok &&
      dupCart === 1 &&
      dupAfter?.mindbodySyncStatus === "mindbody_synced" &&
      dupAfter?.mindbodySaleId === "runtime-dup-sale",
    `cart=${dupCart} first=${firstDup.status} second=${secondDup.status}`,
  );

  const unresolvedOrder = await seedOrder();
  const unresolvedStore = {
    ...store,
    completeOneTimeFulfillment: async () => ({ ok: false, reason: "max_retries_exhausted" }),
    markOneTimeFulfillmentUnknown: async () => ({
      ok: false,
      reason: "max_retries_exhausted",
    }),
  };
  const unresolvedOutcome = await fulfillSession(
    {
      id: unresolvedOrder.record.stripeCheckoutSessionId,
      payment_status: "paid",
      payment_intent: "pi_runtime_unresolved",
      amount_total: 4000,
      amount_subtotal: 4000,
      total_details: { amount_discount: 0 },
      metadata: { orderId: unresolvedOrder.record.orderId, localSku: unresolvedOrder.record.localSku },
      customer_details: { email: "runtime-qa@example.com", name: "Runtime QA" },
    },
    unresolvedStore,
    { stripeLivemode: true, behavior: "live", mindbodyTest: false },
    {
      resolveMindbodyClient: async () => ({
        ok: true,
        clientId: 100002726,
        clientCreated: false,
        email: "runtime-qa@example.com",
      }),
      syncFn: async () => ({ ok: true, mindbodySaleId: "runtime-unresolved-sale", mode: "custom" }),
    },
  );
  check(
    "unresolved post-sale completion does not throw on implicit blob reads",
    unresolvedOutcome != null &&
      unresolvedOutcome.status !== undefined &&
      !/uncachedEdgeURL|strong consistency/i.test(String(unresolvedOutcome.reason || "")),
    unresolvedOutcome.reason || unresolvedOutcome.status || "",
  );

  const stale = await seedOrder();
  const staleOrderKey = `site:stripe-mindbody-orders/v1/${stale.record.orderId}`;
  rejectMatchedWrites.add(staleOrderKey);
  let staleCartCalls = 0;
  const staleOutcome = await fulfillOneTimeMindbodySale(
    saleInput(stale.record, async () => {
      staleCartCalls += 1;
      return { ok: true, mindbodySaleId: "must-not-run" };
    }),
  );
  check(
    "D stale ETag fails closed and remains retryable",
    !staleOutcome.ok && staleOutcome.retryable === true && staleCartCalls === 0,
    staleOutcome.reason || "",
  );
  rejectMatchedWrites.delete(staleOrderKey);

  const concurrent = await seedOrder();
  let cartCalls = 0;
  const syncFn = async () => {
    cartCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      mindbodySaleId: "runtime-sale-1",
      mindbodyTransactionId: null,
      responseSummary: "runtime QA",
      mode: "custom",
    };
  };
  await Promise.all(
    Array.from({ length: 6 }, () =>
      fulfillOneTimeMindbodySale(saleInput(concurrent.record, syncFn)),
    ),
  );
  const concurrentAfter = await store.get(concurrent.record.orderId);
  check(
    "E competing workers send at most one cart",
    cartCalls === 1 && concurrentAfter?.mindbodySyncStatus === "mindbody_synced",
    `cartCalls=${cartCalls}`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failed) process.exit(1);
console.log("Production-runtime Blobs QA passed");
