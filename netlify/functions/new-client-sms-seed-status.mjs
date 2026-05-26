/**
 * GET /api/admin/new-client-sms/seed-report/status
 * Returns metadata for the saved Series Expirations seed report in Netlify Blobs.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { getSeedReportBlobStatus } from "./new-client-sms-seed-report.mjs";

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

  const status = await getSeedReportBlobStatus(event);
  return jsonResponse(200, { ok: true, ...status }, adminCorsHeaders());
}
