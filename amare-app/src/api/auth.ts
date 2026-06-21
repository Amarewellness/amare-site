import { appOrigin, saveAuth, clearAuth, type AuthProfile } from "../config";

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  profile?: AuthProfile;
};

function apiBase() {
  return (import.meta.env.VITE_API_BASE || "http://127.0.0.1:4321").replace(/\/$/, "");
}

export async function exchangeOAuthCode(code: string, state: string): Promise<TokenPair> {
  const res = await fetch(`${apiBase()}/api/mindbody/oauth/mobile-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, state }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.error || `exchange_failed_${res.status}`);
  }
  saveAuth(data.accessToken, data.refreshToken);
  return data as TokenPair;
}

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const res = await fetch(`${apiBase()}/api/mindbody/oauth/mobile-refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "refresh_failed");
  saveAuth(data.accessToken, data.refreshToken);
  return data as TokenPair;
}

export async function revokeSession(accessToken: string | null) {
  if (accessToken) {
    try {
      await fetch(`${apiBase()}/api/mindbody/oauth/mobile-revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
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
  const appReturn = encodeURIComponent(appOrigin());
  const url =
    `${oauthApiBase()}/api/mindbody/oauth/start?platform=mobile` +
    `&app_return=${appReturn}`;
  window.location.href = url;
}
