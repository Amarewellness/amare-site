import {
  mindbodyHeaders,
  mindbodyHost,
  netlifyCacheHeadersForUpstream,
  querySuffixFromEvent,
} from "./mindbody-upstream.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * CDN cache config for the pricing catalog (drop-ins, class packs, NCS).
 *
 * Studios edit pricing rarely (weeks/months), so a 1 h hot window + 24 h stale-while-revalidate
 * keeps Mindbody calls negligible while still picking up real changes within an hour. After a
 * deliberate price edit in Mindbody, the studio (or ops) can hit the admin purge endpoint
 * (PR-3) — there is no Mindbody webhook for pricing changes documented.
 *
 * Shared `mindbody-pricing` tag with `/api/mindbody/sale/contracts` so a single purge clears
 * both endpoints (drop-ins and recurring memberships).
 */
const PRICING_CACHE = { sMaxage: 3600, swr: 86400, tag: "mindbody-pricing" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      body: "Method Not Allowed",
    };
  }

  const headers = mindbodyHeaders();
  if (!headers) {
    return {
      statusCode: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
      body: JSON.stringify({
        ok: false,
        error: "MindbodyProxyNotConfigured",
        message: "Set MINDBODY_API_KEY (and MINDBODY_SITE_ID) in Netlify environment variables.",
      }),
    };
  }

  const path = `/public/v6/sale/services${querySuffixFromEvent(event)}`;
  const url = `https://${mindbodyHost()}${path}`;

  try {
    const res = await fetch(url, { method: "GET", headers });
    const body = await res.text();
    const ct = res.headers.get("content-type") || "application/json; charset=utf-8";
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": ct,
        ...cors,
        ...netlifyCacheHeadersForUpstream(res.status, PRICING_CACHE),
      },
      body,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
      body: JSON.stringify({
        ok: false,
        error: "MindbodyUpstreamError",
        message: String(e?.message ?? e),
      }),
    };
  }
};
