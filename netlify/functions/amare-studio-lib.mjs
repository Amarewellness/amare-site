/**
 * AMARÉ Studio authorization.
 * clientId is resolved only from a linked association. Never from the frontend.
 */

import { amareAuthEnabled, resolveAmareUser } from "./amare-sess-lib.mjs";
import { amareSiteId, readMbSessClientId } from "./amare-auth-lib.mjs";
import { jsonResponse, resolveConsumerClient } from "./mindbody-consumer-lib.mjs";
import { resolveStaffAuthHeaders } from "./mindbody-class-book-lib.mjs";

export function amareMemberReadEnabled() {
  return amareAuthEnabled() && (process.env.ENABLE_AMARE_MEMBER_READ || "").trim() === "1";
}

export function amareStudioOperationsEnabled() {
  return amareAuthEnabled() && (process.env.ENABLE_AMARE_STUDIO_OPERATIONS || "").trim() === "1";
}

export function amareStudioClientResolveEnabled() {
  return amareMemberReadEnabled() || amareStudioOperationsEnabled();
}

function cookieHeader(event) {
  return event?.headers?.cookie || event?.headers?.Cookie || "";
}

/**
 * Identity-store ownership from `amare_sess`. Requires ENABLE_AMARE_AUTH only.
 * Does not require member-read or studio-ops, and does not authorize those
 * capabilities by itself. Checkout uses this so a linked AMARÉ session is
 * never treated as anonymous when ENABLE_AMARE_COMMERCE=0.
 *
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{
 *   findUser?: (id: string) => Promise<unknown>;
 *   getLinkedAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string, client_id?: unknown } | null>;
 *   getLatestAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string } | null>;
 * }} [deps]
 */
export async function resolveAmareLinkedOwnership(event, deps = {}) {
  if (!amareAuthEnabled()) return { ok: false, reason: "flag_off", amareUserId: null, clientId: null };

  const user = await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user.signedIn || !user.amareUserId) {
    return { ok: false, reason: "signed_out", amareUserId: null, clientId: null };
  }

  const siteId = amareSiteId();
  const identity = deps.getLinkedAssociation
    ? deps
    : await import("./amare-identity-store.mjs");
  const linked = await identity.getLinkedAssociation(user.amareUserId, siteId);
  if (!linked) {
    const mbPending = readMbSessClientId(cookieHeader(event));
    if (mbPending.valid && mbPending.clientId) {
      console.warn(
        JSON.stringify({
          event: "amare_sess_conflicts_mb_sess",
          amare_user_id: user.amareUserId,
        }),
      );
      return { ok: false, reason: "session_conflict", amareUserId: user.amareUserId, clientId: null };
    }
    const latest =
      typeof identity.getLatestAssociation === "function"
        ? await identity.getLatestAssociation(user.amareUserId, siteId)
        : null;
    const status = latest && typeof latest.status === "string" ? latest.status : "";
    const reason =
      status === "verified"
        ? "verified_pending_link"
        : status === "conflict"
          ? "association_conflict"
          : "not_authorized";
    return { ok: false, reason, amareUserId: user.amareUserId, clientId: null };
  }

  const clientId = Number(linked.client_id);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return { ok: false, reason: "not_authorized", amareUserId: user.amareUserId, clientId: null };
  }

  const mb = readMbSessClientId(cookieHeader(event));
  if (mb.valid && mb.clientId && mb.clientId !== clientId) {
    console.warn(
      JSON.stringify({
        event: "amare_sess_conflicts_mb_sess",
        amare_user_id: user.amareUserId,
      }),
    );
    return { ok: false, reason: "session_conflict", amareUserId: user.amareUserId, clientId: null };
  }
  if (mb.valid && mb.clientId === clientId) {
    console.log(
      JSON.stringify({
        event: "amare_sess_aligns_mb_sess",
        amare_user_id: user.amareUserId,
      }),
    );
  }

  return { ok: true, reason: "linked", amareUserId: user.amareUserId, clientId };
}

/**
 * Studio member-read / studio-ops resolver. Same ownership rules as
 * `resolveAmareLinkedOwnership`, but only when those flags are on.
 *
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{
 *   findUser?: (id: string) => Promise<unknown>;
 *   getLinkedAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string, client_id?: unknown } | null>;
 *   getLatestAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string } | null>;
 * }} [deps]
 */
export async function resolveAmareStudioClient(event, deps = {}) {
  if (!amareStudioClientResolveEnabled()) return { ok: false, reason: "flag_off", amareUserId: null, clientId: null };
  return resolveAmareLinkedOwnership(event, deps);
}

export function studioAccessFromResolve(result) {
  if (!result || result.reason === "signed_out" || result.reason === "flag_off") return "none";
  if (result.ok) return "linked";
  if (result.reason === "verified_pending_link") return "verified_pending_link";
  if (result.reason === "session_conflict" || result.reason === "association_conflict") return "conflict";
  return "none";
}

/**
 * needs_profile only from successful Staff zero-match provenance.
 * Generic unlinked is not enough.
 *
 * @param {{ status?: string; block_reason?: string | null } | null | undefined} latest
 */
export function studioAccessFromLatestAssociation(latest) {
  if (!latest || typeof latest !== "object") return null;
  const status = String(latest.status || "");
  const reason = String(latest.block_reason || "");
  if (status === "unlinked" && reason === "staff_zero_match") return "needs_profile";
  if (reason === "staff_search_unavailable") return "search_unavailable";
  if (status === "candidate") return "candidate";
  if (status === "ambiguous") return "ambiguous";
  return null;
}

function conflictResponse() {
  return {
    ok: false,
    reason: "session_conflict",
    clientId: null,
    authSource: null,
    response: jsonResponse(409, { ok: false, error: "session_conflict" }),
  };
}

/**
 * Provider-neutral Studio customer for reads and mutations.
 * AMARÉ linked association wins when studio operations (or member-read resolve) is on.
 * Legacy mb_sess remains the fallback. clientId is never taken from the browser.
 *
 * @param {import("@netlify/functions").HandlerEvent} event
 */
export async function resolveStudioCustomer(event, deps = {}) {
  const opsOn = amareStudioOperationsEnabled();
  const resolveOn = amareStudioClientResolveEnabled();
  let amare = { ok: false, reason: "flag_off", amareUserId: null, clientId: null };
  if (resolveOn) {
    amare = await resolveAmareStudioClient(event, deps);
    if (amare.reason === "session_conflict") return conflictResponse();
  }

  const consumer = deps.resolveConsumerClient
    ? await deps.resolveConsumerClient(event)
    : await resolveConsumerClient(event);
  if (amare.amareUserId && consumer.ok) {
    if (!(amare.ok && Number(consumer.clientId) === Number(amare.clientId))) {
      return conflictResponse();
    }
  }

  if (opsOn && amare.ok) {
    const staffHeaders = deps.resolveStaffAuthHeaders
      ? await deps.resolveStaffAuthHeaders()
      : await resolveStaffAuthHeaders();
    if (!staffHeaders) {
      return {
        ok: false,
        reason: "studio_ops_unavailable",
        clientId: null,
        authSource: null,
        response: jsonResponse(503, { ok: false, error: "studio_ops_unavailable" }),
      };
    }
    return {
      ok: true,
      reason: "linked",
      clientId: amare.clientId,
      authSource: "amare",
      amareUserId: amare.amareUserId,
      authHeaders: staffHeaders,
      session: consumer.ok ? consumer.session || {} : {},
      email: consumer.ok ? consumer.email : null,
      consumerCtx: consumer.ok ? consumer : null,
      setCookie: consumer.ok ? consumer.setCookie : undefined,
    };
  }

  if (consumer.ok) {
    return {
      ok: true,
      reason: "mindbody",
      clientId: consumer.clientId,
      authSource: "mindbody",
      amareUserId: amare.amareUserId || null,
      authHeaders: consumer.authHeaders,
      session: consumer.session,
      email: consumer.email,
      consumerCtx: consumer,
      setCookie: consumer.setCookie,
    };
  }

  return {
    ok: false,
    reason: amare.reason === "signed_out" || amare.reason === "flag_off" ? "not_authenticated" : amare.reason,
    clientId: null,
    authSource: null,
    response: consumer.response,
  };
}
