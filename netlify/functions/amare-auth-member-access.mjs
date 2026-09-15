/**
 * GET /api/amare/auth/member-access
 *
 * Non-authority UI contract for 2B member-read. No clientId.
 * email/displayName are presentation only — not claim or Book authority.
 */

import { amareAuthEnabled, resolveAmareUser } from "./amare-sess-lib.mjs";
import { amareSiteId } from "./amare-auth-lib.mjs";
import { displayEmailFromIdentities, resolveAmareSessionEmail } from "./amare-member-email-lib.mjs";

export { displayEmailFromIdentities } from "./amare-member-email-lib.mjs";
import {
  amareStudioClientResolveEnabled,
  amareStudioOperationsEnabled,
  resolveAmareStudioClient,
  studioAccessFromLatestAssociation,
  studioAccessFromResolve,
} from "./amare-studio-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

async function resolveDisplayEmail(amareUserId, deps) {
  return resolveAmareSessionEmail(amareUserId, deps);
}

function disabled() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "amare_auth_disabled",
  };
}

export async function handleAmareAuthMemberAccess(event, deps = {}) {
  if (!amareAuthEnabled()) return disabled();
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  const user = await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user.signedIn) {
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ signedIn: false }) };
  }
  const email = await resolveDisplayEmail(user.amareUserId, deps);
  const display = email ? { email } : {};
  if (!amareStudioClientResolveEnabled()) {
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({ signedIn: true, studioAccess: "none", studioOperations: false, ...display }),
    };
  }

  const resolved = await resolveAmareStudioClient(event, deps);
  let studioAccess = studioAccessFromResolve(resolved);
  if (studioAccess === "none") {
    try {
      const getLatest =
        typeof deps.getLatestAssociation === "function"
          ? deps.getLatestAssociation
          : (await import("./amare-identity-store.mjs")).getLatestAssociation;
      const latest = await getLatest(user.amareUserId, amareSiteId());
      const fromLatest = studioAccessFromLatestAssociation(latest);
      if (fromLatest) studioAccess = fromLatest;
    } catch {
      /* keep none */
    }
  }
  const body = {
    signedIn: true,
    studioAccess,
    studioOperations: amareStudioOperationsEnabled() && studioAccess === "linked",
    ...display,
  };
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(body) };
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthMemberAccess);
export default withLambdaMobileCors(lambdaHandler);
