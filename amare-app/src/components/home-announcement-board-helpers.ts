import type { ActiveAnnouncement } from "../api/announcement-api";

export function shouldRenderHomeBoard(board: ActiveAnnouncement | null | undefined): board is ActiveAnnouncement {
  return board != null && typeof board.id === "string" && board.id.length > 0;
}

export function boardCtaVisible(board: Pick<ActiveAnnouncement, "ctaUrl" | "ctaLabel">): boolean {
  return typeof board.ctaUrl === "string" && board.ctaUrl.trim().length > 0;
}

/** One seen POST per announcement id per component mount cycle. */
export function shouldPostBoardSeen(
  announcementId: string | undefined,
  postedForId: string | null,
): boolean {
  if (!announcementId) return false;
  return postedForId !== announcementId;
}
