/**
 * GET /api/amare/auth/member-access
 *
 * Non-authority UI contract for 2B member-read. No clientId.
 * email/displayName are presentation only — not claim or Book authority.
 */

import { amareAuthEnabled, resolveAmareUser } from "./amare-sess-lib.mjs";
import { isApplePrivateRelayEmail } from "./amare-identity-policy.mjs";
import { amareSiteId } from "./amare-auth-lib.mjs";
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

/**
 * Pick a display email from identity rows. Never uses Mindbody provider_sub.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string | null}
 */
export function displayEmailFromIdentities(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const asEmail = (value) => {
    const email = String(value || "").trim().toLowerCase();
    if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) return null;
    return email;
  };
  const fromRow = (row, allowRelay) => {
    const direct = asEmail(row?.email);
    if (direct && (allowRelay || !isApplePrivateRelayEmail(direct))) return direct;
    if (String(row?.provider || "") === "email") {
      const sub = asEmail(row?.provider_sub);
      if (sub && (allowRelay || !isApplePrivateRelayEmail(sub))) return sub;
    }
    return null;
  };
  for (const provider of ["email", "google"]) {
    for (const row of list) {
      if (String(row?.provider || "") !== provider) continue;
      const email = fromRow(row, false);
      if (email) return email;
    }
  }
  for (const row of list) {
    const email = fromRow(row, false);
    if (email) return email;
  }
  for (const row of list) {
    const email = fromRow(row, true);
    if (email) return email;
  }
  return null;
}

async function resolveDisplayEmail(amareUserId, deps) {
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
