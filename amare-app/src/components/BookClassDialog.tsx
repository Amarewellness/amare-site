import { useState } from "react";
import { Link } from "react-router-dom";
import { classTitle, classStart, staffName } from "../api/client";
import { classDurationMinutes } from "../lib/schedule-utils";
import { formatMindbodyEt } from "../lib/mindbody-time";
import { scheduleWalletViewModel } from "../lib/wallet-view";
import { cancellationPolicyFromSummary } from "../lib/cancellation-policy";
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
  intent?: "book" | "waitlist";
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
  intent = "book",
}: Props) {
  const wallet = scheduleWalletViewModel(summary);
  const hasCredits = wallet.kind === "packs" || wallet.kind === "membership";
  const blocked = !!blockedMessage;
  const needsPass = !blocked && !hasCredits && wallet.kind === "message";
  const policy = !blocked && !needsPass ? cancellationPolicyFromSummary(summary) : null;
  const requiresAck = policy?.kind === "unlimited_fee" && policy.requiresAcknowledgment;
  const [policyChecked, setPolicyChecked] = useState(false);
  const confirmDisabled = busy || wallet.kind === "loading" || (requiresAck && !policyChecked);
  const isWaitlist = intent === "waitlist";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal card mb-book-dialog"
        role="dialog"
        aria-labelledby="book-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="book-dialog-title" className="mb-book-dialog__title">
          {blocked
            ? blockedTitle || "Account not linked yet"
            : isWaitlist
              ? "Join the waitlist?"
              : "Book this class"}
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
            <>
              <p className="mb-book-dialog__hint">
                {isWaitlist
                  ? "We'll email you if a spot opens."
                  : "Confirm to book this class. Check your email for confirmation."}
              </p>
              {policy?.kind === "unlimited_fee" ? (
                <div className="mb-book-dialog__policy">
                  <p className="mb-book-dialog__policy-title">{policy.title || "Unlimited Member Policy"}</p>
                  <label className="mb-book-dialog__policy-check">
                    <input
                      type="checkbox"
                      className="mb-book-dialog__policy-box"
                      checked={policyChecked}
                      onChange={(e) => setPolicyChecked(e.target.checked)}
                    />
                    <span>
                      {policy.checkboxLabel ||
                        policy.body ||
                        "I understand that late cancellations made less than 12 hours before class and no-shows are subject to a $10 fee."}
                    </span>
                  </label>
                </div>
              ) : policy?.kind === "credit_forfeit" ? (
                <div className="mb-book-dialog__policy">
                  <p className="mb-book-dialog__policy-title">{policy.title || "Cancellation Policy"}</p>
                  <p className="mb-book-dialog__policy-body">
                    {policy.body ||
                      "Cancellations made less than 12 hours before class are considered late cancellations and the class credit will be forfeited."}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="mb-book-dialog__actions">
          {blocked ? (
            <>
              <Link className="btn btn--ghost" to="/contact" onClick={onCancel}>
                Contact studio
              </Link>
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
              <button type="button" className="btn" disabled={confirmDisabled} onClick={onConfirm}>
                {busy ? (isWaitlist ? "Joining…" : "Booking…") : isWaitlist ? "Join waitlist" : "Book Class"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
