/**
 * POST /api/amare/auth/email/verify-code
 * Possession of the OTP authenticates. Studio claim is evaluated separately.
 * Never writes verified/linked.
 */

import {
  buildClaimTxCookie,
  buildPendingLinkCookie,
  buildProfileTxCookie,
  claimStatusForVerifyResponse,
  clearCookie,
  disabledAuthResponse,
  emailOtpRoutesEnabled,
  isForeignOriginMutation,
  issueEmailAmareSession,
  jsonResponse,
  readMbSessClientId,
  sealProfileTxToken,
  verifyEmailOtp,
  withAmareMobileTokens,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_PENDING_LINK_COOKIE,
  AMARE_PROFILE_TX_COOKIE,
} from "./amare-auth-lib.mjs";
import { withLambda } from "@netlify/aws-lambda-compat";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

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

export async function handleAmareAuthEmailVerify(event, deps = {}) {
  if (!emailOtpRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const body = parseBody(event);
  const mb = readMbSessClientId(cookieHeader(event));
  const result = await verifyEmailOtp(
    {
      email: body.email,
      code: body.code,
      mbSessClientId: mb.clientId,
      siteId: deps.siteId,
      orderIdHint: body.orderId,
    },
    {
      otp: deps.otp,
      identity: deps.identity,
      searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
      pepper: deps.pepper,
      getOrder:
        deps.getOrder ||
        (async (orderId) => {
          const { openOrderStore } = await import("./stripe-order-store.mjs");
          return openOrderStore(event).get(orderId);
        }),
    },
  );
  if (!result.ok) {
    return jsonResponse(result.statusCode || 401, { ok: false, error: "invalid_code" });
  }

  const headers = event.headers || {};
  const cookies = [];
  if (result.outcome === "pending_attach") {
    cookies.push(buildPendingLinkCookie(result.pending, headers));
    return jsonResponse(
      200,
      { ok: true, status: "pending_attach" },
      cookies.length === 1 ? { "Set-Cookie": cookies[0] } : {},
    );
  }

  const issued = issueEmailAmareSession(result.amare_user_id, headers);
  if (issued?.cookie) cookies.push(issued.cookie);
  if (result.claimTx) cookies.push(buildClaimTxCookie(result.claimTx, headers));
  else cookies.push(clearCookie(AMARE_CLAIM_TX_COOKIE, headers));
  if (result.profileTx) cookies.push(buildProfileTxCookie(result.profileTx, headers));
  else cookies.push(clearCookie(AMARE_PROFILE_TX_COOKIE, headers));
  cookies.push(clearCookie(AMARE_PENDING_LINK_COOKIE, headers));

  const extra = {};
  if (cookies.length === 1) extra["Set-Cookie"] = cookies[0];
  const bodyOut = withAmareMobileTokens(
    {
      ok: true,
      signedIn: true,
      amareUserId: result.amare_user_id,
      claimStatus: claimStatusForVerifyResponse(result.claim),
      maskedEmail: result.maskedEmail || null,
      purchaseConnected: result.purchaseConnected === true,
    },
    result.amare_user_id,
  );
  if (bodyOut.accessToken && result.profileTx) {
    bodyOut.profileTxToken = sealProfileTxToken(result.profileTx);
  }
  const res = jsonResponse(200, bodyOut, extra);
  if (cookies.length > 1) res.multiValueHeaders = { "Set-Cookie": cookies };
  return res;
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthEmailVerify);
export default withLambda(lambdaHandler);
