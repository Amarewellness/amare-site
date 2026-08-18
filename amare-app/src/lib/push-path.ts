import { safeAppReturnPath } from "../config";

export function pathFromNotificationData(data: Record<string, unknown> | undefined | null): string {
  const raw = data && typeof data.path === "string" ? data.path : "";
  return safeAppReturnPath(raw);
}

export function pathFromAppOpenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
    return safeAppReturnPath(path.startsWith("/") ? path : `/${path}`);
  } catch {
    const idx = url.indexOf("/my-classes");
    if (idx >= 0) return safeAppReturnPath(url.slice(idx));
    return "/";
  }
}
