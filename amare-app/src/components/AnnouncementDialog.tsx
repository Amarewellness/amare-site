import { useEffect, useId, useRef } from "react";
import type { ActiveAnnouncement } from "../api/announcement-api";

export function announcementBackdropDismissible(requireAcknowledgment: boolean): boolean {
  return !requireAcknowledgment;
}

type Props = {
  announcement: ActiveAnnouncement;
  onDismiss: () => void;
  onCta: () => void;
  ctaBusy: boolean;
  ctaError: string | null;
  onPresented: () => void;
};

export function AnnouncementDialog({
  announcement,
  onDismiss,
  onCta,
  ctaBusy,
  ctaError,
  onPresented,
}: Props) {
  const titleId = useId();
  const descId = useId();
  const presentedRef = useRef(false);
  const dismissible = announcementBackdropDismissible(announcement.requireAcknowledgment);

  useEffect(() => {
    if (presentedRef.current) return;
    presentedRef.current = true;
    const id = requestAnimationFrame(() => onPresented());
    return () => cancelAnimationFrame(id);
  }, [onPresented, announcement.id]);

  function handleBackdropClick() {
    if (!dismissible || ctaBusy) return;
    onDismiss();
  }

  function handleDialogClick(ev: React.MouseEvent) {
    ev.stopPropagation();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        className="modal card mb-book-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={handleDialogClick}
      >
        <h2 id={titleId} className="mb-book-dialog__title">
          {announcement.title}
        </h2>
        <div className="mb-book-dialog__body">
          <p
            id={descId}
            className="mb-book-dialog__hint"
            style={{ whiteSpace: "pre-wrap", maxHeight: "min(50vh, 320px)", overflowY: "auto" }}
          >
            {announcement.message}
          </p>
          {ctaError ? (
            <p className="error-banner" style={{ marginTop: "0.75rem" }} role="alert">
              {ctaError}
            </p>
          ) : null}
        </div>
        <div className="mb-book-dialog__actions mb-book-dialog__actions--stack">
          <button
            type="button"
            className="btn btn--cream"
            disabled={ctaBusy}
            onClick={() => void onCta()}
          >
            {ctaBusy ? "Please wait…" : announcement.ctaLabel || "Got it"}
          </button>
          {dismissible ? (
            <button type="button" className="btn btn--ghost" disabled={ctaBusy} onClick={onDismiss}>
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
