/**
 * POST /api/admin/follow-ups/send-report — send combined team email from cached run results.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { sendFollowUpDashboardReport } from "./follow-up-dashboard-report.mjs";

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
  const method = (event.httpMethod || "POST").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    });
  }

  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, adminCorsHeaders());
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const body = parseJsonBody(event);
  const adminEmail = await sendFollowUpDashboardReport({
    newClient: body.newClient && typeof body.newClient === "object" ? body.newClient : null,
    lowCredits: body.lowCredits && typeof body.lowCredits === "object" ? body.lowCredits : null,
    classPass: body.classPass && typeof body.classPass === "object" ? body.classPass : null,
  });

  return jsonResponse(200, { ok: adminEmail.ok, adminEmail }, adminCorsHeaders());
}
