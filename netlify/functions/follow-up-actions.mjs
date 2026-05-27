/**
 * POST /api/admin/follow-ups/actions — mark contacted / snooze / hide
 * GET  /api/admin/follow-ups/actions?category=low_credits
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  followUpActionKey,
  openFollowUpActionsStore,
} from "./follow-up-actions-store.mjs";

const ALLOWED_CATEGORIES = new Set([
  "new_client",
  "low_credits",
  "frequent_non_members",
  "classpass_repeat",
  "lapsed_clients",
]);
const ALLOWED_ACTIONS = new Set(["contacted", "snoozed", "hidden"]);

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

  const store = openFollowUpActionsStore(event);

  if (method === "GET") {
    const category = (event.queryStringParameters?.category || "").trim();
    if (!ALLOWED_CATEGORIES.has(category)) {
      return jsonResponse(400, { ok: false, error: "invalid_category" }, adminCorsHeaders());
    }
    const actions = store.available ? await store.listByCategory(category) : [];
    return jsonResponse(200, { ok: true, category, actions, storeMode: store.mode }, adminCorsHeaders());
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const body = parseJsonBody(event);
  const category = String(body.category || "").trim();
  const mindbodyClientId = Number(body.mindbodyClientId);
  const action = String(body.action || "").trim();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  if (!ALLOWED_CATEGORIES.has(category) || !ALLOWED_ACTIONS.has(action)) {
    return jsonResponse(400, { ok: false, error: "invalid_request" }, adminCorsHeaders());
  }
  if (!Number.isFinite(mindbodyClientId) || mindbodyClientId <= 0) {
    return jsonResponse(400, { ok: false, error: "invalid_client_id" }, adminCorsHeaders());
  }

  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "actions_store_unavailable" }, adminCorsHeaders());
  }

  const snoozeDays = Math.max(1, Math.min(Number(body.snoozeDays) || 7, 90));
  const now = new Date();
  /** @type {string | null} */
  let expiresAt = null;
  if (action === "snoozed") {
    const exp = new Date(now);
    exp.setUTCDate(exp.getUTCDate() + snoozeDays);
    expiresAt = exp.toISOString();
  }

  const record = {
    category,
    mindbodyClientId: Math.trunc(mindbodyClientId),
    action,
    note,
    createdAt: now.toISOString(),
    createdBy: "admin_token",
    expiresAt,
    actionKey: followUpActionKey(Math.trunc(mindbodyClientId), action),
  };

  await store.put(record);

  return jsonResponse(200, { ok: true, record, storeMode: store.mode }, adminCorsHeaders());
}
