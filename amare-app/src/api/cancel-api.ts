import { apiJson, ApiError } from "./client";
import {
  cancellationPolicyFromSummary,
  requiresUnlimitedPolicyAcceptance,
} from "../lib/cancellation-policy";
import { isWithinLateCancelWindowForClass, LATE_CANCEL_HOURS } from "../lib/schedule-utils";

export type GuestCancelPreflight = {
  hasGuest?: boolean;
  guestFirstName?: string;
  guestLastInitial?: string;
  period?: string;
  canRemoveGuestOnly?: boolean;
  guestPassWillRestore?: boolean;
};

export type CancelBookingOptions = {
  confirmCancelGuest?: boolean;
  period?: string;
};

export type CancelBookingResult = {
  ok: boolean;
  message: string;
  lateCancelled?: boolean | null;
  noLongerAvailable?: boolean;
  guestAlsoCancelled?: boolean;
  guestPassReturned?: boolean;
  memberBookingKept?: boolean;
};

function classNoLongerAvailable(msg: string): boolean {
  return /\bno longer available\b/i.test(msg) || /\binvalid class\b/i.test(msg);
}

export async function fetchGuestCancelPreflight(
  accessToken: string,
  classIdNum: number,
): Promise<GuestCancelPreflight> {
  try {
    return await apiJson<GuestCancelPreflight>(
      `/api/mindbody/class/cancel?preflight=1&classId=${encodeURIComponent(String(classIdNum))}`,
      accessToken,
    );
  } catch {
    return { hasGuest: false };
  }
}

export function cancelSuccessMessage(
  body: Record<string, unknown>,
  cls: Record<string, unknown>,
  summary?: unknown,
): string {
  if (body.cancelGuestOnly === true && body.memberBookingKept === true) {
    return body.guestPassReturned === true
      ? "Your guest was removed. Your class stays booked and your Bring a Friend Pass is available again for this period."
      : "Your guest was removed. Your class stays booked.";
  }

  const withinLateWindow = isWithinLateCancelWindowForClass(cls);
  const lateRaw = body.lateCancelled;
  const lateCancelled = typeof lateRaw === "boolean" ? lateRaw : null;
  const wasLate = lateCancelled === true || (lateCancelled == null && withinLateWindow);

  if (body.guestAlsoCancelled === true) {
    if (body.guestPassReturned === true) {
      return "Your class was cancelled and your guest was notified. Your Bring a Friend Pass is available again for this period.";
    }
    if (lateCancelled === true) {
      return "Your class and your guest's spot were cancelled inside the studio's late-cancel window. Your Bring a Friend Pass will not be returned.";
    }
    return "Your class was cancelled and your guest was notified. Your Bring a Friend Pass for this period will remain used.";
  }

  if (wasLate) {
    const policy = cancellationPolicyFromSummary(summary);
    if (requiresUnlimitedPolicyAcceptance(policy)) {
      return `Booking cancelled. Thanks for the heads-up — late cancellations and no-shows may be subject to a $10 fee per our ${LATE_CANCEL_HOURS}-hour policy, and you've freed the spot for someone else.`;
    }
    return `Booking cancelled. Thanks for the heads-up — your class credit is used per our ${LATE_CANCEL_HOURS}-hour policy, and you've freed the spot for someone else.`;
  }

  return "Your reservation was removed.";
}

export function guestPassCancelHint(
  preflight: GuestCancelPreflight,
  withinLateWindow: boolean,
): string {
  const willRestore =
    preflight.guestPassWillRestore === true
      ? true
      : preflight.guestPassWillRestore === false
        ? false
        : !withinLateWindow;
  return willRestore
    ? "Your Bring a Friend Pass will be available again for this period."
    : "Your Bring a Friend Pass for this period will remain used.";
}

export async function cancelBooking(
  accessToken: string,
  classIdNum: number,
  visitId: number,
  cls: Record<string, unknown>,
  opts?: CancelBookingOptions,
  summary?: unknown,
): Promise<CancelBookingResult> {
  /** @type {Record<string, unknown>} */
  const payload: Record<string, unknown> = { classId: classIdNum, visitId };
  if (opts?.confirmCancelGuest) {
    payload.confirmCancelGuest = true;
    if (opts.period) payload.period = opts.period;
  }

  try {
    const j = await apiJson<Record<string, unknown>>("/api/mindbody/class/cancel", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (j.ok === false) {
      const msg = typeof j.detail === "string" ? j.detail : "Could not cancel this booking.";
      return { ok: false, message: msg };
    }

    const lateRaw = j.lateCancelled;
    return {
      ok: true,
      message: cancelSuccessMessage(j, cls, summary),
      lateCancelled: typeof lateRaw === "boolean" ? lateRaw : null,
      guestAlsoCancelled: j.guestAlsoCancelled === true,
      guestPassReturned: j.guestPassReturned === true ? true : j.guestPassReturned === false ? false : undefined,
      memberBookingKept: j.memberBookingKept === true,
    };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body;
      const errCode =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: string }).error)
          : "";
      let msg = "Could not cancel this booking.";
      if (typeof (body as { detail?: string })?.detail === "string") {
        msg = (body as { detail: string }).detail;
      }
      if (errCode === "guest_cancel_confirmation_required") {
        msg = "This class has a guest booking. Confirm to cancel both reservations.";
      }
      if (classNoLongerAvailable(msg)) {
        return {
          ok: false,
          noLongerAvailable: true,
          message: "This class is no longer available. Please refresh the schedule and choose another class.",
        };
      }
      return { ok: false, message: msg };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Could not cancel this booking." };
  }
}

export function guestCancelWarningText(
  preflight: GuestCancelPreflight,
  withinLateWindow: boolean,
): string {
  const gf = preflight.guestFirstName?.trim() || "Your guest";
  const gl = preflight.guestLastInitial?.trim() || "";
  return `Canceling this class will also cancel ${gf}${gl ? ` ${gl}` : ""}'s spot. ${guestPassCancelHint(preflight, withinLateWindow)}`;
}

export async function cancelGuestOnly(
  accessToken: string,
  classIdNum: number,
  period?: string,
): Promise<CancelBookingResult> {
  const payload: Record<string, unknown> = {
    classId: classIdNum,
    cancelGuestOnly: true,
    confirmRemoveGuest: true,
  };
  if (period) payload.period = period;

  try {
    const j = await apiJson<Record<string, unknown>>("/api/mindbody/class/cancel", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (j.ok === false) {
      const msg = typeof j.detail === "string" ? j.detail : "Could not remove your guest.";
      return { ok: false, message: msg };
    }

    const message =
      j.guestPassReturned === true
        ? "Your guest was removed. Your class stays booked and your Bring a Friend Pass is available again for this period."
        : "Your guest was removed. Your class stays booked.";

    return {
      ok: true,
      message,
      guestPassReturned: j.guestPassReturned === true,
      memberBookingKept: j.memberBookingKept === true,
    };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body;
      let msg = "Could not remove your guest.";
      if (typeof (body as { detail?: string })?.detail === "string") {
        msg = (body as { detail: string }).detail;
      }
      return { ok: false, message: msg };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Could not remove your guest." };
  }
}
