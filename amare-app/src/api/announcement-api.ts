import { apiJson } from "./client";

export type AnnouncementDisplayType = "popup" | "board";

export type ActiveAnnouncement = {
  id: string;
  title: string;
  message: string;
  displayType?: AnnouncementDisplayType;
  requireAcknowledgment: boolean;
  ctaLabel: string;
  ctaUrl: string | null;
};

export type ActiveAnnouncementResponse = {
  ok: boolean;
  announcement: ActiveAnnouncement | null;
};

export function activeAnnouncementPath(type: AnnouncementDisplayType = "popup"): string {
  const q = type === "popup" ? "type=popup" : `type=${encodeURIComponent(type)}`;
  return `/api/app/announcement/active?${q}`;
}

export async function fetchActiveAnnouncement(
  accessToken: string,
  type: AnnouncementDisplayType = "popup",
): Promise<ActiveAnnouncement | null> {
  try {
    const data = await apiJson<ActiveAnnouncementResponse>(
      activeAnnouncementPath(type),
      accessToken,
    );
    if (!data?.ok || !data.announcement) return null;
    return data.announcement;
  } catch {
    return null;
  }
}

export async function postAnnouncementSeen(
  accessToken: string,
  announcementId: string,
): Promise<boolean> {
  try {
    await apiJson<{ ok: boolean }>(
      `/api/app/announcement/${encodeURIComponent(announcementId)}/seen`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    return true;
  } catch {
    return false;
  }
}

export async function postAnnouncementAcknowledge(
  accessToken: string,
  announcementId: string,
): Promise<boolean> {
  try {
    await apiJson<{ ok: boolean }>(
      `/api/app/announcement/${encodeURIComponent(announcementId)}/acknowledge`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    return true;
  } catch {
    return false;
  }
}
