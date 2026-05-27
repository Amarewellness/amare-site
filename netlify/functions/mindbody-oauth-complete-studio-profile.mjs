import {
  cookieSecureFlag,
  normalizeUsMobilePhone,
  sealCookiePayload,
  sessionSecret,
} from "./oauth-lib.mjs";
import {
  completeStudioClientFromOAuthSession,
  getSessionWithConsumerHeaders,
  jsonResponse,
  resolveSessionStudioLinkFlags,
} from "./mindbody-consumer-lib.mjs";

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

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const auth = await getSessionWithConsumerHeaders(event);
    if (!auth.ok) return auth.response;

    const body = parseJsonBody(event);
    if (body === null) {
      return jsonResponse(400, { ok: false, error: "invalid_json" });
    }

    const mobilePhone = normalizeUsMobilePhone(
      body.mobilePhone ?? body.MobilePhone ?? body.phone ?? body.Phone,
    );
    if (!mobilePhone) {
      return jsonResponse(400, {
        ok: false,
        error: "invalid_phone",
        message: "Enter a valid US mobile number (10 digits).",
      });
    }

    const before = await resolveSessionStudioLinkFlags(auth.session, auth.authHeaders);
    if (before.clientId != null && before.clientExists) {
      return jsonResponse(200, {
        ok: true,
        alreadyComplete: true,
        clientId: before.clientId,
        clientExists: before.clientExists,
        consumerAssociated: before.consumerAssociated,
        bookingAllowed: before.bookingAllowed,
        linkStatus: before.linkStatus,
      });
    }
    if (before.linkStatus !== "no_studio_client") {
      return jsonResponse(409, {
        ok: false,
        error: "completion_not_needed",
        linkStatus: before.linkStatus,
        message: "Studio profile completion is not available for this account state.",
      });
    }

    const result = await completeStudioClientFromOAuthSession({
      session: auth.session,
      consumerAuthHeaders: auth.authHeaders,
      mobilePhone,
    });

    if (!result.ok) {
      const status =
        result.reason === "ambiguous_studio_client" || result.reason === "apple_relay_email"
          ? 409
          : result.reason === "no_staff_headers"
            ? 503
            : 400;
      return jsonResponse(status, {
        ok: false,
        error: result.reason,
        mindbody: result.mindbody ?? null,
        message:
          result.reason === "ambiguous_studio_client"
            ? "Multiple studio profiles match your email. Please contact the studio."
            : result.reason === "apple_relay_email"
              ? "Sign in with the email on your AMARÉ account, not Apple Hide My Email."
              : "We could not add your profile to the studio. Check your phone number or contact us.",
      });
    }

    const link = result.linkState;
    const secret = sessionSecret();
    const sessionPayload = {
      ...auth.session,
      client_id: link.client_id,
      client_exists: link.client_exists,
      consumer_associated: link.consumer_associated,
      booking_allowed: link.booking_allowed,
      link_status: link.link_status,
      at: Date.now(),
    };
    const sealed = sealCookiePayload(sessionPayload, secret);
    const ttl = 60 * 60 * 24 * 30;
    const profileCookie = `mb_sess=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${cookieSecureFlag(event.headers)}`;

    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": profileCookie,
    };
    if (auth.setCookie) {
      headers["Set-Cookie"] = [profileCookie, auth.setCookie];
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        created: result.created === true,
        alreadyLinked: result.alreadyLinked === true,
        clientId: link.client_id,
        clientExists: link.client_exists,
        consumerAssociated: link.consumer_associated,
        bookingAllowed: link.booking_allowed,
        linkStatus: link.link_status,
      }),
    };
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      error: "complete_studio_profile_failed",
      detail: String(e?.message ?? e).slice(0, 200),
    });
  }
}
