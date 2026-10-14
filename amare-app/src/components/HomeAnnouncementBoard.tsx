import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchActiveAnnouncement,
  postAnnouncementSeen,
  type ActiveAnnouncement,
} from "../api/announcement-api";
import { openExternalUrl } from "../lib/studio-contact";
import {
  boardCtaVisible,
  shouldPostBoardSeen,
  shouldRenderHomeBoard,
} from "./home-announcement-board-helpers";

type Props = {
  accessToken: string;
};

export function HomeAnnouncementBoardView({
  board,
  ctaBusy,
  onCta,
}: {
  board: ActiveAnnouncement;
  ctaBusy?: boolean;
  onCta?: () => void;
}) {
  const showCta = boardCtaVisible(board);
  return (
    <section className="card home-announce-board" aria-labelledby="home-announce-board-title">
      <p className="home-announce-board__eyebrow">Announcement board</p>
      <h2 id="home-announce-board-title" className="home-announce-board__title">
        {board.title}
      </h2>
      <p className="home-announce-board__message">{board.message}</p>
      {showCta ? (
        <button
          type="button"
          className="btn btn--ghost home-announce-board__cta"
          disabled={ctaBusy}
          onClick={() => onCta?.()}
        >
          {board.ctaLabel?.trim() || "Learn more"}
        </button>
      ) : null}
    </section>
  );
}

export function HomeAnnouncementBoard({ accessToken }: Props) {
  const [board, setBoard] = useState<ActiveAnnouncement | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const seenPostedForId = useRef<string | null>(null);

  const loadBoard = useCallback(async () => {
    const active = await fetchActiveAnnouncement(accessToken, "board");
    setBoard(active);
  }, [accessToken]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    let remove: (() => void) | undefined;
    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) void loadBoard();
        });
        remove = () => {
          void handle.remove();
        };
      } catch {
        /* web dev */
      }
    })();
    return () => remove?.();
  }, [loadBoard]);

  useEffect(() => {
    if (!shouldRenderHomeBoard(board)) return;
    if (!shouldPostBoardSeen(board.id, seenPostedForId.current)) return;
    seenPostedForId.current = board.id;
    void postAnnouncementSeen(accessToken, board.id);
  }, [board, accessToken]);

  if (!shouldRenderHomeBoard(board)) return null;

  const handleCta = async () => {
    if (!board.ctaUrl || ctaBusy) return;
    setCtaBusy(true);
    try {
      await openExternalUrl(board.ctaUrl);
    } finally {
      setCtaBusy(false);
    }
  };

  return <HomeAnnouncementBoardView board={board} ctaBusy={ctaBusy} onCta={() => void handleCta()} />;
}
