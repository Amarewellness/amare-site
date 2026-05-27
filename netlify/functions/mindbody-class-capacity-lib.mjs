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
