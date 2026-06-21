import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  buildSessionPayloadFromOAuthTokens,
  exchangeAuthorizationCode,
} from "./mindbody-oauth-session-build.mjs";
import {
  issueMobileTokenPair,
  mobileBearerAuthEnabled,
} from "./mobile-auth-lib.mjs";
import { effectiveMobileRedirectUri, sessionSecret, verifyState } from "./oauth-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

/** @param {import('@netlify/functions').HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function mobileExchangeHandler(event) {
  if (!mobileBearerAuthEnabled()) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "mobile_auth_disabled" }),
    };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const code = String(body.code ?? body.Code ?? "").trim();
  const stateRaw = String(body.state ?? body.State ?? "").trim();
  if (!code) return jsonResponse(400, { ok: false, error: "missing_code" });
  if (!stateRaw) return jsonResponse(400, { ok: false, error: "missing_state" });

  const st = verifyState(stateRaw, sessionSecret());
  if (!st) return jsonResponse(400, { ok: false, error: "invalid_or_expired_state" });
  if (st.platform !== "mobile") {
    return jsonResponse(400, { ok: false, error: "not_mobile_oauth_state" });
  }

  try {
    const tokens = await exchangeAuthorizationCode(code, {
      redirectUri: effectiveMobileRedirectUri(),
    });
    const sessionPayload = await buildSessionPayloadFromOAuthTokens(tokens);
    const pair = issueMobileTokenPair(sessionPayload);

    console.log(
      JSON.stringify({
        event: "mobile_oauth_exchange_ok",
        email: typeof sessionPayload.email === "string" ? sessionPayload.email : null,
        clientId: sessionPayload.client_id ?? null,
        linkStatus: sessionPayload.link_status ?? null,
        hasMindbodyAccessToken: typeof sessionPayload.access_token === "string" && sessionPayload.access_token.length > 0,
        hasMindbodyRefreshToken: typeof sessionPayload.refresh_token === "string" && sessionPayload.refresh_token.length > 0,
      }),
    );

    return jsonResponse(200, {
      ok: true,
      ...pair,
      profile: {
        email: sessionPayload.email ?? null,
        name: sessionPayload.name ?? null,
        clientId: sessionPayload.client_id ?? null,
        clientExists: sessionPayload.client_exists ?? null,
        consumerAssociated: sessionPayload.consumer_associated ?? null,
        bookingAllowed: sessionPayload.booking_allowed ?? null,
        linkStatus: sessionPayload.link_status ?? null,
      },
    });
  } catch (e) {
    const status = typeof /** @type {{ status?: number }} */ (e).status === "number" ? /** @type {{ status: number }} */ (e).status : 502;
    console.warn(
      JSON.stringify({
        event: "mobile_oauth_exchange_failed",
        error: String(e?.message ?? e).slice(0, 200),
        status,
      }),
    );
    return jsonResponse(status >= 400 && status < 600 ? status : 502, {
      ok: false,
      error: "token_exchange_failed",
      detail: String(e?.message ?? e).slice(0, 200),
    });
  }
}

export const handler = withMobileCorsHandler(mobileExchangeHandler);
