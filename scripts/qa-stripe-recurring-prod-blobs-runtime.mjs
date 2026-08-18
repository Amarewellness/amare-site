/**
 * Recurring-store production transport regression.
 *
 * Default mode reproduces the implicit Netlify Function Blobs transport: an
 * edge URL with no uncachedEdgeURL. Real QA mode uses isolated `-qa` stores
 * through the explicit API transport:
 *
 *   node scripts/qa-stripe-recurring-prod-blobs-runtime.mjs
 *   STRIPE_SUBSCRIPTION_STORE_BLOBS_QA=1 node scripts/qa-stripe-recurring-prod-blobs-runtime.mjs
 *
 * No Stripe or Mindbody API is called. The fulfillment step is a local mock.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

const REAL_BLOBS_QA = (process.env.STRIPE_SUBSCRIPTION_STORE_BLOBS_QA || "").trim() === "1";
const siteID = "recurring-runtime-qa-site";
/** @type {Map<string, { body: string; etag: string }>} */
const blobs = new Map();
/** @type {Array<{ method: string; key: string; ifMatch: string; ifNoneMatch: string }>} */
const requests = [];
const rejectMatchedWrites = new Set();
let etagSequence = 0;
/** @type {http.Server | null} */
let server = null;

function nextEtag() {
  etagSequence += 1;
  return `"recurring-runtime-${etagSequence}"`;
}

/** @param {http.IncomingMessage} req */
async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (REAL_BLOBS_QA) {
  delete process.env.NETLIFY;
  delete process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY;
  delete globalThis.netlifyBlobsContext;
} else {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const requestSiteID = parts.shift();
    const storeName = parts.shift();
    const blobKey = parts.join("/");
    if (requestSiteID !== siteID || !storeName || !blobKey) {
      res.writeHead(400).end("invalid recurring runtime QA path");
      return;
    }

    const key = `${storeName}/${blobKey}`;
    const method = String(req.method || "GET").toUpperCase();
    const ifMatch = String(req.headers["if-match"] || "");
    const ifNoneMatch = String(req.headers["if-none-match"] || "");
    requests.push({ method, key, ifMatch, ifNoneMatch });

    if (method === "GET" || method === "HEAD") {
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
      blobs.set(key, { body: await requestBody(req), etag: nextEtag() });
      res.writeHead(200).end();
      return;
    }

    res.writeHead(405).end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("recurring runtime QA server did not bind");
  globalThis.netlifyBlobsContext = Buffer.from(
    JSON.stringify({
      edgeURL: `http://127.0.0.1:${address.port}`,
      siteID,
      token: "recurring-runtime-qa-token",
      // Deliberately no uncachedEdgeURL: this is the production failure shape.
    }),
  ).toString("base64");
  process.env.NETLIFY = "1";
  delete process.env.STRIPE_SUBSCRIPTION_STORE_BLOBS_QA;
  delete process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY;
}

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

try {
  const { openSubscriptionStore } = await import(
    "../netlify/functions/stripe-subscription-store.mjs"
  );
  const store = openSubscriptionStore({});
  if (!store.available) {
    throw new Error(REAL_BLOBS_QA ? "explicit real QA Blobs unavailable" : "implicit Function Blobs unavailable");
  }

  const suffix = randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase();
  const subscriptionId = `sub_amare_RT${suffix}`;
  const stripeSubscriptionId = `sub_RT${suffix}`;
  const checkoutSessionId = `cs_runtime_${suffix}`;
  const invoiceId = `in_runtime_${suffix}`;
  const raceInvoiceId = `in_race_${suffix}`;
  const now = new Date().toISOString();
  const record = {
    id: subscriptionId,
    stripeSubscriptionId: `pending_${subscriptionId}`,
    stripeCustomerId: `cus_RT${suffix}`,
    stripeCheckoutSessionId: checkoutSessionId,
    localSku: "monthly_5",
    displayName: "Monthly 5 Classes",
    monthlyAmountCents: 12500,
    currency: "usd",
    mindbodyClientId: 100003724,
    mindbodyServiceId: 100133,
    mindbodyContractProductId: "101",
    minimumCommitmentMonths: 3,
    earlyCancellationFeePercent: 50,
    commitmentStartDate: now,
    commitmentEndDate: now,
    earlyCancellationFeeCents: 6250,
    membershipConsentId: `${subscriptionId}_qa`,
    agreementVersion: "runtime-qa",
    agreementTextHash: "runtime-qa",
    agreementAcceptedAt: now,
    legalNameTyped: "Runtime QA",
    clientIp: "127.0.0.1",
    userAgent: "recurring-runtime-qa",
    status: "pending_first_invoice",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAt: null,
    canceledAt: null,
    cancellationReason: null,
    invoices: [],
    createdAt: now,
    updatedAt: now,
    stripeLivemode: false,
  };

  const put = await store.put(record, { onlyIfNew: true });
  const patched = await store.patch(subscriptionId, {
    stripeSubscriptionId,
    stripeLivemode: true,
  });
  await store.bindStripeSubscription(stripeSubscriptionId, subscriptionId);
  const resolved = await store.getByStripeSubscriptionId(stripeSubscriptionId);
  check(
    `${REAL_BLOBS_QA ? "explicit strong QA" : "implicit Function"} invoice.paid record patch works`,
    put.ok && patched?.stripeSubscriptionId === stripeSubscriptionId && resolved?.id === subscriptionId,
  );

  const claim = await store.claimInvoiceSlot(subscriptionId, invoiceId, {
    sourceEventId: `evt_${suffix}`,
  });
  let fulfillmentCalls = 0;
  if (claim.ok && claim.acquired) {
    fulfillmentCalls += 1;
    const appended = await store.appendInvoiceSync(subscriptionId, {
      invoiceId,
      amountPaidCents: 12500,
      currency: "usd",
      status: "synced",
      attempts: 1,
      firstAttemptAt: now,
      lastAttemptAt: now,
      mindbodySaleId: "runtime-mock-sale",
      adminRetryRequired: false,
    });
    await store.patch(subscriptionId, { status: appended.ok ? "active" : "pending_first_invoice" });
  }
  const afterFulfillment = await store.get(subscriptionId);
  check("invoice claim acquired", claim.ok && claim.acquired === true);
  check(
    "fulfillment can proceed after patch and claim",
    fulfillmentCalls === 1 &&
      afterFulfillment?.status === "active" &&
      afterFulfillment?.invoices?.some((entry) => entry.invoiceId === invoiceId && entry.status === "synced"),
  );

  let competingFulfillmentCalls = 0;
  const competingClaims = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.claimInvoiceSlot(subscriptionId, raceInvoiceId, {
        sourceEventId: `evt_race_${suffix}`,
      }),
    ),
  );
  for (const candidate of competingClaims) {
    if (candidate.ok && candidate.acquired) competingFulfillmentCalls += 1;
  }
  check(
    "competing invoice events fulfill at most once",
    competingClaims.every((candidate) => candidate.ok) && competingFulfillmentCalls === 1,
    `fulfillmentCalls=${competingFulfillmentCalls}`,
  );

  if (!REAL_BLOBS_QA) {
    const recordKey = `site:stripe-mindbody-subscriptions/v1/${subscriptionId}`;
    const claimKey = `site:stripe-mindbody-invoice-claims/claim/${subscriptionId}/${invoiceId}`;
    const successfulCasWrite = requests.find(
      (entry) => entry.key === recordKey && entry.method === "PUT" && entry.ifMatch,
    );
    const claimCreate = requests.find(
      (entry) => entry.key === claimKey && entry.method === "PUT",
    );
    check("onlyIfNew invoice claim preserved", claimCreate?.ifNoneMatch === "*");
    check("onlyIfMatch CAS preserved", Boolean(successfulCasWrite?.ifMatch));

    rejectMatchedWrites.add(recordKey);
    const beforeStale = await store.get(subscriptionId);
    const stalePatch = await store.patch(subscriptionId, { cancelAt: "2099-01-01T00:00:00.000Z" });
    const afterStale = await store.get(subscriptionId);
    rejectMatchedWrites.delete(recordKey);
    check(
      "stale ETag fails closed",
      stalePatch === null && afterStale?.cancelAt === beforeStale?.cancelAt,
    );
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}

if (failed) process.exit(1);
console.log(
  `Recurring production-runtime Blobs QA passed (${REAL_BLOBS_QA ? "real QA Blobs" : "implicit Function"})`,
);
