import { apiBase as configApiBase, applyTunnelHeaders, saveAuth, clearAuth } from "../config";

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionKind?: "amare";
};

function apiBase() {
  return configApiBase();
}

function tunnelFetch(url: string, init: RequestInit = {}) {
  const headers = applyTunnelHeaders(new Headers(init.headers), url);
  return fetch(url, { ...init, headers });
}

/** Rotate AMARÉ mobile access/refresh tokens (shared mobile-refresh endpoint). */
export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const res = await tunnelFetch(`${apiBase()}/api/mindbody/oauth/mobile-refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "refresh_failed");
  saveAuth(data.accessToken, data.refreshToken, "amare");
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
