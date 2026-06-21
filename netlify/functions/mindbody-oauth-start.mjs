import crypto from "node:crypto";
import {
  effectiveMobileRedirectUri,
  issuerBase,
  oauthScopes,
  redirectUri,
  sessionSecret,
  signState,
  subscriberId,
  safeReturnPath,
  safeAppReturnOrigin,
} from "./oauth-lib.mjs";

export async function handler(event) {
  try {
    const secret = sessionSecret();
    const qs = event.queryStringParameters || {};
    const returnPath = safeReturnPath(qs.return || "/classes");
    const isMobilePlatform = String(qs.platform ?? "")
      .trim()
      .toLowerCase() === "mobile";
    const useMobileOAuth = isMobilePlatform;

    /** @type {Record<string, unknown>} */
    const statePayload = { exp: Date.now() + 15 * 60 * 1000, return: returnPath };
    if (useMobileOAuth) {
      statePayload.platform = "mobile";
      statePayload.appReturn = safeAppReturnOrigin(qs.app_return ?? qs.appReturn);
    }

    const state = signState(statePayload, secret);
    const nonce = crypto.randomBytes(16).toString("hex");

    const url = new URL(`${issuerBase()}/connect/authorize`);
    const rd = useMobileOAuth ? effectiveMobileRedirectUri() : redirectUri();
    /** Native/SPA clients use code+PKCE; Web clients require hybrid flow (Mindbody portal type). */
    const nativeMobileRedirect = useMobileOAuth && /^[a-z][a-z0-9+.-]*:\/\//i.test(rd) && !/^https?:\/\//i.test(rd);
    if (nativeMobileRedirect) {
      url.searchParams.set("response_mode", "query");
      url.searchParams.set("response_type", "code");
    } else {
      url.searchParams.set("response_mode", "form_post");
      url.searchParams.set("response_type", "code id_token");
    }
    url.searchParams.set("client_id", process.env.MINDBODY_OAUTH_CLIENT_ID?.trim() || "");
    /** Help local dev: page opened via HTTPS tunnel but .env still has http://127.0.0.1 → Mindbody rejects. */
    try {
      const h = /** @type {Record<string,string|undefined>} */ (event.headers || {});
      const ref = String(h.referer || h.Referrer || h.REFERER || "");
      const xfp = String(h["x-forwarded-proto"] || "");
      const fromNgrokTunnel =
        /ngrok(?:-free)?\.(app|dev|io)\b/i.test(ref) || /\bngrok\b/i.test(String(h.host || h.Host || ""));
      if (fromNgrokTunnel && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(rd)) {
        console.warn(
          "[mindbody-oauth-start] Page via ngrok but MINDBODY_OAUTH_REDIRECT_URI looks like localhost. " +
            "Use the SAME https tunnel URL + /api/mindbody/oauth/callback in .env AND in Mindbody redirect list.",
        );
      }
      if (/^http:\/\//i.test(rd) && xfp === "https") {
        console.warn(
          "[mindbody-oauth-start] redirect_uri is plain http but request came via HTTPS proxy; Mindbody expects https callback when using tunnels.",
        );
      }
    } catch {
      /* ignore */
    }

    url.searchParams.set("redirect_uri", rd);
    url.searchParams.set("scope", oauthScopes());
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("state", state);

    const sub = subscriberId();
    if (sub) url.searchParams.set("subscriberId", sub);

    /**
     * OIDC `prompt` (optional). `login` asks the IdP to show credentials again — helps “switch Mindbody user”
     * after our site-only logout (Mindbody SSO cookies may otherwise auto-approve).
     * Mindbody may ignore unsupported values.
     */
    const rawPrompt = String(qs.prompt ?? "")
      .trim()
      .toLowerCase();
    const allowedPrompt = new Set(["login", "select_account", "consent", "none"]);
    if (rawPrompt && allowedPrompt.has(rawPrompt)) {
      url.searchParams.set("prompt", rawPrompt);
    }

    /**
     * OIDC `login_hint` (optional). Pre-fills the email/username on the Mindbody Identity sign-in
     * screen. Critical after a Stripe checkout that just created a new Mindbody client — the
     * customer must sign in with that exact email so the wallet shows the package they bought.
     * Without the hint, SSO might auto-resume a previous session bound to a different email and
     * the buyer ends up logged in as a different Mindbody client.
     *
     * Validated to be a plausible email (defense-in-depth — Mindbody also validates).
     */
    const rawHint = String(qs.login_hint ?? qs.email ?? "").trim();
    if (rawHint && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(rawHint) && rawHint.length <= 254) {
      url.searchParams.set("login_hint", rawHint);
    }

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
