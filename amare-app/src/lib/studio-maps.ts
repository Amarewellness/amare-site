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

export function studioDirectionsUrl(platform = Capacitor.getPlatform()): string {
  const dest = encodedStudioAddress();
  if (platform === "ios") {
    return `https://maps.apple.com/?daddr=${dest}&dirflg=d`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

export async function openStudioDirections(): Promise<void> {
  const url = studioDirectionsUrl();
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Browser.open({ url });
}
