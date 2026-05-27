/**
 * POST /api/admin/follow-ups/low-credits/run
 * GET  /api/admin/follow-ups/low-credits/run (use saved Series Expirations report)
 */

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { resolveSeedReportContent } from "./new-client-sms-seed-report.mjs";
import { runLowCreditsReport } from "./follow-up-low-credits-lib.mjs";
import { sendFollowUpDashboardReport } from "./follow-up-dashboard-report.mjs";

/** @returns {Promise<Record<string, string> | null>} */
async function resolveStaffHeaders() {
  const issued = await getMindbodyStaffAccessTokenCached();
  if (issued.ok) return mindbodyStaffBearerHeaders(issued.accessToken);
  return mindbodyStaffApiHeaders();
}

/** @param {unknown} event */
function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: string | null; isBase64Encoded?: boolean }} */ (event);
  if (!e.body) return {};
  const raw = e.isBase64Encoded ? Buffer.from(e.body, "base64").toString("utf8") : e.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    });
  }

  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, adminCorsHeaders());
  }

  if (method !== "POST" && method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const body = method === "POST" ? parseJsonBody(event) : { useSavedReport: true };
  const useSaved = body.useSavedReport === true || method === "GET";

  const resolveEvent = {
    ...event,
    body: JSON.stringify({
      useSavedReport: useSaved && !body.seriesExpirationReport,
      ...(typeof body.seriesExpirationReport === "string"
        ? { seriesExpirationReport: body.seriesExpirationReport }
        : {}),
    }),
  };
  const resolved = await resolveSeedReportContent(resolveEvent);

  if (!resolved?.text) {
    return jsonResponse(
      400,
      {
        ok: false,
        error: "no_seed_report",
        hint: "Upload Series Expirations at /admin/follow-ups or /admin/new-client-followup first.",
      },
      adminCorsHeaders(),
    );
  }

  const staffHeaders = await resolveStaffHeaders();
  if (!staffHeaders) {
    return jsonResponse(503, { ok: false, error: "mindbody_staff_unavailable" }, adminCorsHeaders());
  }

  const result = await runLowCreditsReport(event, staffHeaders, resolved.text);

  let adminEmail = { ok: false, skipped: true, reason: "not_requested" };
  if (body.sendTeamEmail === true) {
    adminEmail = await sendFollowUpDashboardReport({ newClient: null, lowCredits: result });
  }

  return jsonResponse(200, { ...result, adminEmail }, adminCorsHeaders());
}
