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
  const envSite = process.env.MINDBODY_SITE_ID?.trim();
  // Prefer configured studio SiteId — JWT-derived site can omit or disagree; membership-style heuristics must not override production env.
  const siteId =
    envSite && envSite !== "-99" ? envSite : tokenSite ?? base.SiteId;
  return {
    ...base,
    SiteId: siteId,
    "consumer-identity-token": at,
  };
}

/**
 * Staff / elevated User Token for endpoints that refuse consumer-only JWT (e.g. `POST …/sale/checkoutshoppingcart`).
 * Prefer `MINDBODY_STAFF_USERNAME` + `MINDBODY_STAFF_PASSWORD` + `POST …/usertoken/issue` (see `issueMindbodyStaffUserToken` in consumer-lib) so tokens are not fixed in env.
 * Legacy: `MINDBODY_STAFF_USER_TOKEN` (static Bearer) — expires without refresh.
 * Do not expose tokens or staff passwords to the browser.
 */
export function mindbodyStaffApiHeaders() {
  const base = mindbodyHeaders();
  const staff = process.env.MINDBODY_STAFF_USER_TOKEN?.trim();
  if (!base || !staff) return null;
  return {
    ...base,
    Authorization: `Bearer ${staff}`,
  };
}

/** @param {string | undefined | null} accessToken From `POST …/usertoken/issue` → `AccessToken`. */
export function mindbodyStaffBearerHeaders(accessToken) {
  const base = mindbodyHeaders();
  const t = accessToken?.trim();
  if (!base || !t) return null;
  return {
    ...base,
    Authorization: `Bearer ${t}`,
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
