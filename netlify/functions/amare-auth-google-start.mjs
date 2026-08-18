/**
 * GET /api/amare/auth/google/start
 * Authorization Code + PKCE + OIDC nonce. No session issue.
 */

import { safeReturnPath } from "./oauth-lib.mjs";
import {
  buildGoogleStart,
  disabledAuthResponse,
  googleAuthRoutesEnabled,
} from "./amare-auth-lib.mjs";

export async function handleAmareAuthGoogleStart(event) {
  if (!googleAuthRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  try {
    const qs = event.queryStringParameters || {};
    const started = buildGoogleStart({
      returnPath: safeReturnPath(qs.return),
      headers: event.headers || {},
    });
    return {
      statusCode: 302,
      headers: {
        Location: started.url,
        "Cache-Control": "no-store",
        "Set-Cookie": started.txCookie,
      },
      body: "",
    };
  } catch (err) {
    if (err?.code === "google_oauth_unconfigured" || err?.code === "amare_session_configuration_error") {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: false, error: "configuration_error" }),
      };
    }
    console.log(JSON.stringify({ event: "login_failure", provider: "google", reason: "start_failed" }));
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "google_start_failed" }),
    };
  }
}

export async function handler(event) {
  return handleAmareAuthGoogleStart(event);
}
