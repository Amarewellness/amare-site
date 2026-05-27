/**
 * POST /api/admin/follow-ups/run — run New Client + Low Credits reports (optional team email).
 */

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { runNewClientSmsScan } from "./new-client-sms-scan.mjs";
import { resolveSeedReportContent } from "./new-client-sms-seed-report.mjs";
import { runLowCreditsReport } from "./follow-up-low-credits-lib.mjs";
import { runClassPassReport } from "./follow-up-classpass-lib.mjs";
import { resolveVisitsReportContent } from "./follow-up-visits-report.mjs";
import { VisitsReportFormatError } from "./new-client-sms-client-visits.mjs";
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
  const categories = Array.isArray(body.categories)
    ? body.categories.map((c) => String(c))
    : ["new_client", "low_credits"];
  const runNewClient = categories.includes("new_client");
  const runLowCredits = categories.includes("low_credits");
  const runClassPass = categories.includes("classpass_repeat") || categories.includes("classpass");
  const sendTeamEmail = body.sendTeamEmail === true;

  /** @type {Record<string, unknown> | null} */
  let newClientResult = null;
  /** @type {Record<string, unknown> | null} */
  let lowCreditsResult = null;
  /** @type {Record<string, unknown> | null} */
  let classPassResult = null;

  if (runNewClient) {
    const scan = await runNewClientSmsScan(event, {
      manual: true,
      skipAdminEmail: sendTeamEmail,
    });
    if (scan.statusCode >= 400) {
      return jsonResponse(scan.statusCode, scan.body, adminCorsHeaders());
    }
    newClientResult = /** @type {Record<string, unknown>} */ (scan.body);
  }

  if (runLowCredits) {
    const useSaved = body.useSavedReport !== false && !body.seriesExpirationReport;
    const resolveEvent = {
      ...event,
      body: JSON.stringify({
        useSavedReport: useSaved,
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
          hint: "Upload Series Expirations report before running Low Credits.",
          newClient: newClientResult,
        },
        adminCorsHeaders(),
      );
    }
    const staffHeaders = await resolveStaffHeaders();
    if (!staffHeaders) {
      return jsonResponse(503, { ok: false, error: "mindbody_staff_unavailable" }, adminCorsHeaders());
    }
    lowCreditsResult = /** @type {Record<string, unknown>} */ (
      await runLowCreditsReport(event, staffHeaders, resolved.text)
    );
  }

  if (runClassPass) {
    const resolveEvent = {
      ...event,
      body: JSON.stringify({
        useSavedReport: body.useSavedReport !== false && !body.clientVisitsReport && !body.clientVisitsReportBase64,
        ...(typeof body.clientVisitsReportBase64 === "string"
          ? { clientVisitsReportBase64: body.clientVisitsReportBase64 }
          : {}),
        ...(typeof body.clientVisitsReport === "string"
          ? { clientVisitsReport: body.clientVisitsReport }
          : {}),
      }),
    };
    const resolvedVisits = await resolveVisitsReportContent(resolveEvent);
    if (!resolvedVisits?.buffer?.length) {
      classPassResult = {
        ok: false,
        skipped: true,
        error: "no_visits_report",
        candidates: 0,
        hint: "Upload Client Visits report in the ClassPass tab to include this category.",
      };
    } else {
      const staffHeaders = await resolveStaffHeaders();
      if (!staffHeaders) {
        return jsonResponse(503, { ok: false, error: "mindbody_staff_unavailable" }, adminCorsHeaders());
      }
      try {
        classPassResult = /** @type {Record<string, unknown>} */ (
          await runClassPassReport(event, staffHeaders, resolvedVisits.buffer)
        );
      } catch (err) {
        if (err instanceof VisitsReportFormatError) {
          classPassResult = {
            ok: false,
            skipped: true,
            error: err.code,
            hint: err.hint,
            candidates: 0,
          };
        } else {
          throw err;
        }
      }
    }
  }

  let adminEmail = { ok: false, skipped: true, reason: "not_requested" };
  if (sendTeamEmail) {
    adminEmail = await sendFollowUpDashboardReport({
      newClient: newClientResult,
      lowCredits: lowCreditsResult,
      classPass: classPassResult,
    });
  }

  const ncCount = Number(newClientResult?.candidates ?? 0);
  const lcCount = Number(lowCreditsResult?.candidates ?? 0);
  const cpCount = Number(classPassResult?.candidates ?? 0);

  return jsonResponse(
    200,
    {
      ok: true,
      dryRun: true,
      reportOnly: true,
      totalCandidates: ncCount + lcCount + cpCount,
      newClient: newClientResult,
      lowCredits: lowCreditsResult,
      classPass: classPassResult,
      adminEmail,
    },
    adminCorsHeaders(),
  );
}
