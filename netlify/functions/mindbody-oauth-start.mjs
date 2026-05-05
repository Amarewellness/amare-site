import crypto from "node:crypto";
import {
  issuerBase,
  oauthScopes,
  redirectUri,
  sessionSecret,
  signState,
  subscriberId,
  safeReturnPath,
} from "./oauth-lib.mjs";

export async function handler(event) {
  try {
    const secret = sessionSecret();
    const qs = event.queryStringParameters || {};
    const returnPath = safeReturnPath(qs.return || "/classes-api");
    const state = signState(
      { exp: Date.now() + 15 * 60 * 1000, return: returnPath },
      secret,
    );
    const nonce = crypto.randomBytes(16).toString("hex");

    const url = new URL(`${issuerBase()}/connect/authorize`);
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("response_type", "code id_token");
    url.searchParams.set("client_id", process.env.MINDBODY_OAUTH_CLIENT_ID?.trim() || "");
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("scope", oauthScopes());
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("state", state);

    const sub = subscriberId();
    if (sub) url.searchParams.set("subscriberId", sub);

    if (!process.env.MINDBODY_OAUTH_CLIENT_ID?.trim()) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Missing MINDBODY_OAUTH_CLIENT_ID",
      };
    }

    return {
      statusCode: 302,
      headers: {
        Location: url.toString(),
        "Cache-Control": "no-store",
      },
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: String(e?.message ?? e),
    };
  }
}
