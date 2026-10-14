import { visitRowIsWaitlist, type VisitRow } from "./visit-utils";

function normalizeAppointmentStatus(v: VisitRow): string {
  return String(v.AppointmentStatus ?? v.appointmentStatus ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Authoritative Mindbody cancellation — evaluated before Missed / NoShow. */
function visitHasAuthoritativeCancellation(v: VisitRow): boolean {
  if (v.LateCancelled === true || v.lateCancelled === true) return true;
  if (v.Cancelled === true || v.cancelled === true) return true;

  const status = normalizeAppointmentStatus(v);
  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "latecancelled" ||
    status === "latecancel"
  ) {
    return true;
  }

  const action = String(v.Action ?? v.action ?? "")
    .trim()
    .toLowerCase();
  if (
    action === "cancelled" ||
    action === "canceled" ||
    action === "late cancel" ||
    action === "latecancelled"
  ) {
    return true;
  }

  return false;
}

/**
 * Visit row should not count as an active booking in schedule / My Classes.
 * Aligns with server-side idempotent cancel / inactive-visit semantics for UI.
 *
 * Authoritative cancellation (LateCancelled, Cancelled status, etc.) wins over Missed.
 * Missed / NoShow alone on an otherwise active visit are not treated as cancelled.
 */
export function visitIsCancelledForBooking(v: VisitRow): boolean {
  if (!v || typeof v !== "object") return false;
  if (visitRowIsWaitlist(v)) return false;

  if (visitHasAuthoritativeCancellation(v)) return true;

  if (v.Missed === true || v.missed === true) return false;
  const status = normalizeAppointmentStatus(v);
  if (status === "noshow" || status === "missed") return false;

  return false;
}
