import { randomBytes } from "node:crypto";
import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";
import { loadGuestPassConfig, monthlyMindbodyProductIdToSkuMap } from "./guest-pass-catalog-lib.mjs";
import { guestPassBlobReadConsistency, guestPassBlobsEnabled } from "./guest-pass-blobs.mjs";
import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import {
  assertClassEligibleForGuestBooking,
  spotsRemainingFromClassRow,
} from "./mindbody-class-capacity-lib.mjs";
import { loadMbContractTermsConfig } from "./load-mb-contract-terms.mjs";
import { normalizeEmail, normalizePhone } from "./mindbody-guest-client-lib.mjs";
import {
  isStudioDayInInclusiveWindow,
  mindbodyStudioCalendarDay,
  studioTodayKey,
} from "./member-topup-lib.mjs";

export { normalizeEmail, normalizePhone };
export { spotsRemainingFromClassRow, assertClassEligibleForGuestBooking };

const PENDING_TTL_MS = 5 * 60 * 1000;
/** Studio late-cancel window (hours before class start). */
export const STUDIO_LATE_CANCEL_HOURS = 12;
const STUDIO_LATE_CANCEL_MS = STUDIO_LATE_CANCEL_HOURS * 60 * 60 * 1000;

/** @typedef {import("@netlify/blobs").Store} BlobStore */

/** @typedef {{
 *   status: string;
 *   period: string;
 *   periodMode?: string;
 *   entitlementSku?: string;
 *   memberClientId?: number;
 *   guestClientId?: number;
 *   guestClientServiceId?: number;
 *   guestVisitId?: number;
 *   guestBookingId?: string;
 *   saleId?: number;
 *   classId?: number;
 *   classDateTime?: string;
 *   className?: string;
 *   guestFirstName?: string;
 *   guestLastName?: string;
 *   guestEmailLower?: string;
 *   guestPhoneNorm?: string;
 *   guestResolvedBy?: string;
 *   confirmedAtIso?: string;
 *   requiresInStudioWaiver?: boolean;
 *   expiresAt?: string;
 *   cancelledAtIso?: string;
 *   cancelLateMember?: boolean;
 *   cancelLateGuest?: boolean;
 *   cancelledByMemberClientId?: number;
 * }} GuestPassUsageRecord */

/** @param {Date} [now] @param {string} [tz] */
export function calendarMonthPeriodKey(now = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

/** @param {Date} [now] @param {string} [tz] */
export function nextCalendarMonthStartIso(now = new Date(), tz = "America/New_York") {
  const key = calendarMonthPeriodKey(now, tz);
  const [y, m] = key.split("-").map((x) => parseInt(x, 10));
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const iso = `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01T00:00:00`;
  const d = new Date(iso);
  return new Date(d.toLocaleString("en-US", { timeZone: tz })).toISOString();
}

/** @param {string} expirationDate @param {string} [tz] */
export function packExpirationEndIso(expirationDate, tz = "America/New_York") {
  const raw = String(expirationDate || "").trim();
  if (!raw) return null;
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T23:59:59`;
}

export function usageKey(memberClientId, periodKey) {
  return `guestPassUsage:${memberClientId}:${periodKey}`;
}

export function emailReceivedKey(emailLower, periodKey) {
  return `guestPassReceived:email:${emailLower}:${periodKey}`;
}

export function phoneReceivedKey(phoneNorm, periodKey) {
  return `guestPassReceived:phone:${phoneNorm}:${periodKey}`;
}

export function clientReceivedKey(guestClientId, periodKey) {
  return `guestPassReceived:client:${guestClientId}:${periodKey}`;
}

export function guestBookingConsentKey(guestClientId, contractVersion) {
  return `guestBookingConsent:${guestClientId}:${contractVersion}`;
}

export function loadGuestBookingConsentText() {
  const cfg = loadMbContractTermsConfig();
  const text = cfg && typeof cfg === "object" ? /** @type {Record<string, unknown>} */ (cfg).guestBookingConsentText : null;
  if (typeof text === "string" && text.trim()) return text.trim();
  return "I confirm my guest gave permission to share their contact information with Amaré and understands they must arrive 10 minutes early to complete the in-studio waiver and check-in.";
}

export function makeGuestBookingId() {
  return randomBytes(6).toString("hex");
}

/** @param {BlobStore | null} store @param {string} key */
async function readJson(store, key) {
  if (!store) return null;
  const v = await store.get(key, { type: "json" });
  return v && typeof v === "object" ? /** @type {GuestPassUsageRecord} */ (v) : null;
}

/** @param {Record<string, unknown>} row */
function clientServiceProductId(row) {
  const pid = row.ProductId ?? row.productId ?? row.ServiceId ?? row.serviceId;
  if (typeof pid === "number" && Number.isFinite(pid)) return Math.trunc(pid);
  if (typeof pid === "string" && /^\d+$/.test(pid)) return parseInt(pid, 10);
  return NaN;
}

/** @param {Record<string, unknown>} row */
function clientServiceHasRemaining(row) {
  const rem = row.Remaining ?? row.remaining;
  if (typeof rem === "number" && rem > 0) return true;
  if (rem === "1") return true;
  if (typeof rem === "string" && parseInt(rem, 10) > 0) return true;
  // Unlimited monthly packs use a high sentinel in Mindbody
  if (typeof rem === "number" && rem >= 999999) return true;
  return false;
}

/** @param {Record<string, unknown>} row @param {number} nowMs */
function clientServiceNotExpired(row, nowMs) {
  const expRaw = row.ExpirationDate ?? row.expirationDate;
  if (!expRaw) return true;
  const d = new Date(String(expRaw));
  if (Number.isNaN(d.getTime())) return true;
  const today = new Date(nowMs);
  const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return expDay >= todayDay;
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pickRowValue(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return null;
}

/**
 * Monthly membership identity uses the paid date window, not leftover class credits.
 * Exhausted rows may have Remaining=0, Current=false, and no Active flag.
 *
 * When both start and end dates exist, use the studio calendar window.
 * Fallbacks (pre-4465875) apply only when ActiveDate is absent:
 *   - ActiveClientMemberships: Active=true + unexpired ExpirationDate
 *   - ClientServices monthly rows: Remaining > 0 + unexpired ExpirationDate
 *
 * @param {Record<string, unknown>} row
 * @param {number} [nowMs]
 */
export function monthlyMembershipWindowActive(row, nowMs = Date.now()) {
  if (!row || typeof row !== "object") return false;
  const startRaw = pickRowValue(row, [
    "ActiveDate",
    "activeDate",
    "RestrictedStartDate",
    "restrictedStartDate",
    "PaymentDate",
    "paymentDate",
    "SaleDate",
    "saleDate",
  ]);
  const endRaw = pickRowValue(row, ["ExpirationDate", "expirationDate", "EndDate", "End", "endDate"]);
  const today = studioTodayKey(nowMs);

  if (startRaw != null && endRaw != null) {
    const startDay = mindbodyStudioCalendarDay(startRaw);
    const endDay = mindbodyStudioCalendarDay(endRaw);
    return isStudioDayInInclusiveWindow(startDay, endDay, today);
  }

  if (endRaw == null) return false;
  const endDay = mindbodyStudioCalendarDay(endRaw);
  if (!endDay || !today) return false;

  const active = row.Active ?? row.active;
  if (active === true || active === "true" || active === 1) {
    return today <= endDay;
  }

  if (clientServiceHasRemaining(row) && clientServiceNotExpired(row, nowMs)) {
    return true;
  }

  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<typeof loadGuestPassConfig>} gp
 */
export function monthlySkuFromMembershipRow(row, gp) {
  const monthlyMap = monthlyMindbodyProductIdToSkuMap();
  const pidNum = clientServiceProductId(row);
  if (Number.isFinite(pidNum) && pidNum > 0) {
    const mapped = monthlyMap.get(pidNum);
    if (mapped && gp.eligibleMemberSkus.includes(mapped)) return mapped;
  }
  const name = String(
    row.MembershipName ?? row.Name ?? row.name ?? row.ProgramName ?? row.Description ?? "",
  ).trim();
  return inferMonthlySkuFromName(name, gp);
}

/**
 * @param {unknown[]} arr
 * @param {ReturnType<typeof loadGuestPassConfig>} gp
 * @param {number} [nowMs]
 * @returns {{ row: Record<string, unknown>; sku: string } | null}
 */
export function firstMonthlyMembershipMatch(arr, gp, nowMs = Date.now()) {
  for (const raw of arr || []) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const sku = monthlySkuFromMembershipRow(row, gp);
    if (!sku) continue;
    if (!monthlyMembershipWindowActive(row, nowMs)) continue;
    return { row, sku };
  }
  return null;
}

/** @param {string} name @param {ReturnType<typeof loadGuestPassConfig>} gp */
function inferMonthlySkuFromName(name, gp) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const lower = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const hasMonthly =
    /\bmonthly\b/.test(lower) ||
    /\brecurring\b/.test(lower) ||
    /\bamare monthly\b/.test(lower) ||
    /\bamare\s+monthly\b/.test(lower) ||
    /\b\d+\s+monthly\s+classes?\b/.test(lower);
  if (!hasMonthly && !/\b(unlimited|recurring\s+[58]|monthly\s+[58])\b/.test(lower)) {
    return null;
  }
  /** @type {string | null} */
  let sku = null;
  if (/unlimited/.test(lower)) sku = "monthly_unlimited";
  else if (/\b8\b/.test(lower) || /8\s*class/.test(lower) || /recurring\s*8/.test(lower)) sku = "monthly_8";
  else if (/\b5\b/.test(lower) || /5\s*class/.test(lower) || /recurring\s*5/.test(lower)) sku = "monthly_5";
  if (!sku || !gp.eligibleMemberSkus.includes(sku)) return null;
  return sku;
}

/** @param {ReturnType<typeof loadGuestPassConfig>} gp @param {string} sku */
function monthlyEntitlementResult(gp, sku) {
  const period = calendarMonthPeriodKey(new Date(), gp.studioTimezone);
  return {
    ok: true,
    tier: sku,
    periodMode: "calendarMonth",
    periodKey: period,
    resetsAt: nextCalendarMonthStartIso(new Date(), gp.studioTimezone),
  };
}

/** @param {unknown} data */
function clientServicesArrayFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  const arr = d.ClientServices ?? d.clientServices ?? d.Services ?? d.services;
  return Array.isArray(arr) ? arr : [];
}

/** @param {unknown} data */
function activeMembershipsArrayFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of [
    "ClientMemberships",
    "Memberships",
    "ActiveClientMemberships",
    "ActiveMemberships",
    "activeMemberships",
  ]) {
    const v = d[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * Match active Mindbody monthly membership class-credit rows (same source as wallet widget).
 * @param {unknown[]} arr
 * @param {ReturnType<typeof loadGuestPassConfig>} gp
 */
function resolveMonthlyFromClientServices(arr, gp) {
  const match = firstMonthlyMembershipMatch(arr, gp);
  return match ? monthlyEntitlementResult(gp, match.sku) : null;
}

/**
 * @param {unknown[]} arr
 * @param {ReturnType<typeof loadGuestPassConfig>} gp
 */
function resolveMonthlyFromActiveMemberships(arr, gp) {
  const match = firstMonthlyMembershipMatch(arr, gp);
  return match ? monthlyEntitlementResult(gp, match.sku) : null;
}

/**
 * @param {number} memberClientId
 * @param {Record<string, string> | null | undefined} headers
 */
async function fetchMindbodyClientServices(memberClientId, headers) {
  if (!headers) return null;
  const q = new URLSearchParams({
    "request.clientId": String(memberClientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientservices?${q}`,
    headers,
    null,
  );
  if (!r.ok) return null;
  return clientServicesArrayFromPayload(r.data);
}

/**
 * @param {number} memberClientId
 * @param {Record<string, string> | null | undefined} headers
 */
async function fetchMindbodyActiveMemberships(memberClientId, headers) {
  if (!headers) return null;
  const q = new URLSearchParams({
    "request.clientId": String(memberClientId),
    "request.limit": "50",
  });
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/activeclientmemberships?${q}`,
    headers,
    null,
  );
  if (!r.ok) return null;
  return activeMembershipsArrayFromPayload(r.data);
}

/** @param {unknown[] | null | undefined} arr @param {ReturnType<typeof loadGuestPassConfig>} gp */
function hasNonExpiredFlexiblePackInClientServices(arr, gp) {
  if (!arr?.length) return false;
  const now = Date.now();
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const pidNum = clientServiceProductId(row);
    if (!gp.eligibleFlexiblePackMindbodyServiceIds.includes(pidNum)) continue;
    if (!clientServiceNotExpired(row, now)) continue;
    return true;
  }
  return false;
}

/**
 * Active 10/20 class pack that has not expired. Remaining credits are not required
 * (partner benefits one-time perks).
 *
 * @param {number} memberClientId
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ consumerAuthHeaders?: Record<string, string>; staffHeaders?: Record<string, string> | null }} [opts]
 */
export async function hasActiveNonExpiredFlexiblePack(memberClientId, event, opts) {
  const gp = loadGuestPassConfig();
  const consumerHeaders = opts?.consumerAuthHeaders ?? null;
  let staffHeaders = opts?.staffHeaders ?? null;
  if (!staffHeaders) {
    const { resolveGuestPassStaffHeaders } = await import("./mindbody-guest-pass-sale.mjs");
    staffHeaders = await resolveGuestPassStaffHeaders();
  }

  const [consumerServices, staffServices] = await Promise.all([
    fetchMindbodyClientServices(memberClientId, consumerHeaders),
    staffHeaders ? fetchMindbodyClientServices(memberClientId, staffHeaders) : Promise.resolve(null),
  ]);

  if (hasNonExpiredFlexiblePackInClientServices(consumerServices, gp)) return true;
  if (hasNonExpiredFlexiblePackInClientServices(staffServices, gp)) return true;
  return false;
}

/**
 * @param {number} memberClientId
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ consumerAuthHeaders?: Record<string, string>; staffHeaders?: Record<string, string> | null; debug?: Record<string, unknown> }} [opts]
 */
export async function resolveGuestPassEntitlement(memberClientId, event, opts) {
  const gp = loadGuestPassConfig();
  const consumerHeaders = opts?.consumerAuthHeaders ?? null;
  const debug = opts?.debug && typeof opts.debug === "object" ? opts.debug : null;

  let staffHeaders = opts?.staffHeaders ?? null;
  if (!staffHeaders) {
    const { resolveGuestPassStaffHeaders } = await import("./mindbody-guest-pass-sale.mjs");
    staffHeaders = await resolveGuestPassStaffHeaders();
  }

  if (debug) {
    debug.authMode = consumerHeaders ? "consumer" : "staff";
    debug.siteId =
      (consumerHeaders?.SiteId || staffHeaders?.SiteId || process.env.MINDBODY_SITE_ID || "").trim() || null;
    debug.staffFallbackUsed = false;
    debug.stripeFallbackChecked = false;
    debug.matchedEntitlementSource = null;
    debug.matchedProductId = null;
    debug.matchedServiceName = null;
    debug.matchedSku = null;
  }

  /** @param {unknown[]} arr @param {ReturnType<typeof loadGuestPassConfig>} cfg @returns {{ row: Record<string, unknown>; sku: string } | null} */
  function firstMonthlyServiceMatch(arr, cfg) {
    return firstMonthlyMembershipMatch(arr, cfg);
  }

  /** @param {Record<string, unknown>} row @param {string} sku @param {string} source */
  function applyServiceMatchDebug(row, sku, source) {
    if (!debug) return;
    debug.matchedEntitlementSource = source;
    debug.matchedSku = sku;
    debug.matchedProductId = clientServiceProductId(row) || null;
    debug.matchedServiceName = String(row.Name ?? row.ProgramName ?? row.name ?? "").trim() || null;
  }

  /**
   * Stripe-synced monthly credits and staff bookings can appear on staff clientservices
   * before the consumer token reflects them — try consumer first, then staff.
   * @param {unknown[] | null | undefined} arr
   * @param {"consumer" | "staff"} sourceLabel
   */
  function entitlementFromClientServices(arr, sourceLabel) {
    if (!arr?.length) return null;

    const monthlyMatch = firstMonthlyServiceMatch(arr, gp);
    if (monthlyMatch) {
      const monthly = monthlyEntitlementResult(gp, monthlyMatch.sku);
      applyServiceMatchDebug(
        monthlyMatch.row,
        monthlyMatch.sku,
        sourceLabel === "staff" ? "staff_clientservices" : "consumer_clientservices",
      );
      if (debug) debug.periodKey = monthly.periodKey;
      return monthly;
    }

    const now = Date.now();
    /** @type {{ clientServiceId: number; expirationMs: number; sku: string }[]} */
    const packs = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const pidNum = clientServiceProductId(row);
      if (!gp.eligibleFlexiblePackMindbodyServiceIds.includes(pidNum)) continue;
      if (!clientServiceHasRemaining(row)) continue;
      if (!clientServiceNotExpired(row, now)) continue;
      const sid = row.Id ?? row.id;
      const sidNum =
        typeof sid === "number" ? sid : typeof sid === "string" && /^\d+$/.test(sid) ? parseInt(sid, 10) : NaN;
      if (!Number.isFinite(sidNum) || sidNum <= 0) continue;
      let sku = "pack_10_classes";
      if (pidNum === 100128) sku = "pack_20_classes";
      const expRaw = row.ExpirationDate ?? row.expirationDate;
      const expMs = expRaw ? Date.parse(String(expRaw)) : NaN;
      packs.push({
        clientServiceId: sidNum,
        expirationMs: Number.isFinite(expMs) ? expMs : 0,
        sku,
      });
    }
    if (!packs.length) return null;

    packs.sort((a, b) => b.expirationMs - a.expirationMs);
    const best = packs[0];
    const expIso = best.expirationMs
      ? packExpirationEndIso(new Date(best.expirationMs).toISOString(), gp.studioTimezone)
      : null;
    if (debug) {
      debug.matchedEntitlementSource =
        sourceLabel === "staff" ? "staff_clientservices" : "consumer_clientservices";
      debug.matchedSku = best.sku;
    }
    return {
      ok: true,
      tier: best.sku,
      periodMode: "packLifetime",
      periodKey: `pack:${best.clientServiceId}`,
      memberPackClientServiceId: best.clientServiceId,
      resetsAt: expIso || null,
    };
  }

  /** @param {unknown[] | null | undefined} arr @param {"consumer" | "staff"} sourceLabel */
  function entitlementFromActiveMemberships(arr, sourceLabel) {
    if (!arr?.length) return null;
    const monthlyMem = resolveMonthlyFromActiveMemberships(arr, gp);
    if (!monthlyMem) return null;
    if (debug) {
      debug.matchedEntitlementSource =
        sourceLabel === "staff" ? "staff_activeclientmemberships" : "activeclientmemberships";
      debug.matchedSku = monthlyMem.tier;
      debug.periodKey = monthlyMem.periodKey;
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const row = /** @type {Record<string, unknown>} */ (raw);
        const name = String(
          row.MembershipName ?? row.Name ?? row.name ?? row.ProgramName ?? row.Description ?? "",
        ).trim();
        if (inferMonthlySkuFromName(name, gp) === monthlyMem.tier) {
          debug.matchedServiceName = name || null;
          break;
        }
      }
    }
    return monthlyMem;
  }

  const [consumerServices, staffServices] = await Promise.all([
    fetchMindbodyClientServices(memberClientId, consumerHeaders),
    staffHeaders
      ? fetchMindbodyClientServices(memberClientId, staffHeaders)
      : Promise.resolve(null),
  ]);

  if (debug) {
    debug.consumerClientServicesCount = consumerServices?.length ?? 0;
    debug.staffClientServicesCount = staffServices?.length ?? 0;
  }

  let servicesEntitlement = entitlementFromClientServices(consumerServices, "consumer");
  if (!servicesEntitlement && staffServices?.length) {
    if (debug) debug.staffFallbackUsed = true;
    servicesEntitlement = entitlementFromClientServices(staffServices, "staff");
  }
  if (servicesEntitlement) return servicesEntitlement;

  const [consumerMemberships, staffMemberships] = await Promise.all([
    fetchMindbodyActiveMemberships(memberClientId, consumerHeaders),
    staffHeaders
      ? fetchMindbodyActiveMemberships(memberClientId, staffHeaders)
      : Promise.resolve(null),
  ]);

  if (debug) {
    debug.activeMembershipsCount = consumerMemberships?.length ?? 0;
    if (staffMemberships?.length) debug.staffMembershipsCount = staffMemberships.length;
  }

  let membershipEntitlement = entitlementFromActiveMemberships(consumerMemberships, "consumer");
  if (!membershipEntitlement && staffMemberships?.length) {
    if (debug) debug.staffFallbackUsed = true;
    membershipEntitlement = entitlementFromActiveMemberships(staffMemberships, "staff");
  }
  if (membershipEntitlement) return membershipEntitlement;

  /**
   * Stripe recurring checkout creates a `pending_first_invoice` SubscriptionRecord
   * before the buyer pays. Abandoned checkouts keep that record until session.expired
   * (~24h) or the 30m orphan cutoff in create-session — must NOT grant Bring-a-Friend.
   * @param {string} status
   */
  function subscriptionStatusEligibleForGuestPass(status) {
    const st = String(status || "").trim();
    return st === "active" || st === "past_due";
  }

  const subStore = openSubscriptionStore(event);
  if (subStore) {
    if (debug) debug.stripeFallbackChecked = true;
    const subs = await subStore.listActiveByMindbodyClientId(memberClientId, { limit: 10 });
    for (const sub of subs) {
      if (!subscriptionStatusEligibleForGuestPass(sub.status)) continue;
      const sku = String(sub.localSku || "");
      if (gp.eligibleMemberSkus.includes(sku)) {
        if (debug) {
          debug.matchedEntitlementSource = "stripe";
          debug.matchedSku = sku;
          debug.matchedSubscriptionStatus = sub.status;
          debug.periodKey = calendarMonthPeriodKey(new Date(), gp.studioTimezone);
        }
        return monthlyEntitlementResult(gp, sku);
      }
    }
  }

  if (debug) debug.periodKey = calendarMonthPeriodKey(new Date(), gp.studioTimezone);
  return { ok: false, reason: "tier_not_eligible" };
}

/**
 * @param {BlobStore | null} store
 * @param {{ emailLower: string; phoneNorm: string; periodKey: string; memberClientId: number }} opts
 */
export async function findExistingGuestSlotConflict(store, opts) {
  if (!store || !guestPassBlobsEnabled()) return { conflict: false };
  const usage = await readJson(store, usageKey(opts.memberClientId, opts.periodKey));
  if (usage) {
    const st = String(usage.status || "");
    if (st === "confirmed" || st === "confirmed_cancelled" || st === "failed_manual_review") {
      return { conflict: true, reason: "already_used_this_period", found: { state: st, periodResetsAt: null } };
    }
    if (st === "pending" && usage.expiresAt && Date.parse(String(usage.expiresAt)) > Date.now()) {
      return { conflict: true, reason: "already_used_this_period", found: { state: st, periodResetsAt: null } };
    }
  }
  if (opts.emailLower) {
    const e = await readJson(store, emailReceivedKey(opts.emailLower, opts.periodKey));
    if (e) return { conflict: true, reason: "guest_already_used_this_period" };
  }
  if (opts.phoneNorm) {
    const p = await readJson(store, phoneReceivedKey(opts.phoneNorm, opts.periodKey));
    if (p) return { conflict: true, reason: "guest_already_used_this_period" };
  }
  return { conflict: false };
}

/**
 * @param {BlobStore} store
 * @param {{
 *   memberClientId: number;
 *   periodKey: string;
 *   periodMode: string;
 *   entitlementSku: string;
 *   guestEmailLower: string;
 *   guestPhoneNorm: string;
 *   guestFirstName: string;
 *   guestLastName: string;
 *   classId: number;
 *   classDateTime: string | null;
 *   className: string | null;
 * }} opts
 */
export async function reserveGuestPassSlot(store, opts) {
  const guestBookingId = makeGuestBookingId();
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  /** @type {GuestPassUsageRecord} */
  const pending = {
    status: "pending",
    period: opts.periodKey,
    periodMode: opts.periodMode,
    entitlementSku: opts.entitlementSku,
    memberClientId: opts.memberClientId,
    guestFirstName: opts.guestFirstName,
    guestLastName: opts.guestLastName,
    guestEmailLower: opts.guestEmailLower,
    guestPhoneNorm: opts.guestPhoneNorm,
    classId: opts.classId,
    classDateTime: opts.classDateTime || undefined,
    className: opts.className || undefined,
    guestBookingId,
    expiresAt,
  };
  const memberKey = usageKey(opts.memberClientId, opts.periodKey);
  const m = await atomicCreateJSON(store, memberKey, pending);
  if (!m.modified) {
    const cur = await readJson(store, memberKey);
    const st = String(cur?.status || "");
    if (st === "confirmed" || st === "confirmed_cancelled" || st === "failed_manual_review") {
      return { ok: false, reason: "already_used_this_period" };
    }
    return { ok: false, reason: "already_used_this_period" };
  }
  const reservedKeys = [memberKey];
  if (opts.guestEmailLower) {
    const ek = emailReceivedKey(opts.guestEmailLower, opts.periodKey);
    const er = await atomicCreateJSON(store, ek, { status: "pending", guestBookingId, memberClientId: opts.memberClientId });
    if (!er.modified) {
      await failGuestPassSlot(store, { memberClientId: opts.memberClientId, periodKey: opts.periodKey, reservedKeys, restore: true, reason: "email_conflict" });
      return { ok: false, reason: "guest_already_used_this_period" };
    }
    reservedKeys.push(ek);
  }
  if (opts.guestPhoneNorm) {
    const pk = phoneReceivedKey(opts.guestPhoneNorm, opts.periodKey);
    const pr = await atomicCreateJSON(store, pk, { status: "pending", guestBookingId, memberClientId: opts.memberClientId });
    if (!pr.modified) {
      await failGuestPassSlot(store, { memberClientId: opts.memberClientId, periodKey: opts.periodKey, reservedKeys, restore: true, reason: "phone_conflict" });
      return { ok: false, reason: "guest_already_used_this_period" };
    }
    reservedKeys.push(pk);
  }
  return { ok: true, reservedKeys, guestBookingId, pending };
}

/**
 * @param {BlobStore} store
 * @param {{
 *   memberClientId: number;
 *   periodKey: string;
 *   reservedKeys: string[];
 *   guestClientId?: number;
 *   reason?: string;
 *   restore: boolean;
 * }} opts
 */
export async function failGuestPassSlot(store, opts) {
  if (opts.restore) {
    for (const key of opts.reservedKeys) {
      try {
        await store.delete(key);
      } catch {
        /* ignore */
      }
    }
    return { ok: true, released: true };
  }
  const memberKey = usageKey(opts.memberClientId, opts.periodKey);
  await atomicUpdateJSON(
    store,
    memberKey,
    async (cur) => {
      if (!cur || typeof cur !== "object") return null;
      const rec = /** @type {GuestPassUsageRecord} */ ({ ...cur });
      rec.status = "failed_manual_review";
      rec.guestClientId = opts.guestClientId;
      return rec;
    },
    { readConsistency: guestPassBlobReadConsistency(store) },
  );
  return { ok: true, released: false };
}

/**
 * @param {BlobStore} store
 * @param {{
 *   memberClientId: number;
 *   periodKey: string;
 *   reservedKeys: string[];
 *   guestClientId: number;
 *   confirm: GuestPassUsageRecord;
 *   consentMeta?: { ip?: string; userAgent?: string; acceptedByMemberClientId: number };
 * }} opts
 */
export async function confirmGuestPassSlot(store, opts) {
  const memberKey = usageKey(opts.memberClientId, opts.periodKey);
  const upd = await atomicUpdateJSON(
    store,
    memberKey,
    async (cur) => {
      if (!cur || typeof cur !== "object") return null;
      const rec = /** @type {GuestPassUsageRecord} */ ({ ...cur, ...opts.confirm, status: "confirmed" });
      delete rec.expiresAt;
      rec.confirmedAtIso = new Date().toISOString();
      return rec;
    },
    { readConsistency: guestPassBlobReadConsistency(store) },
  );
  if (!upd.ok || !upd.modified) {
    return { ok: false, reason: "confirm_failed" };
  }
  const gp = loadGuestPassConfig();
  const ck = clientReceivedKey(opts.guestClientId, opts.periodKey);
  const cr = await atomicCreateJSON(store, ck, {
    status: "confirmed",
    memberClientId: opts.memberClientId,
    guestBookingId: opts.confirm.guestBookingId,
  });
  if (opts.confirm.guestEmailLower) {
    const ek = emailReceivedKey(String(opts.confirm.guestEmailLower), opts.periodKey);
    await atomicUpdateJSON(
      store,
      ek,
      async (cur) =>
        cur && typeof cur === "object" ? { ...cur, status: "confirmed" } : { status: "confirmed" },
      { readConsistency: guestPassBlobReadConsistency(store) },
    );
  }
  if (opts.confirm.guestPhoneNorm) {
    const pk = phoneReceivedKey(String(opts.confirm.guestPhoneNorm), opts.periodKey);
    await atomicUpdateJSON(
      store,
      pk,
      async (cur) =>
        cur && typeof cur === "object" ? { ...cur, status: "confirmed" } : { status: "confirmed" },
      { readConsistency: guestPassBlobReadConsistency(store) },
    );
  }
  if (opts.consentMeta) {
    const consentKey = guestBookingConsentKey(opts.guestClientId, gp.bookingConsentContractVersion);
    await store.setJSON(consentKey, {
      acceptedByMemberClientId: opts.consentMeta.acceptedByMemberClientId,
      acceptedAtIso: new Date().toISOString(),
      ip: opts.consentMeta.ip || null,
      userAgent: opts.consentMeta.userAgent || null,
      consentTextShown: loadGuestBookingConsentText(),
      contractVersion: gp.bookingConsentContractVersion,
    });
  }
  return {
    ok: true,
    manualReview: !cr.modified,
    reason: cr.modified ? undefined : "guest_client_already_used",
  };
}

/** @param {BlobStore | null} store @param {{ memberClientId: number; classId: number; periodKey?: string }} opts */
export async function loadConfirmedGuestPassForMemberAndClass(store, opts) {
  if (!store) return { hasGuest: false, reason: "no_blob" };
  const gp = loadGuestPassConfig();
  let periodKey = opts.periodKey;
  if (!periodKey) {
    periodKey = calendarMonthPeriodKey(new Date(), gp.studioTimezone);
  }
  const rec = await readJson(store, usageKey(opts.memberClientId, periodKey));
  if (!rec) return { hasGuest: false, reason: "no_blob" };
  if (rec.status !== "confirmed") return { hasGuest: false, reason: "wrong_status" };
  if (Number(rec.classId) !== opts.classId) return { hasGuest: false, reason: "wrong_class" };
  return { hasGuest: true, record: rec, periodKey };
}

/**
 * @param {BlobStore} store
 * @param {{
 *   memberClientId: number;
 *   periodKey: string;
 *   cancelLateMember: boolean;
 *   cancelLateGuest: boolean;
 *   cancelledByMemberClientId: number;
 * }} opts
 */
/** @param {string | null | undefined} iso */
export function classStartMsFromIso(iso) {
  if (!iso) return NaN;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * True when class start is in the past or within the studio late-cancel window.
 * @param {number} classStartMs
 * @param {number} [nowMs]
 */
export function isWithinStudioLateCancelWindow(classStartMs, nowMs = Date.now()) {
  if (!Number.isFinite(classStartMs)) return false;
  const msUntilStart = classStartMs - nowMs;
  if (msUntilStart <= 0) return true;
  return msUntilStart < STUDIO_LATE_CANCEL_MS;
}

/**
 * @param {{
 *   classDateTime?: string | null;
 *   memberLateCancel?: boolean;
 *   nowMs?: number;
 * }} opts
 */
export function guestPassCancelTiming(opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const classStartMs = classStartMsFromIso(opts.classDateTime);
  const classAlreadyPassed = Number.isFinite(classStartMs) && classStartMs <= nowMs;
  const withinLateWindow = isWithinStudioLateCancelWindow(classStartMs, nowMs);
  const mindbodyLate = opts.memberLateCancel === true;
  const effectiveLate = mindbodyLate || withinLateWindow;
  const eligibleForEarlyRestore = !classAlreadyPassed && !effectiveLate;
  return {
    classStartMs,
    classAlreadyPassed,
    withinLateWindow,
    mindbodyLate,
    effectiveLate,
    eligibleForEarlyRestore,
  };
}

/**
 * Delete period cap keys after an early cancel so the member can invite again.
 * Writes a non-blocking audit record keyed by guestBookingId when present.
 * @param {BlobStore} store
 * @param {{
 *   memberClientId: number;
 *   periodKey: string;
 *   cancelledByMemberClientId: number;
 * }} opts
 */
export async function restoreGuestPassSlotAfterEarlyCancel(store, opts) {
  const memberKey = usageKey(opts.memberClientId, opts.periodKey);
  const rec = await readJson(store, memberKey);
  if (!rec) {
    return { ok: true, restored: false, alreadyRestored: true, reason: "no_usage_key" };
  }
  const st = String(rec.status || "");
  if (st === "confirmed_cancelled") {
    return { ok: true, restored: false, alreadyRestored: false, reason: "already_late_cancelled" };
  }
  if (st !== "confirmed") {
    return { ok: true, restored: false, alreadyRestored: true, reason: "not_confirmed" };
  }

  const usage = /** @type {GuestPassUsageRecord} */ (rec);
  /** @type {string[]} */
  const keysToDelete = [memberKey];
  if (usage.guestEmailLower) {
    keysToDelete.push(emailReceivedKey(String(usage.guestEmailLower), opts.periodKey));
  }
  if (usage.guestPhoneNorm) {
    keysToDelete.push(phoneReceivedKey(String(usage.guestPhoneNorm), opts.periodKey));
  }
  if (usage.guestClientId) {
    keysToDelete.push(clientReceivedKey(Number(usage.guestClientId), opts.periodKey));
  }

  for (const key of keysToDelete) {
    try {
      await store.delete(key);
    } catch {
      /* ignore */
    }
  }

  const auditKey = usage.guestBookingId
    ? `guestPassAudit:restored_early_cancel:${usage.guestBookingId}`
    : `guestPassAudit:restored_early_cancel:${opts.memberClientId}:${opts.periodKey}:${usage.confirmedAtIso || "unknown"}`;
  try {
    await store.setJSON(auditKey, {
      status: "restored_early_cancel",
      restoredAtIso: new Date().toISOString(),
      restoredByMemberClientId: opts.cancelledByMemberClientId,
      memberClientId: opts.memberClientId,
      periodKey: opts.periodKey,
      guestBookingId: usage.guestBookingId ?? null,
      classId: usage.classId ?? null,
      classDateTime: usage.classDateTime ?? null,
      guestClientId: usage.guestClientId ?? null,
      previousStatus: st,
    });
  } catch {
    /* audit is best-effort */
  }

  return { ok: true, restored: true, alreadyRestored: false, deletedKeys: keysToDelete, auditKey };
}

export async function cancelGuestPassSlot(store, opts) {
  const memberKey = usageKey(opts.memberClientId, opts.periodKey);
  const existing = await readJson(store, memberKey);
  if (existing && String(existing.status || "") === "confirmed_cancelled") {
    return {
      ok: true,
      record: /** @type {GuestPassUsageRecord} */ (existing),
      alreadyCancelled: true,
    };
  }
  const upd = await atomicUpdateJSON(
    store,
    memberKey,
    async (cur) => {
      if (!cur || typeof cur !== "object") return null;
      const rec = /** @type {GuestPassUsageRecord} */ (cur);
      if (rec.status !== "confirmed") return null;
      return {
        ...rec,
        status: "confirmed_cancelled",
        cancelledAtIso: new Date().toISOString(),
        cancelLateMember: opts.cancelLateMember,
        cancelLateGuest: opts.cancelLateGuest,
        cancelledByMemberClientId: opts.cancelledByMemberClientId,
      };
    },
    { readConsistency: guestPassBlobReadConsistency(store) },
  );
  if (!upd.ok) return { ok: false, reason: "stale_state", currentStatus: "not_found" };
  if (!upd.modified && upd.reason === "no_op") {
    const cur = await readJson(store, memberKey);
    return { ok: false, reason: "stale_state", currentStatus: String(cur?.status || "unknown") };
  }
  if (!upd.modified) {
    const cur = await readJson(store, memberKey);
    return { ok: false, reason: "stale_state", currentStatus: String(cur?.status || "unknown") };
  }
  return { ok: true, record: /** @type {GuestPassUsageRecord} */ (upd.record) };
}

/** @param {BlobStore | null} store @param {number} memberClientId @param {string} periodKey */
export async function readGuestPassUsage(store, memberClientId, periodKey) {
  if (!store) return null;
  return readJson(store, usageKey(memberClientId, periodKey));
}

/**
 * Dev / studio recovery: clear a member's guest-pass blob slot for a period (e.g. after
 * `failed_manual_review` from a partial Mindbody mutation). Does not undo Mindbody sales/visits.
 * @param {BlobStore} store
 * @param {number} memberClientId
 * @param {string} periodKey
 */
export async function resetGuestPassPeriodUsage(store, memberClientId, periodKey) {
  const rec = await readJson(store, usageKey(memberClientId, periodKey));
  /** @type {string[]} */
  const keys = [usageKey(memberClientId, periodKey)];
  if (rec && typeof rec === "object") {
    const r = /** @type {GuestPassUsageRecord} */ (rec);
    if (r.guestEmailLower) keys.push(emailReceivedKey(String(r.guestEmailLower), periodKey));
    if (r.guestPhoneNorm) keys.push(phoneReceivedKey(String(r.guestPhoneNorm), periodKey));
    if (r.guestClientId) keys.push(clientReceivedKey(Number(r.guestClientId), periodKey));
  }
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, deletedKeys: keys, previousStatus: rec ? String(rec.status || "") : null };
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
function visitField(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

/** @param {Record<string, unknown>} visit */
export function visitStartMsFromRow(visit) {
  const direct = visitField(visit, [
    "StartDateTime",
    "startDateTime",
    "StartDate",
    "startDate",
    "ClassDate",
    "classDate",
    "VisitDate",
    "visitDate",
    "AppointmentStartDate",
    "VisitStartDateTime",
    "visitStartDateTime",
    "scheduledDateTime",
  ]);
  if (direct != null) {
    const ms = Date.parse(String(direct));
    if (Number.isFinite(ms)) return ms;
  }
  const cls = visit.Class ?? visit.class;
  if (cls && typeof cls === "object") {
    const c = /** @type {Record<string, unknown>} */ (cls);
    const fromClass = visitField(c, ["StartDateTime", "startDateTime", "StartDate", "scheduledDateTime"]);
    if (fromClass != null) {
      const ms = Date.parse(String(fromClass));
      if (Number.isFinite(ms)) return ms;
    }
    const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
    if (sched && typeof sched === "object") {
      const s = /** @type {Record<string, unknown>} */ (sched);
      const raw = visitField(s, ["StartDateTime", "startDateTime", "ScheduleStartTime", "EndDateTime"]);
      if (raw != null) {
        const ms = Date.parse(String(raw));
        if (Number.isFinite(ms)) return ms;
      }
    }
  }
  return null;
}

/** @param {Record<string, unknown>} visit */
export function visitClassIdFromRow(visit) {
  const cls = visit.Class ?? visit.class;
  if (cls && typeof cls === "object") {
    const c = /** @type {Record<string, unknown>} */ (cls);
    const id = c.Id ?? c.id;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
    const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
    if (sched && typeof sched === "object") {
      const cid =
        /** @type {Record<string, unknown>} */ (sched).ClassId ??
        /** @type {Record<string, unknown>} */ (sched).classId;
      if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) return Number(cid);
    }
  }
  const raw = visit.ClassId ?? visit.classId;
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
  return null;
}

/** @param {Record<string, unknown>} visit */
export function isUpcomingBookedVisit(visit) {
  if (visit.SignedIn === true) return false;
  const cancelled =
    visit.Cancelled === true ||
    visit.cancelled === true ||
    visit.LateCancelled === true ||
    visit.lateCancelled === true;
  if (cancelled) return false;
  const status = String(visit.AppointmentStatus ?? visit.appointmentStatus ?? "").toLowerCase();
  if (/^(cancel|cancelled|no.?show|missed)\b/.test(status)) return false;
  const startMs = visitStartMsFromRow(visit);
  return startMs != null && startMs > Date.now();
}

/** @param {unknown} data */
export function visitsArrayFromClientVisitsPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of ["Visits", "ClientVisits", "visits", "VisitDetails", "ScheduledVisits"]) {
    const v = d[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * @param {number} memberClientId
 * @param {Record<string, string>} authHeaders
 */
export async function fetchMemberClientVisits(memberClientId, authHeaders) {
  const visitStart = new Date();
  visitStart.setUTCDate(visitStart.getUTCDate() - 1);
  visitStart.setUTCHours(0, 0, 0, 0);
  const visitEnd = new Date();
  visitEnd.setUTCDate(visitEnd.getUTCDate() + 366);
  visitEnd.setUTCHours(23, 59, 59, 999);

  /** @type {unknown[]} */
  const merged = [];
  const seen = new Set();
  for (let offset = 0; offset < 500; offset += 100) {
    const q = new URLSearchParams({
      "request.clientId": String(memberClientId),
      "request.startDate": visitStart.toISOString(),
      "request.endDate": visitEnd.toISOString(),
      "request.limit": "100",
      "request.offset": String(offset),
    });
    const r = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clientvisits?${q}`,
      authHeaders,
      null,
    );
    if (!r.ok) return { ok: false, data: r.data, visits: merged };
    const batch = visitsArrayFromClientVisitsPayload(r.data);
    for (const raw of batch) {
      if (!raw || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const vid = row.Id ?? row.id ?? row.VisitId ?? row.visitId;
      const key =
        vid != null && vid !== ""
          ? `id:${String(vid)}`
          : `row:${String(visitStartMsFromRow(row) ?? "")}:${String(row.Name ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    if (batch.length < 100) break;
  }
  return { ok: true, visits: merged };
}

/** @param {unknown} row @param {number} classId */
function classRowMatchesId(row, classId) {
  if (!row || typeof row !== "object") return false;
  const c = /** @type {Record<string, unknown>} */ (row);
  const id = c.Id ?? c.id ?? c.ClassId ?? c.classId;
  return id != null && Number.isFinite(Number(id)) && Number(id) === classId;
}

/**
 * @param {Record<string, string>} staffHeaders
 * @param {number} classId
 * @param {{ startDateTime?: string | null }} [opts]
 */
function classRowFromClassesResponse(data, classId) {
  const d = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  const classes = d.Classes ?? d.classes;
  if (!Array.isArray(classes)) return null;
  return classes.find((raw) => classRowMatchesId(raw, classId)) ?? null;
}

/** @param {Date} anchor */
function dateWindowAround(anchor, daysBefore, daysAfter) {
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - daysBefore);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + daysAfter);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

export async function fetchClassRowForCapacity(staffHeaders, classId, opts = {}) {
  /** @param {URLSearchParams} q */
  async function queryClasses(q) {
    return fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/class/classes?${q}`,
      staffHeaders,
      null,
      { timeoutMs: 15000 },
    );
  }

  /** @param {{ start: Date; end: Date; limit?: number }} window */
  async function queryWindow(window) {
    const q = new URLSearchParams();
    q.set("StartDateTime", window.start.toISOString());
    q.set("EndDateTime", window.end.toISOString());
    q.set("Limit", String(window.limit ?? 100));
    const r = await queryClasses(q);
    if (!r.ok) return { ok: false, row: null, data: r.data };
    const row = classRowFromClassesResponse(r.data, classId);
    return row ? { ok: true, row, data: r.data } : { ok: false, row: null, data: r.data };
  }

  const rawStart = opts.startDateTime;
  if (rawStart) {
    const ms = Date.parse(String(rawStart));
    if (Number.isFinite(ms)) {
      const narrow = await queryWindow(dateWindowAround(new Date(ms), 1, 1));
      if (opts.debugCapacity) {
        opts.debugCapacity.lookupMode = "narrow_window";
        opts.debugCapacity.rowsFound = narrow.ok && narrow.row ? 1 : 0;
      }
      if (narrow.ok && narrow.row) {
        return { ok: true, row: narrow.row, spotsRemaining: spotsRemainingFromClassRow(narrow.row) };
      }
    }
  }

  const wideStart = new Date();
  wideStart.setUTCDate(wideStart.getUTCDate() - 1);
  wideStart.setUTCHours(0, 0, 0, 0);
  const wideEnd = new Date();
  wideEnd.setUTCDate(wideEnd.getUTCDate() + 366);
  wideEnd.setUTCHours(23, 59, 59, 999);
  const wide = await queryWindow({ start: wideStart, end: wideEnd, limit: 200 });
  if (opts.debugCapacity) {
    opts.debugCapacity.lookupMode = "wide_window";
    opts.debugCapacity.rowsFound = wide.ok && wide.row ? 1 : 0;
  }
  if (wide.ok && wide.row) {
    return { ok: true, row: wide.row, spotsRemaining: spotsRemainingFromClassRow(wide.row) };
  }

  return { ok: false, data: wide.data, spotsRemaining: null };
}

/**
 * Build dropdown rows for Bring-a-Friend status (member booked + spotsRemaining >= 2).
 * @param {{
 *   memberClientId: number;
 *   consumerAuthHeaders: Record<string, string>;
 *   staffHeaders: Record<string, string> | null;
 *   debug?: Record<string, unknown>;
 * }} opts
 */
export async function buildUpcomingBookedClassesForMember(opts) {
  const debug = opts.debug && typeof opts.debug === "object" ? opts.debug : null;
  let visitsResult = await fetchMemberClientVisits(opts.memberClientId, opts.consumerAuthHeaders);
  if (
    opts.staffHeaders &&
    (!visitsResult.ok || visitsResult.visits.length === 0)
  ) {
    const staffVisits = await fetchMemberClientVisits(opts.memberClientId, opts.staffHeaders);
    if (staffVisits.ok && staffVisits.visits.length > 0) {
      visitsResult = staffVisits;
    } else if (!visitsResult.ok && staffVisits.ok) {
      visitsResult = staffVisits;
    }
  }
  if (!visitsResult.ok) {
    if (debug) {
      debug.visitsCount = 0;
      debug.matchedVisitIds = [];
      debug.matchedClassIds = [];
      debug.upcomingBookedClassesCount = 0;
    }
    return [];
  }

  if (debug) {
    debug.visitsCount = visitsResult.visits.length;
    debug.matchedVisitIds = [];
    debug.matchedClassIds = [];
    debug.spotsRemainingByClassId = {};
    debug.capacityRowsFound = 0;
    debug.capacityLookupMode = null;
    /** @type {number} */
    debug._upcomingVisitsBeforeCapacity = 0;
  }

  /** @type {Record<number, { row: unknown; spotsRemaining: number | null }>} */
  const classCache = new Map();

  async function spotsForClass(classId, startDateTime) {
    if (!opts.staffHeaders) return null;
    if (classCache.has(classId)) return classCache.get(classId)?.spotsRemaining ?? null;
    const capDbg = {};
    const fetched = await fetchClassRowForCapacity(opts.staffHeaders, classId, {
      startDateTime,
      debugCapacity: capDbg,
    });
    if (debug) {
      if (capDbg.lookupMode) debug.capacityLookupMode = capDbg.lookupMode;
      debug.capacityRowsFound =
        (typeof debug.capacityRowsFound === "number" ? debug.capacityRowsFound : 0) +
        (typeof capDbg.rowsFound === "number" ? capDbg.rowsFound : 0);
      /** @type {Record<string, number | null>} */ (debug.spotsRemainingByClassId)[String(classId)] =
        fetched.spotsRemaining ?? null;
    }
    classCache.set(classId, {
      row: fetched.ok ? fetched.row : null,
      spotsRemaining: fetched.spotsRemaining ?? null,
    });
    return fetched.spotsRemaining ?? null;
  }

  /** @type {Array<Record<string, unknown>>} */
  const upcomingBookedClasses = [];
  for (const raw of visitsResult.visits) {
    if (!raw || typeof raw !== "object") continue;
    const visit = /** @type {Record<string, unknown>} */ (raw);
    if (!isUpcomingBookedVisit(visit)) continue;
    const classId = visitClassIdFromRow(visit);
    if (classId == null || classId <= 0) continue;
    if (debug) {
      const vid = visit.Id ?? visit.id ?? visit.VisitId ?? visit.visitId;
      if (vid != null && vid !== "") debug.matchedVisitIds.push(Number(vid) || vid);
      debug.matchedClassIds.push(classId);
      debug._upcomingVisitsBeforeCapacity++;
    }
    const startDateTime =
      String(visit.StartDateTime ?? visit.startDateTime ?? "").trim() ||
      (visitStartMsFromRow(visit) != null
        ? new Date(visitStartMsFromRow(visit)).toISOString()
        : "");
    const spotsRemaining = await spotsForClass(classId, startDateTime);
    const cap = assertClassEligibleForGuestBooking(spotsRemaining);
    if (!cap.ok) continue;
    const cached = classCache.get(classId);
    const meta = classMetaFromRow(cached?.row ?? visit);
    upcomingBookedClasses.push({
      classId,
      name: meta.name || String(visit.Name ?? visit.ClassName ?? "Class"),
      instructor: meta.instructor,
      startDateTime: meta.startDateTime || startDateTime,
      spotsRemaining,
    });
  }
  upcomingBookedClasses.sort((a, b) =>
    String(a.startDateTime || "").localeCompare(String(b.startDateTime || "")),
  );
  if (debug) {
    debug.upcomingBookedClassesCount = upcomingBookedClasses.length;
    debug.classStartDate = upcomingBookedClasses[0]?.startDateTime ?? null;
  }
  return upcomingBookedClasses;
}

/** @param {Record<string, unknown>} v @param {number} classId */
function visitIsActiveBookingForClass(v, classId) {
  if (v.SignedIn === true) return false;
  const cancelled =
    v.Cancelled === true ||
    v.cancelled === true ||
    v.LateCancelled === true ||
    v.lateCancelled === true;
  if (cancelled) return false;
  const status = String(v.AppointmentStatus ?? v.appointmentStatus ?? "").toLowerCase();
  if (/cancel|no.?show|missed/.test(status)) return false;
  const visitClassId = visitClassIdFromRow(v);
  if (visitClassId != null && visitClassId === classId) return true;
  const cid = v.ClassId ?? v.classId;
  return cid != null && Number(cid) === classId;
}

/**
 * Mindbody `GET clientvisits` with `request.classId` often returns zero rows even when booked.
 * Scan visits from a date window instead (same source as the Bring-a-Friend dropdown).
 * @param {Record<string, string>} authHeaders
 * @param {number} memberClientId
 * @param {number} classId
 * @param {{ staffHeaders?: Record<string, string> | null }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findMemberBookedVisitForClass(authHeaders, memberClientId, classId, opts = {}) {
  let visitsResult = await fetchMemberClientVisits(memberClientId, authHeaders);
  if (opts.staffHeaders && (!visitsResult.ok || visitsResult.visits.length === 0)) {
    const staffVisits = await fetchMemberClientVisits(memberClientId, opts.staffHeaders);
    if (staffVisits.ok && (staffVisits.visits.length > 0 || !visitsResult.ok)) {
      visitsResult = staffVisits;
    }
  }
  if (!visitsResult.ok) return null;
  for (const raw of visitsResult.visits) {
    if (!raw || typeof raw !== "object") continue;
    const v = /** @type {Record<string, unknown>} */ (raw);
    if (visitIsActiveBookingForClass(v, classId)) return v;
  }
  return null;
}

/**
 * @param {Record<string, string>} authHeaders
 * @param {number} memberClientId
 * @param {number} classId
 * @param {{ staffHeaders?: Record<string, string> | null }} [opts]
 */
export async function isMemberBookedToClass(authHeaders, memberClientId, classId, opts = {}) {
  return (await findMemberBookedVisitForClass(authHeaders, memberClientId, classId, opts)) != null;
}

/** @param {unknown} row */
export function classMetaFromRow(row) {
  if (!row || typeof row !== "object") {
    return { name: null, startDateTime: null, instructor: null };
  }
  const c = /** @type {Record<string, unknown>} */ (row);
  const name = c.ClassDescription?.Name ?? c.Name ?? c.name ?? null;
  const desc =
    c.ClassDescription && typeof c.ClassDescription === "object"
      ? /** @type {Record<string, unknown>} */ (c.ClassDescription)
      : null;
  const className =
    typeof name === "string"
      ? name
      : desc && typeof desc.Name === "string"
        ? desc.Name
        : null;
  const start = c.StartDateTime ?? c.startDateTime ?? null;
  let instructor = null;
  const staff = c.Staff ?? c.staff;
  if (staff && typeof staff === "object") {
    const s = /** @type {Record<string, unknown>} */ (staff);
    const fn = s.FirstName ?? s.firstName ?? "";
    const ln = s.LastName ?? s.lastName ?? "";
    instructor = `${fn} ${ln}`.trim() || null;
  }
  return {
    name: className,
    startDateTime: start ? String(start) : null,
    instructor,
  };
}

export const __testing = {
  clientServiceHasRemaining,
  hasNonExpiredFlexiblePackInClientServices,
  firstMonthlyMembershipMatch,
  resolveMonthlyFromClientServices,
  resolveMonthlyFromActiveMemberships,
  classStartMsFromIso,
  isWithinStudioLateCancelWindow,
  guestPassCancelTiming,
  classDateTimesMatch,
  attachGuestToUpcomingBookedClasses,
};

/** @param {string | null | undefined} a @param {string | null | undefined} b */
export function classDateTimesMatch(a, b) {
  const rawA = String(a || "").trim();
  const rawB = String(b || "").trim();
  if (!rawA || !rawB) return false;
  const msA = classStartMsFromIso(rawA);
  const msB = classStartMsFromIso(rawB);
  if (Number.isFinite(msA) && Number.isFinite(msB)) {
    return Math.abs(msA - msB) <= 60_000;
  }
  return rawA === rawB;
}

/**
 * Attach a confirmed guest badge to the matching upcoming class row.
 * Omits guest email/phone. No badge for restored early cancel or confirmed_cancelled.
 * @param {Array<Record<string, unknown>>} upcomingBookedClasses
 * @param {GuestPassUsageRecord | null | undefined} usage
 * @param {string | null | undefined} usageStatus
 */
export function attachGuestToUpcomingBookedClasses(upcomingBookedClasses, usage, usageStatus) {
  const rows = Array.isArray(upcomingBookedClasses) ? upcomingBookedClasses : [];
  const st = String(usageStatus || "");
  if (st !== "confirmed" || !usage) {
    return rows.map((row) => {
      if (!row || typeof row !== "object") return row;
      const { guestAttached: _drop, ...rest } = /** @type {Record<string, unknown>} */ (row);
      return rest;
    });
  }

  const guestAttached = {
    guestFirstName: String(usage.guestFirstName || "").trim(),
    guestLastInitial: guestLastInitial(String(usage.guestLastName || "")),
    status: "confirmed",
  };
  if (!guestAttached.guestFirstName && !guestAttached.guestLastInitial) {
    return rows.map((row) => {
      if (!row || typeof row !== "object") return row;
      const { guestAttached: _drop, ...rest } = /** @type {Record<string, unknown>} */ (row);
      return rest;
    });
  }

  const usageClassId = usage.classId != null ? Number(usage.classId) : null;
  const usageDt = usage.classDateTime ? String(usage.classDateTime) : null;
  let matched = false;

  /** @type {Array<Record<string, unknown>>} */
  const enriched = rows.map((row) => {
    if (!row || typeof row !== "object") return /** @type {Record<string, unknown>} */ (row);
    const r = /** @type {Record<string, unknown>} */ (row);
    const rowClassId = r.classId != null ? Number(r.classId) : null;
    const rowDt = r.startDateTime ? String(r.startDateTime) : null;
    const { guestAttached: _drop, ...rest } = r;
    if (
      usageClassId != null &&
      rowClassId === usageClassId &&
      classDateTimesMatch(usageDt, rowDt)
    ) {
      matched = true;
      return { ...rest, guestAttached };
    }
    return rest;
  });

  if (!matched && usageClassId != null && usageDt) {
    enriched.push({
      classId: usageClassId,
      name: usage.className || "Class",
      instructor: null,
      startDateTime: usageDt,
      spotsRemaining: null,
      guestAttached,
    });
    enriched.sort((a, b) =>
      String(a.startDateTime || "").localeCompare(String(b.startDateTime || "")),
    );
  }

  return enriched;
}

/** @param {string} lastName */
export function guestLastInitial(lastName) {
  const s = String(lastName || "").trim();
  if (!s) return "";
  return `${s.charAt(0).toUpperCase()}.`;
}
