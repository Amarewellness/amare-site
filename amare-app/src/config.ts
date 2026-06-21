const STORAGE_ACCESS = "amare_access_token";
const STORAGE_REFRESH = "amare_refresh_token";
const STORAGE_PROFILE = "amare_profile";

export type AuthProfile = {
  email: string | null;
  name: string | null;
  clientId: number | null;
  bookingAllowed: boolean | null;
  linkStatus: string | null;
};

export type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  profile: AuthProfile | null;
};

export function loadStoredAuth(): AuthState {
  return {
    accessToken: localStorage.getItem(STORAGE_ACCESS),
    refreshToken: localStorage.getItem(STORAGE_REFRESH),
    profile: loadStoredProfile(),
  };
}

export function loadStoredProfile(): AuthProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILE);
    if (!raw) return null;
    const p = JSON.parse(raw) as AuthProfile;
    if (!p || typeof p !== "object") return null;
    return p;
  } catch {
    return null;
  }
}

export function saveProfile(profile: AuthProfile) {
  localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
}

export function saveAuth(accessToken: string, refreshToken: string) {
  localStorage.setItem(STORAGE_ACCESS, accessToken);
  localStorage.setItem(STORAGE_REFRESH, refreshToken);
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_ACCESS);
  localStorage.removeItem(STORAGE_REFRESH);
  localStorage.removeItem(STORAGE_PROFILE);
}

export function apiBase(): string {
  return (import.meta.env.VITE_API_BASE || "http://127.0.0.1:4321").replace(/\/$/, "");
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

export function appOrigin(): string {
  return window.location.origin;
}
