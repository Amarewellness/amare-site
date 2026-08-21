/**
 * POST /api/amare/auth/profile/create
 *
 * D28 brand-new Email OTP Studio profile. Requires amare_sess + amare_profile_tx.
 */

import { amareAuthEnabled, isForeignOriginMutation, resolveAmareUser } from "./amare-sess-lib.mjs";
import {
  buildClaimTxCookie,
  buildProfileTxCookie,
  clearCookie,
  disabledAuthResponse,
  emailOtpRoutesEnabled,
  jsonResponse,
  readProfileTxCookie,
  readProfileTxToken,
  withAmareMobileTokens,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_PROFILE_TX_COOKIE,
} from "./amare-auth-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { createAmareStudioProfile } from "./amare-auth-profile-lib.mjs";

function cookieHeader(event) {
  return event.headers?.cookie || event.headers?.Cookie || "";
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function withCookies(statusCode, body, cookies) {
  const extra = {};
  if (cookies.length === 1) extra["Set-Cookie"] = cookies[0];
  const res = jsonResponse(statusCode, body, extra);
  if (cookies.length > 1) res.multiValueHeaders = { "Set-Cookie": cookies };
  return res;
}

export async function handleAmareAuthProfileCreate(event, deps = {}) {
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

  const body = parseBody(event);
  const headers = event.headers || {};
  const profileTx = readProfileTxCookie(cookieHeader(event)) || readProfileTxToken(body.profileTx);
  const result = await createAmareStudioProfile(
    {
      amareUserId: user.amareUserId,
      profileTx,
      firstName: body.firstName,
      lastName: body.lastName,
      mobilePhone: body.mobilePhone,
      explicitCreate: body.explicitCreate === true,
      body,
      siteId: deps.siteId,
    },
    {
      identity: deps.identity,
      searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
      createStudioClient: deps.createStudioClient,
      resolveStaffAuthHeaders: deps.resolveStaffAuthHeaders,
      staffHeaders: deps.staffHeaders,
      withLock: deps.withLock,
    },
  );

  const cookies = [];
  if (result.ok) {
    cookies.push(clearCookie(AMARE_PROFILE_TX_COOKIE, headers));
    cookies.push(clearCookie(AMARE_CLAIM_TX_COOKIE, headers));
    return withCookies(200, withAmareMobileTokens({
      ok: true,
      status: result.status || "linked",
      claimStatus: result.status || "linked",
      claimMethod: result.claimMethod || "new_profile_created",
      amareUserId: user.amareUserId,
    }, user.amareUserId), cookies);
  }

  if (result.claimTx) cookies.push(buildClaimTxCookie(result.claimTx, headers));
  if (result.claimStatus && result.claimStatus !== "needs_profile") {
    cookies.push(clearCookie(AMARE_PROFILE_TX_COOKIE, headers));
  }
  if (result.profileTx) cookies.push(buildProfileTxCookie(result.profileTx, headers));

  return withCookies(result.statusCode || 400, {
    ok: false,
    error: result.error,
    field: result.field,
    claimStatus: result.claimStatus || null,
  }, cookies);
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthProfileCreate);
export default withLambdaMobileCors(lambdaHandler);
