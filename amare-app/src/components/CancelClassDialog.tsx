import { useEffect, useState } from "react";
import { classTitle, classStart, staffName, classId } from "../api/client";
import {
  fetchGuestCancelPreflight,
  guestCancelWarningText,
  type CancelBookingOptions,
  type GuestCancelPreflight,
} from "../api/cancel-api";
import { classDurationMinutes, isWithinLateCancelWindowForClass, LATE_CANCEL_HOURS } from "../lib/schedule-utils";
import { formatMindbodyEt } from "../lib/mindbody-time";

type Props = {
  cls: Record<string, unknown>;
  accessToken: string | null;
  onConfirm: (opts?: CancelBookingOptions) => void;
  onDismiss: () => void;
  busy: boolean;
};

function formatSub(cls: Record<string, unknown>): string {
  const iso = classStart(cls);
  const duration = classDurationMinutes(cls);
  const bits: string[] = [];
  if (iso) {
    bits.push(
      formatMindbodyEt(iso, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  }
  if (duration != null) bits.push(`${duration} min`);
  bits.push(staffName(cls));
  return bits.join(" · ");
}

export function CancelClassDialog({ cls, accessToken, onConfirm, onDismiss, busy }: Props) {
  const [preflight, setPreflight] = useState<GuestCancelPreflight | null>(null);
  const cid = classId(cls);
  const withinLateWindow = isWithinLateCancelWindowForClass(cls);
  const hasGuest = preflight?.hasGuest === true;

  useEffect(() => {
    if (!accessToken || cid == null) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    void fetchGuestCancelPreflight(accessToken, cid).then((p) => {
      if (!cancelled) setPreflight(p);
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, cid]);

  function handleConfirm() {
    if (hasGuest) {
      onConfirm({
        confirmCancelGuest: true,
        period: typeof preflight?.period === "string" ? preflight.period : undefined,
      });
      return;
    }
    onConfirm();
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal card mb-book-dialog"
        role="dialog"
        aria-labelledby="cancel-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cancel-dialog-title" className="mb-book-dialog__title">
          {hasGuest ? "Cancel your class and your guest?" : "Remove your spot in this class?"}
        </h2>
        <div className="mb-book-dialog__body">
          <p className="mb-book-dialog__lead">{classTitle(cls)}</p>
          <p className="mb-book-dialog__sub">{formatSub(cls)}</p>
          {hasGuest && preflight && (
            <p className="mb-book-dialog__hint mb-book-dialog__late-warning">
              {guestCancelWarningText(preflight)}
            </p>
          )}
          {withinLateWindow && (
            <p className="mb-book-dialog__hint mb-book-dialog__late-warning">
              Heads up: within our {LATE_CANCEL_HOURS}-hour window. Cancelling now uses your class
              credit. If you can still make it, your spot is saved.
            </p>
          )}
        </div>
        <div className="mb-book-dialog__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onDismiss}>
            {hasGuest ? "Keep booking" : "Keep reservation"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={handleConfirm}>
            {busy ? "Canceling…" : hasGuest ? "Cancel both bookings" : "Confirm cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
