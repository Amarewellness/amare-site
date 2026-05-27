/**
 * Local dev only — reset guest-pass blob state for a member/period (e.g. failed_manual_review).
 * POST /api/dev/guest-pass/reset  { "memberClientId": 100002726, "periodKey": "2026-05" }
 */
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { guestPassBlobsEnabled, tryOpenGuestPassBlobStore } from "./guest-pass-blobs.mjs";
import { calendarMonthPeriodKey, resetGuestPassPeriodUsage } from "./guest-pass-lib.mjs";
import { loadGuestPassConfig } from "./guest-pass-catalog-lib.mjs";

export async function handler(event) {
  if ((process.env.NETLIFY || "").trim()) {
    return jsonResponse(404, { ok: false, error: "not_available" });
  }
  if ((process.env.GUEST_PASS_DEV_RESET || "").trim() !== "1") {
    return jsonResponse(403, { ok: false, error: "guest_pass_dev_reset_disabled" });
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!guestPassBlobsEnabled()) {
    return jsonResponse(503, { ok: false, error: "guest_pass_blobs_disabled" });
  }

  let body = {};
  if (event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse(400, { ok: false, error: "invalid_json" });
    }
  }

  const idRaw = body.memberClientId ?? body.clientId;
  const memberClientId =
    typeof idRaw === "number" ? idRaw : typeof idRaw === "string" ? parseInt(idRaw, 10) : NaN;
  if (!Number.isFinite(memberClientId) || memberClientId <= 0) {
    return jsonResponse(400, { ok: false, error: "invalid_member_client_id" });
  }

  const gp = loadGuestPassConfig();
  const periodKey =
    typeof body.periodKey === "string" && body.periodKey.trim()
      ? body.periodKey.trim()
      : calendarMonthPeriodKey(new Date(), gp.studioTimezone);

  const store = tryOpenGuestPassBlobStore(event);
  if (!store) {
    return jsonResponse(503, { ok: false, error: "guest_pass_blobs_unavailable" });
  }

  const result = await resetGuestPassPeriodUsage(store, memberClientId, periodKey);
  return jsonResponse(200, { ...result, memberClientId, periodKey });
}
