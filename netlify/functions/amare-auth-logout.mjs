/**
 * POST /api/amare/auth/logout
 *
 * Clears `amare_sess` only. Does not clear `mb_sess`.
 * Does not revoke Google / Apple / Mindbody. Idempotent.
 */

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

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 */
export async function handleAmareAuthLogout(event) {
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

  console.log(JSON.stringify({ event: "amare_session_cleared" }));
  const headers = event.headers || {};
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    multiValueHeaders: {
      "Set-Cookie": [
        buildClearAmareSessionCookie(headers),
        clearCookie(AMARE_PROFILE_TX_COOKIE, headers),
      ],
    },
    body: JSON.stringify({ ok: true, signedIn: false }),
  };
}

export async function handler(event) {
  return handleAmareAuthLogout(event);
}
