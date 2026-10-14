import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  DISPLAY_TYPE_BOARD,
  DISPLAY_TYPE_POPUP,
  formatEtDatetimeLocalInput,
  mapAnnouncementRow,
  normalizeDisplayType,
  parseAnnouncementSaveBody,
} from "./app-announcement-lib.mjs";
import {
  activateAnnouncement,
  deactivateAnnouncement,
  fetchAdminActiveAnnouncement,
  fetchAdminAnnouncementForEditing,
  fetchAdminReceiptRows,
  fetchAnnouncementById,
  fetchAnnouncementMetrics,
  saveAnnouncement,
} from "./app-announcement-store.mjs";

/** @param {number} status @param {unknown} body */
function adminJson(status, body) {
  return jsonResponse(status, body, adminCorsHeaders());
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function requestPath(event) {
  const fwd = event.headers["x-forwarded-uri"] || event.headers["X-Forwarded-Uri"];
  if (typeof fwd === "string" && fwd.includes("/api/admin/app-announcement")) {
    return fwd.split("?")[0].replace(/\/+$/, "");
  }
  const raw = event.rawUrl || event.path || "";
  const path = raw.includes("://") ? new URL(raw).pathname : String(raw).split("?")[0];
  return path.replace(/\/+$/, "");
}

/** @param {ReturnType<typeof mapAnnouncementRow> | null} ann */
function adminAnnouncementPayload(ann) {
  if (!ann) return null;
  return {
    id: ann.id,
    title: ann.title,
    message: ann.message,
    displayType: ann.displayType,
    isActive: ann.isActive,
    startsAt: ann.startsAt,
    expiresAt: ann.expiresAt,
    startsAtEt: formatEtDatetimeLocalInput(ann.startsAt),
    expiresAtEt: formatEtDatetimeLocalInput(ann.expiresAt),
    requireAcknowledgment: ann.requireAcknowledgment,
    ctaLabel: ann.ctaLabel,
    ctaUrl: ann.ctaUrl,
    createdAt: ann.createdAt,
    updatedAt: ann.updatedAt,
  };
}

/** @param {ReturnType<typeof mapAnnouncementRow> | null} ann */
function adminActiveSummary(ann) {
  if (!ann) return null;
  return {
    id: ann.id,
    title: ann.title,
    isActive: ann.isActive,
    startsAt: ann.startsAt,
    expiresAt: ann.expiresAt,
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleCurrent(event) {
  const qs = event?.queryStringParameters || {};
  const editingType = normalizeDisplayType(qs.displayType ?? qs.display_type ?? qs.type ?? DISPLAY_TYPE_POPUP);

  try {
    const activePopup = await fetchAdminActiveAnnouncement(DISPLAY_TYPE_POPUP);
    const activeBoard = await fetchAdminActiveAnnouncement(DISPLAY_TYPE_BOARD);
    const ann = await fetchAdminAnnouncementForEditing(editingType);

    if (!ann) {
      return adminJson(200, {
        ok: true,
        displayType: editingType,
        activePopup: adminActiveSummary(activePopup),
        activeBoard: adminActiveSummary(activeBoard),
        announcement: null,
        seenClients: 0,
        acknowledgedClients: 0,
        ackRate: null,
        ackAnalyticsApplicable: editingType !== DISPLAY_TYPE_BOARD,
        receipts: [],
      });
    }

    const metrics = await fetchAnnouncementMetrics(ann.id);
    const receipts = await fetchAdminReceiptRows(ann.id);
    const isBoard = ann.displayType === DISPLAY_TYPE_BOARD;

    return adminJson(200, {
      ok: true,
      displayType: editingType,
      activePopup: adminActiveSummary(activePopup),
      activeBoard: adminActiveSummary(activeBoard),
      announcement: adminAnnouncementPayload(ann),
      seenClients: metrics.seenClients,
      acknowledgedClients: isBoard ? null : metrics.acknowledgedClients,
      ackRate: isBoard ? null : metrics.ackRate,
      ackAnalyticsApplicable: !isBoard,
      receipts,
    });
  } catch (err) {
    return adminJson(503, {
      ok: false,
      error: "admin_read_failed",
      message: String(err?.message || err).slice(0, 200),
    });
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleSave(event) {
  const body = parseJsonBody(event);
  const parsed = parseAnnouncementSaveBody(body);
  if (!parsed.ok) return adminJson(400, { ok: false, error: parsed.error });

  try {
    const saved = await saveAnnouncement(parsed.value);
    console.log(
      JSON.stringify({
        event: "announcement_admin_saved",
        ok: true,
        announcement_id: saved?.id ?? null,
        display_type: saved?.displayType ?? null,
      }),
    );
    const metrics = saved
      ? await fetchAnnouncementMetrics(saved.id)
      : { seenClients: 0, acknowledgedClients: 0, ackRate: null };
    const receipts = saved ? await fetchAdminReceiptRows(saved.id) : [];
    const isBoard = saved?.displayType === DISPLAY_TYPE_BOARD;
    const activePopup = await fetchAdminActiveAnnouncement(DISPLAY_TYPE_POPUP);
    const activeBoard = await fetchAdminActiveAnnouncement(DISPLAY_TYPE_BOARD);

    return adminJson(200, {
      ok: true,
      displayType: saved?.displayType ?? DISPLAY_TYPE_POPUP,
      activePopup: adminActiveSummary(activePopup),
      activeBoard: adminActiveSummary(activeBoard),
      announcement: adminAnnouncementPayload(saved),
      seenClients: metrics.seenClients,
      acknowledgedClients: isBoard ? null : metrics.acknowledgedClients,
      ackRate: isBoard ? null : metrics.ackRate,
      ackAnalyticsApplicable: !isBoard,
      receipts,
    });
  } catch (err) {
    return adminJson(503, { ok: false, error: "save_failed", message: String(err?.message || err).slice(0, 200) });
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleSetActive(event) {
  const body = parseJsonBody(event);
  if (!body || typeof body !== "object") return adminJson(400, { ok: false, error: "invalid_body" });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const active = body.active === true || body.isActive === true;
  if (!id) return adminJson(400, { ok: false, error: "id_required" });

  try {
    let editingType = normalizeDisplayType(
      event?.queryStringParameters?.displayType ?? event?.queryStringParameters?.display_type,
    );
    if (active) {
      const saved = await activateAnnouncement(id);
      if (saved?.displayType) editingType = saved.displayType;
      console.log(JSON.stringify({ event: "announcement_admin_activated", ok: true, announcement_id: id }));
    } else {
      await deactivateAnnouncement(id);
      const row = await fetchAnnouncementById(id);
      if (row?.display_type) editingType = normalizeDisplayType(row.display_type);
      console.log(JSON.stringify({ event: "announcement_admin_deactivated", ok: true, announcement_id: id }));
    }
    const syntheticEvent = {
      ...event,
      queryStringParameters: {
        ...(event.queryStringParameters || {}),
        displayType: editingType,
      },
    };
    return await handleCurrent(syntheticEvent);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg === "announcement_not_found") return adminJson(404, { ok: false, error: "not_found" });
    return adminJson(503, { ok: false, error: "set_active_failed", message: msg.slice(0, 200) });
  }
}

async function adminHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, "", adminCorsHeaders());
  }
  if (!adminAuthorized(event)) {
    return adminJson(403, { ok: false, error: "forbidden", hint: "Set x-admin-token to ADMIN_DEBUG_TOKEN" });
  }

  const path = requestPath(event);
  if (path === "/api/admin/app-announcement/current" && event.httpMethod === "GET") {
    return await handleCurrent(event);
  }
  if (path === "/api/admin/app-announcement/save" && event.httpMethod === "POST") {
    return await handleSave(event);
  }
  if (path === "/api/admin/app-announcement/set-active" && event.httpMethod === "POST") {
    return await handleSetActive(event);
  }

  return adminJson(404, { ok: false, error: "not_found" });
}

export default withLambda(adminHandler);
