/**
 * AMARÉ Unlimited — max class sessions per studio calendar day (America/New_York).
 * Mirrors Mindbody pricing-option scheduling; does not override Mindbody counting rules.
 */

import {
  MONTHLY_UNLIMITED_PRODUCT_IDS,
  STUDIO_TZ,
  mindbodyStudioCalendarDay,
} from "./member-topup-lib.mjs";
import {
  clientServiceIdFromRow,
  fetchClientVisitsWindow,
  visitClassIdFromRow,
  visitIdFromRow,
  visitRowLooksUnpaid,
  visitServiceIdFromRow,
} from "./mindbody-class-book-lib.mjs";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";

export const UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE = 2;

export const UNLIMITED_DAILY_LIMIT_USER_MESSAGE =
  "You've reached your 2-class daily limit for this membership.";

export const UNLIMITED_DAILY_LIMIT_USER_DETAIL = `${UNLIMITED_DAILY_LIMIT_USER_MESSAGE} Late cancellations and no-shows count toward the daily limit.`;

/** @param {unknown} productId */
export function isCanonicalUnlimitedProductId(productId) {
  const n = Number(productId);
  if (!Number.isFinite(n) || n <= 0) return false;
  return MONTHLY_UNLIMITED_PRODUCT_IDS.includes(n);
}

/** @param {Record<string, unknown>} row */
export function clientServiceProductIdFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const raw = row.ProductId ?? row.productId;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** @param {Record<string, unknown>[]} policyRows */
export function unlimitedClientServiceIdSetFromPolicyRows(policyRows) {
  /** @type {Set<number>} */
  const set = new Set();
  for (const row of policyRows) {
    if (!row || typeof row !== "object") continue;
    if (!isCanonicalUnlimitedProductId(clientServiceProductIdFromRow(row))) continue;
    const id = clientServiceIdFromRow(row);
    if (id != null) set.add(id);
  }
  return set;
}

/**
 * @param {number | null | undefined} explicitServiceId
 * @param {number[]} bookingServiceIds
 * @param {Set<number>} unlimitedIds
 */
export function resolvePrimaryUnlimitedClientServiceIdForBooking(
  explicitServiceId,
  bookingServiceIds,
  unlimitedIds,
) {
  if (explicitServiceId != null && Number.isFinite(explicitServiceId)) {
    const id = Math.trunc(explicitServiceId);
    if (unlimitedIds.has(id)) return id;
    /** Explicit pack/drop-in — daily Unlimited cap does not apply to this book attempt. */
    return null;
  }
  for (const id of bookingServiceIds) {
    if (unlimitedIds.has(id)) return id;
  }
  return null;
}

/**
 * Server-selected ClientService for this book attempt (matches AddClient try order).
 * When Unlimited daily quota is exhausted, skips Unlimited ids and auto-selects the next
 * eligible non-Unlimited service in `bookingServiceIds` order.
 *
 * @param {number | null | undefined} explicitServiceId
 * @param {number[]} bookingServiceIds
 * @param {Set<number>} unlimitedIds
 * @param {{ unlimitedQuotaConsumed: number }} quota
 * @returns {number | null}
 */
export function resolveIntendedBookClientServiceId(
  explicitServiceId,
  bookingServiceIds,
  unlimitedIds,
  quota,
) {
  if (explicitServiceId != null && Number.isFinite(explicitServiceId)) {
    return Math.trunc(explicitServiceId);
  }
  const quotaBlocked =
    quota.unlimitedQuotaConsumed >= UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE;
  for (const id of bookingServiceIds) {
    if (!unlimitedIds.has(id)) return id;
    if (!quotaBlocked) return id;
  }
  for (const id of bookingServiceIds) {
    if (unlimitedIds.has(id)) return id;
  }
  return bookingServiceIds[0] ?? null;
}

/** @param {Record<string, unknown>} row */
function normalizeAppointmentStatus(row) {
  return String(row.AppointmentStatus ?? row.appointmentStatus ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** @param {Record<string, unknown>} row */
export function visitRowIsWaitlistEntry(row) {
  if (!row || typeof row !== "object") return false;
  if (row.Waitlist === true || row.waitlist === true) return true;
  const status = normalizeAppointmentStatus(row);
  return status === "waitlist" || status === "waitlisted";
}

/** @param {Record<string, unknown>} row */
export function visitIsNoShowOrMissedForLimit(row) {
  if (!row || typeof row !== "object") return false;
  if (row.Missed === true || row.missed === true) return true;
  const status = normalizeAppointmentStatus(row);
  return status === "noshow" || status === "missed";
}

/** @param {Record<string, unknown>} row */
export function visitIsLateCancelledForLimit(row) {
  if (!row || typeof row !== "object") return false;
  if (row.LateCancelled === true || row.lateCancelled === true) return true;
  const status = normalizeAppointmentStatus(row);
  return status === "latecancelled" || status === "latecancel";
}

/**
 * Timely/normal cancellation that Mindbody treats as released (does not consume daily slot).
 *
 * @param {Record<string, unknown>} row
 */
export function visitIsTimelyCancelledReleased(row) {
  if (!row || typeof row !== "object") return false;
  if (visitIsLateCancelledForLimit(row)) return false;
  if (visitIsNoShowOrMissedForLimit(row)) return false;
  if (row.EarlyCancelled === true || row.earlyCancelled === true) return true;
  if (row.Cancelled === true || row.cancelled === true) return true;
  const status = normalizeAppointmentStatus(row);
  if (status === "cancelled" || status === "canceled") return true;
  const action = String(row.Action ?? row.action ?? "")
    .trim()
    .toLowerCase();
  if (
    action === "cancelled" ||
    action === "canceled" ||
    action === "early cancel" ||
    action === "earlycancelled"
  ) {
    return true;
  }
  return false;
}

/** @param {Record<string, unknown>} row */
export function visitClassStartIsoFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const raw = row.StartDateTime ?? row.startDateTime ?? row.ClassDate ?? row.classDate;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Visit must be paid with the member's Unlimited ClientService (not pack/drop-in).
 *
 * @param {Record<string, unknown>} row
 * @param {Set<number>} unlimitedClientServiceIds
 */
export function visitUsesUnlimitedClientService(row, unlimitedClientServiceIds) {
  const csId = visitServiceIdFromRow(row);
  if (csId == null || !unlimitedClientServiceIds.has(csId)) return false;
  const productId = visitProductIdFromRow(row);
  if (productId != null && !isCanonicalUnlimitedProductId(productId)) return false;
  return true;
}

/** @param {Record<string, unknown>} row */
export function visitProductIdFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const top = row.ProductId ?? row.productId;
  const topN = Number(top);
  if (Number.isFinite(topN) && topN > 0) return Math.trunc(topN);
  const svc = row.Service ?? row.service;
  if (svc && typeof svc === "object") {
    const s = /** @type {Record<string, unknown>} */ (svc);
    const n = Number(s.ProductId ?? s.productId);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

/**
 * Whether a Mindbody visit row consumes one Unlimited daily session on `targetClassDate`.
 *
 * @param {Record<string, unknown>} row
 * @param {string} targetClassDate YYYY-MM-DD America/New_York
 * @param {Set<number>} unlimitedClientServiceIds
 */
export function visitConsumesUnlimitedDailySession(row, targetClassDate, unlimitedClientServiceIds) {
  if (!targetClassDate || !row || typeof row !== "object") return false;
  if (visitRowIsWaitlistEntry(row)) return false;
  if (visitRowLooksUnpaid(row)) return false;
  if (!visitUsesUnlimitedClientService(row, unlimitedClientServiceIds)) return false;

  const startIso = visitClassStartIsoFromRow(row);
  const visitDay = startIso ? mindbodyStudioCalendarDay(startIso, STUDIO_TZ) : null;
  if (visitDay !== targetClassDate) return false;

  if (visitIsLateCancelledForLimit(row)) return true;
  if (visitIsNoShowOrMissedForLimit(row)) return true;
  if (visitIsTimelyCancelledReleased(row)) return false;

  return true;
}

/**
 * @param {Record<string, unknown>[]} visits
 * @param {string} targetClassDate
 * @param {Set<number>} unlimitedClientServiceIds
 * @param {{ excludeVisitIds?: number[] }} [opts]
 */
export function countUnlimitedDailyConsumedSessions(
  visits,
  targetClassDate,
  unlimitedClientServiceIds,
  opts = {},
) {
  const exclude = new Set(
    (opts.excludeVisitIds ?? []).filter((id) => Number.isFinite(id) && id > 0).map(Math.trunc),
  );
  /** @type {Record<string, unknown>[]} */
  const consumed = [];
  for (const raw of visits) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const vid = visitIdFromRow(row);
    if (vid != null && exclude.has(vid)) continue;
    if (!visitConsumesUnlimitedDailySession(row, targetClassDate, unlimitedClientServiceIds)) continue;
    consumed.push(row);
  }
  return { count: consumed.length, consumedRows: consumed };
}

/** @param {Record<string, unknown>[]} consumedRows */
export function auditConsumedUnlimitedVisits(consumedRows) {
  return consumedRows.map((row) => ({
    visitId: visitIdFromRow(row),
    classId: visitClassIdFromRow(row),
    classDate: mindbodyStudioCalendarDay(visitClassStartIsoFromRow(row), STUDIO_TZ),
    clientServiceId: visitServiceIdFromRow(row),
    appointmentStatus: row.AppointmentStatus ?? row.appointmentStatus ?? null,
    lateCancelled: visitIsLateCancelledForLimit(row),
    missed: visitIsNoShowOrMissedForLimit(row),
    timelyCancelledReleased: visitIsTimelyCancelledReleased(row),
  }));
}

/**
 * @param {Record<string, string | string[]>} [cookieHdr]
 * @param {Record<string, unknown>} [extra]
 */
export function unlimitedDailyLimitReachedResponse(cookieHdr, extra = {}) {
  return jsonResponse(
    409,
    {
      ok: false,
      error: "unlimited_daily_limit_reached",
      dailyLimit: UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE,
      message: UNLIMITED_DAILY_LIMIT_USER_MESSAGE,
      detail: UNLIMITED_DAILY_LIMIT_USER_DETAIL,
      suggestPackages: false,
      hasBookableCredits: true,
      ...extra,
    },
    cookieHdr,
  );
}

/**
 * @param {{
 *   clientId: number;
 *   classId: number;
 *   targetClassDate: string;
 *   selectedClientServiceId: number;
 *   productId: number | null;
 *   unlimitedClientServiceIds: Set<number>;
 *   visits: Record<string, unknown>[];
 *   excludeVisitIds?: number[];
 * }} input
 */
export function evaluateUnlimitedDailyLimitFromVisits(input) {
  const { unlimitedClientServiceIds, selectedClientServiceId, targetClassDate } = input;
  if (!unlimitedClientServiceIds.has(selectedClientServiceId)) {
    return { decision: /** @type {const} */ ("not_applicable"), consumedCount: 0, consumedRows: [] };
  }
  const { count, consumedRows } = countUnlimitedDailyConsumedSessions(
    input.visits,
    targetClassDate,
    unlimitedClientServiceIds,
    { excludeVisitIds: input.excludeVisitIds },
  );
  if (count >= UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE) {
    return {
      decision: /** @type {const} */ ("block"),
      consumedCount: count,
      consumedRows,
      dailyLimit: UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE,
    };
  }
  return {
    decision: /** @type {const} */ ("allow"),
    consumedCount: count,
    consumedRows,
    dailyLimit: UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE,
  };
}

/**
 * @param {{
 *   clientId: number;
 *   classId: number;
 *   targetClassDate: string;
 *   policyRows: Record<string, unknown>[];
 *   bookingServiceIds: number[];
 *   explicitServiceId: number | null;
 *   authHeaders: Record<string, string>;
 *   excludeVisitIds?: number[];
 * }} opts
 */
export async function assessUnlimitedDailyLimitForBooking(opts) {
  const unlimitedIds = unlimitedClientServiceIdSetFromPolicyRows(opts.policyRows);

  const visitsResult = await fetchClientVisitsWindow(opts.clientId, opts.authHeaders);
  if (!visitsResult.ok) {
    const fallbackIntended = resolveIntendedBookClientServiceId(
      opts.explicitServiceId,
      opts.bookingServiceIds,
      unlimitedIds,
      { unlimitedQuotaConsumed: 0 },
    );
    const policyRow =
      fallbackIntended != null
        ? opts.policyRows.find((r) => clientServiceIdFromRow(r) === fallbackIntended)
        : null;
    return {
      applicable: unlimitedIds.has(fallbackIntended ?? -1),
      decision: /** @type {const} */ ("unknown"),
      intendedClientServiceId: fallbackIntended,
      selectedClientServiceId: fallbackIntended,
      productId: policyRow ? clientServiceProductIdFromRow(policyRow) : null,
      consumedCount: null,
      consumedRows: [],
      visitsOk: false,
    };
  }

  const { count, consumedRows } = countUnlimitedDailyConsumedSessions(
    visitsResult.visits,
    opts.targetClassDate,
    unlimitedIds,
    { excludeVisitIds: opts.excludeVisitIds },
  );

  const intendedId = resolveIntendedBookClientServiceId(
    opts.explicitServiceId,
    opts.bookingServiceIds,
    unlimitedIds,
    { unlimitedQuotaConsumed: count },
  );

  if (intendedId == null || !unlimitedIds.has(intendedId)) {
    const policyRow =
      intendedId != null ? opts.policyRows.find((r) => clientServiceIdFromRow(r) === intendedId) : null;
    return {
      applicable: false,
      decision: /** @type {const} */ ("not_applicable"),
      intendedClientServiceId: intendedId,
      selectedClientServiceId: intendedId,
      productId: policyRow ? clientServiceProductIdFromRow(policyRow) : null,
      consumedCount: count,
      consumedRows,
      dailyLimit: UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE,
      visitsOk: true,
      visits: visitsResult.visits,
    };
  }

  const policyRow = opts.policyRows.find((r) => clientServiceIdFromRow(r) === intendedId);
  const productId = policyRow ? clientServiceProductIdFromRow(policyRow) : null;

  const evalResult = evaluateUnlimitedDailyLimitFromVisits({
    clientId: opts.clientId,
    classId: opts.classId,
    targetClassDate: opts.targetClassDate,
    selectedClientServiceId: intendedId,
    productId,
    unlimitedClientServiceIds: unlimitedIds,
    visits: visitsResult.visits,
    excludeVisitIds: opts.excludeVisitIds,
  });

  return {
    applicable: true,
    ...evalResult,
    intendedClientServiceId: intendedId,
    selectedClientServiceId: intendedId,
    productId,
    visitsOk: true,
    visits: visitsResult.visits,
  };
}

/**
 * Post-verify reclassification (after rollback) when quota is authoritative.
 *
 * @param {{
 *   verify: { ok: boolean; reason?: string; detail?: Record<string, unknown> };
 *   usedServiceId: number | null;
 *   policyRows: Record<string, unknown>[];
 *   targetClassDate: string;
 *   visits: Record<string, unknown>[];
 *   rollingBackVisitId: number | null;
 * }} opts
 */
export function classifyVerifyFailureAsUnlimitedDailyLimit(opts) {
  if (opts.verify.ok) return false;
  if (opts.usedServiceId == null || !Number.isFinite(opts.usedServiceId)) return false;
  if (opts.verify.reason !== "remaining_unchanged") return false;

  const unlimitedIds = unlimitedClientServiceIdSetFromPolicyRows(opts.policyRows);
  if (!unlimitedIds.has(Math.trunc(opts.usedServiceId))) return false;

  const detail = opts.verify.detail ?? {};
  const visitServiceId =
    detail.visitServiceId != null && Number.isFinite(Number(detail.visitServiceId))
      ? Number(detail.visitServiceId)
      : null;
  if (visitServiceId != null && visitServiceId === opts.usedServiceId) return false;

  const exclude = opts.rollingBackVisitId != null ? [opts.rollingBackVisitId] : [];
  const { count } = countUnlimitedDailyConsumedSessions(
    opts.visits,
    opts.targetClassDate,
    unlimitedIds,
    { excludeVisitIds: exclude },
  );
  return count >= UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE;
}
