/**
 * POST /api/amare/auth/profile/begin
 *
 * Re-issues amare_profile_tx from persisted successful Staff zero-match provenance.
 */

import { amareAuthEnabled, isForeignOriginMutation, resolveAmareUser } from "./amare-sess-lib.mjs";
import {
  buildClaimTxCookie,
  buildProfileTxCookie,
  clearCookie,
  disabledAuthResponse,
  emailOtpRoutesEnabled,
  jsonResponse,
  sealProfileTxToken,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_PROFILE_TX_COOKIE,
} from "./amare-auth-lib.mjs";
import { withLambda } from "@netlify/aws-lambda-compat";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { beginAmareProfileTx } from "./amare-auth-profile-lib.mjs";

function withCookies(statusCode, body, cookies) {
  const extra = {};
  if (cookies.length === 1) extra["Set-Cookie"] = cookies[0];
  const res = jsonResponse(statusCode, body, extra);
  if (cookies.length > 1) res.multiValueHeaders = { "Set-Cookie": cookies };
  return res;
}

export async function handleAmareAuthProfileBegin(event, deps = {}) {
  if (!amareAuthEnabled() || !emailOtpRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const user = await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user.signedIn || !user.amareUserId) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const headers = event.headers || {};
  const result = await beginAmareProfileTx(
    { amareUserId: user.amareUserId, siteId: deps.siteId },
    {
      identity: deps.identity,
      searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
    },
  );

  const cookies = [];
  if (result.ok && result.profileTx) {
    cookies.push(buildProfileTxCookie(result.profileTx, headers));
    cookies.push(clearCookie(AMARE_CLAIM_TX_COOKIE, headers));
    return withCookies(200, {
      ok: true,
      claimStatus: "needs_profile",
      profileTxToken: sealProfileTxToken(result.profileTx),
    }, cookies);
  }
  if (result.claimTx) cookies.push(buildClaimTxCookie(result.claimTx, headers));
  cookies.push(clearCookie(AMARE_PROFILE_TX_COOKIE, headers));
  return withCookies(result.statusCode || 400, {
    ok: false,
    error: result.error,
    claimStatus: result.claimStatus || null,
  }, cookies);
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthProfileBegin);
export default withLambda(lambdaHandler);
