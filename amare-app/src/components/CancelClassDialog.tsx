import { useEffect, useState } from "react";
import { classTitle, classStart, staffName, classId } from "../api/client";
import {
  fetchGuestCancelPreflight,
  guestCancelWarningText,
  type CancelBookingOptions,
  type GuestCancelPreflight,
} from "../api/cancel-api";
import { preflightAllowsRemoveGuestOnly } from "../lib/bring-a-friend";
import { classDurationMinutes, isWithinLateCancelWindowForClass, LATE_CANCEL_HOURS } from "../lib/schedule-utils";
import { formatMindbodyEt } from "../lib/mindbody-time";
import { cancellationPolicyFromSummary, lateCancelConfirmCopy } from "../lib/cancellation-policy";

type Props = {
  cls: Record<string, unknown>;
  summary?: unknown;
  accessToken: string | null;
  onConfirm: (opts?: CancelBookingOptions) => void;
  onRemoveGuestOnly?: (preflight: GuestCancelPreflight) => void;
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

export function CancelClassDialog({
  cls,
  summary,
  accessToken,
  onConfirm,
  onRemoveGuestOnly,
  onDismiss,
  busy,
}: Props) {
  const [preflight, setPreflight] = useState<GuestCancelPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const cid = classId(cls);
  const withinLateWindow = isWithinLateCancelWindowForClass(cls);
  const cancelPolicy = cancellationPolicyFromSummary(summary);
  const hasGuest = preflight?.hasGuest === true;
  const canRemoveGuestOnly =
    hasGuest && preflight != null && preflightAllowsRemoveGuestOnly(preflight);

  useEffect(() => {
    if (!accessToken || cid == null) {
      setPreflight(null);
      setPreflightLoading(false);
      return;
    }
    let cancelled = false;
    setPreflightLoading(true);
    void fetchGuestCancelPreflight(accessToken, cid).then((p) => {
      if (!cancelled) {
        setPreflight(p);
        setPreflightLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, cid]);

  function handleConfirm() {
    if (hasGuest && preflight) {
      onConfirm({
        confirmCancelGuest: true,
        period: typeof preflight.period === "string" ? preflight.period : undefined,
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
          {preflightLoading
            ? "Checking booking…"
            : hasGuest
              ? "Cancel your class and your guest?"
              : "Remove your spot in this class?"}
        </h2>
        <div className="mb-book-dialog__body">
          <p className="mb-book-dialog__lead">{classTitle(cls)}</p>
          <p className="mb-book-dialog__sub">{formatSub(cls)}</p>
          {preflightLoading && (
            <p className="mb-book-dialog__hint" aria-live="polite">
              Loading guest details…
            </p>
          )}
          {!preflightLoading && hasGuest && preflight && (
            <>
              <p className="mb-book-dialog__hint mb-book-dialog__late-warning">
                {guestCancelWarningText(preflight, withinLateWindow)}
              </p>
              {canRemoveGuestOnly && onRemoveGuestOnly && (
                <p className="mb-book-dialog__hint">
                  Want to keep your spot? Remove your guest only — your pass will be available again.
                </p>
              )}
            </>
          )}
          {!preflightLoading && withinLateWindow && (
            <p className="mb-book-dialog__hint mb-book-dialog__late-warning">
              {lateCancelConfirmCopy(cancelPolicy, LATE_CANCEL_HOURS)}
            </p>
          )}
        </div>
        <div className="mb-book-dialog__actions mb-book-dialog__actions--stack">
          <button
            type="button"
            className="btn"
            disabled={busy || preflightLoading}
            onClick={handleConfirm}
          >
            {busy ? "Canceling…" : hasGuest ? "Cancel both bookings" : "Confirm cancel"}
          </button>
          {canRemoveGuestOnly && onRemoveGuestOnly && preflight && !preflightLoading && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => onRemoveGuestOnly(preflight)}
            >
              Remove guest only
            </button>
          )}
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onDismiss}>
            {hasGuest ? "Keep booking" : "Keep reservation"}
          </button>
        </div>
      </div>
    </div>
  );
}
