/**
 * Focused regression for implicit Netlify Function Blob stores that use the
 * shared atomicUpdateJSON helper. The fake runtime intentionally provides an
 * edgeURL without uncachedEdgeURL, matching the production failure shape.
 *
 * No Stripe, Mindbody, or other external API is called.
 */
import http from "node:http";

const siteID = "implicit-prod-stores-qa-site";
/** @type {Map<string, { body: string; etag: string }>} */
const blobs = new Map();
/** @type {Array<{ method: string; key: string; ifMatch: string; ifNoneMatch: string }>} */
const requests = [];
let etagSequence = 0;

function nextEtag() {
  etagSequence += 1;
  return `"implicit-prod-stores-${etagSequence}"`;
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
    res.writeHead(400).end("invalid implicit stores QA path");
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
      (ifMatch && (!current || current.etag !== ifMatch))
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
if (!address || typeof address === "string") throw new Error("implicit stores QA server did not bind");

globalThis.netlifyBlobsContext = Buffer.from(
  JSON.stringify({
    edgeURL: `http://127.0.0.1:${address.port}`,
    siteID,
    token: "implicit-prod-stores-qa-token",
    // Deliberately no uncachedEdgeURL.
  }),
).toString("base64");
process.env.NETLIFY = "1";
process.env.GUEST_PASS_BLOBS = "1";
process.env.PARTNER_BENEFITS_BLOBS = "1";
process.env.SESSION_SECRET = "implicit-prod-stores-qa-secret";
delete process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY;
delete process.env.GUEST_PASS_BLOBS_LOCAL_MEMORY;
delete process.env.PARTNER_BENEFITS_BLOBS_LOCAL_MEMORY;

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function conditionalRequest(storeName, blobKey, condition) {
  return requests.find(
    (entry) =>
      entry.method === "PUT" &&
      entry.key.includes(storeName) &&
      entry.key.endsWith(`/${blobKey}`) &&
      Boolean(entry[condition]),
  );
}

try {
  const { atomicCreateJSON } = await import("../netlify/functions/blobs-conditional-create.mjs");
  const { openEventReservationStore } = await import(
    "../netlify/functions/event-reservation-store.mjs"
  );
  const { tryOpenGuestPassBlobStore } = await import(
    "../netlify/functions/guest-pass-blobs.mjs"
  );
  const { failGuestPassSlot, usageKey } = await import(
    "../netlify/functions/guest-pass-lib.mjs"
  );
  const { tryOpenPartnerBenefitsBlobStore } = await import(
    "../netlify/functions/partner-benefits-blobs.mjs"
  );
  const {
    benefitKey,
    confirmRedemption,
    hashToken,
    redemptionKey,
    tokenLookupKey,
  } = await import("../netlify/functions/partner-benefits-lib.mjs");

  const now = new Date().toISOString();
  const reservationId = "evt_implicit_runtime_qa";
  const reservations = openEventReservationStore({});
  const eventPut = await reservations.put(
    {
      id: reservationId,
      status: "deposit_pending",
      createdAt: now,
      updatedAt: now,
    },
    { onlyIfNew: true },
  );
  const eventPatch = await reservations.patch(reservationId, { status: "deposit_paid_pending_confirm" });
  const eventAfter = await reservations.get(reservationId);
  check(
    "event reservation CAS works without uncachedEdgeURL",
    reservations.available && eventPut.ok && eventPatch.ok && eventAfter?.status === "deposit_paid_pending_confirm",
  );
  check(
    "event reservation onlyIfNew preserved",
    Boolean(conditionalRequest("amare-event-reservations", reservationId, "ifNoneMatch")),
  );
  check(
    "event reservation onlyIfMatch preserved",
    Boolean(conditionalRequest("amare-event-reservations", reservationId, "ifMatch")),
  );

  const guestStore = tryOpenGuestPassBlobStore({});
  if (!guestStore) throw new Error("implicit guest-pass Blob store unavailable");
  const memberClientId = 910000001;
  const periodKey = "2099-01";
  const guestUsageKey = usageKey(memberClientId, periodKey);
  const guestSeed = await atomicCreateJSON(guestStore, guestUsageKey, {
    status: "pending",
    period: periodKey,
    memberClientId,
  });
  await failGuestPassSlot(guestStore, {
    memberClientId,
    periodKey,
    reservedKeys: [guestUsageKey],
    guestClientId: 910000002,
    restore: false,
  });
  const guestAfter = await guestStore.get(guestUsageKey, { type: "json" });
  check(
    "guest pass CAS works without uncachedEdgeURL",
    guestSeed.modified && guestAfter?.status === "failed_manual_review",
  );
  check(
    "guest pass onlyIfNew preserved",
    Boolean(conditionalRequest("guest-pass-records", guestUsageKey, "ifNoneMatch")),
  );
  check(
    "guest pass onlyIfMatch preserved",
    Boolean(conditionalRequest("guest-pass-records", guestUsageKey, "ifMatch")),
  );

  const benefitsStore = tryOpenPartnerBenefitsBlobStore({});
  if (!benefitsStore) throw new Error("implicit partner-benefits Blob store unavailable");
  const benefitId = "implicit-runtime-qa";
  const benefitPeriod = "2099-01";
  const benefitMemberClientId = 920000001;
  const token = "implicit-runtime-qa-token";
  const tokenHash = hashToken(token);
  const benefitRedemptionKey = redemptionKey(benefitId, benefitMemberClientId, benefitPeriod);
  await benefitsStore.setJSON(benefitKey(benefitId), {
    id: benefitId,
    partnerSlug: "implicit-runtime-qa",
    partnerDisplayName: "Runtime QA",
    title: "Runtime QA Benefit",
    active: true,
  });
  await benefitsStore.setJSON(benefitRedemptionKey, {
    id: "implicit-runtime-redemption",
    status: "pending",
    benefitId,
    partnerSlug: "implicit-runtime-qa",
    memberClientId: benefitMemberClientId,
    memberFirstName: "Runtime",
    memberLastInitial: "Q",
    periodKey: benefitPeriod,
    expiresAt: "2099-01-31T23:59:59-05:00",
    tokenHash,
  });
  await benefitsStore.setJSON(tokenLookupKey(tokenHash), {
    redemptionKey: benefitRedemptionKey,
    benefitId,
    expiresAt: "2099-01-31T23:59:59-05:00",
  });
  const redemption = await confirmRedemption(benefitsStore, token, "127.0.0.1");
  const benefitAfter = await benefitsStore.get(benefitRedemptionKey, { type: "json" });
  check(
    "partner benefits CAS works without uncachedEdgeURL",
    redemption.ok && benefitAfter?.status === "redeemed",
  );
  check(
    "partner benefits onlyIfMatch preserved",
    Boolean(conditionalRequest("partner-benefits", benefitRedemptionKey, "ifMatch")),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failed) process.exit(1);
console.log("Implicit production Blob stores QA passed");
