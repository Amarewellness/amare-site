/**
 * Read-only admin API for membership purchase consent evidence (Netlify Blobs).
 *
 * GET /api/admin/membership-consents/list
 * GET /api/admin/membership-consents/detail?consentId=
 * GET /api/admin/membership-consents/pdf?consentId=
 * GET /api/admin/membership-consents/client-summary?mindbodyClientId=
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  buildClientConsentSummary,
  buildConsentDetail,
  buildConsentList,
  getConsentBlobRecord,
} from "./membership-consent-admin-lib.mjs";
import { generateMembershipConsentProofPdf } from "./membership-consent-admin-pdf.mjs";
import { tryOpenMembershipConsentBlobStore } from "./membership-consent-blobs.mjs";

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function adminResponse(status, body, headers = {}) {
  return jsonResponse(status, body, { ...adminCorsHeaders(), ...headers });
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function requestPath(event) {
  const fwd = event.headers["x-forwarded-uri"] || event.headers["X-Forwarded-Uri"];
  if (typeof fwd === "string" && fwd.includes("/api/admin/membership-consents")) {
    return fwd.split("?")[0].replace(/\/+$/, "");
  }
  const raw = event.rawUrl || event.path || "";
  const path = raw.includes("://") ? new URL(raw).pathname : String(raw).split("?")[0];
  return path.replace(/\/+$/, "");
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function queryParams(event) {
  const raw =
    event && typeof event === "object" && "queryStringParameters" in event
      ? /** @type {{ queryStringParameters?: Record<string, string | undefined> | null }} */ (event)
          .queryStringParameters
      : null;
  return raw && typeof raw === "object" ? raw : {};
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} action */
function logAdminAction(event, action, outcome, consentId) {
  console.log(
    JSON.stringify({
      event: "membership_consent_admin",
      action,
      outcome,
      consentId: consentId ? String(consentId).slice(0, 80) : undefined,
    }),
  );
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleList(event) {
  const q = queryParams(event);
  const body = await buildConsentList(event, q);
  logAdminAction(event, "list", "ok");
  return adminResponse(200, body);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleDetail(event) {
  const q = queryParams(event);
  const consentId = (q.consentId || q.consent_id || "").trim();
  const result = await buildConsentDetail(event, consentId);
  if (!result.ok) {
    logAdminAction(event, "detail", result.error || "error", consentId);
    const status = result.error === "consent_not_found" ? 404 : 400;
    return adminResponse(status, result);
  }
  logAdminAction(event, "detail", "ok", consentId);
  return adminResponse(200, result);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleClientSummary(event) {
  const q = queryParams(event);
  const raw = (q.mindbodyClientId || q.mindbody_client_id || "").trim();
  const cid = parseInt(raw, 10);
  const result = await buildClientConsentSummary(event, cid);
  if (!result.ok) {
    return adminResponse(400, result);
  }
  logAdminAction(event, "client_summary", "ok");
  return adminResponse(200, result);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handlePdf(event) {
  const q = queryParams(event);
  const consentId = (q.consentId || q.consent_id || "").trim();
  const detailResult = await buildConsentDetail(event, consentId);
  if (!detailResult.ok || !detailResult.detail) {
    logAdminAction(event, "pdf", detailResult.error || "error", consentId);
    const status = detailResult.error === "consent_not_found" ? 404 : 400;
    return adminResponse(status, detailResult);
  }

  const store = tryOpenMembershipConsentBlobStore(event);
  const rec = store ? await getConsentBlobRecord(store, consentId) : null;
  if (!rec || !detailResult.detail.snapshotPresent) {
    logAdminAction(event, "pdf", "missing_snapshot", consentId);
    return adminResponse(409, {
      ok: false,
      error: "missing_snapshot",
      message: "Cannot generate proof PDF without a stored historical terms snapshot.",
      hashVerification: detailResult.hashVerification,
    });
  }

  const pdf = await generateMembershipConsentProofPdf({
    detail: /** @type {Record<string, unknown>} */ (detailResult.detail),
    hashVerification: detailResult.hashVerification,
    consentRecord: rec,
  });

  logAdminAction(event, "pdf", "ok", consentId);
  return {
    statusCode: 200,
    headers: {
      ...adminCorsHeaders(),
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="amare-membership-consent-${consentId.slice(0, 32)}.pdf"`,
      "Cache-Control": "no-store",
    },
    body: pdf.toString("base64"),
    isBase64Encoded: true,
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function lambdaHandler(event) {
  const method = String(event.httpMethod || "").toUpperCase();
  if (method === "OPTIONS") {
    return adminResponse(204, { ok: true });
  }
  if (method !== "GET") {
    return adminResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!adminAuthorized(event)) {
    return adminResponse(401, {
      ok: false,
      error: "unauthorized",
      hint: "Set x-admin-token to ADMIN_DEBUG_TOKEN",
    });
  }

  const path = requestPath(event);
  try {
    if (path.endsWith("/client-summary")) return await handleClientSummary(event);
    if (path.endsWith("/detail")) return await handleDetail(event);
    if (path.endsWith("/pdf")) return await handlePdf(event);
    if (path.endsWith("/list") || path.endsWith("/membership-consents")) {
      return await handleList(event);
    }
    return adminResponse(404, { ok: false, error: "not_found" });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "membership_consent_admin_error",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return adminResponse(500, { ok: false, error: "internal_error" });
  }
}

export const handler = withLambda(lambdaHandler);
