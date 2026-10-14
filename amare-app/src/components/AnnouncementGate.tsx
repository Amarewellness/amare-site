import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useMemberSummary } from "../hooks/useMemberSummary";
import {
  fetchActiveAnnouncement,
  postAnnouncementAcknowledge,
  postAnnouncementSeen,
  type ActiveAnnouncement,
} from "../api/announcement-api";
import { openExternalUrl } from "../lib/studio-contact";
import { AnnouncementDialog } from "./AnnouncementDialog";

const SESSION_PRESENTED_PREFIX = "amare_ann_presented:";

export function AnnouncementGate() {
  const { isLoggedIn, accessToken } = useAuth();
  const { initialReady } = useMemberSummary();
  const [announcement, setAnnouncement] = useState<ActiveAnnouncement | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const [ctaError, setCtaError] = useState<string | null>(null);
  const fetchStarted = useRef(false);
  const seenPosted = useRef(false);

  const clearAnnouncement = useCallback(() => {
    setAnnouncement(null);
    setCtaError(null);
    setCtaBusy(false);
  }, []);

  useEffect(() => {
    if (!isLoggedIn || !accessToken || !initialReady) return;
    if (fetchStarted.current) return;
    fetchStarted.current = true;

    const timer = window.setTimeout(() => {
      void (async () => {
        const active = await fetchActiveAnnouncement(accessToken, "popup");
        if (!active) return;
        const sessionKey = `${SESSION_PRESENTED_PREFIX}${active.id}`;
        if (sessionStorage.getItem(sessionKey) === "1") return;
        setAnnouncement(active);
      })();
    }, 320);

    return () => clearTimeout(timer);
  }, [isLoggedIn, accessToken, initialReady]);

  const handlePresented = useCallback(() => {
    if (!announcement || !accessToken || seenPosted.current) return;
    seenPosted.current = true;
    const id = announcement.id;
    const sessionKey = `${SESSION_PRESENTED_PREFIX}${id}`;
    sessionStorage.setItem(sessionKey, "1");
    void postAnnouncementSeen(accessToken, id).then((ok) => {
      if (!ok) {
        /* keep session guard to avoid modal spam; server may catch up later */
      }
    });
  }, [announcement, accessToken]);

  const handleDismiss = useCallback(() => {
    clearAnnouncement();
  }, [clearAnnouncement]);

  const handleCta = useCallback(async () => {
    if (!announcement || !accessToken) return;
    setCtaBusy(true);
    setCtaError(null);
    const ok = await postAnnouncementAcknowledge(accessToken, announcement.id);
    if (!ok) {
      setCtaError("Couldn’t save — check connection and try again.");
      setCtaBusy(false);
      return;
    }
    const url = announcement.ctaUrl?.trim();
    if (url) {
      try {
        await openExternalUrl(url);
      } catch {
        /* ack succeeded; opening browser is best-effort */
      }
    }
    clearAnnouncement();
  }, [announcement, accessToken, clearAnnouncement]);

  if (!announcement) return null;

  return (
    <AnnouncementDialog
      announcement={announcement}
      onDismiss={handleDismiss}
      onCta={() => void handleCta()}
      ctaBusy={ctaBusy}
      ctaError={ctaError}
      onPresented={handlePresented}
    />
  );
}
