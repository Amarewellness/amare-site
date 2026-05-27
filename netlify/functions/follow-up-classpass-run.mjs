/**
 * POST /api/admin/follow-ups/classpass/run
 * GET  /api/admin/follow-ups/classpass/run (use saved Client Visits report)
 */

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { VisitsReportFormatError } from "./new-client-sms-client-visits.mjs";
import { runClassPassReport } from "./follow-up-classpass-lib.mjs";
import { sendFollowUpDashboardReport } from "./follow-up-dashboard-report.mjs";
import {
  persistVisitsReportBlob,
  resolveVisitsReportContent,
  shouldPersistVisitsReportFromBody,
  visitsUploadFilenameFromBody,
} from "./follow-up-visits-report.mjs";

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

/** @param {import("@netlify/functions").HandlerEvent} event @param {Record<string, unknown>} body */
function buildResolveEvent(event, body) {
  const useSaved =
    body.useSavedReport === true &&
    typeof body.clientVisitsReport !== "string" &&
    typeof body.clientVisitsReportBase64 !== "string";
  return {
    ...event,
    body: JSON.stringify({
      useSavedReport: useSaved,
      ...(typeof body.clientVisitsReportBase64 === "string"
        ? {
            clientVisitsReportBase64: body.clientVisitsReportBase64,
            reportFilename: body.reportFilename || body.filename || null,
          }
        : {}),
      ...(typeof body.clientVisitsReport === "string"
        ? { clientVisitsReport: body.clientVisitsReport }
        : {}),
    }),
  };
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
  const resolved = await resolveVisitsReportContent(buildResolveEvent(event, body));

  if (!resolved?.buffer?.length) {
    return jsonResponse(
      400,
      {
        ok: false,
        error: "no_visits_report",
        hint: "Upload Mindbody Client Visits report (.xlsx or .xls) in the ClassPass tab first.",
      },
      adminCorsHeaders(),
    );
  }

  /** @type {Record<string, unknown> | null} */
  let visitsReportPersist = null;
  if (shouldPersistVisitsReportFromBody(event) || body.persistVisitsReport === true) {
    visitsReportPersist = await persistVisitsReportBlob(event, {
      buffer: resolved.buffer,
      format: resolved.format,
      filename: visitsUploadFilenameFromBody(event) || body.reportFilename || body.filename || null,
      source: resolved.source,
    });
    if (visitsReportPersist && !visitsReportPersist.ok) {
      return jsonResponse(
        400,
        {
          ok: false,
          error: visitsReportPersist.error || "visits_report_persist_failed",
          hint: visitsReportPersist.hint || null,
          visitsReportPersist,
        },
        adminCorsHeaders(),
      );
    }
  }

  const staffHeaders = await resolveStaffHeaders();
  if (!staffHeaders) {
    return jsonResponse(503, { ok: false, error: "mindbody_staff_unavailable" }, adminCorsHeaders());
  }

  try {
    const result = await runClassPassReport(event, staffHeaders, resolved.buffer);

    let adminEmail = { ok: false, skipped: true, reason: "not_requested" };
    if (body.sendTeamEmail === true) {
      adminEmail = await sendFollowUpDashboardReport({ classPass: result });
    }

    return jsonResponse(
      200,
      { ...result, visitsReportPersist, adminEmail },
      adminCorsHeaders(),
    );
  } catch (err) {
    if (err instanceof VisitsReportFormatError) {
      return jsonResponse(
        400,
        { ok: false, error: err.code, hint: err.hint },
        adminCorsHeaders(),
      );
    }
    throw err;
  }
}
