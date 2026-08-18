/**
 * GET /api/amare/commerce/status
 *
 * Provider-neutral purchase state for pricing. No clientId.
 * Gated by ENABLE_AMARE_AUTH. ENABLE_AMARE_COMMERCE=0 still returns the real
 * session state (linked / recovery / signed out) so a known AMARÉ customer is
 * never shown as anonymous. commerceEnabled is false in that case.
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import { amareAuthEnabled } from "./amare-sess-lib.mjs";
import { displayEmailFromIdentities } from "./amare-auth-member-access.mjs";
import {
  commercePublicStatus,
  maskCommerceEmail,
  resolveCommerceCustomer,
} from "./amare-commerce-lib.mjs";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function disabled() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "amare_auth_disabled",
  };
}

async function resolveDisplayEmail(amareUserId, deps) {
  if (!amareUserId) return null;
  try {
    const listIdentities =
      typeof deps.listIdentities === "function"
        ? deps.listIdentities
        : (await import("./amare-identity-store.mjs")).listIdentities;
    return displayEmailFromIdentities(await listIdentities(amareUserId));
  } catch {
    return null;
  }
}

export async function handleAmareCommerceStatus(event, deps = {}) {
  if (!amareAuthEnabled()) return disabled();
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  const resolved = await resolveCommerceCustomer(event, deps);
  const email = resolved.amareUserId
    ? await resolveDisplayEmail(resolved.amareUserId, deps)
    : resolved.mbEmail || null;
  const body = commercePublicStatus(resolved, {
    maskedEmail: maskCommerceEmail(email),
    displayName: null,
  });
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(body) };
}

export async function lambdaHandler(event) {
  return handleAmareCommerceStatus(event);
}

export default withLambda(lambdaHandler);
