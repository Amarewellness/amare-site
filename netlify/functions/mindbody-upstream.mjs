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

/**
 * Build Netlify Edge / durable cache headers for a Mindbody passthrough response.
 *
 * Catalog/schedule endpoints under `/api/mindbody/{class/classes,sale/services,sale/contracts,site/sites}`
 * are studio-wide and identical for every visitor (no cookie / consumer-token / per-user query), so
 * Netlify's shared CDN can hold the upstream JSON and serve it to subsequent visitors without
 * re-invoking the function — which is what keeps us under Mindbody's metered Public API quota.
 *
 * Hard rules baked in:
 *   1. Only 2xx responses are cached. 4xx/5xx get `Cache-Control: no-store` so a transient
 *      Mindbody outage (rate limiting, auth blip, etc.) cannot get pinned to the edge.
 *   2. Browser cache is `max-age=0, must-revalidate` — every browser still hits the edge so a
 *      tag purge propagates on the very next request. The cache lives on Netlify, not in laptops.
 *   3. The `durable` directive enables Netlify's per-region durable cache so an edge-cache miss
 *      doesn't always re-invoke the function — see https://docs.netlify.com/platform/caching .
 *
 * `tag` is registered via `Netlify-Cache-Tag` (Netlify-only — not leaked to clients) so the
 * webhook handler (PR-2) and the admin purge endpoint (PR-3) can purge cleanly with
 * `purgeCache({ tags: [...] })` from `@netlify/functions`.
 *
 * @param {number} status Upstream HTTP status (passed through to the client).
 * @param {{ sMaxage: number; swr: number; tag: string }} cfg
 * @returns {Record<string, string>}
 */
export function netlifyCacheHeadersForUpstream(status, cfg) {
  const ok = status >= 200 && status < 300;
  if (!ok) return { "Cache-Control": "no-store" };
  return {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${cfg.sMaxage}, stale-while-revalidate=${cfg.swr}`,
    "Netlify-Cache-Tag": cfg.tag,
  };
}
