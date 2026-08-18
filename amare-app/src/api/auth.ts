import { apiBase as configApiBase, appOrigin, applyTunnelHeaders, saveAuth, clearAuth, saveSessionKind, type AuthProfile } from "../config";

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionKind?: "amare" | "mindbody";
  profile?: AuthProfile;
};

function apiBase() {
  return configApiBase();
}

function tunnelFetch(url: string, init: RequestInit = {}) {
  const headers = applyTunnelHeaders(new Headers(init.headers), url);
  return fetch(url, { ...init, headers });
}

export async function exchangeOAuthCode(code: string, state: string): Promise<TokenPair> {
  const res = await tunnelFetch(`${apiBase()}/api/mindbody/oauth/mobile-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, state }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.error || `exchange_failed_${res.status}`);
  }
  saveAuth(data.accessToken, data.refreshToken, "mindbody");
  saveSessionKind("mindbody");
  return data as TokenPair;
}

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const res = await tunnelFetch(`${apiBase()}/api/mindbody/oauth/mobile-refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "refresh_failed");
  saveAuth(
    data.accessToken,
    data.refreshToken,
    data.sessionKind === "amare" ? "amare" : data.sessionKind === "mindbody" ? "mindbody" : undefined,
  );
  return data as TokenPair;
}

export async function revokeSession(accessToken: string | null, refreshToken?: string | null) {
  if (accessToken || refreshToken) {
    try {
      await tunnelFetch(`${apiBase()}/api/mindbody/oauth/mobile-revoke`, {
        method: "POST",
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });
    } catch {
      /* ignore */
    }
  }
  clearAuth();
}

export function oauthApiBase(): string {
  const o = (import.meta.env.VITE_OAUTH_API_BASE || "").trim();
  if (o) return o.replace(/\/$/, "");
  return apiBase();
}

/** Redirect to Mindbody OAuth (mobile platform). Returns via /auth/callback. */
export function startMindbodyOAuth() {
  try {
    const here = window.location.pathname + window.location.search;
    if (here && !here.startsWith("/login") && !here.startsWith("/auth/")) {
      sessionStorage.setItem("amare_app_return", here);
    }
  } catch {
    /* ignore */
  }
  const appReturn = encodeURIComponent(appOrigin());
  const url =
    `${oauthApiBase()}/api/mindbody/oauth/start?platform=mobile` +
    `&app_return=${appReturn}`;
  window.location.href = url;
}
