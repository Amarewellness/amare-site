import { useState } from "react";
import { classId, classTitle, staffName } from "../../api/client";
import {
  classDetailsHtml,
  classDurationMinutes,
  classStartHasPassed,
  formatSlotTime,
  getClassBadges,
  shouldShowWaitlistClosed,
} from "../../lib/schedule-utils";
import { formatGuestBadgeLabel, type GuestBadge } from "../../lib/bring-a-friend";

type ScheduleRowBusyOp = "book" | "cancel" | "joinWaitlist" | "leaveWaitlist" | "removeGuest";

type Props = {
  cls: Record<string, unknown>;
  isoMs: number;
  isLoggedIn: boolean;
  isEnrolled: boolean;
  onWaitlist: boolean;
  showJoinWaitlist: boolean;
  busyOp: ScheduleRowBusyOp | null;
  guestBadge?: GuestBadge | null;
  showRemoveGuest?: boolean;
  removeGuestPreflightBusy?: boolean;
  onBook: () => void;
  onCancel: () => void;
  onRemoveGuest?: () => void;
  onJoinWaitlist: () => void;
  onLeaveWaitlist: () => void;
  onSignIn: () => void;
};

export function ClassSlotRow({
  cls,
  isoMs,
  isLoggedIn,
  isEnrolled,
  onWaitlist,
  showJoinWaitlist,
  busyOp,
  guestBadge,
  showRemoveGuest = false,
  removeGuestPreflightBusy = false,
  onBook,
  onCancel,
  onRemoveGuest,
  onJoinWaitlist,
  onLeaveWaitlist,
  onSignIn,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const elapsed = classStartHasPassed(isoMs);
  const canceled = cls.IsCanceled === true || cls.isCanceled === true;
  const waitlistClosed = shouldShowWaitlistClosed(cls);
  const detailsHtml = classDetailsHtml(cls);
  const duration = classDurationMinutes(cls);
  const metaParts = [staffName(cls)];
  if (duration != null) metaParts.push(`${duration} min`);

  const badgeState = { elapsed, isEnrolled, onWaitlist, showJoinWaitlist };
  const badges = getClassBadges(cls, badgeState);

  const rowBusy = busyOp != null;

  let primaryLabel = "Book";
  let primaryAction = () => {
    if (!isLoggedIn) onSignIn();
    else onBook();
  };
  let primaryDisabled = classId(cls) == null || elapsed || rowBusy;

  if (busyOp === "book") {
    primaryLabel = "Booking…";
    primaryDisabled = true;
  } else if (isEnrolled) {
    primaryLabel = "Booked";
    primaryDisabled = true;
  } else if (onWaitlist) {
    primaryLabel = busyOp === "leaveWaitlist" ? "Leaving…" : "Leave waitlist";
    primaryAction = onLeaveWaitlist;
    primaryDisabled = classId(cls) == null || elapsed || rowBusy;
  } else if (showJoinWaitlist) {
    primaryLabel = busyOp === "joinWaitlist" ? "Joining…" : "Join waitlist";
    primaryAction = isLoggedIn ? onJoinWaitlist : onSignIn;
    primaryDisabled = classId(cls) == null || elapsed || rowBusy;
  } else if (waitlistClosed) {
    primaryLabel = "Full";
    primaryDisabled = true;
  } else if (!isLoggedIn) {
    primaryLabel = "Sign in to book";
    primaryDisabled = elapsed || rowBusy;
  }

  return (
    <li
      className={`mb-schedule-slot${canceled ? " is-canceled" : ""}${isEnrolled ? " is-booked" : ""}${onWaitlist ? " is-waitlist" : ""}`}
    >
      <div className="mb-schedule-slot__timecol">
        <time dateTime={new Date(isoMs).toISOString()}>{formatSlotTime(isoMs)}</time>
      </div>
      <div className="mb-schedule-slot__body">
        <span className="mb-schedule-slot__title">
          {classTitle(cls)}
          {guestBadge ? (
            <span className="mb-schedule-guest-badge">{formatGuestBadgeLabel(guestBadge)}</span>
          ) : null}
        </span>
        <span className="mb-schedule-slot__meta">{metaParts.join(" · ")}</span>
        {detailsHtml && (
          <>
            <button
              type="button"
              className="mb-schedule-slot__details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((o) => !o)}
            >
              {detailsOpen ? "Hide details" : "Show details"}
            </button>
            {!detailsOpen ? null : (
              <div
                className="mb-schedule-slot__details"
                dangerouslySetInnerHTML={{ __html: detailsHtml }}
              />
            )}
          </>
        )}
      </div>
      <div className="mb-schedule-slot__actions">
        {badges.map((b) => (
          <span key={b.type} className={`mb-schedule-slot__badge mb-schedule-slot__badge--${b.type}`}>
            {b.label}
          </span>
        ))}
        <button
          type="button"
          className={`btn btn--cream mb-schedule-slot__book${isLoggedIn ? " mb-schedule-slot__book--api" : ""}${elapsed ? " mb-schedule-slot__book--elapsed" : ""}`}
          disabled={primaryDisabled}
          onClick={primaryAction}
        >
          {primaryLabel}
        </button>
        {isEnrolled && busyOp !== "book" && (
          <>
            {showRemoveGuest && onRemoveGuest && (
              <button
                type="button"
                className="btn btn--ghost mb-schedule-slot__remove-guest"
                disabled={elapsed || rowBusy || removeGuestPreflightBusy}
                onClick={onRemoveGuest}
              >
                {busyOp === "removeGuest"
                  ? "Removing…"
                  : removeGuestPreflightBusy
                    ? "Loading…"
                    : "Remove guest"}
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost mb-schedule-slot__cancel"
              disabled={elapsed || rowBusy}
              onClick={onCancel}
            >
              {busyOp === "cancel" ? "Canceling…" : "Cancel booking"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
