import { AppLauncher } from "@capacitor/app-launcher";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

export const STUDIO_ADDRESS = "501 N Dixie Hwy, Hallandale Beach, FL 33009";
export const STUDIO_ADDRESS_LINE = "501 N Dixie Hwy, Hallandale Beach";
export const PARKING_MAP_URL = "https://www.amarewellness.com/images/first-visit/parking.webp";
export const PARKING_MAP_ALT =
  "Aerial parking map for AMARÉ Wellness Studio at 501 N Dixie Hwy. Green marks free street parking and the free garage; red marks paid parking.";

function encodedStudioAddress(): string {
  return encodeURIComponent(STUDIO_ADDRESS);
}

function iosNativeMapsDirectionsUrl(): string {
  const dest = encodedStudioAddress();
  return `maps://?daddr=${dest}&dirflg=d`;
}

export function studioDirectionsUrl(platform = Capacitor.getPlatform()): string {
  const dest = encodedStudioAddress();
  if (platform === "ios") {
    return `https://maps.apple.com/?daddr=${dest}&dirflg=d`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

export async function openStudioDirections(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    window.open(studioDirectionsUrl(), "_blank", "noopener,noreferrer");
    return;
  }
  if (Capacitor.getPlatform() === "ios") {
    await AppLauncher.openUrl({ url: iosNativeMapsDirectionsUrl() });
    return;
  }
  await Browser.open({ url: studioDirectionsUrl() });
}
