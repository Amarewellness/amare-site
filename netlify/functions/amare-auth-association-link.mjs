/**
 * POST /api/amare/auth/association/link
 *
 * Explicit verified → linked. Does not run on login.
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import { amareAuthEnabled, isForeignOriginMutation, resolveAmareUser } from "./amare-sess-lib.mjs";
import { amareMemberReadEnabled } from "./amare-studio-lib.mjs";
import { amareSiteId } from "./amare-auth-lib.mjs";
import { promoteAssociationToLinked } from "./amare-identity-store.mjs";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function disabled() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "amare_auth_disabled",
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

export async function handleAmareAuthAssociationLink(event) {
  if (!amareAuthEnabled() || !amareMemberReadEnabled()) return disabled();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const body = parseBody(event);
  if (body.explicitPromote !== true) return jsonResponse(400, { ok: false, error: "explicit_promote_required" });
  if (body.clientId != null || body.client_id != null) {
    return jsonResponse(400, { ok: false, error: "client_id_not_authority" });
  }

  const user = await resolveAmareUser(event);
  if (!user.signedIn || !user.amareUserId) return jsonResponse(401, { ok: false, error: "signed_out" });

  try {
    const result = await promoteAssociationToLinked({
      amare_user_id: user.amareUserId,
      site_id: amareSiteId(),
      explicitPromote: true,
    });
    return jsonResponse(200, { ok: true, status: result.status });
  } catch (err) {
    const message = String(err?.message || err);
    if (message === "claim_conflict") return jsonResponse(409, { ok: false, error: "claim_conflict" });
    if (message === "linked_requires_verified") return jsonResponse(409, { ok: false, error: "not_verified" });
    if (message === "linked_forbidden_in_phase1") return disabled();
    throw err;
  }
}

export async function lambdaHandler(event) {
  return handleAmareAuthAssociationLink(event);
}

export default withLambda(lambdaHandler);
