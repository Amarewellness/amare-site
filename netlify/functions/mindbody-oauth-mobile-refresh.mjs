import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  mobileBearerAuthEnabled,
  reissueMobileTokenPairFromSession,
  sessionFromMobileRefreshToken,
} from "./mobile-auth-lib.mjs";
import { mindbodyAccessTokenFromSession, refreshAccessToken } from "./oauth-lib.mjs";
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

async function mobileRefreshHandler(event) {
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

  const refreshToken = String(body.refreshToken ?? body.refresh_token ?? "").trim();
  if (!refreshToken) return jsonResponse(400, { ok: false, error: "missing_refresh_token" });

  const session = sessionFromMobileRefreshToken(refreshToken);
  if (!session) return jsonResponse(401, { ok: false, error: "invalid_refresh_token" });

  if (mindbodyAccessTokenFromSession(session)) {
    const pair = reissueMobileTokenPairFromSession(session);
    return jsonResponse(200, { ok: true, ...pair });
  }

  const mindbodyRefresh = session.refresh_token;
  if (typeof mindbodyRefresh !== "string" || !mindbodyRefresh.trim()) {
    return jsonResponse(401, { ok: false, error: "missing_mindbody_refresh_token" });
  }

  try {
    const tokens = await refreshAccessToken(mindbodyRefresh);
    if (!tokens.access_token) throw new Error("no_access_token");
    const updated = {
      ...session,
      at: Date.now(),
      access_token: tokens.access_token,
    };
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token.trim()) {
      updated.refresh_token = tokens.refresh_token.trim();
    }
    const pair = reissueMobileTokenPairFromSession(updated);
    return jsonResponse(200, { ok: true, ...pair });
  } catch (e) {
    return jsonResponse(401, {
      ok: false,
      error: "token_refresh_failed",
      detail: String(e?.message ?? e).slice(0, 200),
    });
  }
}

export const handler = withMobileCorsHandler(mobileRefreshHandler);
