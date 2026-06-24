import {
  cookieSecureFlag,
  sealCookiePayload,
  sessionSecret,
  verifyState,
  safeReturnPath,
  safeAppReturnOrigin,
} from "./oauth-lib.mjs";
import {
  buildSessionPayloadFromOAuthTokens,
  exchangeAuthorizationCode,
} from "./mindbody-oauth-session-build.mjs";
import { createObsContext, maskEmail, obsLog } from "./obs-log.mjs";

function parseFormBody(event) {
  /** @type {Record<string,string>} */
  const out = {};
  if (event.httpMethod === "POST" && event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    }
  }
  if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v != null && v !== "") out[k] = v;
    }
  }
  return out;
}

export async function handler(event) {
  const obs = createObsContext(event);
  obsLog(obs, "oauth_callback_request", { ok: true, httpMethod: event.httpMethod });

  const secret = sessionSecret();
  const params = parseFormBody(event);
  const st = params.state ? verifyState(params.state, secret) : null;
  const fallbackReturn = safeReturnPath(st?.return || "/classes");
  const platform = st?.platform === "mobile" ? "mobile" : "web";

  try {
    if (params.error) {
      obsLog(
        obs,
        "oauth_callback_response",
        {
          ok: false,
          status: 302,
          outcome: "provider_error",
          oauthError: String(params.error).slice(0, 80),
          platform,
          returnPath: fallbackReturn,
        },
        "warn",
      );
      const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent(params.error)}`;
      return { statusCode: 302, headers: { Location: loc, "Cache-Control": "no-store" } };
    }

    if (!st) {
      obsLog(
        obs,
        "oauth_callback_response",
        { ok: false, status: 400, outcome: "invalid_state", platform },
        "warn",
      );
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Invalid or expired OAuth state. Start sign-in again.",
      };
    }

    if (!params.code) {
      obsLog(
        obs,
        "oauth_callback_response",
        { ok: false, status: 400, outcome: "missing_code", platform },
        "warn",
      );
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Missing authorization code.",
      };
    }

    if (st.platform === "mobile") {
      const appReturn = safeAppReturnOrigin(st.appReturn);
      obsLog(obs, "oauth_callback_response", {
        ok: true,
        status: 302,
        outcome: "mobile_bridge_redirect",
        platform: "mobile",
        appReturnHost: (() => {
          try {
            return new URL(appReturn).host;
          } catch {
            return null;
          }
        })(),
      });
      const loc = new URL("/auth/callback", appReturn);
      loc.searchParams.set("code", params.code);
      loc.searchParams.set("state", params.state);
      return {
        statusCode: 302,
        headers: { Location: loc.toString(), "Cache-Control": "no-store" },
      };
    }

    const tokens = await exchangeAuthorizationCode(params.code);
    const sessionPayload = await buildSessionPayloadFromOAuthTokens(tokens, {
      idTokenFromForm: params.id_token,
    });

    const sealed = sealCookiePayload(sessionPayload, secret);
    const ttl = 60 * 60 * 24 * 30;
    const cookie = `mb_sess=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${cookieSecureFlag(event.headers)}`;

    obsLog(obs, "oauth_callback_response", {
      ok: true,
      status: 302,
      outcome: "session_created",
      platform: "web",
      clientId: sessionPayload.client_id ?? null,
      linkStatus: sessionPayload.link_status ?? null,
      bookingAllowed: sessionPayload.booking_allowed ?? null,
      consumerAssociated: sessionPayload.consumer_associated ?? null,
      clientExists: sessionPayload.client_exists ?? null,
      emailDomain: maskEmail(sessionPayload.email),
      returnPath: fallbackReturn,
    });

    return {
      statusCode: 302,
      headers: {
        Location: fallbackReturn,
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    obsLog(
      obs,
      "oauth_callback_response",
      {
        ok: false,
        status: 302,
        outcome: "token_exchange_failed",
        platform,
        error: msg,
        returnPath: fallbackReturn,
      },
      "error",
    );
    const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent("token_exchange")}&detail=${encodeURIComponent(msg)}`;
    return {
      statusCode: 302,
      headers: { Location: loc, "Cache-Control": "no-store" },
    };
  }
}
