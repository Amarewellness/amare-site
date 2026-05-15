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
 * Shares the `mindbody-pricing` cache tag with `/api/mindbody/sale/services` so one tag purge
 * invalidates both halves of the pricing catalog (drop-in services and recurring memberships).
 * Same TTL/SWR; see `mindbody-sale-services.mjs` for the rationale.
 */
const PRICING_CACHE = { sMaxage: 3600, swr: 86400, tag: "mindbody-pricing" };

/** GET → Mindbody `/public/v6/sale/contracts` (recurring / autopay — not included in `/sale/services`). */
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...cors },
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

  const path = `/public/v6/sale/contracts${querySuffixFromEvent(event)}`;
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
