/**
 * GET /api/amare/auth/session
 *
 * Read-only AMARÉ identity probe. Does not replace /api/mindbody/oauth/session.
 * Does not expose clientId, tokens, or claim proof.
 *
 * claimStatus stays off this endpoint. Claim UI uses verify / pending-link /
 * claim/confirm. Do not couple authentication to Studio ownership here.
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import {
  AmareSessionConfigError,
  amareAuthEnabled,
  resolveAmareUser,
} from "./amare-sess-lib.mjs";

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

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ findUser?: (id: string) => Promise<unknown> }} [options]
 */
export async function handleAmareAuthSession(event, options = {}) {
  if (!amareAuthEnabled()) return disabled();
  const method = event.httpMethod || "GET";
  if (method !== "GET" && method !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  try {
    const user = await resolveAmareUser(event, options);
    if (!user.signedIn) {
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ signedIn: false }),
      };
    }
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({ signedIn: true, amareUserId: user.amareUserId }),
    };
  } catch (err) {
    if (err instanceof AmareSessionConfigError || err?.code === "amare_session_configuration_error") {
      return {
        statusCode: 500,
        headers: jsonHeaders,
        body: JSON.stringify({ ok: false, error: "configuration_error" }),
      };
    }
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ ok: false, error: "session_probe_failed" }),
    };
  }
}

export async function lambdaHandler(event) {
  return handleAmareAuthSession(event);
}

export default withLambda(lambdaHandler);
