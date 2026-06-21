import {
  decodeJwtPayload,
  fetchUserInfo,
  issuerBase,
  oauthScopes,
  pickMindbodyClientId,
  profileFromClaims,
  redirectUri,
  requiredEnv,
  scanMindbodyClientIdFromClaims,
  subscriberId,
} from "./oauth-lib.mjs";
import { computeOAuthStudioLinkState, tryResolveClientId } from "./mindbody-consumer-lib.mjs";
import { mindbodyConsumerHeaders } from "./mindbody-upstream.mjs";
import { autoMergeDuplicatesByEmail } from "./stripe-mindbody-sync-lib.mjs";

/**
 * @param {{ mbClientId: number | null; email: string | null }} input
 */
export async function runPostOAuthAutoMerge(input) {
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

/**
 * @param {string} code
 * @param {{ redirectUri?: string }} [options]
 */
export async function exchangeAuthorizationCode(code, options = {}) {
  const rd = (options.redirectUri || redirectUri()).trim();
  const tokenUrl = `${issuerBase()}/connect/token`;
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", requiredEnv("MINDBODY_OAUTH_CLIENT_ID"));
  params.set("client_secret", requiredEnv("MINDBODY_OAUTH_CLIENT_SECRET"));
  params.set("code", code);
  params.set("redirect_uri", rd);
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

/**
 * Shared OAuth completion: Mindbody tokens → `mb_sess`-compatible session payload.
 *
 * @param {Record<string, unknown>} tokens
 * @param {{ idTokenFromForm?: string }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildSessionPayloadFromOAuthTokens(tokens, options = {}) {
  let raw = {};
  if (tokens.id_token) raw = { ...raw, ...decodeJwtPayload(String(tokens.id_token)) };
  if (options.idTokenFromForm) raw = { ...raw, ...decodeJwtPayload(options.idTokenFromForm) };
  if (tokens.access_token) {
    const at = decodeJwtPayload(String(tokens.access_token));
    if (at && Object.keys(at).length) raw = { ...at, ...raw };
  }

  const userinfo = await fetchUserInfo(String(tokens.access_token || ""));
  const merged = { ...raw, ...userinfo };
  const p = profileFromClaims(merged);
  let mbClientId = pickMindbodyClientId(merged) ?? scanMindbodyClientIdFromClaims(merged);

  if (mbClientId == null) {
    /** @type {Record<string, string>} */
    const shape = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v == null) shape[k] = "null";
      else if (typeof v === "string") shape[k] = `string(${v.length})`;
      else if (typeof v === "number") shape[k] = `number(${String(v).length}d)`;
      else if (typeof v === "boolean") shape[k] = "boolean";
      else if (Array.isArray(v)) shape[k] = `array(${v.length})`;
      else shape[k] = typeof v;
    }
    console.log(
      JSON.stringify({
        event: "stripe_oauth_claims_shape_no_client_id",
        email: p.email,
        claimsKeys: Object.keys(merged),
        claimsShape: shape,
      }),
    );

    try {
      const consumerHeaders = mindbodyConsumerHeaders(String(tokens.access_token || ""));
      if (consumerHeaders) {
        const synthSession = {
          email: p.email,
          name: p.name,
          client_id: null,
          refresh_token: null,
        };
        /** @type {Record<string, unknown>[]} */
        const fallbackTrace = [];
        const resolved = await tryResolveClientId(
          synthSession,
          p.email,
          consumerHeaders,
          String(tokens.access_token || ""),
          fallbackTrace,
        );
        if (resolved != null) {
          mbClientId = resolved;
          console.log(
            JSON.stringify({
              event: "stripe_oauth_client_id_resolved_via_fallback",
              email: p.email,
              mbClientId: resolved,
              via: "tryResolveClientId",
            }),
          );
        } else {
          console.warn(
            JSON.stringify({
              event: "stripe_oauth_client_id_unresolved",
              email: p.email,
              name: p.name,
              fallbackTrace,
            }),
          );
        }
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "stripe_oauth_client_id_fallback_error",
          email: p.email,
          error: String(err?.message ?? err).slice(0, 200),
        }),
      );
    }
  }

  await runPostOAuthAutoMerge({ mbClientId, email: p.email });

  const consumerHeaders = mindbodyConsumerHeaders(String(tokens.access_token || ""));
  const linkState = consumerHeaders
    ? await computeOAuthStudioLinkState({
        email: p.email,
        mergedClaims: merged,
        consumerAuthHeaders: consumerHeaders,
        resolvedClientId: mbClientId,
      })
    : {
        client_id: mbClientId,
        client_exists: mbClientId != null,
        consumer_associated: false,
        booking_allowed: false,
        link_status: "not_associated",
      };

  console.log(
    JSON.stringify({
      event: "oauth_link_state_summary",
      email: p.email,
      resolvedMbClientIdBeforeLink: mbClientId,
      linkStatus: linkState.link_status,
      clientId: linkState.client_id ?? mbClientId,
      clientExists: linkState.client_exists,
      consumerAssociated: linkState.consumer_associated,
      bookingAllowed: linkState.booking_allowed,
    }),
  );

  return {
    sub: p.sub,
    email: p.email,
    name: p.name,
    client_id: linkState.client_id ?? mbClientId,
    client_exists: linkState.client_exists,
    consumer_associated: linkState.consumer_associated,
    booking_allowed: linkState.booking_allowed,
    link_status: linkState.link_status,
    access_token: typeof tokens.access_token === "string" ? tokens.access_token : null,
    refresh_token: tokens.refresh_token || null,
    at: Date.now(),
  };
}
