import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  inspectMobileToken,
  mobileBearerAuthEnabled,
  parseBearerAuthorization,
  revokeMobileCredential,
} from "./mobile-auth-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function parseJsonBody(event) {
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

/**
 * Mobile logout — revoke the presented token family only.
 * AMARÉ sid/fingerprint does not revoke a Mindbody family, and vice versa.
 */
async function mobileRevokeHandler(event) {
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
  const presented =
    parseBearerAuthorization(event) ||
    String(body.refreshToken || body.refresh_token || body.accessToken || "").trim();
  const inspected = inspectMobileToken(presented);
  if (inspected) {
    revokeMobileCredential({
      sid: inspected.sid,
      token: presented,
      expMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    console.log(
      JSON.stringify({
        event: "mobile_oauth_revoke_ok",
        family: inspected.family,
        typ: inspected.typ,
      }),
    );
    return jsonResponse(200, { ok: true, revoked: true, family: inspected.family });
  }

  console.log(JSON.stringify({ event: "mobile_oauth_revoke_ok", family: null }));
  return jsonResponse(200, { ok: true, revoked: true });
}

export const handler = withMobileCorsHandler(mobileRevokeHandler);
