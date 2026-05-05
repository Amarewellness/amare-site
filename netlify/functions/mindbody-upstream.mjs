import { decodeJwtPayload, pickMindbodyTokenSiteId } from "./oauth-lib.mjs";

/**
 * Shared env + headers for Mindbody Public API forwards (Netlify Functions).
 */
export function mindbodyHeaders() {
  const key = process.env.MINDBODY_API_KEY?.trim();
  if (!key) return null;
  return {
    "API-Key": key,
    SiteId: process.env.MINDBODY_SITE_ID?.trim() || "-99",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/** Public API: `API-Key` + `SiteId` + Partner OAuth access token. Mindbody expects the consumer JWT in `consumer-identity-token` (not `Authorization: Bearer`). */
export function mindbodyConsumerHeaders(accessToken) {
  const base = mindbodyHeaders();
  const at = accessToken?.trim();
  if (!base || !at) return null;
  const tokenSite = pickMindbodyTokenSiteId(decodeJwtPayload(at));
  return {
    ...base,
    SiteId: tokenSite ?? base.SiteId,
    "consumer-identity-token": at,
  };
}

export function mindbodyHost() {
  const h = process.env.MINDBODY_API_HOST?.trim() || "api.mindbodyonline.com";
  if (!/^[\w.-]+$/.test(h)) return "api.mindbodyonline.com";
  return h;
}

/** @param {{ rawQuery?: string; queryStringParameters?: Record<string, string> | null }} event */
export function querySuffixFromEvent(event) {
  const raw = event.rawQuery?.trim();
  if (raw) return raw.startsWith("?") ? raw : `?${raw}`;
  const q = event.queryStringParameters;
  if (!q || Object.keys(q).length === 0) return "";
  const sp = new URLSearchParams();
  for (const [k, val] of Object.entries(q)) {
    if (val != null && val !== "") sp.set(k, String(val));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
