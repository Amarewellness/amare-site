import { Link } from "react-router-dom";
import { classTitle, classStart, staffName } from "../api/client";
import { classDurationMinutes } from "../lib/schedule-utils";
import { formatMindbodyEt } from "../lib/mindbody-time";
import { scheduleWalletViewModel } from "../lib/wallet-view";
import { apiBase } from "../config";
import { MemberTopUpCard } from "./MemberTopUpCard";

type Props = {
  cls: Record<string, unknown>;
  summary: unknown;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  /** When set, booking is blocked (unlinked account) — same as website book dialog. */
  blockedTitle?: string | null;
  blockedMessage?: string | null;
  accessToken?: string | null;
};

function formatBookSub(cls: Record<string, unknown>): string {
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

export function BookClassDialog({
  cls,
  summary,
  onConfirm,
  onCancel,
  busy,
  blockedTitle,
  blockedMessage,
  accessToken,
}: Props) {
  const wallet = scheduleWalletViewModel(summary);
  const hasCredits = wallet.kind === "packs" || wallet.kind === "membership";
  const contact = `${apiBase()}/contact`;
  const blocked = !!blockedMessage;
  const needsPass = !blocked && !hasCredits && wallet.kind === "message";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal card mb-book-dialog"
        role="dialog"
        aria-labelledby="book-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="book-dialog-title" className="mb-book-dialog__title">
          {blocked ? blockedTitle || "Account not linked yet" : "Book this class"}
        </h2>
        <div className="mb-book-dialog__body">
          <p className="mb-book-dialog__lead">{classTitle(cls)}</p>
          <p className="mb-book-dialog__sub">{formatBookSub(cls)}</p>
          {blocked ? (
            <p className="mb-book-dialog__hint mb-book-dialog__hint--warn">{blockedMessage}</p>
          ) : needsPass ? (
            <>
              <p className="mb-book-dialog__hint">{wallet.text}</p>
              {accessToken ? <MemberTopUpCard accessToken={accessToken} compact /> : null}
            </>
          ) : (
            <p className="mb-book-dialog__hint">
              Confirm to book with your Mindbody account. Check your email for confirmation.
            </p>
          )}
        </div>
        <div className="mb-book-dialog__actions">
          {blocked ? (
            <>
              <a className="btn btn--ghost" href={contact} target="_blank" rel="noopener noreferrer">
                Contact studio
              </a>
              <button type="button" className="btn" onClick={onCancel}>
                Close
              </button>
            </>
          ) : needsPass ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={onCancel}>
                Cancel
              </button>
              <Link className="btn" to="/purchase" onClick={onCancel}>
                Buy a pass
              </Link>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
                {busy ? "Booking…" : "Confirm booking"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
