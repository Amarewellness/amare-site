import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";

/**
 * Prefetch staff User Token into the hot function instance (in-memory cache).
 * Requires consumer session so anonymous clients cannot spam Mindbody Issue.
 */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  const hasIssueCreds = Boolean(staffUser && typeof staffPass === "string" && staffPass !== "");

  const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};

  if (!hasIssueCreds) {
    return jsonResponse(
      200,
      { ok: true, skipped: true, reason: "issues_only_with_staff_username_password" },
      hdr,
    );
  }

  const r = await getMindbodyStaffAccessTokenCached();
  if (!r.ok) {
    return jsonResponse(typeof r.status === "number" && r.status >= 400 ? r.status : 502, {
      ok: false,
      error: r.error,
      mindbody: r.mindbody,
    }, hdr);
  }

  return jsonResponse(200, { ok: true, fromCache: r.fromCache === true }, hdr);
}
