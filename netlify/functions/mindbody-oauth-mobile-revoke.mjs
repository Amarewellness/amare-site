import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { mobileBearerAuthEnabled } from "./mobile-auth-lib.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
};

/**
 * Mobile logout — stateless JWT revoke (client deletes tokens).
 * V1: acknowledge; optional server-side denylist in Phase 2.
 */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...CORS, "Cache-Control": "no-store" }, body: "" };
  }

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

  console.log(JSON.stringify({ event: "mobile_oauth_revoke_ok" }));
  return jsonResponse(200, { ok: true, revoked: true }, CORS);
}
