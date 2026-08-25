/**
 * POST /api/amare/auth/account/delete
 *
 * Deletes/deactivates AMARÉ-owned app access (identity, sessions, push, unlink).
 * Does not cancel billing, memberships, bookings, or mutate Mindbody/Stripe.
 */

import {
  clearCookie,
  disabledAuthResponse,
  emailOtpRoutesEnabled,
  hashOtpCode,
  isForeignOriginMutation,
  jsonResponse,
  normalizeAmareEmail,
  requireOtpPepper,
  resolveAmareUser,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_PENDING_LINK_COOKIE,
  AMARE_PROFILE_TX_COOKIE,
} from "./amare-auth-lib.mjs";
import { buildClearAmareSessionCookie } from "./amare-sess-lib.mjs";
import {
  deactivateAmareAppAccount,
  findAmareUserById,
  isAmareUserDeleted,
  listIdentities,
} from "./amare-identity-store.mjs";
import { consumeOtpChallenge, deleteOtpChallengesByEmail } from "./amare-otp-store.mjs";
import { openNotificationStore } from "./amare-notification-store.mjs";
import {
  inspectMobileToken,
  parseBearerAuthorization,
  revokeMobileCredential,
} from "./mobile-auth-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function emailMatchesUserIdentities(identities, email) {
  const normalized = normalizeAmareEmail(email);
  if (!normalized) return false;
  return identities.some((row) => {
    const direct = normalizeAmareEmail(row.email);
    if (direct === normalized) return true;
    if (String(row.provider || "") === "email") {
      const sub = normalizeAmareEmail(row.provider_sub);
      if (sub === normalized) return true;
    }
    return false;
  });
}

async function cleanupNotifications(amareUserId, deps = {}) {
  const store = deps.notificationStore || openNotificationStore();
  if (typeof store.revokeAllInstallationsForUser === "function") {
    await store.revokeAllInstallationsForUser(amareUserId);
  }
  if (typeof store.deletePreferencesForUser === "function") {
    await store.deletePreferencesForUser(amareUserId);
  }
  if (typeof store.cancelPendingRemindersForUser === "function") {
    await store.cancelPendingRemindersForUser(amareUserId);
  }
  if (typeof store.clearNotificationUserLinks === "function") {
    await store.clearNotificationUserLinks(amareUserId);
  }
}

function clearAmareAuthCookies(headers) {
  return [
    buildClearAmareSessionCookie(headers),
    clearCookie(AMARE_PROFILE_TX_COOKIE, headers),
    clearCookie(AMARE_CLAIM_TX_COOKIE, headers),
    clearCookie(AMARE_PENDING_LINK_COOKIE, headers),
  ];
}

function revokeBearerIfPresent(event) {
  const bearer = parseBearerAuthorization(event);
  if (!bearer) return;
  const inspected = inspectMobileToken(bearer);
  if (!inspected) return;
  revokeMobileCredential({ sid: inspected.sid, token: bearer });
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {Record<string, unknown>} [deps]
 */
export async function handleAmareAuthAccountDelete(event, deps = {}) {
  if (!emailOtpRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const body = parseBody(event);
  if (body.confirm !== true) {
    return jsonResponse(400, { ok: false, error: "confirm_required" });
  }

  const user = await resolveAmareUser(event, {
    findUser: deps.findUser || findAmareUserById,
  });
  if (!user.signedIn) {
    if (user.reason === "account_deleted") {
      return jsonResponse(200, {
        ok: true,
        deleted: true,
        alreadyDeleted: true,
        studioRecordsRetained: true,
      });
    }
    return jsonResponse(401, { ok: false, error: "not_authenticated" });
  }

  const row = await (deps.findUser || findAmareUserById)(user.amareUserId);
  if (row && isAmareUserDeleted(row)) {
    return jsonResponse(200, {
      ok: true,
      deleted: true,
      alreadyDeleted: true,
      studioRecordsRetained: true,
    });
  }

  const email = normalizeAmareEmail(body.email);
  const code = String(body.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return jsonResponse(400, { ok: false, error: "invalid_code" });
  }

  const identities = await (deps.listIdentities || listIdentities)(user.amareUserId);
  if (!emailMatchesUserIdentities(identities, email)) {
    return jsonResponse(403, { ok: false, error: "email_mismatch" });
  }

  const otp = deps.otp || (await import("./amare-otp-store.mjs"));
  const codeHash = hashOtpCode(email, code, deps.pepper || requireOtpPepper());
  const consumed = await otp.consumeOtpChallenge({
    emailNormalized: email,
    codeHash,
    now: deps.now ? new Date(deps.now) : new Date(),
  });
  if (!consumed.ok) {
    console.log(
      JSON.stringify({
        event: "account_deletion_otp_failed",
        amare_user_id: user.amareUserId,
        reason: consumed.reason,
      }),
    );
    return jsonResponse(401, { ok: false, error: "invalid_code" });
  }

  const result = await (deps.deactivateAmareAppAccount || deactivateAmareAppAccount)(user.amareUserId, deps);
  if (!result.ok) {
    return jsonResponse(500, { ok: false, error: "deletion_failed" });
  }

  if (!result.alreadyDeleted) {
    try {
      await cleanupNotifications(user.amareUserId, deps);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "account_deletion_notification_cleanup_failed",
          amare_user_id: user.amareUserId,
          reason: String(err?.message || err).slice(0, 120),
        }),
      );
    }

    const emails = Array.isArray(result.emails) ? result.emails : [email];
    for (const em of [...new Set(emails.filter(Boolean))]) {
      try {
        await (deps.deleteOtpChallengesByEmail || deleteOtpChallengesByEmail)(em);
      } catch {
        /* best-effort */
      }
    }
  }

  revokeBearerIfPresent(event);

  console.log(
    JSON.stringify({
      event: "amare_app_account_deleted",
      amare_user_id: user.amareUserId,
      already_deleted: result.alreadyDeleted === true,
    }),
  );

  const headers = event.headers || {};
  const cookies = clearAmareAuthCookies(headers);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    multiValueHeaders: { "Set-Cookie": cookies },
    body: JSON.stringify({
      ok: true,
      deleted: true,
      alreadyDeleted: result.alreadyDeleted === true,
      studioRecordsRetained: true,
    }),
  };
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthAccountDelete);
export default withLambdaMobileCors(lambdaHandler);
