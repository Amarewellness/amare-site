/**
 * POST /api/admin/annual-memberships — controlled annual membership mutations.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  adminCancelAnnualRenewal,
  adminRevokeAnnualTerm,
} from "./annual-membership-admin-actions.mjs";

/** @param {unknown} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers =
    /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
      if (got.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < got.length; i += 1) {
        mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    }
  }
  return false;
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, { ok: true });
  }
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!adminAuthorized(event)) {
    return jsonResponse(401, {
      ok: false,
      error: "unauthorized",
      hint: "Set x-admin-token to ADMIN_DEBUG_TOKEN",
    });
  }

  let body = {};
  try {
    body =
      event.body && typeof event.body === "string"
        ? JSON.parse(event.body)
        : /** @type {Record<string, unknown>} */ (event.body ?? {});
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json_body" });
  }

  const action = String(body.action || "").trim();
  const annualMembershipId = String(body.annualMembershipId || body.id || "").trim();
  if (!annualMembershipId) {
    return jsonResponse(400, { ok: false, error: "annual_membership_id_required" });
  }

  try {
    if (action === "cancel_renewal") {
      const result = await adminCancelAnnualRenewal(annualMembershipId);
      if (!result.ok) {
        return jsonResponse(result.error === "membership_not_found" ? 404 : 409, {
          ok: false,
          ...result,
        });
      }
      return jsonResponse(200, { ok: true, ...result });
    }

    if (action === "revoke_term") {
      const result = await adminRevokeAnnualTerm(annualMembershipId, {
        confirmStop: typeof body.confirmStop === "string" ? body.confirmStop : "",
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      if (!result.ok) {
        const status =
          result.error === "membership_not_found"
            ? 404
            : result.error === "confirm_stop_required"
              ? 400
              : 409;
        return jsonResponse(status, { ok: false, ...result });
      }
      return jsonResponse(200, { ok: true, ...result });
    }

    return jsonResponse(400, {
      ok: false,
      error: "unknown_action",
      allowed: ["cancel_renewal", "revoke_term"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, {
      ok: false,
      error: "annual_membership_admin_mutation_failed",
      message: message.slice(0, 240),
    });
  }
}
