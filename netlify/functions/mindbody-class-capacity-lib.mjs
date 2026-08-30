/**
 * Shared class capacity helpers — must match `spotsRemainingFromCls` in
 * `src/js/classes-schedule.js` (§1.4.1.a bring-a-friend plan).
 */

/** @param {Record<string, unknown>} cls @param {string[]} keys */
function numFieldFromClassRow(cls, keys) {
  for (const k of keys) {
    const v = cls[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** @param {unknown} raw */
function boolFieldFromClassRow(raw) {
  return raw === true || raw === "true" || raw === 1 || raw === "1";
}

/**
 * Authoritative capacity snapshot from a Mindbody Get Classes row.
 * @param {unknown} classRow
 */
export function parseClassCapacitySnapshot(classRow) {
  if (!classRow || typeof classRow !== "object") {
    return {
      maxCapacity: null,
      totalBooked: null,
      isWaitlistAvailable: null,
      totalBookedWaitlist: null,
      waitlistCapacity: null,
      spotsRemaining: null,
    };
  }
  const cls = /** @type {Record<string, unknown>} */ (classRow);
  const maxCapacity = numFieldFromClassRow(cls, ["MaxCapacity", "maxCapacity"]);
  const totalBooked = numFieldFromClassRow(cls, ["TotalBooked", "totalBooked"]);
  const totalBookedWaitlist = numFieldFromClassRow(cls, [
    "TotalBookedWaitlist",
    "totalBookedWaitlist",
  ]);
  const waitlistCapacity = numFieldFromClassRow(cls, ["WaitlistCapacity", "waitlistCapacity"]);
  const isWaitlistAvailableRaw = cls.IsWaitlistAvailable ?? cls.isWaitlistAvailable;
  const isWaitlistAvailable =
    isWaitlistAvailableRaw == null ? null : boolFieldFromClassRow(isWaitlistAvailableRaw);
  let spotsRemaining = null;
  if (maxCapacity != null && totalBooked != null) {
    spotsRemaining = Math.max(0, Math.trunc(maxCapacity - totalBooked));
  } else {
    spotsRemaining = spotsRemainingFromClassRow(classRow);
  }
  return {
    maxCapacity,
    totalBooked,
    isWaitlistAvailable,
    totalBookedWaitlist,
    waitlistCapacity,
    spotsRemaining,
  };
}

/**
 * Gate for staff-token normal-seat acquisition (`Waitlist: false`).
 * Waitlist requests must bypass this check at the call site.
 *
 * @param {ReturnType<typeof parseClassCapacitySnapshot>} snapshot
 * @returns {{ ok: true; spotsRemaining: number | null } | { ok: false; reason: "class_full"; waitlistAvailable: boolean; maxCapacity: number | null; totalBooked: number | null; spotsRemaining: number }}
 */
export function evaluateStaffNormalSeatBooking(snapshot) {
  const { maxCapacity, totalBooked, isWaitlistAvailable, spotsRemaining } = snapshot;
  if (maxCapacity == null || totalBooked == null) {
    return {
      ok: false,
      reason: "capacity_unavailable",
      waitlistAvailable: isWaitlistAvailable === true,
      maxCapacity,
      totalBooked,
      spotsRemaining: spotsRemaining ?? null,
    };
  }
  const remaining =
    spotsRemaining != null ? spotsRemaining : Math.max(0, Math.trunc(maxCapacity - totalBooked));
  if (remaining <= 0) {
    return {
      ok: false,
      reason: "class_full",
      waitlistAvailable: isWaitlistAvailable === true,
      maxCapacity,
      totalBooked,
      spotsRemaining: 0,
    };
  }
  return { ok: true, spotsRemaining: remaining };
}

/**
 * @param {unknown} classRow Mindbody Get Classes row
 * @returns {number | null}
 */
export function spotsRemainingFromClassRow(classRow) {
  if (!classRow || typeof classRow !== "object") return null;
  const cls = /** @type {Record<string, unknown>} */ (classRow);
  const maxCap = numFieldFromClassRow(cls, ["MaxCapacity", "maxCapacity"]);
  const totalBooked = numFieldFromClassRow(cls, ["TotalBooked", "totalBooked"]);
  if (maxCap != null && totalBooked != null) {
    return Math.max(0, Math.trunc(maxCap - totalBooked));
  }
  const webCap = numFieldFromClassRow(cls, ["WebCapacity", "webCapacity"]);
  if (webCap == null) return null;
  const webBooked = numFieldFromClassRow(cls, ["WebBooked", "webBooked"]);
  const booked = webBooked ?? totalBooked ?? 0;
  return Math.max(0, Math.trunc(webCap - booked));
}

/**
 * @param {number | null | undefined} spotsRemaining
 * @returns {{ ok: true } | { ok: false, reason: "class_not_available_for_guest", spotsRemaining: number | null }}
 */
export function assertClassEligibleForGuestBooking(spotsRemaining) {
  if (spotsRemaining == null || spotsRemaining < 2) {
    return { ok: false, reason: "class_not_available_for_guest", spotsRemaining: spotsRemaining ?? null };
  }
  return { ok: true };
}
