import { Capacitor } from "@capacitor/core";
import { registerPushInstallation, revokePushInstallation } from "../api/notifications";
import { getOrCreateInstallationId } from "./installation-id";

export type OsPermission = "unknown" | "prompt" | "granted" | "denied";

export async function currentOsPermission(): Promise<OsPermission> {
  if (!Capacitor.isNativePlatform()) return "unknown";
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const status = await PushNotifications.checkPermissions();
    if (status.receive === "granted") return "granted";
    if (status.receive === "denied") return "denied";
    if (status.receive === "prompt" || status.receive === "prompt-with-rationale") return "prompt";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function requestOsPermission(): Promise<OsPermission> {
  if (!Capacitor.isNativePlatform()) return "unknown";
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const status = await PushNotifications.requestPermissions();
  if (status.receive === "granted") return "granted";
  if (status.receive === "denied") return "denied";
  return "prompt";
}

export async function registerNativePush(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  try {
    await PushNotifications.createChannel({
      id: "amare-class",
      name: "Class updates",
      description: "Bookings, waitlist, and class reminders",
      importance: 5,
      visibility: 1,
    });
  } catch {
    /* channel may already exist */
  }
  await PushNotifications.register();
}

export async function syncInstallation(
  accessToken: string,
  input: { pushToken?: string | null; permissionState: "unknown" | "prompt" | "granted" | "denied" | "revoked" },
) {
  const installationId = await getOrCreateInstallationId();
  const platform = Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web";
  const res = await registerPushInstallation(accessToken, {
    installationId,
    platform,
    pushToken: input.pushToken,
    permissionState: input.permissionState,
  });
  return res.installation;
}

export async function revokeCurrentInstallation(accessToken: string | null) {
  if (!accessToken) return;
  try {
    const installationId = await getOrCreateInstallationId();
    await revokePushInstallation(accessToken, installationId);
  } catch {
    /* logout continues even if revoke fails */
  }
}
