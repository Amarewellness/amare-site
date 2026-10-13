import { apiJson } from "./client";

export type ActiveAnnouncement = {
  id: string;
  title: string;
  message: string;
  requireAcknowledgment: boolean;
  ctaLabel: string;
  ctaUrl: string | null;
};

export type ActiveAnnouncementResponse = {
  ok: boolean;
  announcement: ActiveAnnouncement | null;
};

export async function fetchActiveAnnouncement(
  accessToken: string,
): Promise<ActiveAnnouncement | null> {
  try {
    const data = await apiJson<ActiveAnnouncementResponse>(
      "/api/app/announcement/active",
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
