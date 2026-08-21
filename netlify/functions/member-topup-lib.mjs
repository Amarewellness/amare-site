/**
 * Monthly Member Top-Up — eligibility, cycle keys, reserve/confirm/release.
 * Isolated from Guest Pass records. Period is membership billing cycle, not calendar month.
 */

import Stripe from "stripe";
import { amareSiteId } from "./amare-auth-lib.mjs";
import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";
import { MB_API_VERSION, fetchMb, getMindbodyStaffAccessTokenCached } from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { readStripeSubscriptionPeriod } from "./stripe-subscription-period.mjs";

export const TOPUP_SKU = "monthly_member_topup";
export const TOPUP_SERVICE_ID = 100143;
export const GUEST_PASS_SERVICE_ID = 100136;
export const MONTHLY_5_8_PRODUCT_IDS = Object.freeze([100129, 100130, 100133, 100134]);
export const MONTHLY_UNLIMITED_PRODUCT_IDS = Object.freeze([100056, 100135]);
export const IGNORED_PERK_PRODUCT_IDS = Object.freeze([100136, 100143]);
/** Client Services that book a normal AMARÉ group class (not retail / private / workshop). */
export const ORDINARY_GROUP_CLASS_PRODUCT_IDS = Object.freeze([
  100011, // Drop-In
  100012, // NCS
  100123, // Same-Day
  100127, // 10 Pack
  100128, // 20 Pack
]);
export const ELIGIBLE_TIERS = Object.freeze(["monthly_5", "monthly_8"]);
export const STUDIO_TZ = "America/New_York";
export const RESERVE_TTL_MS = 24 * 60 * 60 * 1000;
export const UNLIMITED_SENTINEL = 999999;

/** @typedef {{
 *   status: "reserved" | "purchased";
 *   siteId: string;
 *   mindbodyClientId: number;
 *   cycleStartDay: string;
 *   cycleStart: string | null;
 *   cycleEnd: string | null;
 *   sku: string;
 *   orderId?: string | null;
 *   expiresAt?: string;
 *   purchasedAt?: string;
 *   reservedAt?: string;
 * }} TopUpUsageRecord */

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

/** @param {unknown} data */
export function clientServicesRowsFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const k of ["ClientServices", "clientServices", "Services", "services"]) {
    const v = d[k];
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x));
    }
  }
  return [];
}

/** @param {unknown} data */
export function membershipsRowsFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const k of [
    "ClientMemberships",
    "Memberships",
    "memberships",
    "ActiveClientMemberships",
    "ActiveMemberships",
    "activeMemberships",
  ]) {
    const v = d[k];
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x));
    }
  }
  return [];
}

/** @param {Record<string, unknown>} row */
export function clientServiceProductId(row) {
  const pid = pick(row, ["ProductId", "productId", "ServiceId", "serviceId"]);
  if (typeof pid === "number" && Number.isFinite(pid)) return Math.trunc(pid);
  if (typeof pid === "string" && /^\d+$/.test(pid)) return parseInt(pid, 10);
  return NaN;
}

/** @param {Record<string, unknown>} row */
export function clientServiceRemaining(row) {
  const rem = pick(row, ["Remaining", "remaining"]);
  if (typeof rem === "number" && Number.isFinite(rem)) return rem;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return 0;
}

/** @param {Record<string, unknown>} row @param {number} [nowMs] */
export function clientServiceExpired(row, nowMs = Date.now()) {
  const exp = pick(row, ["ExpirationDate", "expirationDate", "End", "endDate"]);
  if (exp == null || exp === "") return false;
  const d = new Date(String(exp));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date(nowMs);
  const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return expDay < todayDay;
}

/** @param {Record<string, unknown>} row */
export function clientServiceName(row) {
  const name = pick(row, ["Name", "ProgramName", "serviceName", "name"]);
  return typeof name === "string" ? name.trim() : "";
}

/** @param {string} name */
export function isTopUpOrGuestPassName(name) {
  const lower = String(name || "").toLowerCase();
  return /top-?up/.test(lower) || /guest\s*pass/.test(lower);
}

/** @param {string} name */
export function inferMonthlyTierFromName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || isTopUpOrGuestPassName(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const hasMonthly = /\bmonthly\b/.test(lower) || /\brecurring\b/.test(lower);
  if (!hasMonthly && !/\b(unlimited|recurring\s+[58]|monthly\s+[58])\b/.test(lower)) return null;
  if (/unlimited/.test(lower)) return "monthly_unlimited";
  if (/\b8\b/.test(lower) || /8\s*class/.test(lower) || /recurring\s*8/.test(lower)) return "monthly_8";
  if (/\b5\b/.test(lower) || /5\s*class/.test(lower) || /recurring\s*5/.test(lower)) return "monthly_5";
  return null;
}

/** @param {Record<string, unknown>} row */
export function clientServiceInactive(row) {
  const active = pick(row, ["Active", "active", "IsActive", "isActive", "Current", "current"]);
  return active === false || active === "false" || active === 0 || active === "0";
}

/**
 * True only for credits the group-class booking flow can consume.
 * Unknown Remaining>0 services (retail, private, workshop) do not block Top-Up.
 * @param {Record<string, unknown>} row
 */
export function isOrdinaryGroupClassCredit(row) {
  if (!row || typeof row !== "object") return false;
  if (isIgnoredPerkService(row)) return false;
  if (isMonthlyFiveOrEightService(row)) return false;
  const pid = clientServiceProductId(row);
  if (ORDINARY_GROUP_CLASS_PRODUCT_IDS.includes(pid)) return true;
  const name = clientServiceName(row).toLowerCase();
  if (!name) return false;
  if (/drop\s*-?\s*in/.test(name)) return true;
  if (/same\s*-?\s*day/.test(name)) return true;
  if (/new\s*client|\bncs\b|3\s*for\s*65|3\s*pack|3\s*classes/.test(name)) return true;
  if (/\b(5|10|20)\b/.test(name) && /(class\s*)?pack|class(?:es)?/.test(name)) return true;
  return false;
}

/** @param {Record<string, unknown>} row */
export function isIgnoredPerkService(row) {
  const pid = clientServiceProductId(row);
  if (IGNORED_PERK_PRODUCT_IDS.includes(pid)) return true;
  return isTopUpOrGuestPassName(clientServiceName(row));
}

/** @param {Record<string, unknown>} row */
export function monthlyTierFromServiceRow(row) {
  const pid = clientServiceProductId(row);
  if (pid === 100129 || pid === 100133) return "monthly_5";
  if (pid === 100130 || pid === 100134) return "monthly_8";
  if (pid === 100056 || pid === 100135) return "monthly_unlimited";
  return inferMonthlyTierFromName(clientServiceName(row));
}

/** @param {Record<string, unknown>} row */
export function isMonthlyFiveOrEightService(row) {
  const tier = monthlyTierFromServiceRow(row);
  return tier === "monthly_5" || tier === "monthly_8";
}

/**
 * Split remaining visits into:
 *   monthlyCreditsRemaining — current monthly_5/8 allocation only
 *   otherUsableCredits — remaining visits on ordinary group-class credits only
 *     (Drop-In, NCS, valid Same-Day, 10/20 packs; name fallback for the same kinds)
 *
 * Ignores Guest Pass, Top-Up, expired/inactive rows, unlimited sentinel rows,
 * and non-class Client Services (retail, private, workshop).
 *
 * @param {Record<string, unknown>[]} rows
 * @param {number} [nowMs]
 */
export function computeUsableCreditBuckets(rows, nowMs = Date.now()) {
  let monthlyCreditsRemaining = 0;
  let otherUsableCredits = 0;
  /** @type {Record<string, unknown>[]} */
  const monthlyRows = [];
  /** @type {Record<string, unknown>[]} */
  const otherRows = [];

  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    if (clientServiceExpired(row, nowMs)) continue;
    if (clientServiceInactive(row)) continue;
    if (isIgnoredPerkService(row)) continue;
    const rem = clientServiceRemaining(row);
    if (rem <= 0) {
      if (isMonthlyFiveOrEightService(row)) monthlyRows.push(row);
      continue;
    }
    if (rem >= UNLIMITED_SENTINEL) continue;
    if (isMonthlyFiveOrEightService(row)) {
      monthlyCreditsRemaining += rem;
      monthlyRows.push(row);
      continue;
    }
    if (!isOrdinaryGroupClassCredit(row)) continue;
    otherUsableCredits += rem;
    otherRows.push(row);
  }

  return { monthlyCreditsRemaining, otherUsableCredits, monthlyRows, otherRows };
}

/** @param {Record<string, unknown>[]} memberships */
export function activeMembershipTier(memberships) {
  for (const row of memberships || []) {
    const active = pick(row, ["Active", "active"]);
    if (active !== true && active !== "true" && active !== 1) continue;
    const name = String(
      pick(row, ["MembershipName", "Name", "name", "ProgramName", "Description"]) || "",
    );
    const tier = inferMonthlyTierFromName(name);
    if (tier) return { tier, row };
  }
  return { tier: null, row: null };
}

/**
 * @param {{
 *   services: Record<string, unknown>[];
 *   memberships: Record<string, unknown>[];
 *   stripeSubs: Array<{ localSku?: string; status?: string }>;
 * }} input
 */
export function resolveMemberTier(input) {
  for (const sub of input.stripeSubs || []) {
    const st = String(sub.status || "");
    if (st !== "active" && st !== "past_due") continue;
    const sku = String(sub.localSku || "");
    if (sku === "monthly_5" || sku === "monthly_8" || sku === "monthly_unlimited") {
      return { tier: sku, source: "stripe" };
    }
  }

  const buckets = computeUsableCreditBuckets(input.services);
  /** @type {string | null} */
  let fromServices = null;
  for (const row of buckets.monthlyRows) {
    const t = monthlyTierFromServiceRow(row);
    if (t === "monthly_5" || t === "monthly_8") fromServices = t;
  }
  for (const row of input.services || []) {
    if (clientServiceExpired(row)) continue;
    const t = monthlyTierFromServiceRow(row);
    if (t === "monthly_unlimited") return { tier: "monthly_unlimited", source: "clientservices" };
    if ((t === "monthly_5" || t === "monthly_8") && !fromServices) fromServices = t;
  }
  if (fromServices) return { tier: fromServices, source: "clientservices" };

  const mem = activeMembershipTier(input.memberships);
  if (mem.tier) return { tier: mem.tier, source: "activeclientmemberships" };
  return { tier: null, source: null };
}

const YMD_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

/** @param {string} s */
function isNaiveMindbodyDateTime(s) {
  if (!YMD_PREFIX_RE.test(s)) return false;
  if (/[zZ]/.test(s)) return false;
  if (/[+-]\d{2}:?\d{2}\s*$/.test(s)) return false;
  return true;
}

/** @param {string | Date} isoOrDate @param {string} [tz] */
function formatInstantInTimeZone(isoOrDate, tz = STUDIO_TZ) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(String(isoOrDate));
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !day) return null;
  return `${y}-${m}-${day}`;
}

/**
 * Studio calendar day for cycle keys.
 * Naive Mindbody `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm:ss` (no offset) keep that calendar
 * component. Real instants (Date, Z, or numeric offset) use America/New_York.
 *
 * @param {string | Date | null | undefined} raw
 * @param {string} [tz]
 */
export function mindbodyStudioCalendarDay(raw, tz = STUDIO_TZ) {
  if (raw instanceof Date) return formatInstantInTimeZone(raw, tz);
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (isNaiveMindbodyDateTime(s)) {
    const m = YMD_PREFIX_RE.exec(s);
    return m ? m[1] : null;
  }
  return formatInstantInTimeZone(s, tz);
}

/** @param {string | Date} iso @param {string} [tz] */
export function cycleStartDayKey(iso, tz = STUDIO_TZ) {
  return mindbodyStudioCalendarDay(iso, tz);
}

/** @param {number} [nowMs] @param {string} [tz] */
export function studioTodayKey(nowMs = Date.now(), tz = STUDIO_TZ) {
  return formatInstantInTimeZone(new Date(nowMs), tz);
}

/** @param {string | null} startDay @param {string | null} endDay @param {string | null} todayDay */
export function isStudioDayInInclusiveWindow(startDay, endDay, todayDay) {
  if (!startDay || !endDay || !todayDay) return false;
  return todayDay >= startDay && todayDay <= endDay;
}

/** @param {Record<string, unknown>} row */
export function rowDateIso(row, keys) {
  const raw = pick(row, keys);
  if (raw == null || raw === "") return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Current monthly_5/8 ClientService for billing-cycle dates only.
 * Exhausted Remaining=0 / Current=false / Active=false rows stay eligible when
 * the studio calendar day is inside ActiveDate–ExpirationDate.
 * Does not change credit buckets or clientServiceInactive().
 *
 * @param {Record<string, unknown>[]} rows
 * @param {number} [nowMs]
 */
export function selectCurrentMonthlyCycleRow(rows, nowMs = Date.now()) {
  const today = studioTodayKey(nowMs);
  if (!today) return null;
  /** @type {{ row: Record<string, unknown>; endDay: string }[]} */
  const candidates = [];
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    if (!MONTHLY_5_8_PRODUCT_IDS.includes(clientServiceProductId(row))) continue;
    const startDay = mindbodyStudioCalendarDay(
      pick(row, ["ActiveDate", "activeDate"]),
    );
    const endDay = mindbodyStudioCalendarDay(pick(row, ["ExpirationDate", "expirationDate", "End", "endDate"]));
    if (!startDay || !endDay) continue;
    if (!isStudioDayInInclusiveWindow(startDay, endDay, today)) continue;
    candidates.push({ row, endDay });
  }
  candidates.sort((a, b) => b.endDay.localeCompare(a.endDay));
  return candidates[0]?.row || null;
}

/**
 * @param {{
 *   stripeStart?: string | null;
 *   stripeEnd?: string | null;
 *   monthlyRow?: Record<string, unknown> | null;
 *   membershipRow?: Record<string, unknown> | null;
 * }} input
 */
export function resolveBillingCycle(input) {
  if (input.stripeStart && input.stripeEnd) {
    const day = cycleStartDayKey(input.stripeStart);
    const endDay = cycleStartDayKey(input.stripeEnd);
    if (day) {
      return {
        cycleStart: input.stripeStart,
        cycleEnd: input.stripeEnd,
        cycleStartDay: day,
        cycleEndDay: endDay,
        source: "stripe",
      };
    }
  }
  const monthly = input.monthlyRow || null;
  if (monthly) {
    const startRaw = pick(monthly, ["ActiveDate", "activeDate", "PaymentDate", "paymentDate", "SaleDate", "saleDate"]);
    const endRaw = pick(monthly, ["ExpirationDate", "expirationDate", "End", "endDate"]);
    const startDay = mindbodyStudioCalendarDay(startRaw);
    const endDay = mindbodyStudioCalendarDay(endRaw);
    if (startDay && endDay) {
      return {
        cycleStart: startRaw != null ? String(startRaw) : startDay,
        cycleEnd: endRaw != null ? String(endRaw) : endDay,
        cycleStartDay: startDay,
        cycleEndDay: endDay,
        source: "clientservices",
      };
    }
    if (endDay) {
      return {
        cycleStart: endRaw != null ? String(endRaw) : endDay,
        cycleEnd: endRaw != null ? String(endRaw) : endDay,
        cycleStartDay: endDay,
        cycleEndDay: endDay,
        source: "clientservices_end",
      };
    }
  }
  const mem = input.membershipRow || null;
  if (mem) {
    const endRaw = pick(mem, ["ExpirationDate", "EndDate", "end", "expirationDate"]);
    const endDay = mindbodyStudioCalendarDay(endRaw);
    if (endDay) {
      return {
        cycleStart: endRaw != null ? String(endRaw) : endDay,
        cycleEnd: endRaw != null ? String(endRaw) : endDay,
        cycleStartDay: endDay,
        cycleEndDay: endDay,
        source: "memberships",
      };
    }
  }
  return { cycleStart: null, cycleEnd: null, cycleStartDay: null, cycleEndDay: null, source: "missing" };
}

export function topUpUsageKey(siteId, mindbodyClientId, cycleStartDay, sku = TOPUP_SKU) {
  return `topup:${siteId}:${mindbodyClientId}:${cycleStartDay}:${sku}`;
}

/** @param {TopUpUsageRecord | null | undefined} usage @param {number} [nowMs] */
export function usageBlocksNewPurchase(usage, nowMs = Date.now()) {
  if (!usage) return false;
  if (usage.status === "purchased") return true;
  if (usage.status === "reserved") {
    if (usage.expiresAt && Date.parse(String(usage.expiresAt)) <= nowMs) return false;
    return true;
  }
  return false;
}

/**
 * @param {{
 *   tier: string | null;
 *   monthlyCreditsRemaining: number;
 *   otherUsableCredits: number;
 *   usage?: TopUpUsageRecord | null;
 *   cycleStartDay?: string | null;
 *   nowMs?: number;
 * }} input
 */
export function evaluateTopUpGate(input) {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.tier) return { eligible: false, reason: "not_a_member", cta: "none" };
  if (input.tier === "monthly_unlimited") return { eligible: false, reason: "unlimited", cta: "none" };
  if (!ELIGIBLE_TIERS.includes(input.tier)) return { eligible: false, reason: "tier_not_eligible", cta: "none" };
  if (!input.cycleStartDay) return { eligible: false, reason: "cycle_unresolved", cta: "none" };
  if (input.monthlyCreditsRemaining > 0) {
    return { eligible: false, reason: "monthly_credits_remain", cta: "none" };
  }
  if (input.otherUsableCredits > 0) {
    return { eligible: false, reason: "other_usable_credits", cta: "none" };
  }
  if (usageBlocksNewPurchase(input.usage, nowMs)) {
    const cta = input.tier === "monthly_5" ? "upgrade_monthly_8" : "go_unlimited";
    const reason = input.usage?.status === "reserved" ? "topup_reserved" : "topup_purchased";
    return { eligible: false, reason, cta };
  }
  return { eligible: true, reason: "eligible", cta: "topup" };
}

export function topUpPublicCopy(cta) {
  if (cta === "topup") {
    return {
      eyebrow: "Need one more class?",
      button: "Add 1 Class · $29",
      support: "One member top-up per billing cycle.",
      upgrade: null,
    };
  }
  if (cta === "upgrade_monthly_8") {
    return {
      eyebrow: "Need one more class?",
      button: "Upgrade to Monthly 8",
      support: "One member top-up per billing cycle.",
      upgrade: "Upgrade to Monthly 8",
    };
  }
  if (cta === "go_unlimited") {
    return {
      eyebrow: "Need one more class?",
      button: "Go Unlimited",
      support: "One member top-up per billing cycle.",
      upgrade: "Go Unlimited",
    };
  }
  return { eyebrow: null, button: null, support: null, upgrade: null };
}

/** @param {unknown} data */
function clientServiceRowId(row) {
  const raw = pick(row, ["Id", "id"]);
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
}

/** @param {unknown} consumerData @param {unknown} staffData */
export function mergeClientServicesPayload(consumerData, staffData) {
  const consumerRows = clientServicesRowsFromPayload(consumerData);
  const staffRows = clientServicesRowsFromPayload(staffData);
  if (!consumerRows.length) return staffRows;
  if (!staffRows.length) return consumerRows;
  /** @type {Map<number, Record<string, unknown>>} */
  const staffById = new Map();
  for (const row of staffRows) {
    const id = clientServiceRowId(row);
    if (id != null) staffById.set(id, row);
  }
  const merged = consumerRows.map((row) => {
    const id = clientServiceRowId(row);
    if (id == null) return row;
    const staffRow = staffById.get(id);
    if (!staffRow) return row;
    const cRem = clientServiceRemaining(row);
    const sRem = clientServiceRemaining(staffRow);
    return sRem < cRem ? { ...row, Remaining: staffRow.Remaining ?? staffRow.remaining ?? row.Remaining } : row;
  });
  const seen = new Set(merged.map((r) => clientServiceRowId(r)).filter((id) => id != null));
  for (const row of staffRows) {
    const id = clientServiceRowId(row);
    if (id != null && !seen.has(id)) merged.push(row);
  }
  return merged;
}

export async function resolveTopUpStaffHeaders() {
  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  if (staffUser && typeof staffPass === "string" && staffPass !== "") {
    const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
    if (issued.ok) return mindbodyStaffBearerHeaders(issued.accessToken);
  }
  return mindbodyStaffApiHeaders();
}

/**
 * @param {number} clientId
 * @param {Record<string, string> | null} headers
 */
async function fetchClientServices(clientId, headers) {
  if (!headers) return [];
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/client/clientservices?${q}`, headers, null);
  if (!r.ok) return [];
  return clientServicesRowsFromPayload(r.data);
}

/**
 * @param {number} clientId
 * @param {Record<string, string> | null} headers
 */
async function fetchActiveMemberships(clientId, headers) {
  if (!headers) return [];
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.limit": "50",
  });
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/client/activeclientmemberships?${q}`, headers, null);
  if (!r.ok) return [];
  return membershipsRowsFromPayload(r.data);
}

/**
 * @param {string} stripeSubscriptionId
 */
export async function liveRetrieveStripePeriod(stripeSubscriptionId) {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk.startsWith("sk_") || !/^sub_[A-Za-z0-9]+$/.test(stripeSubscriptionId)) return null;
  const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, { expand: ["items.data"] });
  return readStripeSubscriptionPeriod(sub);
}

/**
 * @param {import("@netlify/blobs").Store | null} store
 * @param {{
 *   siteId: string;
 *   mindbodyClientId: number;
 *   cycleStartDay: string;
 *   cycleStart: string | null;
 *   cycleEnd: string | null;
 *   orderId?: string | null;
 * }} opts
 */
export async function reserveTopUpSlot(store, opts) {
  if (!store) return { ok: false, reason: "store_unavailable" };
  const key = topUpUsageKey(opts.siteId, opts.mindbodyClientId, opts.cycleStartDay);
  const existing = await store.get(key, { type: "json" });
  const rec = existing && typeof existing === "object" ? /** @type {TopUpUsageRecord} */ (existing) : null;
  if (rec?.status === "purchased") return { ok: false, reason: "topup_purchased", record: rec };
  if (rec?.status === "reserved" && rec.expiresAt && Date.parse(String(rec.expiresAt)) > Date.now()) {
    return { ok: false, reason: "topup_reserved", record: rec };
  }
  if (rec?.status === "reserved") {
    try {
      await store.delete(key);
    } catch {
      /* ignore */
    }
  }
  /** @type {TopUpUsageRecord} */
  const pending = {
    status: "reserved",
    siteId: opts.siteId,
    mindbodyClientId: opts.mindbodyClientId,
    cycleStartDay: opts.cycleStartDay,
    cycleStart: opts.cycleStart,
    cycleEnd: opts.cycleEnd,
    sku: TOPUP_SKU,
    orderId: opts.orderId || null,
    reservedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + RESERVE_TTL_MS).toISOString(),
  };
  const created = await atomicCreateJSON(store, key, pending);
  if (!created.modified) {
    const cur = await store.get(key, { type: "json" });
    return { ok: false, reason: "topup_reserved", record: cur };
  }
  return { ok: true, record: pending, key };
}

/**
 * @param {import("@netlify/blobs").Store | null} store
 * @param {{ siteId: string; mindbodyClientId: number; cycleStartDay: string; orderId?: string | null }} opts
 */
export async function releaseTopUpReservation(store, opts) {
  if (!store) return { ok: false, reason: "store_unavailable" };
  const key = topUpUsageKey(opts.siteId, opts.mindbodyClientId, opts.cycleStartDay);
  try {
    const cur = await store.get(key, { type: "json" });
    if (!cur || typeof cur !== "object") return { ok: true, released: false, reason: "not_found" };
    const rec = /** @type {TopUpUsageRecord} */ (cur);
    if (rec.status === "purchased") return { ok: true, released: false, reason: "already_purchased" };
    if (opts.orderId && rec.orderId && rec.orderId !== opts.orderId) {
      return { ok: true, released: false, reason: "order_mismatch" };
    }
    await store.delete(key);
    return { ok: true, released: true };
  } catch {
    return { ok: false, released: false };
  }
}

/**
 * Paid → permanently consume. Idempotent for the same orderId.
 *
 * @param {import("@netlify/blobs").Store | null} store
 * @param {{ siteId: string; mindbodyClientId: number; cycleStartDay: string; orderId: string; cycleStart?: string | null; cycleEnd?: string | null }} opts
 */
export async function finalizeTopUpPurchase(store, opts) {
  if (!store) return { ok: false, reason: "store_unavailable" };
  const key = topUpUsageKey(opts.siteId, opts.mindbodyClientId, opts.cycleStartDay);
  const purchasedAt = new Date().toISOString();
  const upd = await atomicUpdateJSON(
    store,
    key,
    async (cur) => {
      if (cur && typeof cur === "object") {
        const rec = /** @type {TopUpUsageRecord} */ (cur);
        if (rec.status === "purchased") return rec;
        return {
          ...rec,
          status: "purchased",
          orderId: opts.orderId,
          purchasedAt,
        };
      }
      return {
        status: "purchased",
        siteId: opts.siteId,
        mindbodyClientId: opts.mindbodyClientId,
        cycleStartDay: opts.cycleStartDay,
        cycleStart: opts.cycleStart || null,
        cycleEnd: opts.cycleEnd || null,
        sku: TOPUP_SKU,
        orderId: opts.orderId,
        purchasedAt,
      };
    },
  );
  if (!upd.ok && upd.reason === "not_found") {
    const created = await atomicCreateJSON(store, key, {
      status: "purchased",
      siteId: opts.siteId,
      mindbodyClientId: opts.mindbodyClientId,
      cycleStartDay: opts.cycleStartDay,
      cycleStart: opts.cycleStart || null,
      cycleEnd: opts.cycleEnd || null,
      sku: TOPUP_SKU,
      orderId: opts.orderId,
      purchasedAt,
    });
    return { ok: created.modified, reason: created.modified ? undefined : "already_purchased" };
  }
  return { ok: upd.ok, modified: upd.ok ? upd.modified : false, reason: upd.ok ? undefined : upd.reason };
}

/**
 * Bind Stripe order id onto an existing reservation.
 * @param {import("@netlify/blobs").Store | null} store
 */
export async function attachTopUpOrderId(store, opts) {
  if (!store) return { ok: false };
  const key = topUpUsageKey(opts.siteId, opts.mindbodyClientId, opts.cycleStartDay);
  const upd = await atomicUpdateJSON(store, key, async (cur) => {
    if (!cur || typeof cur !== "object") return null;
    const rec = /** @type {TopUpUsageRecord} */ (cur);
    if (rec.status !== "reserved") return null;
    return { ...rec, orderId: opts.orderId };
  });
  return { ok: upd.ok && upd.modified };
}

/**
 * @param {number} clientId
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ consumerAuthHeaders?: Record<string, string> | null }} [opts]
 */
export async function loadTopUpEligibilityContext(clientId, event, opts = {}) {
  const siteId = amareSiteId();
  const staffHeaders = await resolveTopUpStaffHeaders();
  const consumerHeaders = opts.consumerAuthHeaders ?? null;
  const [consumerServices, staffServices, consumerMems, staffMems] = await Promise.all([
    fetchClientServices(clientId, consumerHeaders),
    fetchClientServices(clientId, staffHeaders),
    fetchActiveMemberships(clientId, consumerHeaders),
    fetchActiveMemberships(clientId, staffHeaders),
  ]);
  const services = mergeClientServicesPayload(
    { ClientServices: consumerServices },
    { ClientServices: staffServices },
  );
  const memberships = consumerMems.length ? consumerMems : staffMems;

  const subStore = openSubscriptionStore(event);
  const stripeSubs = subStore?.available
    ? await subStore.listActiveByMindbodyClientId(clientId, { limit: 10 })
    : [];

  const tierInfo = resolveMemberTier({ services, memberships, stripeSubs });
  const buckets = computeUsableCreditBuckets(services);
  const currentMonthly = selectCurrentMonthlyCycleRow(services);

  const activeStripe = (stripeSubs || []).find((s) => {
    const st = String(s.status || "");
    const sku = String(s.localSku || "");
    return (st === "active" || st === "past_due") && (sku === "monthly_5" || sku === "monthly_8");
  });

  let stripeStart = activeStripe?.currentPeriodStart || null;
  let stripeEnd = activeStripe?.currentPeriodEnd || null;
  let stripePeriodSource = stripeStart && stripeEnd ? "subscription_store" : "missing";
  if ((!stripeStart || !stripeEnd) && activeStripe?.stripeSubscriptionId) {
    try {
      const live = await liveRetrieveStripePeriod(String(activeStripe.stripeSubscriptionId));
      if (live?.start && live?.end) {
        stripeStart = live.start;
        stripeEnd = live.end;
        stripePeriodSource = live.source;
        if (subStore?.available && activeStripe.id) {
          try {
            await subStore.patch(activeStripe.id, {
              currentPeriodStart: live.start,
              currentPeriodEnd: live.end,
            });
          } catch {
            /* cache fill is best-effort */
          }
        }
      }
    } catch {
      /* fall through to ClientService dates */
    }
  }

  const mem = activeMembershipTier(memberships);
  const cycle = resolveBillingCycle({
    stripeStart,
    stripeEnd,
    monthlyRow: currentMonthly,
    membershipRow: mem.row,
  });

  return {
    siteId,
    services,
    memberships,
    stripeSubs,
    tier: tierInfo.tier,
    tierSource: tierInfo.source,
    ...buckets,
    cycle,
    stripePeriodSource,
    currentMonthly,
  };
}

/**
 * Eligibility + reserve for checkout / PaymentSheet. Caller supplies orderId when known.
 * @param {{
 *   event: import("@netlify/functions").HandlerEvent;
 *   clientId: number;
 *   consumerAuthHeaders?: Record<string, string> | null;
 *   orderId?: string | null;
 * }} opts
 */
export async function prepareTopUpForPurchase(opts) {
  const { memberTopUpEnabled, tryOpenMemberTopUpBlobStore } = await import("./member-topup-blobs.mjs");
  if (!memberTopUpEnabled()) return { ok: false, reason: "topup_disabled" };
  const store = tryOpenMemberTopUpBlobStore(opts.event);
  if (!store) return { ok: false, reason: "store_unavailable" };
  const ctx = await loadTopUpEligibilityContext(opts.clientId, opts.event, {
    consumerAuthHeaders: opts.consumerAuthHeaders ?? null,
  });
  /** @type {TopUpUsageRecord | null} */
  let usage = null;
  if (ctx.cycle.cycleStartDay) {
    const key = topUpUsageKey(ctx.siteId, opts.clientId, ctx.cycle.cycleStartDay);
    const raw = await store.get(key, { type: "json" });
    if (raw && typeof raw === "object") usage = /** @type {TopUpUsageRecord} */ (raw);
  }
  const gate = evaluateTopUpGate({
    tier: ctx.tier,
    monthlyCreditsRemaining: ctx.monthlyCreditsRemaining,
    otherUsableCredits: ctx.otherUsableCredits,
    usage,
    cycleStartDay: ctx.cycle.cycleStartDay,
  });
  if (!gate.eligible) return { ok: false, reason: gate.reason || "ineligible", ctx, gate };
  const reserved = await reserveTopUpSlot(store, {
    siteId: ctx.siteId,
    mindbodyClientId: opts.clientId,
    cycleStartDay: ctx.cycle.cycleStartDay,
    cycleStart: ctx.cycle.cycleStart,
    cycleEnd: ctx.cycle.cycleEnd,
    orderId: opts.orderId || null,
  });
  if (!reserved.ok) return { ok: false, reason: reserved.reason || "topup_reserved", ctx, gate };
  return { ok: true, store, ctx, gate, reserved };
}

/**
 * Consume cycle slot on paid. Safe to call for any order — no-ops unless Top-Up.
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ localSku?: string; orderId?: string; knownMindbodyClientId?: number | null; resolvedMindbodyClientId?: number | null; topUpCycleStartDay?: string | null; topUpCycleStart?: string | null; topUpCycleEnd?: string | null }} order
 */
export async function consumeTopUpForPaidOrder(event, order) {
  if (!isMemberTopUpSku(order?.localSku)) return { ok: true, skipped: true };
  const { tryOpenMemberTopUpBlobStore } = await import("./member-topup-blobs.mjs");
  const store = tryOpenMemberTopUpBlobStore(event);
  const clientId = Number(order.knownMindbodyClientId || order.resolvedMindbodyClientId || 0);
  const cycleStartDay = String(order.topUpCycleStartDay || "");
  if (!store || !clientId || !cycleStartDay || !order.orderId) {
    return { ok: false, reason: "missing_topup_context" };
  }
  return finalizeTopUpPurchase(store, {
    siteId: amareSiteId(),
    mindbodyClientId: clientId,
    cycleStartDay,
    orderId: order.orderId,
    cycleStart: order.topUpCycleStart || null,
    cycleEnd: order.topUpCycleEnd || null,
  });
}

/**
 * Release reservation on failed/expired/abandoned payment. Never un-purchases.
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ localSku?: string; orderId?: string; knownMindbodyClientId?: number | null; resolvedMindbodyClientId?: number | null; topUpCycleStartDay?: string | null }} order
 */
export async function releaseTopUpForAbandonedOrder(event, order) {
  if (!isMemberTopUpSku(order?.localSku)) return { ok: true, skipped: true };
  const { tryOpenMemberTopUpBlobStore } = await import("./member-topup-blobs.mjs");
  const store = tryOpenMemberTopUpBlobStore(event);
  const clientId = Number(order.knownMindbodyClientId || order.resolvedMindbodyClientId || 0);
  const cycleStartDay = String(order.topUpCycleStartDay || "");
  if (!store || !clientId || !cycleStartDay) return { ok: true, released: false };
  return releaseTopUpReservation(store, {
    siteId: amareSiteId(),
    mindbodyClientId: clientId,
    cycleStartDay,
    orderId: order.orderId || null,
  });
}

const PAID_SYNC_STATUSES = new Set([
  "payment_completed",
  "mindbody_synced",
  "paid_but_not_synced",
  "mindbody_sync_unknown",
]);

/**
 * Fail-closed unpaid cancel. Never release if Stripe/order may already be paid.
 * @param {{
 *   order?: { localSku?: string; mindbodySyncStatus?: string; stripePaymentStatus?: string } | null;
 *   stripePaymentIntentStatus?: string | null;
 *   stripeSessionPaymentStatus?: string | null;
 * }} input
 */
export function canSafelyReleaseTopUpReservation(input) {
  const order = input.order;
  if (!order || !isMemberTopUpSku(order.localSku)) return { ok: false, reason: "not_topup" };
  const sync = String(order.mindbodySyncStatus || "");
  if (PAID_SYNC_STATUSES.has(sync)) return { ok: false, reason: "order_paid" };
  const pay = String(order.stripePaymentStatus || "");
  if (pay === "paid" || pay === "succeeded") return { ok: false, reason: "order_paid" };
  const pi = String(input.stripePaymentIntentStatus || "");
  if (pi === "succeeded" || pi === "processing") return { ok: false, reason: pi === "processing" ? "pi_processing" : "pi_succeeded" };
  const sess = String(input.stripeSessionPaymentStatus || "");
  if (sess === "paid") return { ok: false, reason: "session_paid" };
  return { ok: true };
}

/**
 * @param {{ stripePaymentIntentId?: string; stripeCheckoutSessionId?: string }} order
 */
export async function inspectStripePaymentForTopUpRelease(order, stripeClient) {
  const stripe =
    stripeClient ||
    ((process.env.STRIPE_SECRET_KEY || "").trim().startsWith("sk_")
      ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" })
      : null);
  /** @type {string | null} */
  let stripePaymentIntentStatus = null;
  /** @type {string | null} */
  let stripeSessionPaymentStatus = null;
  if (stripe && order.stripePaymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(String(order.stripePaymentIntentId));
      stripePaymentIntentStatus = typeof pi.status === "string" ? pi.status : null;
    } catch {
      /* treat as unknown — fail closed only if order already looks paid */
    }
  }
  if (stripe && order.stripeCheckoutSessionId) {
    try {
      const sess = await stripe.checkout.sessions.retrieve(String(order.stripeCheckoutSessionId));
      stripeSessionPaymentStatus = typeof sess.payment_status === "string" ? sess.payment_status : null;
    } catch {
      /* ignore */
    }
  }
  return { stripe, stripePaymentIntentStatus, stripeSessionPaymentStatus, inspected: Boolean(stripe) };
}

/**
 * Confirmed unpaid cancel: expire/cancel Stripe if still open, then release reservation.
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{
 *   order: { localSku?: string; orderId?: string; knownMindbodyClientId?: number | null; resolvedMindbodyClientId?: number | null; topUpCycleStartDay?: string | null; mindbodySyncStatus?: string; stripePaymentStatus?: string; stripePaymentIntentId?: string; stripeCheckoutSessionId?: string };
 *   clientId?: number | null;
 *   stripe?: import("stripe").default | null;
 * }} opts
 */
export async function releaseUnpaidTopUpOrder(event, opts) {
  const order = opts.order;
  if (opts.clientId && Number(order.knownMindbodyClientId) > 0 && Number(order.knownMindbodyClientId) !== Number(opts.clientId)) {
    return { ok: false, released: false, reason: "client_mismatch" };
  }
  const inspect = await inspectStripePaymentForTopUpRelease(order, opts.stripe || undefined);
  const gate = canSafelyReleaseTopUpReservation({
    order,
    stripePaymentIntentStatus: inspect.stripePaymentIntentStatus,
    stripeSessionPaymentStatus: inspect.stripeSessionPaymentStatus,
  });
  if (!gate.ok) return { ok: false, released: false, reason: gate.reason };
  if (inspect.stripe) {
    if (order.stripeCheckoutSessionId && inspect.stripeSessionPaymentStatus && inspect.stripeSessionPaymentStatus !== "paid") {
      try {
        await inspect.stripe.checkout.sessions.expire(String(order.stripeCheckoutSessionId));
      } catch {
        /* already expired/completed */
      }
    }
    const cancelable = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
    if (order.stripePaymentIntentId && inspect.stripePaymentIntentStatus && cancelable.has(inspect.stripePaymentIntentStatus)) {
      try {
        await inspect.stripe.paymentIntents.cancel(String(order.stripePaymentIntentId));
      } catch {
        /* already canceled */
      }
    }
  }
  return releaseTopUpForAbandonedOrder(event, order);
}

export function isMemberTopUpSku(sku) {
  return String(sku || "").trim() === TOPUP_SKU;
}

export function isMemberTopUpItem(item) {
  if (!item || typeof item !== "object") return false;
  const it = /** @type {{ localSku?: unknown; kind?: unknown }} */ (item);
  return it.kind === "memberAddon" || isMemberTopUpSku(it.localSku);
}
