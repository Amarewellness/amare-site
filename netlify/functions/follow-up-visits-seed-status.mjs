/**
 * GET /api/admin/follow-ups/classpass/seed-report/status
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { getVisitsReportBlobStatus } from "./follow-up-visits-report.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", adminCorsHeaders());
  }

  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, adminCorsHeaders());
  }

  const status = await getVisitsReportBlobStatus(event);
  return jsonResponse(200, { ok: true, ...status }, adminCorsHeaders());
}
