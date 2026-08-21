/**
 * POST /api/amare/auth/claim/confirm
 *
 * Authority is the server-side candidate / pending-link cookie, not a browser client_id.
 * candidate → verified. When member-read is on, the same explicit confirm may then promote verified → linked.
 * Login itself never writes linked. Pending-link attaches the pending provider after explicit confirm.
 */

import {
  amareClaimRoutesEnabled,
  buildClearAmareSessionCookie,
  clearCookie,
  confirmAmareClaim,
  disabledAuthResponse,
  isForeignOriginMutation,
  issueAmareSessionAfterClaim,
  jsonResponse,
  readClaimTxCookie,
  readPendingLinkCookie,
  resolveAmareUser,
  withAmareMobileTokens,
  AMARE_CLAIM_TX_COOKIE,
  AMARE_PENDING_LINK_COOKIE,
} from "./amare-auth-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
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

export async function handleAmareAuthClaimConfirm(event, deps = {}) {
  if (!amareClaimRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    console.log(JSON.stringify({ event: "claim_confirm_rejected", reason: "foreign_origin" }));
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const body = parseBody(event);
  const cookies = cookieHeader(event);
  const pending = readPendingLinkCookie(cookies);
  const claimTx = readClaimTxCookie(cookies);
  const claimToken = typeof body.claimToken === "string" ? body.claimToken.trim() : "";

  if (pending) {
    if (claimToken && claimToken !== pending.jti) {
      return jsonResponse(403, { ok: false, error: "invalid_claim_token" });
    }
    const result = await confirmAmareClaim(
      {
        pending,
        explicitConfirm: body.explicitConfirm === true,
        continueAsNew: body.continueAsNew === true,
        siteId: deps.siteId,
      },
      { identity: deps.identity },
    );
    if (!result.ok) return jsonResponse(result.statusCode || 409, { ok: false, error: result.error });
    const issued = issueAmareSessionAfterClaim(result.amare_user_id, event.headers || {});
    const setCookies = [clearCookie(AMARE_PENDING_LINK_COOKIE, event.headers || {})];
    if (issued?.cookie) setCookies.push(issued.cookie);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": setCookies[0],
      },
      multiValueHeaders: setCookies.length > 1 ? { "Set-Cookie": setCookies } : undefined,
      body: JSON.stringify(withAmareMobileTokens({
        ok: true,
        status: result.status,
        amareUserId: result.amare_user_id,
        firstName: null,
        maskedEmail: pending.email ? maskEmail(pending.email) : null,
      }, result.amare_user_id)),
    };
  }

  const user = await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user.signedIn) return jsonResponse(401, { ok: false, error: "signed_out" });
  if (claimTx && claimTx.amare_user_id !== user.amareUserId) {
    console.log(JSON.stringify({ event: "claim_confirm_rejected", reason: "claim_tx_user_mismatch" }));
    return jsonResponse(403, { ok: false, error: "invalid_claim_token" });
  }
  if (claimTx && claimToken && claimToken !== claimTx.jti) {
    console.log(JSON.stringify({ event: "claim_confirm_rejected", reason: "claim_tx_jti_mismatch" }));
    return jsonResponse(403, { ok: false, error: "invalid_claim_token" });
  }

  const result = await confirmAmareClaim(
    {
      amare_user_id: user.amareUserId,
      explicitConfirm: body.explicitConfirm === true,
      displayedClientId: body.client_id ?? body.clientId,
      siteId: deps.siteId,
    },
    { identity: deps.identity },
  );
  if (!result.ok) return jsonResponse(result.statusCode || 409, { ok: false, error: result.error });
  return jsonResponse(
    200,
    withAmareMobileTokens(
      { ok: true, status: result.status || "verified", amareUserId: result.amare_user_id },
      result.amare_user_id,
    ),
    { "Set-Cookie": clearCookie(AMARE_CLAIM_TX_COOKIE, event.headers || {}) },
  );
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return null;
  const keep = local.slice(0, 1);
  return `${keep}***@${domain}`;
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthClaimConfirm);
export default withLambdaMobileCors(lambdaHandler);

export { buildClearAmareSessionCookie };
