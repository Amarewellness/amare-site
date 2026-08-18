/**
 * Authenticated mobile notification APIs.
 * Ownership comes only from the current AMARÉ session. Device-supplied
 * amare_user_id / clientId / email are ignored.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveAmareUser } from "./amare-sess-lib.mjs";
import { openNotificationStore, sanitizePreferencePatch } from "./amare-notification-store.mjs";
import { CANDIDATE_KINDS } from "./amare-notification-store.mjs";
import { deliverNotificationCandidate, pushTestHttpAllowed } from "./amare-notification-send.mjs";
import { adminAuthorized } from "./new-client-sms-admin-auth.mjs";

const PLATFORMS = new Set(["android", "ios", "web"]);
const PERMISSIONS = new Set(["unknown", "prompt", "granted", "denied", "revoked"]);

function parseJsonBody(event) {
  const raw = event?.body;
  if (!raw) return {};
  const text = event.isBase64Encoded ? Buffer.from(String(raw), "base64").toString("utf8") : String(raw);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

function installationIdFrom(raw) {
  const id = String(raw || "").trim();
  if (!id || id.length > 80) return null;
  if (!/^[A-Za-z0-9:_-]+$/.test(id)) return null;
  return id;
}

async function requireAmareUser(event, deps) {
  const resolve = deps.resolveAmareUser || resolveAmareUser;
  const user = await resolve(event, { findUser: deps.findUser });
  if (!user.signedIn || !user.amareUserId) {
    return { error: jsonResponse(401, { ok: false, error: "signed_out" }) };
  }
  return { user };
}

export async function handleNotificationInstallation(event, deps = {}) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  const auth = await requireAmareUser(event, deps);
  if (auth.error) return auth.error;
  const store = deps.notificationStore || openNotificationStore();
  const body = parseJsonBody(event);
  if (body == null) return jsonResponse(400, { ok: false, error: "invalid_json" });

  if (method === "POST") {
    const platform = String(body.platform || "android").trim();
    if (!PLATFORMS.has(platform)) return jsonResponse(400, { ok: false, error: "invalid_platform" });
    const permissionState = String(body.permissionState || "unknown").trim();
    if (!PERMISSIONS.has(permissionState)) return jsonResponse(400, { ok: false, error: "invalid_permission_state" });
    const installationId = installationIdFrom(body.installationId) || undefined;
    const pushToken = typeof body.pushToken === "string" && body.pushToken.trim() ? body.pushToken.trim() : null;
    if (pushToken && pushToken.length > 4096) return jsonResponse(400, { ok: false, error: "invalid_push_token" });

    if (pushToken) {
      const existingToken = await store.findInstallationByToken(pushToken);
      if (existingToken && existingToken.installationId !== installationId) {
        await store.revokeInstallation(existingToken.installationId);
      }
    }

    const row = await store.upsertInstallation({
      installationId,
      amareUserId: auth.user.amareUserId,
      platform,
      pushToken,
      permissionState,
      revokedAt: null,
    });
    return jsonResponse(200, {
      ok: true,
      installation: {
        installationId: row.installationId,
        platform: row.platform,
        permissionState: row.permissionState,
        hasToken: Boolean(row.pushToken),
        revokedAt: row.revokedAt,
      },
    });
  }

  if (method === "DELETE") {
    const installationId = installationIdFrom(body.installationId);
    if (!installationId) return jsonResponse(400, { ok: false, error: "missing_installation_id" });
    const existing = await store.getInstallation(installationId);
    if (!existing) return jsonResponse(200, { ok: true, revoked: false });
    if (existing.amareUserId !== auth.user.amareUserId) {
      return jsonResponse(403, { ok: false, error: "installation_not_owned" });
    }
    await store.revokeInstallation(installationId);
    return jsonResponse(200, { ok: true, revoked: true, installationId });
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}

export async function handleNotificationPreferences(event, deps = {}) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  const auth = await requireAmareUser(event, deps);
  if (auth.error) return auth.error;
  const store = deps.notificationStore || openNotificationStore();

  if (method === "GET") {
    const prefs = await store.ensurePreferences(auth.user.amareUserId);
    return jsonResponse(200, { ok: true, preferences: prefs });
  }

  if (method === "PATCH" || method === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return jsonResponse(400, { ok: false, error: "invalid_json" });
    const extras = Object.keys(body).filter((k) => !["class_booking_updates", "class_reminders", "waitlist_updates", "studio_news"].includes(k));
    if (extras.length) return jsonResponse(400, { ok: false, error: "unknown_preference_keys", keys: extras });
    const patch = sanitizePreferencePatch(body);
    const prefs = await store.updatePreferences(auth.user.amareUserId, patch);
    return jsonResponse(200, { ok: true, preferences: prefs });
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}

export async function handleNotificationTestSend(event, deps = {}) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  if (!pushTestHttpAllowed() && !deps.forceTest) {
    return { statusCode: 404, headers: { "Cache-Control": "no-store" }, body: "not_found" };
  }
  if (!adminAuthorized(event) && !deps.adminAuthorized) {
    return jsonResponse(401, { ok: false, error: "admin_unauthorized" });
  }
  if (method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  const body = parseJsonBody(event);
  if (body == null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  const kind = String(body.kind || "").trim();
  if (!CANDIDATE_KINDS.includes(kind)) return jsonResponse(400, { ok: false, error: "invalid_kind" });
  const amareUserId = String(body.amareUserId || "").trim();
  if (!amareUserId.startsWith("usr_")) return jsonResponse(400, { ok: false, error: "invalid_amare_user_id" });
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const result = await deliverNotificationCandidate(
    {
      kind,
      amareUserId,
      classId: payload.classId ?? body.classId ?? null,
      suppressPush: false,
      payload,
    },
    { store: deps.notificationStore, send: deps.send, allowTest: true },
  );
  return jsonResponse(200, { ok: true, ...result });
}
