import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";

export type MobileRequestTelemetry = {
  clientSource: "mobile";
  platform: "ios" | "android";
  appVersion: string;
  buildNumber: string;
  clientRequestId: string;
};

type CachedAppInfo = { appVersion: string; buildNumber: string };

let appInfoCache: CachedAppInfo | null = null;
let appInfoLoad: Promise<CachedAppInfo> | null = null;

async function loadNativeAppInfo(): Promise<CachedAppInfo> {
  if (appInfoCache) return appInfoCache;
  if (!appInfoLoad) {
    appInfoLoad = (async () => {
      try {
        const info = await App.getInfo();
        const appVersion = String(info.version || "").trim().slice(0, 32) || "unknown";
        const buildNumber = String(info.build ?? "").trim().slice(0, 16) || appVersion;
        appInfoCache = { appVersion, buildNumber };
      } catch {
        appInfoCache = { appVersion: "unknown", buildNumber: "unknown" };
      }
      return appInfoCache;
    })();
  }
  return appInfoLoad;
}

/** Warm Capacitor App.getInfo cache so book/cancel do not await native on every tap. */
export function warmMobileAppInfoCache(): void {
  if (Capacitor.isNativePlatform()) void loadNativeAppInfo();
}

function nativePlatform(): "ios" | "android" | null {
  if (!Capacitor.isNativePlatform()) return null;
  const p = Capacitor.getPlatform();
  if (p === "ios") return "ios";
  if (p === "android") return "android";
  return null;
}

/** One Book or Cancel user action — new ID every call. */
export function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Per user action (one Book or one Cancel tap). Call once per outbound book/cancel POST.
 */
export async function getMobileRequestTelemetry(): Promise<MobileRequestTelemetry | null> {
  const platform = nativePlatform();
  if (!platform) return null;
  const info = await loadNativeAppInfo();
  return {
    clientSource: "mobile",
    platform,
    appVersion: info.appVersion,
    buildNumber: info.buildNumber,
    clientRequestId: createClientRequestId(),
  };
}

/** Merge telemetry into a book/cancel JSON body on native only. */
export async function withMobileRequestTelemetry(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const telemetry = await getMobileRequestTelemetry();
  if (!telemetry) return payload;
  return { ...payload, ...telemetry };
}
