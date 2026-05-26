/**
 * New Client SMS conversion follow-up — eligibility, messaging, Mindbody helpers.
 */

import { MB_API_VERSION, clientsList, fetchMb, visitsList } from "./mindbody-consumer-lib.mjs";
import { loadStripeMindbodyCatalog } from "./stripe-catalog-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { __testing as syncTesting, fetchMindbodyClientContact } from "./stripe-mindbody-sync-lib.mjs";

/** @typedef {import("./new-client-sms-store.mjs").SmsSegmentId} SmsSegmentId */

/** @type {SmsSegmentId[]} */
export const SMS_SEGMENT_PRIORITY = ["one_remaining", "expiring_soon", "completed_no_purchase"];

/** Reserved for Phase D — ClassPass repeat visitors. Not scanned in V1. */
export const SMS_SEGMENT_CLASSPASS = /** @type {const} */ ("classpass_repeat");

/**
 * @typedef {Object} NcsServiceRow
 * @property {number} clientServiceId
 * @property {number | null} serviceId
 * @property {string} name
 * @property {number} remaining
 * @property {boolean | null} active
 * @property {string | null} expirationDateIso
 * @property {string | null} paymentDateIso
 */

/**
 * @typedef {Object} ClientEvaluation
 * @property {number} mindbodyClientId
 * @property {string[]} seedSources
 * @property {NcsServiceRow} ncs
 * @property {SmsSegmentId} segment
 * @property {string} firstName
 * @property {string} phone
 * @property {string} phoneLast4
 * @property {string} emailDomain
 * @property {"unknown"|"explicit_opt_in"|"explicit_opt_out"} smsConsent
 * @property {string} messageBody
 * @property {string | null} expirationDisplayDate
 * @property {number | null} daysToExpiry
 * @property {boolean} followUpPurchaseFound
 * @property {boolean} activeMindbodyMembershipFound
 * @property {boolean} activeStripeSubscriptionFound
 * @property {boolean} wouldSend
 * @property {string | null} blockReason
 * @property {string[]} skipReasons
 */

/**
 * @typedef {Object} ClientEvalResult
 * @property {number} mindbodyClientId
 * @property {string[]} seedSources
 * @property {boolean} activeMindbodyMembershipFound
 * @property {boolean} activeStripeSubscriptionFound
 * @property {string[]} skipReasons
 * @property {Array<{ ncsClientServiceId: number; ncsServiceId: number | null; remainingVisits: number; expirationDate: string | null; daysToExpiry: number | null; followUpPurchaseFound: boolean }>} ncsPackages
 * @property {ClientEvaluation | null} candidate
 */

/** @param {string} envName @param {number} defaultValue @param {number} hardMax */
function clampEnvInt(envName, defaultValue, hardMax) {
  const raw = Number(process.env[envName]);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : defaultValue;
  return Math.max(1, Math.min(n, hardMax));
}

/** Hard and configured caps for discovery / evaluation (logged in every dry-run summary). */
export function smsRunCaps() {
  const lookbackDays = discoveryLookbackDays(Number(process.env.NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS) || 45);
  const maxClientPages = clampEnvInt("NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES", 10, 50);
  const maxClassScan = clampEnvInt("NEW_CLIENT_SMS_DISCOVERY_MAX_CLASS_SCAN", 90, 300);
  const maxDiscoveredClients = clampEnvInt("NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENTS", 250, 500);
  const maxEvaluatedClients = clampEnvInt("NEW_CLIENT_SMS_MAX_EVALUATED_CLIENTS", 150, 300);
  return {
    lookbackDays: { configured: lookbackDays, hardMax: 120, hardMin: 7 },
    maxClientPages: { configured: maxClientPages, clientsPerPage: 200, hardMax: 50 },
    maxClassScan: { configured: maxClassScan, hardMax: 300, hardMin: 10 },
    maxDiscoveredClients: { configured: maxDiscoveredClients, hardMax: 500 },
    maxEvaluatedClients: { configured: maxEvaluatedClients, hardMax: 300 },
  };
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function envTruthy(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @returns {string} */
export function smsTimezone() {
  const tz = (process.env.NEW_CLIENT_SMS_TIMEZONE || "America/New_York").trim();
  return tz || "America/New_York";
}

/** @param {Date} d @param {string} [tz] */
export function formatDateInTz(d, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz || smsTimezone(),
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** @param {string | null | undefined} iso @param {string} [tz] */
export function calendarDateKey(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || smsTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** @param {string} [tz] */
export function todayCalendarKey(tz) {
  return calendarDateKey(new Date().toISOString(), tz) || new Date().toISOString().slice(0, 10);
}

/**
 * @param {string | null} expIso
 * @param {string} [tz]
 * @returns {number | null}
 */
export function daysUntilExpiration(expIso, tz) {
  const expKey = calendarDateKey(expIso, tz);
  const todayKey = todayCalendarKey(tz);
  if (!expKey || !todayKey) return null;
  const exp = new Date(`${expKey}T12:00:00`);
  const today = new Date(`${todayKey}T12:00:00`);
  if (Number.isNaN(exp.getTime()) || Number.isNaN(today.getTime())) return null;
  return Math.round((exp.getTime() - today.getTime()) / 86400000);
}

/** @returns {number[]} */
export function resolveNcsServiceIds() {
  const override = (process.env.NEW_CLIENT_SMS_MINDBODY_SERVICE_IDS || "").trim();
  if (override) {
    return override
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const { items } = loadStripeMindbodyCatalog();
  /** @type {number[]} */
  const ids = [];
  for (const item of items) {
    if (item.kind !== "newClient") continue;
    if (item.mindbodyServiceId != null && Number.isFinite(item.mindbodyServiceId)) {
      ids.push(Number(item.mindbodyServiceId));
    }
  }
  return [...new Set(ids)];
}

/** @returns {Set<number>} */
function followUpServiceIds() {
  const { items } = loadStripeMindbodyCatalog();
  /** @type {Set<number>} */
  const ids = new Set();
  for (const item of items) {
    if (item.kind === "newClient") continue;
    if (item.mindbodyServiceId != null && Number.isFinite(item.mindbodyServiceId)) {
      ids.add(Number(item.mindbodyServiceId));
    }
    const displayId = /** @type {{ mindbodyDisplayServiceId?: number | null }} */ (item)
      .mindbodyDisplayServiceId;
    if (displayId != null && Number.isFinite(displayId)) {
      ids.add(Number(displayId));
    }
  }
  return ids;
}

/** @param {unknown} row */
function numField(row, keys) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** @param {unknown} row */
function strField(row, keys) {
  if (!row || typeof row !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** @param {unknown} data */
function rowsFromPayload(data, keys) {
  if (!data || typeof data !== "object") return [];
  const o = /** @type {Record<string, unknown>} */ (data);
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** @param {unknown} row @param {Set<number>} ncsIds */
function isNcsServiceRow(row, ncsIds) {
  const serviceId = numField(row, ["ProductId", "productId", "ServiceId", "serviceId"]);
  if (serviceId != null && ncsIds.has(serviceId)) return true;
  const name = strField(row, ["Name", "name", "ServiceName", "serviceName", "Description"]).toLowerCase();
  if (!name) return false;
  if (/\bmonthly\b|\bmembership\b|\brecurring\b/.test(name)) return false;
  return syncTesting.NCS_HISTORY_KEYWORDS.some((kw) => name.includes(kw));
}

/** @param {unknown} row @param {Set<number>} followUpIds */
function isFollowUpServiceRow(row, followUpIds) {
  const serviceId = numField(row, ["ProductId", "productId", "ServiceId", "serviceId"]);
  if (serviceId != null && followUpIds.has(serviceId)) return true;
  const name = strField(row, ["Name", "name", "ServiceName", "serviceName", "Description"]).toLowerCase();
  if (!name) return false;
  if (/\bmonthly\b|\bmembership\b/.test(name)) return true;
  if (/\b10 pack\b|\b20 pack\b|\b10-pack\b|\b20-pack\b/.test(name)) return true;
  if (/\bdrop[\s-]?in\b|\bsingle class\b|\bsame day\b/.test(name)) return true;
  return false;
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function fetchClientRowById(headers, clientId) {
  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.limit", "5");
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${q}`,
    headers,
    null,
    { timeoutMs: 12000 },
  );
  if (!r.ok) return null;
  const rows = rowsFromPayload(r.data, ["Clients", "clients"]);
  for (const raw of rows) {
    const id = numField(raw, ["Id", "id", "UniqueId", "uniqueId"]);
    if (id === clientId) return /** @type {Record<string, unknown>} */ (raw);
  }
  return rows[0] && typeof rows[0] === "object"
    ? /** @type {Record<string, unknown>} */ (rows[0])
    : null;
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 */
export async function fetchClientMindbodyBundle(headers, clientId) {
  const qBase = new URLSearchParams();
  qBase.set("request.clientId", String(clientId));
  qBase.set("request.limit", "200");

  const [servicesR, purchasesR, membershipsR] = await Promise.all([
    fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clientservices?${qBase}`,
      headers,
      null,
      { timeoutMs: 15000 },
    ),
    fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clientpurchases?${qBase}`,
      headers,
      null,
      { timeoutMs: 15000 },
    ),
    fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/activeclientmemberships?${qBase}`,
      headers,
      null,
      { timeoutMs: 15000 },
    ),
  ]);

  return {
    services: servicesR.ok ? rowsFromPayload(servicesR.data, ["ClientServices", "clientServices"]) : [],
    purchases: purchasesR.ok ? rowsFromPayload(purchasesR.data, ["Purchases", "purchases"]) : [],
    memberships: membershipsR.ok
      ? rowsFromPayload(membershipsR.data, ["Memberships", "memberships"])
      : [],
    warnings: [
      !servicesR.ok ? `clientservices_${servicesR.status}` : null,
      !purchasesR.ok ? `purchases_${purchasesR.status}` : null,
      !membershipsR.ok ? `memberships_${membershipsR.status}` : null,
    ].filter(Boolean),
  };
}

/**
 * @param {unknown[]} serviceRows
 * @param {Set<number>} ncsIds
 * @returns {NcsServiceRow[]}
 */
export function extractNcsServices(serviceRows, ncsIds) {
  /** @type {NcsServiceRow[]} */
  const out = [];
  for (const raw of serviceRows) {
    if (!isNcsServiceRow(raw, ncsIds)) continue;
    const clientServiceId = numField(raw, ["Id", "id"]);
    if (clientServiceId == null) continue;
    const remainingRaw = numField(raw, ["Remaining", "remaining"]);
    const remaining = remainingRaw == null ? 0 : remainingRaw;
    const activeRaw = /** @type {Record<string, unknown>} */ (raw).Active ?? /** @type {Record<string, unknown>} */ (raw).active;
    const active = typeof activeRaw === "boolean" ? activeRaw : null;
    out.push({
      clientServiceId,
      serviceId: numField(raw, ["ProductId", "productId", "ServiceId", "serviceId"]),
      name: strField(raw, ["Name", "name", "ServiceName", "serviceName"]),
      remaining,
      active,
      expirationDateIso: strField(raw, ["ExpirationDate", "expirationDate", "End", "end"]) || null,
      paymentDateIso:
        strField(raw, ["PaymentDate", "paymentDate", "ActiveDate", "activeDate", "PurchaseDate"]) ||
        null,
    });
  }
  return out;
}

/** @param {unknown[]} membershipRows */
function hasActiveMindbodyMembership(membershipRows) {
  for (const raw of membershipRows) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const active =
      o.Active === true ||
      o.active === true ||
      String(o.Status ?? o.status ?? "").toLowerCase() === "active";
    if (active) return true;
  }
  return membershipRows.length > 0;
}

/**
 * @param {unknown} clientRow
 * @returns {"unknown"|"explicit_opt_in"|"explicit_opt_out"}
 */
export function readSmsConsent(clientRow) {
  if (!clientRow || typeof clientRow !== "object") return "unknown";
  const o = /** @type {Record<string, unknown>} */ (clientRow);
  const optInKeys = [
    "PromotionalTextOptIn",
    "SendPromotionalTexts",
    "SmsPromotionalOptIn",
    "TextPromotionalOptIn",
  ];
  const optOutKeys = ["PromotionalTextOptOut", "SmsOptOut", "TextOptOut"];
  for (const k of optOutKeys) {
    if (o[k] === true) return "explicit_opt_out";
  }
  for (const k of optInKeys) {
    if (o[k] === true) return "explicit_opt_in";
  }
  return "unknown";
}

/**
 * @param {string} iso
 * @returns {number}
 */
function parseIsoMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {NcsServiceRow} ncs
 * @param {unknown[]} serviceRows
 * @param {unknown[]} purchaseRows
 * @param {Set<number>} followUpIds
 * @returns {boolean}
 */
function hasFollowUpPurchase(ncs, serviceRows, purchaseRows, followUpIds) {
  const anchorMs = parseIsoMs(ncs.paymentDateIso || "") || 0;

  for (const raw of purchaseRows) {
    if (!isFollowUpServiceRow(raw, followUpIds)) continue;
    const purchaseMs = parseIsoMs(
      strField(raw, ["SaleDate", "saleDate", "PurchaseDate", "purchaseDate", "PaymentDate"]),
    );
    if (anchorMs > 0 && purchaseMs > 0 && purchaseMs <= anchorMs) continue;
    return true;
  }

  for (const raw of serviceRows) {
    if (isNcsServiceRow(raw, new Set(resolveNcsServiceIds()))) continue;
    if (!isFollowUpServiceRow(raw, followUpIds)) continue;
    const rem = numField(raw, ["Remaining", "remaining"]);
    if (rem != null && rem <= 0) {
      const expDays = daysUntilExpiration(
        strField(raw, ["ExpirationDate", "expirationDate", "End", "end"]) || null,
      );
      if (expDays != null && expDays < 0) continue;
    }
    const svcMs = parseIsoMs(
      strField(raw, ["PaymentDate", "paymentDate", "ActiveDate", "activeDate", "PurchaseDate"]),
    );
    if (anchorMs > 0 && svcMs > 0 && svcMs <= anchorMs) continue;
    return true;
  }
  return false;
}

/** @param {SmsSegmentId} segment */
export function segmentEnabled(segment) {
  const map = {
    one_remaining: "ENABLE_SMS_SEGMENT_ONE_REMAINING",
    expiring_soon: "ENABLE_SMS_SEGMENT_EXPIRING_SOON",
    completed_no_purchase: "ENABLE_SMS_SEGMENT_COMPLETED_NO_PURCHASE",
    classpass_repeat: "ENABLE_SMS_SEGMENT_CLASSPASS_REPEAT",
  };
  const envName = map[segment];
  if (!envName) return false;
  const raw = (process.env[envName] || "").trim();
  if (!raw) {
    return segment === "one_remaining" || segment === "expiring_soon";
  }
  return envTruthy(envName);
}

/**
 * @param {NcsServiceRow} ncs
 * @param {string} [tz]
 * @returns {SmsSegmentId | null}
 */
export function pickSegmentForNcs(ncs, tz) {
  const expDays = daysUntilExpiration(ncs.expirationDateIso, tz);
  const isExpired = expDays != null && expDays < 0;
  const isActive = ncs.active !== false;
  const completedGrace = Math.max(
    1,
    Math.min(Number(process.env.NEW_CLIENT_SMS_COMPLETED_GRACE_DAYS) || 14, 60),
  );

  if (
    segmentEnabled("one_remaining") &&
    isActive &&
    !isExpired &&
    ncs.remaining === 1
  ) {
    return "one_remaining";
  }

  if (
    segmentEnabled("expiring_soon") &&
    isActive &&
    expDays != null &&
    expDays >= 0 &&
    expDays <= 5 &&
    ncs.remaining >= 1
  ) {
    return "expiring_soon";
  }

  if (segmentEnabled("completed_no_purchase") && ncs.remaining === 0) {
    if (isExpired && expDays != null && Math.abs(expDays) <= completedGrace) {
      return "completed_no_purchase";
    }
    if (!isExpired && ncs.remaining === 0) {
      return "completed_no_purchase";
    }
  }

  return null;
}

/**
 * @param {SmsSegmentId} segment
 * @param {{ firstName: string; couponCode: string; pricingUrl: string; expirationDisplayDate?: string | null }} input
 */
export function buildSmsBody(segment, input) {
  const name = (input.firstName || "there").trim() || "there";
  const coupon = (input.couponCode || "KEEPMOVING15").trim();
  const url = (input.pricingUrl || "https://www.amarewellness.com/pricing").trim();
  const stop = " Reply STOP to opt out.";

  if (segment === "one_remaining") {
    return `Hi ${name} 🫶 you have one class left on your intro package. If AMARÉ feels like a good fit, use ${coupon} for 15% off your first membership month: ${url}${stop}`;
  }
  if (segment === "expiring_soon") {
    const exp = input.expirationDisplayDate || "soon";
    return `Hi ${name} 🫶 your intro package expires soon. Use any remaining visit before ${exp}, and use ${coupon} for 15% off your first membership month: ${url}${stop}`;
  }
  if (segment === "completed_no_purchase") {
    return `Hi ${name} 🫶 we loved having you at AMARÉ. If you want to keep coming weekly, our memberships are the best next step — priority booking, guest pass, late-cancel forgiveness, and member perks. Use ${coupon} for 15% off your first month: ${url}${stop}`;
  }
  return "";
}

/** @param {string} email */
function emailDomainOnly(email) {
  const e = (email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 0) return "";
  return e.slice(at + 1) || "";
}

/** @param {string} phone */
function phoneLast4(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/** @param {unknown} data */
function paginationTotalResults(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of ["PaginationResponse", "Pagination"]) {
    const p = d[key];
    if (p && typeof p === "object") {
      const t = /** @type {Record<string, unknown>} */ (p).TotalResults;
      if (typeof t === "number") return t;
    }
  }
  return null;
}

/** @param {unknown} row */
function clientIdFromRow(row) {
  return numField(row, ["Id", "id", "UniqueId", "uniqueId", "ClientId", "clientId"]);
}

/** @param {number} lookbackDays */
function discoveryLookbackDays(lookbackDays) {
  return Math.max(7, Math.min(lookbackDays || Number(process.env.NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS) || 45, 120));
}

/** @param {number} lookbackDays */
function lookbackIsoUtc(lookbackDays) {
  const d = new Date(Date.now() - discoveryLookbackDays(lookbackDays) * 86400000);
  return d.toISOString();
}

/**
 * Mindbody-first discovery: recently modified client profiles (staff token required).
 * Catches in-studio POS / Mindbody Classic NCS sales when the client row is touched.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {number} lookbackDays
 */
async function discoverMindbodyClientsByLastModified(staffHeaders, lookbackDays) {
  const limit = 200;
  const maxPages = smsRunCaps().maxClientPages.configured;
  const lastModifiedDate = lookbackIsoUtc(lookbackDays);
  /** @type {Set<number>} */
  const ids = new Set();
  let pages = 0;
  let apiCalls = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams();
    q.set("request.lastModifiedDate", lastModifiedDate);
    q.set("request.limit", String(limit));
    q.set("request.offset", String(page * limit));
    const r = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clients?${q}`,
      staffHeaders,
      null,
      { timeoutMs: 20000 },
    );
    apiCalls += 1;
    pages += 1;
    if (!r.ok) {
      return { ids, apiCalls, pages, ok: false, status: r.status, lastModifiedDate };
    }
    const batch = clientsList(r.data);
    for (const raw of batch) {
      const id = clientIdFromRow(raw);
      if (id != null && id > 0) ids.add(Math.trunc(id));
    }
    const total = paginationTotalResults(r.data);
    if (batch.length < limit) break;
    if (typeof total === "number" && ids.size >= total) break;
  }

  return { ids, apiCalls, pages, ok: true, status: 200, lastModifiedDate };
}

/** @param {unknown} visitRow */
function clientIdFromVisitRow(visitRow) {
  return numField(visitRow, ["ClientId", "clientId", "UniqueId", "uniqueId"]);
}

/**
 * Try site-wide class visit discovery via LastModifiedDate (no classID).
 * Works on some sites; falls back to per-class scan when empty or rejected.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {number} lookbackDays
 */
async function discoverMindbodyClientsViaClassVisitsLastModified(staffHeaders, lookbackDays) {
  const lastModifiedDate = lookbackIsoUtc(lookbackDays);
  const q = new URLSearchParams();
  q.set("request.lastModifiedDate", lastModifiedDate);
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/class/classvisits?${q}`,
    staffHeaders,
    null,
    { timeoutMs: 25000 },
  );
  if (!r.ok) {
    return { ids: new Set(), apiCalls: 1, ok: false, status: r.status, mode: "last_modified" };
  }
  /** @type {Set<number>} */
  const ids = new Set();
  for (const raw of visitsList(r.data)) {
    const id = clientIdFromVisitRow(raw);
    if (id != null && id > 0) ids.add(Math.trunc(id));
  }
  return {
    ids,
    apiCalls: 1,
    ok: true,
    status: r.status,
    mode: "last_modified",
    lastModifiedDate,
  };
}

/**
 * Fallback: enumerate scheduled classes in lookback window, then classvisits per class.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {number} lookbackDays
 */
async function discoverMindbodyClientsViaClassSchedule(staffHeaders, lookbackDays) {
  const maxClasses = smsRunCaps().maxClassScan.configured;
  const start = new Date(Date.now() - discoveryLookbackDays(lookbackDays) * 86400000);
  const end = new Date(Date.now() + 7 * 86400000);
  /** @type {Set<number>} */
  const classIds = new Set();
  /** @type {Set<number>} */
  const clientIds = new Set();
  let apiCalls = 0;

  for (let offset = 0; offset < 500; offset += 100) {
    const q = new URLSearchParams();
    q.set("request.startDateTime", start.toISOString());
    q.set("request.endDateTime", end.toISOString());
    q.set("request.limit", "100");
    q.set("request.offset", String(offset));
    const r = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/class/classes?${q}`,
      staffHeaders,
      null,
      { timeoutMs: 20000 },
    );
    apiCalls += 1;
    if (!r.ok) break;
    const rows = rowsFromPayload(r.data, ["Classes", "classes"]);
    for (const raw of rows) {
      const cid = numField(raw, ["Id", "id", "ClassId", "classId"]);
      if (cid != null && cid > 0) classIds.add(Math.trunc(cid));
    }
    if (rows.length < 100) break;
    if (classIds.size >= maxClasses) break;
  }

  let scannedClasses = 0;
  for (const classId of classIds) {
    if (scannedClasses >= maxClasses) break;
    scannedClasses += 1;
    const q = new URLSearchParams();
    q.set("request.classID", String(classId));
    const r = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/class/classvisits?${q}`,
      staffHeaders,
      null,
      { timeoutMs: 15000 },
    );
    apiCalls += 1;
    if (!r.ok) continue;
    for (const raw of visitsList(r.data)) {
      const id = clientIdFromVisitRow(raw);
      if (id != null && id > 0) clientIds.add(Math.trunc(id));
    }
  }

  return {
    ids: clientIds,
    apiCalls,
    ok: true,
    mode: "class_schedule",
    classesConsidered: scannedClasses,
  };
}

/**
 * @param {Record<string, string>} staffHeaders
 * @param {number} lookbackDays
 */
async function discoverMindbodyVisitClientIds(staffHeaders, lookbackDays) {
  const primary = await discoverMindbodyClientsViaClassVisitsLastModified(staffHeaders, lookbackDays);
  if (primary.ok && primary.ids.size > 0) {
    return primary;
  }
  const fallback = await discoverMindbodyClientsViaClassSchedule(staffHeaders, lookbackDays);
  return {
    ...fallback,
    apiCalls: primary.apiCalls + fallback.apiCalls,
    fallbackFrom: primary.ok ? "last_modified_empty" : `last_modified_${primary.status}`,
  };
}

/**
 * Collect deduped Mindbody client IDs for SMS evaluation.
 * Mindbody-first; Stripe + manual env are supplemental only.
 *
 * @param {unknown} event Netlify event (for stores)
 * @param {Record<string, string>} staffHeaders
 */
export async function collectSeedClientIds(event, staffHeaders) {
  const caps = smsRunCaps();
  const lookbackDays = caps.lookbackDays.configured;

  /** @type {Map<number, Set<string>>} */
  const merged = new Map();

  /** @param {number} id @param {string} source */
  function addSeed(id, source) {
    if (!Number.isFinite(id) || id <= 0) return;
    const tid = Math.trunc(id);
    let set = merged.get(tid);
    if (!set) {
      set = new Set();
      merged.set(tid, set);
    }
    set.add(source);
  }

  /** @type {string[]} */
  const discoveryNotes = [];
  let discoveryApiCalls = 0;

  const mbClients = await discoverMindbodyClientsByLastModified(staffHeaders, lookbackDays);
  discoveryApiCalls += mbClients.apiCalls;
  if (!mbClients.ok) {
    discoveryNotes.push(`mindbody_clients_discovery_failed:${mbClients.status}`);
  }
  for (const id of mbClients.ids) addSeed(id, "mindbody_clients");

  const mbVisits = await discoverMindbodyVisitClientIds(staffHeaders, lookbackDays);
  discoveryApiCalls += mbVisits.apiCalls;
  if (!mbVisits.ok) {
    discoveryNotes.push(`mindbody_visits_discovery_failed:${mbVisits.status ?? "unknown"}`);
  } else if ("fallbackFrom" in mbVisits && mbVisits.fallbackFrom) {
    discoveryNotes.push(`mindbody_visits_used_class_schedule:${mbVisits.fallbackFrom}`);
  }
  for (const id of mbVisits.ids) addSeed(id, "mindbody_visits");

  const mindbodyClientsCount = mbClients.ids.size;
  const mindbodyVisitsCount = mbVisits.ids.size;

  /** Manual seed (testing / edge cases) — always kept through truncation. */
  let manualSeedCount = 0;
  const manual = (process.env.NEW_CLIENT_SMS_SEED_CLIENT_IDS || "").trim();
  if (manual) {
    for (const part of manual.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) {
        manualSeedCount += 1;
        addSeed(n, "manual_env");
      }
    }
  }

  /** Supplemental: Stripe NCS orders (website checkout funnel). */
  let stripeOrdersCount = 0;
  const cutoffMs = Date.now() - lookbackDays * 86400000;
  const orderStore = openOrderStore(event);
  if (orderStore.available) {
    const orders = await orderStore.listByStatus("mindbody_synced", { limit: 500 });
    const { items } = loadStripeMindbodyCatalog();
    const ncsSkus = new Set(items.filter((i) => i.kind === "newClient").map((i) => i.localSku));
    for (const order of orders) {
      if (!ncsSkus.has(order.localSku)) continue;
      if (order.stripeLivemode !== true) continue;
      const createdMs = Date.parse(order.createdAt || "");
      if (Number.isFinite(createdMs) && createdMs < cutoffMs) continue;
      const cid = order.resolvedMindbodyClientId ?? order.mindbodyClientId;
      if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) {
        stripeOrdersCount += 1;
        addSeed(Number(cid), "stripe_ncs_order");
      }
    }
  }

  discoveryNotes.push("mindbodyPurchases: no bulk Public API — per-client at evaluation");

  const dedupedBeforeCap = merged.size;
  let truncatedDiscovered = 0;
  const maxDiscovered = caps.maxDiscoveredClients.configured;

  if (dedupedBeforeCap > maxDiscovered) {
    /** Priority when capping: manual → stripe → mindbody_clients → mindbody_visits */
    const priority = ["manual_env", "stripe_ncs_order", "mindbody_clients", "mindbody_visits"];
    /** @type {[number, string[], number][]} */
    const ranked = [...merged.entries()].map(([id, sources]) => {
      const arr = [...sources];
      const rank = Math.min(...arr.map((s) => {
        const idx = priority.indexOf(s);
        return idx >= 0 ? idx : priority.length;
      }));
      return [id, arr, rank];
    });
    ranked.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
    merged.clear();
    for (const [id, arr] of ranked.slice(0, maxDiscovered)) {
      merged.set(id, new Set(arr));
    }
    truncatedDiscovered = dedupedBeforeCap - merged.size;
    discoveryNotes.push(`truncated_discovered:${dedupedBeforeCap}_to_${maxDiscovered}`);
  }

  const perClientEvalCalls = Math.min(merged.size, caps.maxEvaluatedClients.configured) * 4;
  const seedSources = {
    mindbodyClients: mindbodyClientsCount,
    mindbodyVisits: mindbodyVisitsCount,
    mindbodyPurchases: 0,
    stripeOrders: stripeOrdersCount,
    manualSeed: manualSeedCount,
    dedupedTotal: merged.size,
    dedupedBeforeCap,
    truncatedDiscovered,
  };

  return {
    clientIds: [...merged.entries()].map(([id, sources]) => ({
      id,
      seedSources: [...sources].sort(),
    })),
    lookbackDays,
    caps,
    seedSources,
    discoveryNotes,
    discoveryApiCalls,
    estimatedEvaluationApiCalls: perClientEvalCalls,
    estimatedTotalApiCalls: discoveryApiCalls + perClientEvalCalls,
    orderStoreAvailable: !!orderStore.available,
  };
}

/**
 * @param {unknown} event
 * @param {Record<string, string>} staffHeaders
 * @param {number} clientId
 * @param {string[]} seedSources
 * @returns {Promise<ClientEvalResult>}
 */
export async function evaluateClientForSms(event, staffHeaders, clientId, seedSources) {
  const tz = smsTimezone();
  const ncsIds = new Set(resolveNcsServiceIds());
  const followUpIds = followUpServiceIds();
  const couponCode = (process.env.NEW_CLIENT_SMS_COUPON_CODE || "KEEPMOVING15").trim();
  const pricingUrl = (
    process.env.NEW_CLIENT_SMS_PRICING_URL || "https://www.amarewellness.com/pricing"
  ).trim();

  /** @type {string[]} */
  const skipReasons = [];

  const [contact, clientRow] = await Promise.all([
    fetchMindbodyClientContact(staffHeaders, clientId, { timeoutMs: 12000 }),
    fetchClientRowById(staffHeaders, clientId),
  ]);
  if (!contact) {
    return {
      mindbodyClientId: clientId,
      seedSources,
      activeMindbodyMembershipFound: false,
      activeStripeSubscriptionFound: false,
      skipReasons: ["client_profile_not_found"],
      ncsPackages: [],
      candidate: null,
    };
  }

  const bundle = await fetchClientMindbodyBundle(staffHeaders, clientId);
  if (bundle.warnings.length) skipReasons.push(.../** @type {string[]} */ (bundle.warnings));

  let activeStripeSubscriptionFound = false;
  const subStore = openSubscriptionStore(event);
  if (subStore.available) {
    const subs = await subStore.listActiveByMindbodyClientId(clientId, { limit: 5 });
    activeStripeSubscriptionFound = subs.some(
      (s) =>
        s.status === "active" ||
        s.status === "pending_first_invoice" ||
        s.status === "past_due",
    );
    if (activeStripeSubscriptionFound) {
      skipReasons.push("skipped_active_stripe_membership");
    }
  }

  const activeMindbodyMembershipFound = hasActiveMindbodyMembership(bundle.memberships);
  if (activeMindbodyMembershipFound) {
    skipReasons.push("skipped_active_mindbody_membership");
  }

  const ncsRows = extractNcsServices(bundle.services, ncsIds);
  /** @type {ClientEvalResult["ncsPackages"]} */
  const ncsPackages = ncsRows.map((ncs) => ({
    ncsClientServiceId: ncs.clientServiceId,
    ncsServiceId: ncs.serviceId,
    remainingVisits: ncs.remaining,
    expirationDate: ncs.expirationDateIso,
    daysToExpiry: daysUntilExpiration(ncs.expirationDateIso, tz),
    followUpPurchaseFound: hasFollowUpPurchase(ncs, bundle.services, bundle.purchases, followUpIds),
  }));

  if (!ncsRows.length) {
    skipReasons.push("no_ncs_service");
    return {
      mindbodyClientId: clientId,
      seedSources,
      activeMindbodyMembershipFound,
      activeStripeSubscriptionFound,
      skipReasons,
      ncsPackages,
      candidate: null,
    };
  }

  if (activeStripeSubscriptionFound || activeMindbodyMembershipFound) {
    return {
      mindbodyClientId: clientId,
      seedSources,
      activeMindbodyMembershipFound,
      activeStripeSubscriptionFound,
      skipReasons,
      ncsPackages,
      candidate: null,
    };
  }

  /** @type {ClientEvaluation | null} */
  let best = null;

  for (const ncs of ncsRows) {
    const followUpPurchaseFound = hasFollowUpPurchase(
      ncs,
      bundle.services,
      bundle.purchases,
      followUpIds,
    );
    if (followUpPurchaseFound) {
      skipReasons.push(`skipped_already_converted:ncs_${ncs.clientServiceId}`);
      continue;
    }

    const segment = pickSegmentForNcs(ncs, tz);
    if (!segment) {
      skipReasons.push(`skipped_no_matching_segment:ncs_${ncs.clientServiceId}`);
      continue;
    }

    const priorityIdx = SMS_SEGMENT_PRIORITY.indexOf(segment);
    const bestIdx = best ? SMS_SEGMENT_PRIORITY.indexOf(best.segment) : 999;
    if (priorityIdx >= bestIdx) continue;

    const phone = (contact.phone || "").trim();
    if (!phone || phone.replace(/\D/g, "").length < 10) {
      skipReasons.push("skipped_no_valid_phone");
      continue;
    }

    const smsConsent = readSmsConsent(clientRow);
    const daysToExpiry = daysUntilExpiration(ncs.expirationDateIso, tz);
    const expirationDisplayDate = ncs.expirationDateIso
      ? formatDateInTz(new Date(ncs.expirationDateIso), tz)
      : null;
    const messageBody = buildSmsBody(segment, {
      firstName: contact.firstName || "there",
      couponCode,
      pricingUrl,
      expirationDisplayDate,
    });

    let wouldSend = true;
    /** @type {string | null} */
    let blockReason = null;
    if (!segmentEnabled(segment)) {
      wouldSend = false;
      blockReason = "segment_disabled";
    }
    if (smsConsent === "explicit_opt_out") {
      wouldSend = false;
      blockReason = "sms_consent_opt_out";
    }
    if (smsConsent === "unknown" && !envTruthy("NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT")) {
      wouldSend = false;
      blockReason = "sms_consent_unknown";
    }

    best = {
      mindbodyClientId: clientId,
      seedSources,
      ncs,
      segment,
      firstName: contact.firstName || "there",
      phone,
      phoneLast4: phoneLast4(phone),
      emailDomain: emailDomainOnly(contact.email),
      smsConsent,
      messageBody,
      expirationDisplayDate,
      daysToExpiry,
      followUpPurchaseFound: false,
      activeMindbodyMembershipFound: false,
      activeStripeSubscriptionFound: false,
      wouldSend,
      blockReason,
      skipReasons: [],
    };
  }

  return {
    mindbodyClientId: clientId,
    seedSources,
    activeMindbodyMembershipFound,
    activeStripeSubscriptionFound,
    skipReasons,
    ncsPackages,
    candidate: best,
  };
}

/** @param {ClientEvaluation} ev */
export function redactCandidateForReport(ev) {
  return {
    segment: ev.segment,
    seedSources: ev.seedSources,
    mindbodyClientId: ev.mindbodyClientId,
    ncsServiceId: ev.ncs.serviceId,
    ncsClientServiceId: ev.ncs.clientServiceId,
    remainingVisits: ev.ncs.remaining,
    expirationDate: ev.ncs.expirationDateIso,
    daysToExpiry: ev.daysToExpiry,
    followUpPurchaseFound: ev.followUpPurchaseFound,
    activeMindbodyMembershipFound: ev.activeMindbodyMembershipFound,
    activeStripeSubscriptionFound: ev.activeStripeSubscriptionFound,
    activeMembershipOrSubscriptionFound:
      ev.activeMindbodyMembershipFound || ev.activeStripeSubscriptionFound,
    wouldSend: ev.wouldSend,
    blockReason: ev.blockReason,
    phoneLast4: ev.phoneLast4,
    emailDomain: ev.emailDomain,
    smsConsent: ev.smsConsent,
    messageBody: ev.messageBody,
  };
}

/** @param {ClientEvalResult} result */
export function redactSkippedEvalForReport(result) {
  const primary = result.ncsPackages[0] ?? null;
  return {
    segment: null,
    seedSources: result.seedSources,
    mindbodyClientId: result.mindbodyClientId,
    ncsServiceId: primary?.ncsServiceId ?? null,
    ncsClientServiceId: primary?.ncsClientServiceId ?? null,
    remainingVisits: primary?.remainingVisits ?? null,
    expirationDate: primary?.expirationDate ?? null,
    daysToExpiry: primary?.daysToExpiry ?? null,
    followUpPurchaseFound: primary?.followUpPurchaseFound ?? null,
    ncsPackages: result.ncsPackages,
    activeMindbodyMembershipFound: result.activeMindbodyMembershipFound,
    activeStripeSubscriptionFound: result.activeStripeSubscriptionFound,
    activeMembershipOrSubscriptionFound:
      result.activeMindbodyMembershipFound || result.activeStripeSubscriptionFound,
    wouldSend: false,
    blockReason: null,
    phoneLast4: null,
    emailDomain: null,
    skipReasons: result.skipReasons,
  };
}

export const __testing = {
  daysUntilExpiration,
  extractNcsServices,
  pickSegmentForNcs,
  buildSmsBody,
  isNcsServiceRow,
  readSmsConsent,
  smsRunCaps,
};
