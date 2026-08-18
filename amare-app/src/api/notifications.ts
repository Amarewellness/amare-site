import { apiJson } from "./client";

export type NotificationPreferences = {
  class_booking_updates: boolean;
  class_reminders: boolean;
  waitlist_updates: boolean;
  studio_news: boolean;
};

export type InstallationRecord = {
  installationId: string;
  platform: string;
  permissionState: string;
  hasToken: boolean;
  revokedAt: string | null;
};

export async function fetchNotificationPreferences(accessToken: string) {
  return apiJson<{ ok: true; preferences: NotificationPreferences }>(
    "/api/amare/notifications/preferences",
    accessToken,
  );
}

export async function updateNotificationPreferences(
  accessToken: string,
  patch: Partial<NotificationPreferences>,
) {
  return apiJson<{ ok: true; preferences: NotificationPreferences }>(
    "/api/amare/notifications/preferences",
    accessToken,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
}

export async function registerPushInstallation(
  accessToken: string,
  input: {
    installationId?: string;
    platform: "android" | "ios" | "web";
    pushToken?: string | null;
    permissionState: "unknown" | "prompt" | "granted" | "denied" | "revoked";
  },
) {
  return apiJson<{ ok: true; installation: InstallationRecord }>(
    "/api/amare/notifications/installation",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: input.installationId,
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        permissionState: input.permissionState,
      }),
    },
  );
}

export async function revokePushInstallation(accessToken: string, installationId: string) {
  return apiJson<{ ok: true; revoked: boolean }>(
    "/api/amare/notifications/installation",
    accessToken,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId }),
    },
  );
}
