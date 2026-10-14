import { createHash } from "node:crypto";
import {
  membershipConsentBlobKey,
  tryOpenMembershipConsentBlobStore,
} from "./membership-consent-blobs.mjs";
import {
  sha256HexUtf8,
  stripScriptsConsentHtml,
} from "./mindbody-membership-electronic-consent.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";

const CONSENT_STATUSES = [
  "pending_first_invoice",
  "active",
  "past_due",
  "canceled_admin",
  "canceled_payment_failure",
];

/** @param {unknown} raw */
export function consentIdFromBlobKey(key) {
  const k = String(key || "").trim();
  if (!k.startsWith("v1/")) return "";
  return k.slice(3);
}

/** @param {Record<string, unknown>} rec */
export function snapshotFromConsentRecord(rec) {
  const a =
    typeof rec.agreementTextSnapshot === "string"
      ? rec.agreementTextSnapshot
      : typeof rec.termsHtmlSnapshot === "string"
        ? rec.termsHtmlSnapshot
        : "";
  return a.trim();
}

/** @param {Record<string, unknown>} rec */
export function hashFromConsentRecord(rec) {
  const h =
    typeof rec.agreementTextHash === "string"
      ? rec.agreementTextHash
      : typeof rec.termsTextHash === "string"
        ? rec.termsTextHash
        : "";
  return h.trim();
}

/** @param {string} html */
export function htmlToPlainText(html) {
  let s = String(html || "");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/\s*p\s*>/gi, "\n\n");
  s = s.replace(/<\s*p\b[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** @param {string} html */
export function sanitizeTermsForAdminDisplay(html) {
  return stripScriptsConsentHtml(String(html || "")).trim();
}

/**
 * @param {Record<string, unknown>} rec
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord | null} [sub]
 */
export function verifyStoredTermsHash(rec, sub) {
  const snap = snapshotFromConsentRecord(rec);
  const stored =
    hashFromConsentRecord(rec) ||
    (sub && typeof sub.agreementTextHash === "string" ? sub.agreementTextHash.trim() : "");
  if (!snap || snap.length < 80) {
    return { ok: false, storedHash: stored, computedHash: "", reason: "missing_snapshot" };
  }
  const sanitized = sanitizeTermsForAdminDisplay(snap);
  const computed = sha256HexUtf8(sanitized);
  if (!stored) {
    return { ok: false, storedHash: "", computedHash: computed, reason: "missing_stored_hash" };
  }
  return {
    ok: computed === stored,
    storedHash: stored,
    computedHash: computed,
    reason: computed === stored ? null : "hash_mismatch",
  };
}

/**
 * @param {Record<string, unknown>} rec
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord | null} sub
 * @param {boolean} blobExists
 */
export function evidenceLabel(rec, sub, blobExists) {
  const snap = rec ? snapshotFromConsentRecord(rec) : "";
  const hash = (rec ? hashFromConsentRecord(rec) : "") || sub?.agreementTextHash || "";
  const accepted =
    (rec && (rec.acceptedAt || rec.auditCreatedAt)) || sub?.agreementAcceptedAt || null;
  const linkage = Boolean(
    sub?.stripeSubscriptionId ||
      sub?.id ||
      rec?.subscriptionId ||
      rec?.mindbodyClientId ||
      sub?.mindbodyClientId,
  );
  const snapshotInRecord = snap.length >= 80;
  /** List view omits blob body; blob key + sub hash/time/linkage implies stored snapshot. */
  const snapshotIndicated = snapshotInRecord || (blobExists && Boolean(hash));
  if (snapshotIndicated && hash && accepted && linkage) return "STRONG_RECORD";
  if (blobExists || hash || rec?.contractVersion || sub?.agreementVersion) return "PARTIAL_RECORD";
  return "NO_AMARE_RECORD";
}

/** @param {string | null | undefined} flow @param {import("./stripe-subscription-store.mjs").SubscriptionRecord | null} sub */
export function formatConsentSource(flow, sub) {
  const cta = sub?.ctaLocation ? String(sub.ctaLocation) : "";
  if (cta.includes("app_purchase") || cta.includes("app")) return "App";
  if (cta.includes("pricing") || cta.includes("classes")) return "Website";
  const f = String(flow || "").toLowerCase();
  if (f.includes("website")) return "Website";
  if (f.includes("purchase_contract") || f.includes("mindbody")) return "Website (Mindbody flow)";
  return cta || flow || "—";
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function listConsentBlobKeys(event) {
  const store = tryOpenMembershipConsentBlobStore(event);
  if (!store) return [];
  /** @type {string[]} */
  const keys = [];
  try {
    const pages = store.list({ paginate: true });
    for await (const page of pages) {
      for (const b of page?.blobs ?? []) {
        if (typeof b?.key === "string") keys.push(b.key);
      }
    }
  } catch {
    return keys;
  }
  return keys;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ maxPerStatus?: number }} [opts]
 */
export async function loadSubscriptionIndex(event, opts = {}) {
  const subStore = openSubscriptionStore(event);
  const maxPerStatus = Math.min(Math.max(Number(opts.maxPerStatus) || 500, 1), 500);
  /** @type {Map<string, import("./stripe-subscription-store.mjs").SubscriptionRecord>} */
  const byConsentId = new Map();
  /** @type {Map<number, import("./stripe-subscription-store.mjs").SubscriptionRecord[]>} */
  const byMindbodyClientId = new Map();
  /** @type {import("./stripe-subscription-store.mjs").SubscriptionRecord[]} */
  const all = [];

  if (!subStore.available) {
    return { byConsentId, byMindbodyClientId, all, subStoreAvailable: false };
  }

  for (const status of CONSENT_STATUSES) {
    const batch = await subStore.listByStatus(status, { limit: maxPerStatus });
    for (const r of batch) {
      if (!r?.id) continue;
      if (all.some((x) => x.id === r.id)) continue;
      all.push(r);
      if (r.membershipConsentId) byConsentId.set(String(r.membershipConsentId), r);
      const cid = Number(r.mindbodyClientId);
      if (Number.isFinite(cid) && cid > 0) {
        const arr = byMindbodyClientId.get(cid) || [];
        arr.push(r);
        byMindbodyClientId.set(cid, arr);
      }
    }
  }
  return { byConsentId, byMindbodyClientId, all, subStoreAvailable: true };
}

/**
 * @param {import("@netlify/blobs").Store} store
 * @param {string} consentId
 */
export async function getConsentBlobRecord(store, consentId) {
  const id = String(consentId || "").trim();
  if (!id) return null;
  try {
    const raw = await store.get(membershipConsentBlobKey(id), { type: "json" });
    return raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} rec
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord | null} sub
 * @param {boolean} blobExists
 */
export function toListRow(rec, sub, blobExists) {
  const consentId =
    String(rec.consentId || sub?.membershipConsentId || "").trim() ||
    consentIdFromBlobKey(rec._blobKey || "");
  const snap = snapshotFromConsentRecord(rec);
  const acceptedAt =
    String(rec.acceptedAt || rec.auditCreatedAt || sub?.agreementAcceptedAt || "").trim() || null;
  const version =
    String(rec.contractVersion || sub?.agreementVersion || "").trim() || null;
  const localSku = String(rec.localSku || sub?.localSku || "").trim() || null;
  const catalog = localSku ? getCatalogItem(localSku) : null;
  const planLabel = catalog?.displayName || localSku || "—";
  const label = evidenceLabel(rec, sub, blobExists);
  const purchaseStatus = sub?.status || String(rec.checkoutStatus || "") || "—";
  const stripeSub =
    sub?.stripeSubscriptionId && !String(sub.stripeSubscriptionId).startsWith("pending_")
      ? sub.stripeSubscriptionId
      : null;

  let applicability = "CONSENT_FOUND";
  if (label === "NO_AMARE_RECORD") applicability = "NO_AMARE_CONSENT_RECORD";

  return {
    consentId,
    clientName: sub?.customerName || String(rec.fullNameTyped || rec.legalNameTyped || "").trim() || "—",
    email: sub?.customerEmail || "—",
    planLabel,
    localSku,
    acceptedAt,
    termsVersion: version,
    purchaseStatus,
    source: formatConsentSource(String(rec.flow || rec.source || ""), sub),
    stripeSubscriptionId: stripeSub,
    mindbodyClientId: sub?.mindbodyClientId ?? rec.mindbodyClientId ?? null,
    evidenceLabel: label,
    applicability,
    hashPresent: Boolean(hashFromConsentRecord(rec) || sub?.agreementTextHash),
    snapshotPresent: snap.length >= 80 || (blobExists && Boolean(sub?.agreementTextHash)),
    subscriptionId: sub?.id || rec.subscriptionId || null,
  };
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {Record<string, string | undefined>} q
 */
export async function buildConsentList(event, q) {
  const page = Math.max(1, parseInt(String(q.page || "1"), 10) || 1);
  const limit = Math.min(Math.max(parseInt(String(q.limit || "25"), 10) || 25, 1), 100);

  const consentStore = tryOpenMembershipConsentBlobStore(event);
  const blobKeys = consentStore ? await listConsentBlobKeys(event) : [];
  const blobKeySet = new Set(blobKeys);
  const { byConsentId, all, subStoreAvailable } = await loadSubscriptionIndex(event);

  const qConsent = (q.consentId || q.consent_id || "").trim();
  const qStripe = (q.stripeSubscriptionId || q.stripe_subscription_id || q.stripeSub || "").trim();
  const qClient = (q.mindbodyClientId || q.mindbody_client_id || q.clientId || "").trim();
  const qEmail = (q.email || "").trim().toLowerCase();
  const qName = (q.name || q.clientName || "").trim().toLowerCase();
  const qText = (q.q || "").trim().toLowerCase();

  /** @type {Set<string>} */
  let targetConsentIds = new Set();

  if (qConsent) {
    targetConsentIds.add(qConsent);
  } else if (qStripe && subStoreAvailable) {
    const subStore = openSubscriptionStore(event);
    const sub = await subStore.getByStripeSubscriptionId(qStripe);
    if (sub?.membershipConsentId) targetConsentIds.add(String(sub.membershipConsentId));
    else if (sub) targetConsentIds.add(`__sub_only__${sub.id}`);
  } else if (qClient && /^\d+$/.test(qClient)) {
    const cid = parseInt(qClient, 10);
    const subs = (await loadSubscriptionIndex(event)).byMindbodyClientId.get(cid) || [];
    for (const s of subs) {
      if (s.membershipConsentId) targetConsentIds.add(String(s.membershipConsentId));
    }
  } else {
    for (const key of blobKeys) {
      const id = consentIdFromBlobKey(key);
      if (id) targetConsentIds.add(id);
    }
    for (const s of all) {
      if (s.membershipConsentId) targetConsentIds.add(String(s.membershipConsentId));
    }
  }

  /** @type {ReturnType<typeof toListRow>[]} */
  const rows = [];
  for (const consentId of targetConsentIds) {
    if (consentId.startsWith("__sub_only__")) continue;
    const blobKey = membershipConsentBlobKey(consentId);
    const blobExists = blobKeySet.has(blobKey);
    const sub = byConsentId.get(consentId) || null;
    /** List view: subscription + blob index only — no full snapshot load. */
    const rec = /** @type {Record<string, unknown>} */ ({ consentId });
    const row = toListRow(rec, sub, blobExists);
    if (qEmail && row.email !== "—" && !String(row.email).toLowerCase().includes(qEmail)) continue;
    if (qName && !String(row.clientName).toLowerCase().includes(qName)) continue;
    if (qText) {
      const hay = [
        row.clientName,
        row.email,
        row.consentId,
        row.stripeSubscriptionId,
        String(row.mindbodyClientId ?? ""),
        row.localSku,
        row.planLabel,
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(qText)) continue;
    }
    rows.push(row);
  }

  rows.sort((a, b) => String(b.acceptedAt || "").localeCompare(String(a.acceptedAt || "")));
  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  return {
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    consentStoreAvailable: Boolean(consentStore),
    subStoreAvailable,
    items: pageRows,
  };
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {string} consentId
 */
export async function buildConsentDetail(event, consentId) {
  const id = String(consentId || "").trim();
  if (!id) return { ok: false, error: "missing_consent_id" };

  const consentStore = tryOpenMembershipConsentBlobStore(event);
  const blobKey = membershipConsentBlobKey(id);
  const blobKeys = consentStore ? await listConsentBlobKeys(event) : [];
  const blobExists = blobKeys.includes(blobKey);

  const { byConsentId } = await loadSubscriptionIndex(event);
  const sub = byConsentId.get(id) || null;

  let rec = /** @type {Record<string, unknown> | null} */ (null);
  if (consentStore && blobExists) {
    rec = await getConsentBlobRecord(consentStore, id);
  }

  if (!rec && !sub) {
    return { ok: false, error: "consent_not_found" };
  }

  const merged = { ...(rec || {}), consentId: id };
  const snap = snapshotFromConsentRecord(merged);
  const hashCheck = verifyStoredTermsHash(merged, sub);
  const label = evidenceLabel(merged, sub, blobExists);
  const localSku = String(merged.localSku || sub?.localSku || "").trim() || null;
  const catalog = localSku ? getCatalogItem(localSku) : null;

  return {
    ok: true,
    evidenceLabel: label,
    applicability: label === "NO_AMARE_RECORD" ? "NO_AMARE_CONSENT_RECORD" : "CONSENT_FOUND",
    hashVerification: hashCheck,
    detail: {
      consentId: id,
      clientName: sub?.customerName || String(merged.fullNameTyped || merged.legalNameTyped || "").trim() || "—",
      email: sub?.customerEmail || "—",
      mindbodyClientId: sub?.mindbodyClientId ?? merged.mindbodyClientId ?? null,
      membershipLabel: catalog?.displayName || localSku || "—",
      localSku,
      mindbodyServiceId: sub?.mindbodyServiceId ?? merged.mindbodyServiceId ?? merged.checkoutServiceId ?? null,
      mindbodyContractProductId:
        sub?.mindbodyContractProductId ?? merged.mindbodyContractProductId ?? merged.contractProductKey ?? null,
      acceptedAt:
        String(merged.acceptedAt || merged.auditCreatedAt || sub?.agreementAcceptedAt || "").trim() || null,
      termsVersion: String(merged.contractVersion || sub?.agreementVersion || "").trim() || null,
      termsSha256: hashCheck.storedHash || hashCheck.computedHash || null,
      agreementAccepted: Boolean(
        merged.agreementAccepted ?? merged.membershipAgreementAccepted ?? true,
      ),
      billingAuthorized: Boolean(
        merged.billingAuthorized ?? merged.membershipBillingAuthorized ?? true,
      ),
      purchaseStatus: sub?.status || String(merged.checkoutStatus || "") || "—",
      stripeSubscriptionId:
        sub?.stripeSubscriptionId && !String(sub.stripeSubscriptionId).startsWith("pending_")
          ? sub.stripeSubscriptionId
          : null,
      stripeCheckoutSessionId: sub?.stripeCheckoutSessionId || null,
      subscriptionId: sub?.id || merged.subscriptionId || null,
      mindbodySaleId: merged.mindbodySaleId ?? null,
      mindbodyContractId: merged.mindbodyContractId ?? null,
      source: formatConsentSource(String(merged.flow || merged.source || ""), sub),
      clientIp:
        typeof merged.clientIp === "string"
          ? merged.clientIp
          : typeof merged.ipAddress === "string"
            ? merged.ipAddress
            : null,
      userAgent: typeof merged.userAgent === "string" ? merged.userAgent : null,
      termsPlainText: snap ? htmlToPlainText(sanitizeTermsForAdminDisplay(snap)) : "",
      snapshotPresent: snap.length >= 80,
      termsDisclaimer:
        "This is the terms snapshot stored at the time of acceptance (historical record — not regenerated from current policy).",
    },
  };
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {number} mindbodyClientId
 */
export async function buildClientConsentSummary(event, mindbodyClientId) {
  const cid = Number(mindbodyClientId);
  if (!Number.isFinite(cid) || cid <= 0) {
    return { ok: false, error: "invalid_mindbody_client_id" };
  }
  const { byMindbodyClientId } = await loadSubscriptionIndex(event);
  const subs = byMindbodyClientId.get(cid) || [];
  const consentIds = subs
    .map((s) => s.membershipConsentId)
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => String(x).trim());
  const unique = [...new Set(consentIds)];
  const consentStore = tryOpenMembershipConsentBlobStore(event);
  let strong = 0;
  for (const id of unique) {
    if (!consentStore) continue;
    const rec = await getConsentBlobRecord(consentStore, id);
    const sub = subs.find((s) => s.membershipConsentId === id) || null;
    if (evidenceLabel(rec || {}, sub, Boolean(rec)) === "STRONG_RECORD") strong += 1;
  }
  return {
    ok: true,
    mindbodyClientId: cid,
    consentCount: unique.length,
    strongRecordCount: strong,
    hasConsentOnFile: unique.length > 0,
    consentIds: unique,
    viewUrl: `/admin/membership-consents?mindbodyClientId=${cid}`,
  };
}

/** @param {string} iso */
export function formatEtFromIso(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Pure helper for tests — one-time SKUs are not membership consent applicable.
 * @param {string | null | undefined} localSku
 */
export function purchaseApplicabilityForSku(localSku) {
  const sku = String(localSku || "").trim();
  if (!sku) return "NOT_APPLICABLE";
  if (
    sku.includes("monthly") ||
    sku.includes("annual") ||
    sku.startsWith("monthly_") ||
    sku.startsWith("annual_")
  ) {
    return "MEMBERSHIP";
  }
  return "NOT_APPLICABLE";
}
