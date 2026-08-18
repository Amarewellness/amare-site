/**
 * GET /api/amare/auth/google/callback
 * Verifies state/PKCE/OIDC, resolves identity, proposes claim only. Never writes verified/linked.
 */

import {
  buildClaimTxCookie,
  buildPendingLinkCookie,
  clearCookie,
  consumeOAuthTransaction,
  disabledAuthResponse,
  exchangeGoogleAuthorizationCode,
  finishGoogleAuthentication,
  googleAuthRoutesEnabled,
  issueGoogleAmareSession,
  logDualSessionMismatch,
  readMbSessClientId,
  redirectResponse,
  verifyGoogleIdToken,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_OAUTH_TX_COOKIE,
  AMARE_PENDING_LINK_COOKIE,
} from "./amare-auth-lib.mjs";
import { safeReturnPath } from "./oauth-lib.mjs";

function cookieHeader(event) {
  return event.headers?.cookie || event.headers?.Cookie || "";
}

export async function handleAmareAuthGoogleCallback(event, deps = {}) {
  if (!googleAuthRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "GET") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  const clearTx = clearCookie(AMARE_OAUTH_TX_COOKIE, headers);
  const fail = (reason, returnPath = "/classes") => {
    console.log(JSON.stringify({ event: "google_oauth_callback_failure", provider: "google", reason }));
    console.log(JSON.stringify({ event: "login_failure", provider: "google", reason }));
    return redirectResponse(`${safeReturnPath(returnPath)}?amare_auth=error`, [clearTx]);
  };

  if (qs.error) return fail("oauth_denied");

  const consumed = consumeOAuthTransaction({ cookieHeader: cookieHeader(event), state: String(qs.state || "") });
  if (!consumed.ok) return fail(consumed.reason);

  const code = String(qs.code || "").trim();
  if (!code) return fail("missing_code", consumed.returnPath);

  try {
    const exchange = deps.exchangeGoogleAuthorizationCode || exchangeGoogleAuthorizationCode;
    const tokens = await exchange({ code, codeVerifier: consumed.tx.verifier });
    const verify = deps.verifyGoogleIdToken || verifyGoogleIdToken;
    const claims = await verify(tokens.id_token, { nonce: consumed.tx.nonce });
    const mb = readMbSessClientId(cookieHeader(event));

    const finished = await finishGoogleAuthentication(
      {
        sub: claims.sub,
        email: claims.email,
        mbSessClientId: mb.clientId,
        siteId: deps.siteId,
      },
      {
        identity: deps.identity,
        searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
      },
    );

    const cookies = [clearTx];
    if (finished.outcome === "pending_attach") {
      cookies.push(buildPendingLinkCookie(finished.pending, headers));
      console.log(JSON.stringify({ event: "google_oauth_callback_success", provider: "google", status: "pending_attach" }));
      return redirectResponse(`${consumed.returnPath}?amare_claim=pending_link`, cookies);
    }

    if (mb.clientId && finished.claim?.status === "conflict") {
      logDualSessionMismatch({
        amareUserId: finished.amare_user_id,
        mbClientId: mb.clientId,
        reason: "mb_sess_owned_elsewhere",
      });
    }
    const issued = issueGoogleAmareSession(finished.amare_user_id, headers);
    if (issued?.cookie) cookies.push(issued.cookie);
    if (finished.claimTx) cookies.push(buildClaimTxCookie(finished.claimTx, headers));
    else cookies.push(clearCookie(AMARE_CLAIM_TX_COOKIE, headers));
    cookies.push(clearCookie(AMARE_PENDING_LINK_COOKIE, headers));

    console.log(
      JSON.stringify({
        event: "google_oauth_callback_success",
        provider: "google",
        amare_user_id: finished.amare_user_id,
        status: finished.claim?.status,
      }),
    );
    const q = finished.claim?.status === "candidate" ? "amare_claim=candidate" : "amare_auth=ok";
    return redirectResponse(`${consumed.returnPath}?${q}`, cookies);
  } catch (err) {
    const reason = err?.code || String(err?.message || "callback_failed");
    return fail(reason, consumed.returnPath);
  }
}

export async function handler(event) {
  return handleAmareAuthGoogleCallback(event);
}
