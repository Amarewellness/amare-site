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
 * CDN cache config for the schedule passthrough.
 *
 * PR-1 ships with a deliberately short TTL (15 min) because there is no purge mechanism yet —
 * a class added/cancelled in Mindbody Manager naturally appears/disappears within `s-maxage`.
 * The schedule TTL is bumped to 12 h in PR-2 once the Mindbody `classSchedule.*` / `class.updated`
 * webhook receiver is live and tag-purging the `mindbody-schedule` cache on every change.
 *
 * Booking remains unaffected: `/api/mindbody/class/book` and `/api/mindbody/class/cancel` call
 * Mindbody live on every request, so stale schedule UI cannot cause a wrong booking — Mindbody
 * is always the live authority. See `classes-schedule.js::classNoLongerAvailable` for the UX
 * guard that surfaces "class no longer available" with a `forceFresh: true` reload CTA.
 */
const SCHEDULE_CACHE = { sMaxage: 900, swr: 900, tag: "mindbody-schedule" };

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

  const path = `/public/v6/class/classes${querySuffixFromEvent(event)}`;
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
        ...netlifyCacheHeadersForUpstream(res.status, SCHEDULE_CACHE),
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
