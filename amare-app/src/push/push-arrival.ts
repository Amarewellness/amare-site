import { Capacitor } from "@capacitor/core";
import { pathFromAppOpenUrl } from "../lib/push-path";
import { peekPendingPushDestination, setPendingPushDestination } from "./pending-destination";

let started = false;

export function rememberNotificationAction(data: Record<string, unknown> | undefined | null): string {
  const raw = data && typeof data.path === "string" ? data.path : "";
  if (!raw) return peekPendingPushDestination() ?? "/";
  return setPendingPushDestination(raw);
}

export function rememberAppOpenUrl(url: string): string {
  const path = pathFromAppOpenUrl(url);
  if (path === "/") return peekPendingPushDestination() ?? "/";
  return setPendingPushDestination(path);
}

export function bootstrapPushArrival(): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined" || !Capacitor.isNativePlatform()) return;
  void attachArrivalListeners();
}

async function attachArrivalListeners() {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const { App } = await import("@capacitor/app");
  await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
    rememberNotificationAction(event.notification.data as Record<string, unknown>);
  });
  await App.addListener("appUrlOpen", (event) => {
    rememberAppOpenUrl(event.url);
  });
  const launch = await App.getLaunchUrl();
  if (launch?.url) rememberAppOpenUrl(launch.url);
}
