import { classTitle, staffName, classId, classStart } from "../api/client";
import type { GuestCancelPreflight } from "../api/cancel-api";
import { classDurationMinutes } from "../lib/schedule-utils";
import { formatMindbodyEt } from "../lib/mindbody-time";

type Props = {
  cls: Record<string, unknown>;
  preflight: GuestCancelPreflight;
  onConfirm: () => void;
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

export function RemoveGuestDialog({ cls, preflight, onConfirm, onDismiss, busy }: Props) {
  if (classId(cls) == null) return null;

  const gf = preflight.guestFirstName?.trim() || "Your guest";
  const gl = preflight.guestLastInitial?.trim() || "";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal card mb-book-dialog"
        role="dialog"
        aria-labelledby="remove-guest-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="remove-guest-dialog-title" className="mb-book-dialog__title">
          Remove guest only?
        </h2>
        <div className="mb-book-dialog__body">
          <p className="mb-book-dialog__lead">{classTitle(cls)}</p>
          <p className="mb-book-dialog__sub">{formatSub(cls)}</p>
          <p className="mb-book-dialog__hint">
            Cancel {gf}
            {gl ? ` ${gl}` : ""}&apos;s spot only. Your booking stays. Your Bring a Friend Pass will be
            available again for this period.
          </p>
        </div>
        <div className="mb-book-dialog__actions mb-book-dialog__actions--stack">
          <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
            {busy ? "Removing…" : "Remove guest"}
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onDismiss}>
            Keep guest
          </button>
        </div>
      </div>
    </div>
  );
}
