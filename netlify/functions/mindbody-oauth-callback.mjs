import {
  cookieSecureFlag,
  decodeJwtPayload,
  fetchUserInfo,
  issuerBase,
  oauthScopes,
  pickMindbodyClientId,
  profileFromClaims,
  redirectUri,
  requiredEnv,
  scanMindbodyClientIdFromClaims,
  sealCookiePayload,
  sessionSecret,
  subscriberId,
  verifyState,
  safeReturnPath,
} from "./oauth-lib.mjs";
import { autoMergeDuplicatesByEmail } from "./stripe-mindbody-sync-lib.mjs";

/**
 * Run the post-OAuth duplicate-merge sweep: any other Studio Client at this site that
 * shares the signed-in user's email is merged INTO the Identity-bound `mbClientId`.
 *
 * Wrapped in:
 *  • A 12s overall race so a slow Mindbody call cannot block sign-in indefinitely.
 *  • A blanket try/catch — auto-merge MUST NOT fail OAuth. Worst case the user lands on
 *    /classes with an empty wallet briefly; the next sign-in retries (idempotent).
 *
 * Kill switch: `STRIPE_AUTO_MERGE_DUPLICATES=0` disables this entirely without a redeploy.
 *
 * @param {{ mbClientId: number | null; email: string | null }} input
 * @returns {Promise<void>}
 */
async function runPostOAuthAutoMerge(input) {
  /**
   * Always emit a single `stripe_oauth_auto_merge_invoked` line at entry so we can confirm
   * the OAuth callback actually reached this code path on every sign-in. Without this,
   * an early-return below leaves zero log signal and we cannot tell from production logs
   * whether the merge was attempted, skipped, or never invoked at all.
   */
  const killSwitch = (process.env.STRIPE_AUTO_MERGE_DUPLICATES ?? "1").trim();
  const rawClientId = input.mbClientId;
  const clientId = Number(rawClientId);
  const email = (input.email || "").trim().toLowerCase();

  console.log(
    JSON.stringify({
      event: "stripe_oauth_auto_merge_invoked",
      mbClientIdRaw: rawClientId,
      mbClientId: Number.isFinite(clientId) ? clientId : null,
      hasEmail: Boolean(email && email.includes("@")),
      killSwitch,
    }),
  );

  if (killSwitch === "0") {
    console.log(JSON.stringify({ event: "stripe_oauth_auto_merge_skipped", reason: "kill_switch_off" }));
    return;
  }
  if (!Number.isFinite(clientId) || clientId <= 0) {
    console.warn(
      JSON.stringify({
        event: "stripe_oauth_auto_merge_skipped",
        reason: "invalid_mb_client_id",
        mbClientIdRaw: rawClientId,
      }),
    );
    return;
  }
  if (!email || !email.includes("@")) {
    console.warn(
      JSON.stringify({
        event: "stripe_oauth_auto_merge_skipped",
        reason: "invalid_email",
        sessionClientId: clientId,
      }),
    );
    return;
  }

  try {
    const result = await Promise.race([
      autoMergeDuplicatesByEmail({
        sessionClientId: clientId,
        email,
        timeoutMs: 8000,
      }),
      /** @type {Promise<never>} */ (
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("auto_merge_overall_timeout")), 12_000),
        )
      ),
    ]);
    console.log(
      JSON.stringify({
        event: "stripe_oauth_auto_merge",
        sessionClientId: clientId,
        email,
        result,
      }),
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe_oauth_auto_merge_error",
        sessionClientId: clientId,
        email,
        error: String(err?.message ?? err).slice(0, 200),
      }),
    );
  }
}

async function exchangeAuthorizationCode(code) {
  const tokenUrl = `${issuerBase()}/connect/token`;
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", requiredEnv("MINDBODY_OAUTH_CLIENT_ID"));
  params.set("client_secret", requiredEnv("MINDBODY_OAUTH_CLIENT_SECRET"));
  params.set("code", code);
  params.set("redirect_uri", redirectUri());
  params.set("scope", oauthScopes());
  const sub = subscriberId();
  if (sub) params.set("subscriberId", sub);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || text || "token_error");
    /** @type {any} */ (err).status = res.status;
    /** @type {any} */ (err).body = json;
    throw err;
  }
  return json;
}

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
  const secret = sessionSecret();
  const params = parseFormBody(event);
  const st = params.state ? verifyState(params.state, secret) : null;
  const fallbackReturn = safeReturnPath(st?.return || "/classes");

  try {
    if (params.error) {
      const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent(params.error)}`;
      return { statusCode: 302, headers: { Location: loc, "Cache-Control": "no-store" } };
    }

    if (!st) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Invalid or expired OAuth state. Start sign-in again.",
      };
    }

    if (!params.code) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Missing authorization code.",
      };
    }

    const tokens = await exchangeAuthorizationCode(params.code);

    let raw = {};
    if (tokens.id_token) raw = { ...raw, ...decodeJwtPayload(tokens.id_token) };
    if (params.id_token) raw = { ...raw, ...decodeJwtPayload(params.id_token) };
    if (tokens.access_token) {
      const at = decodeJwtPayload(tokens.access_token);
      if (at && Object.keys(at).length) raw = { ...at, ...raw };
    }

    const userinfo = await fetchUserInfo(tokens.access_token);
    const merged = { ...raw, ...userinfo };
    const p = profileFromClaims(merged);
    const mbClientId = pickMindbodyClientId(merged) ?? scanMindbodyClientIdFromClaims(merged);

    /**
     * Sweep duplicate Studio Clients (e.g., the orphan from an anonymous Stripe
     * purchase) into the Identity-bound `mbClientId` so the package shows up in the
     * wallet on /classes immediately. Synchronous on purpose — finishes before the 302
     * redirect so the next page load already reflects the merged state. The helper has
     * its own timeout + try/catch so OAuth never fails on a merge issue.
     */
    await runPostOAuthAutoMerge({ mbClientId, email: p.email });

    const sessionPayload = {
      sub: p.sub,
      email: p.email,
      name: p.name,
      client_id: mbClientId,
      refresh_token: tokens.refresh_token || null,
      at: Date.now(),
    };

    const sealed = sealCookiePayload(sessionPayload, secret);
    const ttl = 60 * 60 * 24 * 30;
    const cookie = `mb_sess=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${cookieSecureFlag(event.headers)}`;

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
    const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent("token_exchange")}&detail=${encodeURIComponent(msg)}`;
    return {
      statusCode: 302,
      headers: { Location: loc, "Cache-Control": "no-store" },
    };
  }
}
