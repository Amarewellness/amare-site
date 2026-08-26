import { Capacitor } from "@capacitor/core";

let hideRequested = false;

/** Dismiss the native launch splash once the in-app shell can paint. Safe to call multiple times. */
export async function hideNativeSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform() || hideRequested) return;
  hideRequested = true;
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 220 });
  } catch {
    /* Web preview or plugin unavailable — in-app loader still covers bootstrap. */
  }
}
