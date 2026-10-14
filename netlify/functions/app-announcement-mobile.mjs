import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveAmareUser } from "./amare-sess-lib.mjs";
import { mobileBearerAuthEnabled } from "./mobile-auth-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import {
  DISPLAY_TYPE_BOARD,
  DISPLAY_TYPE_POPUP,
  isAnnouncementInActiveWindow,
  mapAnnouncementRow,
  normalizeDisplayType,
  publicMobileAnnouncement,
  shouldShowAnnouncementToUser,
  shouldShowBoardAnnouncementToUser,
} from "./app-announcement-lib.mjs";
import {
  fetchAnnouncementById,
  fetchReceipt,
  getActiveAnnouncementForUser,
  recordAcknowledgment,
  recordSeen,
} from "./app-announcement-store.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
function requestPath(event) {
  const fwd = event.headers["x-forwarded-uri"] || event.headers["X-Forwarded-Uri"];
  if (typeof fwd === "string" && fwd.startsWith("/api/app/announcement")) {
    return fwd.split("?")[0].replace(/\/+$/, "") || "/api/app/announcement/active";
  }
  const raw = event.rawUrl || event.path || "";
  const path = raw.includes("://") ? new URL(raw).pathname : String(raw).split("?")[0];
  return path.replace(/\/+$/, "") || "/api/app/announcement/active";
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseActiveDisplayType(event) {
  const qs = event.queryStringParameters || {};
  return normalizeDisplayType(qs.type ?? qs.displayType ?? qs.display_type ?? DISPLAY_TYPE_POPUP);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function resolveMobileUser(event) {
  if (!mobileBearerAuthEnabled()) {
    return {
      ok: false,
      response: jsonResponse(503, { ok: false, error: "mobile_auth_unavailable" }),
    };
  }
  const user = await resolveAmareUser(event);
  if (!user.signedIn || !user.amareUserId) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "not_authenticated" }),
    };
  }
  return { ok: true, amareUserId: user.amareUserId };
}

/** @param {string} announcementId @param {string} amareUserId */
async function assertEligibleAnnouncement(announcementId, amareUserId) {
  const row = await fetchAnnouncementById(announcementId);
  if (!row) {
    return { ok: false, response: jsonResponse(404, { ok: false, error: "announcement_not_available" }) };
  }
  const ann = mapAnnouncementRow(row);
  if (!ann || !isAnnouncementInActiveWindow(ann)) {
    return { ok: false, response: jsonResponse(404, { ok: false, error: "announcement_not_available" }) };
  }
  const receipt = await fetchReceipt(announcementId, amareUserId);
  return { ok: true, row, ann, receipt };
}

async function handleActive(event) {
  const auth = await resolveMobileUser(event);
  if (!auth.ok) return auth.response;

  const displayType = parseActiveDisplayType(event);

  try {
    const payload = await getActiveAnnouncementForUser(auth.amareUserId, displayType);
    if (!payload?.announcement) {
      return jsonResponse(200, { ok: true, announcement: null });
    }

    if (displayType === DISPLAY_TYPE_BOARD) {
      if (!shouldShowBoardAnnouncementToUser(payload.announcement)) {
        return jsonResponse(200, { ok: true, announcement: null });
      }
    } else if (!shouldShowAnnouncementToUser(payload.announcement, payload.receipt)) {
      return jsonResponse(200, { ok: true, announcement: null });
    }

    console.log(
      JSON.stringify({
        event: "announcement_fetch",
        ok: true,
        display_type: displayType,
        announcement_id: payload.announcement.id,
        amare_user_id: auth.amareUserId,
      }),
    );
    return jsonResponse(200, {
      ok: true,
      announcement: publicMobileAnnouncement(payload.announcement),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "announcement_fetch",
        ok: false,
        display_type: displayType,
        amare_user_id: auth.amareUserId,
        error: String(err?.message || err).slice(0, 120),
      }),
    );
    return jsonResponse(200, { ok: true, announcement: null });
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} announcementId */
async function handleSeen(event, announcementId) {
  const auth = await resolveMobileUser(event);
  if (!auth.ok) return auth.response;

  const eligible = await assertEligibleAnnouncement(announcementId, auth.amareUserId);
  if (!eligible.ok) return eligible.response;

  try {
    await recordSeen(announcementId, auth.amareUserId);
    console.log(
      JSON.stringify({
        event: "announcement_seen",
        ok: true,
        announcement_id: announcementId,
        amare_user_id: auth.amareUserId,
      }),
    );
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "announcement_seen",
        ok: false,
        announcement_id: announcementId,
        amare_user_id: auth.amareUserId,
        error: String(err?.message || err).slice(0, 120),
      }),
    );
    return jsonResponse(503, { ok: false, error: "seen_failed" });
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} announcementId */
async function handleAcknowledge(event, announcementId) {
  const auth = await resolveMobileUser(event);
  if (!auth.ok) return auth.response;

  const eligible = await assertEligibleAnnouncement(announcementId, auth.amareUserId);
  if (!eligible.ok) return eligible.response;

  if (eligible.ann?.displayType === DISPLAY_TYPE_BOARD) {
    return jsonResponse(400, { ok: false, error: "ack_not_applicable" });
  }

  try {
    await recordAcknowledgment(announcementId, auth.amareUserId);
    console.log(
      JSON.stringify({
        event: "announcement_acknowledged",
        ok: true,
        announcement_id: announcementId,
        amare_user_id: auth.amareUserId,
      }),
    );
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "announcement_acknowledged",
        ok: false,
        announcement_id: announcementId,
        amare_user_id: auth.amareUserId,
        error: String(err?.message || err).slice(0, 120),
      }),
    );
    return jsonResponse(503, { ok: false, error: "ack_failed" });
  }
}

async function mobileHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }

  const path = requestPath(event);
  if (path === "/api/app/announcement/active" && event.httpMethod === "GET") {
    return handleActive(event);
  }

  const seenMatch = /^\/api\/app\/announcement\/([^/]+)\/seen$/.exec(path);
  if (seenMatch && event.httpMethod === "POST") {
    return handleSeen(event, decodeURIComponent(seenMatch[1]));
  }

  const ackMatch = /^\/api\/app\/announcement\/([^/]+)\/acknowledge$/.exec(path);
  if (ackMatch && event.httpMethod === "POST") {
    return handleAcknowledge(event, decodeURIComponent(ackMatch[1]));
  }

  return jsonResponse(404, { ok: false, error: "not_found" });
}

export const lambdaHandler = withMobileCorsHandler(mobileHandler);
export default withLambdaMobileCors(lambdaHandler);
