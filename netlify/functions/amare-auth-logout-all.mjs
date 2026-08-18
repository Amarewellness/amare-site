/**
 * POST /api/amare/auth/logout/all
 *
 * Clears `amare_sess` and `mb_sess`. Does not change
 * `GET /api/mindbody/oauth/logout` semantics.
 */

import { cookieSecureFlag } from "./oauth-lib.mjs";
import {
  amareAuthEnabled,
  buildClearAmareSessionCookie,
  isForeignOriginMutation,
} from "./amare-sess-lib.mjs";
import { clearCookie, AMARE_PROFILE_TX_COOKIE } from "./amare-auth-lib.mjs";

function disabled() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "amare_auth_disabled",
  };
}

function clearMbSessCookie(headers = {}) {
  return `mb_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(headers)}`;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 */
export async function handleAmareAuthLogoutAll(event) {
  if (!amareAuthEnabled()) return disabled();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "foreign_origin" }),
    };
  }

  const headers = event.headers || {};
  console.log(JSON.stringify({ event: "amare_session_cleared_all" }));
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    multiValueHeaders: {
      "Set-Cookie": [
        buildClearAmareSessionCookie(headers),
        clearMbSessCookie(headers),
        clearCookie(AMARE_PROFILE_TX_COOKIE, headers),
      ],
    },
    body: JSON.stringify({ ok: true, signedIn: false }),
  };
}

export async function handler(event) {
  return handleAmareAuthLogoutAll(event);
}
