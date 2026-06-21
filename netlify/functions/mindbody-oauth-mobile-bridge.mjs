import { mobileBearerAuthEnabled } from "./mobile-auth-lib.mjs";
import { safeAppReturnOrigin, sessionSecret, verifyState } from "./oauth-lib.mjs";

/**
 * Mindbody mobile OAuth redirect target (HTTPS). Verifies `state`, then 302 to the
 * Capacitor / Vite dev app at `{appReturn}/auth/callback?code&state`.
 *
 * Register this URL as MINDBODY_OAUTH_MOBILE_REDIRECT_URI, e.g.:
 *   https://YOUR-TUNNEL.ngrok-free.app/api/mindbody/oauth/mobile-bridge
 */
export async function handler(event) {
  if (!mobileBearerAuthEnabled()) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: "mobile_auth_disabled",
    };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  const qs = event.queryStringParameters || {};
  const err = qs.error ? String(qs.error) : "";
  const stateRaw = qs.state ? String(qs.state) : "";
  const st = stateRaw ? verifyState(stateRaw, sessionSecret()) : null;
  const appReturn = safeAppReturnOrigin(
    st && typeof st.appReturn === "string" ? st.appReturn : undefined,
  );

  if (err) {
    const loc = `${appReturn}/auth/callback?error=${encodeURIComponent(err)}`;
    return { statusCode: 302, headers: { Location: loc, "Cache-Control": "no-store" }, body: "" };
  }

  const code = qs.code ? String(qs.code) : "";
  if (!code || !stateRaw || !st) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      body: "<!DOCTYPE html><html><body><p>Invalid or expired sign-in. Close this window and try again.</p></body></html>",
    };
  }

  const loc =
    `${appReturn}/auth/callback?code=${encodeURIComponent(code)}` +
    `&state=${encodeURIComponent(stateRaw)}`;

  console.log(JSON.stringify({ event: "mobile_oauth_bridge_redirect", appReturn: appReturn }));

  return { statusCode: 302, headers: { Location: loc, "Cache-Control": "no-store" }, body: "" };
}
