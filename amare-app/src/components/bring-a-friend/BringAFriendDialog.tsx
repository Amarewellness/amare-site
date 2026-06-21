import { useEffect, useState } from "react";
import { apiJson, ApiError } from "../../api/client";
import {
  bringAFriendErrorMessage,
  classLabelForGuestOption,
  DEFAULT_BOOKING_CONSENT,
  formatBringAFriendWhen,
  guestInviteClassOption,
  type BringAFriendBookPayload,
  type BringAFriendStatus,
} from "../../lib/bring-a-friend";

type Props = {
  accessToken: string;
  open: boolean;
  status: BringAFriendStatus | null;
  preselectClassId: number | null;
  /** When true, class is fixed (opened from a My Classes card) — no dropdown. */
  lockClassSelection?: boolean;
  onDismiss: () => void;
  onSuccess: (requiresInStudioWaiver?: boolean) => void;
};

export function BringAFriendDialog({
  accessToken,
  open,
  status,
  preselectClassId,
  lockClassSelection = false,
  onDismiss,
  onSuccess,
}: Props) {
  const [classId, setClassId] = useState("");
  const [guestFirstName, setGuestFirstName] = useState("");
  const [guestLastName, setGuestLastName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const classes = status?.upcomingBookedClasses ?? [];
  const consentText = status?.bookingConsentText || DEFAULT_BOOKING_CONSENT;
  const lockedClass =
    lockClassSelection && preselectClassId != null
      ? guestInviteClassOption(status, preselectClassId)
      : null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (lockClassSelection && preselectClassId != null) {
      setClassId(String(preselectClassId));
      return;
    }
    if (preselectClassId != null && classes.some((c) => c.classId === preselectClassId)) {
      setClassId(String(preselectClassId));
    } else if (classes.length === 1) {
      setClassId(String(classes[0].classId));
    } else {
      setClassId("");
    }
  }, [open, lockClassSelection, preselectClassId, classes]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cid = parseInt(classId, 10);
    if (!Number.isFinite(cid) || cid <= 0) {
      setError("Please select a class.");
      return;
    }
    if (!guestFirstName.trim() || !guestLastName.trim() || !guestEmail.trim() || !guestPhone.trim()) {
      setError("Please complete all guest details.");
      return;
    }
    if (!consent) {
      setError("Please confirm your guest gave permission to be booked.");
      return;
    }

    const body: BringAFriendBookPayload = {
      classId: cid,
      guestFirstName: guestFirstName.trim(),
      guestLastName: guestLastName.trim(),
      guestEmail: guestEmail.trim(),
      guestPhone: guestPhone.trim(),
      bookingConsentAccepted: true,
    };

    setBusy(true);
    try {
      const res = await apiJson<{ ok?: boolean; requiresInStudioWaiver?: boolean }>(
        "/api/mindbody/member/bring-a-friend",
        accessToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setGuestFirstName("");
      setGuestLastName("");
      setGuestEmail("");
      setGuestPhone("");
      setConsent(false);
      onSuccess(res.requiresInStudioWaiver === true);
    } catch (err) {
      const bodyPayload = err instanceof ApiError ? err.body : null;
      setError(bringAFriendErrorMessage(bodyPayload));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal card mb-guest-pass-dialog"
        role="dialog"
        aria-labelledby="baf-dialog-title"
        onClick={(ev) => ev.stopPropagation()}
      >
        <form className="mb-guest-pass-dialog__inner" onSubmit={(e) => void submit(e)}>
          <h2 id="baf-dialog-title" className="mb-guest-pass-dialog__title">
            Bring a Friend
          </h2>
          <p className="profile-section__hint">
            {lockClassSelection
              ? "Invite one guest to this class (one complimentary guest per month or per pack)."
              : "Book yourself into a class first, then invite one guest per month (or per pack)."}
          </p>

          {lockClassSelection ? (
            lockedClass ? (
              <div className="mb-guest-pass-field mb-guest-pass-class-summary">
                <span className="mb-guest-pass-field__label">Class</span>
                <p className="mb-guest-pass-class-summary__title">{lockedClass.name || "Class"}</p>
                <p className="mb-guest-pass-class-summary__meta">
                  {formatBringAFriendWhen(lockedClass.startDateTime)}
                  {lockedClass.spotsRemaining != null
                    ? ` · ${lockedClass.spotsRemaining} spots open`
                    : ""}
                </p>
              </div>
            ) : (
              <p className="error-banner mb-guest-pass-dialog__err">
                This class is no longer eligible for a guest invite (needs at least 2 open spots).
              </p>
            )
          ) : (
            <label className="mb-guest-pass-field">
              <span className="mb-guest-pass-field__label">Class</span>
              <select
                value={classId}
                required
                disabled={busy || classes.length === 0}
                onChange={(e) => setClassId(e.target.value)}
              >
                <option value="">
                  {classes.length === 0 ? "No eligible upcoming classes" : "Select a class…"}
                </option>
                {classes.map((c) => (
                  <option key={c.classId} value={String(c.classId)}>
                    {classLabelForGuestOption(c)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="mb-guest-pass-field">
            <span className="mb-guest-pass-field__label">Guest first name</span>
            <input
              type="text"
              value={guestFirstName}
              maxLength={80}
              required
              autoComplete="given-name"
              disabled={busy}
              onChange={(e) => setGuestFirstName(e.target.value)}
            />
          </label>

          <label className="mb-guest-pass-field">
            <span className="mb-guest-pass-field__label">Guest last name</span>
            <input
              type="text"
              value={guestLastName}
              maxLength={80}
              required
              autoComplete="family-name"
              disabled={busy}
              onChange={(e) => setGuestLastName(e.target.value)}
            />
          </label>

          <label className="mb-guest-pass-field">
            <span className="mb-guest-pass-field__label">Guest email</span>
            <input
              type="email"
              value={guestEmail}
              maxLength={254}
              required
              autoComplete="email"
              disabled={busy}
              onChange={(e) => setGuestEmail(e.target.value)}
            />
          </label>

          <label className="mb-guest-pass-field">
            <span className="mb-guest-pass-field__label">Guest phone</span>
            <input
              type="tel"
              value={guestPhone}
              maxLength={32}
              required
              autoComplete="tel"
              disabled={busy}
              onChange={(e) => setGuestPhone(e.target.value)}
            />
          </label>

          <label className="mb-guest-pass-consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{consentText}</span>
          </label>

          {error && <p className="error-banner mb-guest-pass-dialog__err">{error}</p>}

          <div className="mb-guest-pass-dialog__actions mb-book-dialog__actions">
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={onDismiss}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              disabled={busy || (lockClassSelection ? !lockedClass : classes.length === 0)}
            >
              {busy ? "Booking…" : "Book guest"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
