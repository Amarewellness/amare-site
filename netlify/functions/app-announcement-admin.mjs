import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  formatEtDatetimeLocalInput,
  mapAnnouncementRow,
  parseAnnouncementSaveBody,
} from "./app-announcement-lib.mjs";
import {
  activateAnnouncement,
  deactivateAnnouncement,
  fetchAdminCurrentAnnouncement,
  fetchAdminReceiptRows,
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

async function handleCurrent() {
  try {
    const ann = await fetchAdminCurrentAnnouncement();
    if (!ann) {
      return adminJson(200, {
        ok: true,
        announcement: null,
        seenClients: 0,
        acknowledgedClients: 0,
        ackRate: null,
        receipts: [],
      });
    }
    const metrics = await fetchAnnouncementMetrics(ann.id);
    const receipts = await fetchAdminReceiptRows(ann.id);
    return adminJson(200, {
      ok: true,
      announcement: adminAnnouncementPayload(ann),
      seenClients: metrics.seenClients,
      acknowledgedClients: metrics.acknowledgedClients,
      ackRate: metrics.ackRate,
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
      }),
    );
    const metrics = saved ? await fetchAnnouncementMetrics(saved.id) : { seenClients: 0, acknowledgedClients: 0, ackRate: null };
    const receipts = saved ? await fetchAdminReceiptRows(saved.id) : [];
    return adminJson(200, {
      ok: true,
      announcement: adminAnnouncementPayload(saved),
      seenClients: metrics.seenClients,
      acknowledgedClients: metrics.acknowledgedClients,
      ackRate: metrics.ackRate,
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
    if (active) {
      await activateAnnouncement(id);
      console.log(JSON.stringify({ event: "announcement_admin_activated", ok: true, announcement_id: id }));
    } else {
      await deactivateAnnouncement(id);
      console.log(JSON.stringify({ event: "announcement_admin_deactivated", ok: true, announcement_id: id }));
    }
    return await handleCurrent();
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
    return await handleCurrent();
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
