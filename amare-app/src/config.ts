export type { AuthProfile, SessionKind, StoredSession } from "./session-store";
export {
  clearAuth,
  currentProfileTxToken,
  hydrateAuth,
  loadStoredAuth,
  loadStoredProfile,
  peekSessionKind,
  saveAuth,
  saveProfile,
  saveProfileTxToken,
  saveSessionKind,
} from "./session-store";

export function apiBase(): string {
  return (import.meta.env.VITE_API_BASE || "http://127.0.0.1:4321").replace(/\/$/, "");
}

/** ngrok-free interstitial: same header the website already sends. No-op on production hosts. */
export function applyTunnelHeaders(headers: Headers, url: string): Headers {
  try {
    if (new URL(url).hostname.includes("ngrok")) {
      headers.set("ngrok-skip-browser-warning", "true");
    }
  } catch {
    /* ignore */
  }
  return headers;
}

/** HTTPS origin for OAuth start (ngrok → backend). Falls back to apiBase. */
export function oauthApiBase(): string {
  const o = (import.meta.env.VITE_OAUTH_API_BASE || "").trim();
  if (o) return o.replace(/\/$/, "");
  return apiBase();
}

export function pricingUrl(): string {
  return (import.meta.env.VITE_PRICING_URL || `${apiBase()}/pricing`).trim();
}

export function sitePageUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase()}${p}`;
}

export function appOrigin(): string {
  return window.location.origin;
}

export function safeAppReturnPath(raw: string | null | undefined): string {
  const value = String(raw || "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  const [pathPart, queryPart] = value.split("?");
  const path = pathPart || "/";
  if (!/^\/[\w\-./]*$/.test(path)) return "/";
  if (path === "/login" || path.startsWith("/login/")) return "/";
  if (path === "/auth/callback" || path.startsWith("/auth/")) return "/";
  if (path === "/my-classes" && queryPart) {
    const q = new URLSearchParams(queryPart);
    const section = q.get("section");
    const classId = q.get("classId");
    if (section === "upcoming" || section === "waitlist" || section === "past") {
      const id = classId && /^\d{1,12}$/.test(classId) ? `&classId=${classId}` : "";
      return `/my-classes?section=${section}${id}`;
    }
  }
  return path;
}
