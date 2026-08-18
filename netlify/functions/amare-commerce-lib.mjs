/**
 * AMARÉ provider-neutral commerce customer resolver.
 *
 * ENABLE_AMARE_COMMERCE (default OFF) requires ENABLE_AMARE_AUTH=1.
 * Production stays off until review.
 *
 * Compatibility:
 *   Browser-supplied knownMindbodyClientId / clientId / client_id are never
 *   ownership. clientId comes only from cookies (amare_sess linked association
 *   or mb_sess).
 *
 *   ENABLE_AMARE_COMMERCE=0 does NOT erase authenticated ownership.
 *   A valid amare_sess + linked Studio client stays AMARE_LINKED (or
 *   DUAL_ALIGNED / CONFLICT / recovery). It is never rewritten to SIGNED_OUT
 *   and never becomes an anonymous guest form / AddClient / unknown Stripe
 *   customer. Purchases still use existing Stripe one-time/recurring flags
 *   with the server-resolved clientId (legacy-compatible customer path).
 *
 *   Unsigned browsers use the genuine anonymous guest path.
 *
 * Does not change mb_sess name, format, MINDBODY_SESSION_SECRET, or OAuth
 * session behavior. Does not clear mb_sess.
 */

import crypto from "node:crypto";
import { amareAuthEnabled, maybeIssueAmareSession, requireAmareSessionSecret } from "./amare-sess-lib.mjs";
import { amareSiteId, readMbSessClientId } from "./amare-auth-lib.mjs";
import { parseCookies, sealCookiePayload, sessionSecret, unsealCookiePayload } from "./oauth-lib.mjs";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  resolveAmareLinkedOwnership,
  studioAccessFromLatestAssociation,
} from "./amare-studio-lib.mjs";

export const COMMERCE_STATES = Object.freeze({
  SIGNED_OUT: "SIGNED_OUT",
  AMARE_LINKED: "AMARE_LINKED",
  MINDBODY_LINKED: "MINDBODY_LINKED",
  DUAL_ALIGNED: "DUAL_ALIGNED",
  NEEDS_PROFILE: "NEEDS_PROFILE",
  CANDIDATE: "CANDIDATE",
  AMBIGUOUS: "AMBIGUOUS",
  CONFLICT: "CONFLICT",
});

/** Allowlisted SKUs that may resume after profile/claim. Never trust arbitrary SKUs. */
export const SAFE_COMMERCE_SKUS = Object.freeze([
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "drop_in_same_day",
  "pack_10_classes",
  "pack_20_classes",
  "monthly_5",
  "monthly_8",
  "monthly_unlimited",
]);

export function amareCommerceEnabled() {
  return amareAuthEnabled() && (process.env.ENABLE_AMARE_COMMERCE || "").trim() === "1";
}

export function isSafeCommerceSku(raw) {
  const sku = String(raw || "").trim();
  return SAFE_COMMERCE_SKUS.includes(sku);
}

export function maskCommerceEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at < 1 || !normalized.includes(".", at)) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}***@${domain}`;
}

export function bodyHasBrowserClientId(body) {
  if (!body || typeof body !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (body);
  return (
    o.knownMindbodyClientId != null ||
    o.clientId != null ||
    o.client_id != null ||
    o.mindbodyClientId != null ||
    o.mindbody_client_id != null
  );
}

/**
 * Legacy body parser. Kept for tests and log detection only.
 * Checkout must never treat the result as ownership proof.
 * @param {Record<string, unknown>} body
 * @returns {number | null}
 */
export function parseBodyKnownClientId(body) {
  if (!body || typeof body !== "object") return null;
  const raw =
    /** @type {{ knownMindbodyClientId?: unknown }} */ (body).knownMindbodyClientId ??
    /** @type {{ clientId?: unknown }} */ (body).clientId ??
    /** @type {{ client_id?: unknown }} */ (body).client_id;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === "string" && /^\d{1,18}$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  return null;
}

export function isPurchaseLinkedState(state) {
  return (
    state === COMMERCE_STATES.AMARE_LINKED ||
    state === COMMERCE_STATES.MINDBODY_LINKED ||
    state === COMMERCE_STATES.DUAL_ALIGNED
  );
}

export function isBlockedCommerceState(state) {
  return (
    state === COMMERCE_STATES.CONFLICT ||
    state === COMMERCE_STATES.NEEDS_PROFILE ||
    state === COMMERCE_STATES.CANDIDATE ||
    state === COMMERCE_STATES.AMBIGUOUS
  );
}

/**
 * Unseal mb_sess for commerce identity only. Does not change cookie format.
 * @param {string} cookieHeader
 */
export function readMbSessIdentity(cookieHeader) {
  const raw = parseCookies(cookieHeader || "").mb_sess;
  if (!raw) return { valid: false, clientId: null, email: null };
  try {
    const data = unsealCookiePayload(raw, sessionSecret());
    const rawId = data?.client_id ?? data?.clientId;
    const n = typeof rawId === "number" ? rawId : typeof rawId === "string" ? parseInt(rawId, 10) : NaN;
    const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
    return {
      valid: true,
      clientId: Number.isFinite(n) && n > 0 ? n : null,
      email: email && email.includes("@") ? email : null,
    };
  } catch {
    return { valid: false, clientId: null, email: null };
  }
}

function cookieHeader(event) {
  return event?.headers?.cookie || event?.headers?.Cookie || "";
}

function emptyResult(state, extras = {}) {
  return {
    enabled: true,
    state,
    ok: false,
    canPurchase: false,
    canPurchaseAnonymous: state === COMMERCE_STATES.SIGNED_OUT,
    clientId: null,
    amareUserId: null,
    authSource: null,
    mbEmail: null,
    reason: extras.reason || state.toLowerCase(),
    ...extras,
  };
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{
 *   findUser?: (id: string) => Promise<unknown>;
 *   getLinkedAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string, client_id?: unknown } | null>;
 *   getLatestAssociation?: (amareUserId: string, siteId: string) => Promise<{ status?: string, block_reason?: string | null } | null>;
 *   readMbSessIdentity?: (cookieHeader: string) => { valid: boolean, clientId: number | null, email?: string | null };
 *   resolveAmareUser?: typeof resolveAmareUser;
 * }} [deps]
 */
export async function resolveCommerceCustomer(event, deps = {}) {
  const commerceOn = amareCommerceEnabled();
  /**
   * @param {Record<string, unknown>} result
   */
  const stamp = (result) => ({
    ...result,
    enabled: commerceOn,
    compatibility: commerceOn
      ? "commerce_on_server_resolved_ownership"
      : "commerce_flag_off_preserves_authenticated_ownership",
  });
  const cookies = cookieHeader(event);
  const mb = deps.readMbSessIdentity ? deps.readMbSessIdentity(cookies) : readMbSessIdentity(cookies);
  const mbClient =
    mb.clientId != null
      ? mb
      : (() => {
          const fallback = readMbSessClientId(cookies);
          return { valid: fallback.valid, clientId: fallback.clientId, email: mb.email || null };
        })();

  let amare = { ok: false, reason: "flag_off", amareUserId: null, clientId: null };
  if (amareAuthEnabled()) {
    amare = deps.resolveAmareLinkedOwnership
      ? await deps.resolveAmareLinkedOwnership(event, deps)
      : await resolveAmareLinkedOwnership(event, deps);
  }

  if (amare.reason === "session_conflict" || amare.reason === "association_conflict") {
    return stamp(emptyResult(COMMERCE_STATES.CONFLICT, {
      amareUserId: amare.amareUserId || null,
      reason: amare.reason,
    }));
  }

  if (amare.ok && Number(amare.clientId) > 0) {
    const clientId = Number(amare.clientId);
    const aligned = mbClient.valid && mbClient.clientId != null && Number(mbClient.clientId) === clientId;
    return stamp({
      enabled: commerceOn,
      state: aligned ? COMMERCE_STATES.DUAL_ALIGNED : COMMERCE_STATES.AMARE_LINKED,
      ok: true,
      canPurchase: true,
      canPurchaseAnonymous: false,
      clientId,
      amareUserId: amare.amareUserId,
      authSource: aligned ? "dual" : "amare",
      mbEmail: mbClient.email || null,
      reason: aligned ? "dual_aligned" : "amare_linked",
    });
  }

  if (amare.amareUserId) {
    try {
      const identity = deps.getLatestAssociation
        ? deps
        : await import("./amare-identity-store.mjs");
      const latest = await identity.getLatestAssociation(amare.amareUserId, amareSiteId());
      const fromLatest = studioAccessFromLatestAssociation(latest);
      if (fromLatest === "needs_profile") {
        return stamp(emptyResult(COMMERCE_STATES.NEEDS_PROFILE, { amareUserId: amare.amareUserId }));
      }
      if (fromLatest === "ambiguous" || amare.reason === "association_conflict") {
        return stamp(emptyResult(COMMERCE_STATES.AMBIGUOUS, { amareUserId: amare.amareUserId }));
      }
      if (fromLatest === "candidate" || amare.reason === "verified_pending_link") {
        return stamp(emptyResult(COMMERCE_STATES.CANDIDATE, {
          amareUserId: amare.amareUserId,
          reason: amare.reason === "verified_pending_link" ? "verified_pending_link" : "candidate",
        }));
      }
    } catch {
      /* fall through to candidate — signed-in AMARÉ is never treated as anonymous */
    }
    if (mbClient.valid && mbClient.clientId) {
      return stamp(emptyResult(COMMERCE_STATES.CONFLICT, {
        amareUserId: amare.amareUserId,
        reason: "session_conflict",
      }));
    }
    return stamp(emptyResult(COMMERCE_STATES.CANDIDATE, {
      amareUserId: amare.amareUserId,
      reason: amare.reason || "not_authorized",
    }));
  }

  if (mbClient.valid && mbClient.clientId) {
    return stamp({
      enabled: commerceOn,
      state: COMMERCE_STATES.MINDBODY_LINKED,
      ok: true,
      canPurchase: true,
      canPurchaseAnonymous: false,
      clientId: Number(mbClient.clientId),
      amareUserId: null,
      authSource: "mindbody",
      mbEmail: mbClient.email || null,
      reason: "mindbody_linked",
    });
  }

  if (mbClient.valid) {
    return stamp({
      enabled: commerceOn,
      state: COMMERCE_STATES.MINDBODY_LINKED,
      ok: true,
      canPurchase: true,
      canPurchaseAnonymous: false,
      clientId: null,
      amareUserId: null,
      authSource: "mindbody",
      mbEmail: mbClient.email || null,
      reason: "mb_sess_no_client_id",
    });
  }

  return stamp(emptyResult(COMMERCE_STATES.SIGNED_OUT, { reason: "signed_out" }));
}

/**
 * Public status JSON. Never includes clientId.
 * @param {Awaited<ReturnType<typeof resolveCommerceCustomer>>} resolved
 * @param {{ maskedEmail?: string | null, displayName?: string | null }} [view]
 */
export function commercePublicStatus(resolved, view = {}) {
  const state = resolved?.state || COMMERCE_STATES.SIGNED_OUT;
  return {
    ok: true,
    commerceEnabled: resolved?.enabled === true,
    state,
    signedIn:
      Boolean(resolved?.amareUserId) ||
      isPurchaseLinkedState(state) ||
      isBlockedCommerceState(state),
    maskedEmail: view.maskedEmail || null,
    displayName: view.displayName || null,
    studioAccess:
      state === COMMERCE_STATES.AMARE_LINKED || state === COMMERCE_STATES.DUAL_ALIGNED
        ? "linked"
        : state === COMMERCE_STATES.NEEDS_PROFILE
          ? "needs_profile"
          : state === COMMERCE_STATES.CANDIDATE
            ? resolved?.reason === "verified_pending_link"
              ? "verified_pending_link"
              : "candidate"
            : state === COMMERCE_STATES.AMBIGUOUS
              ? "ambiguous"
              : state === COMMERCE_STATES.CONFLICT
                ? "conflict"
                : state === COMMERCE_STATES.MINDBODY_LINKED
                  ? "mindbody"
                  : "none",
  };
}

/**
 * @param {Awaited<ReturnType<typeof resolveCommerceCustomer>>} resolved
 * @returns {import("@netlify/functions").HandlerResponse | null}
 */
export function commerceCheckoutRejectResponse(resolved) {
  if (!resolved) return null;
  if (resolved.state === COMMERCE_STATES.CONFLICT) {
    return jsonResponse(409, {
      ok: false,
      error: "session_conflict",
      message: "This browser has two different studio accounts. Sign out and try again.",
    });
  }
  if (resolved.state === COMMERCE_STATES.NEEDS_PROFILE) {
    return jsonResponse(409, {
      ok: false,
      error: "commerce_needs_profile",
      message: "Complete your AMARÉ profile before purchasing.",
    });
  }
  if (resolved.state === COMMERCE_STATES.CANDIDATE) {
    return jsonResponse(409, {
      ok: false,
      error: "commerce_claim_required",
      message: "Confirm your studio profile before purchasing.",
    });
  }
  if (resolved.state === COMMERCE_STATES.AMBIGUOUS) {
    return jsonResponse(409, {
      ok: false,
      error: "commerce_ambiguous",
      message: "We could not connect this sign-in to a studio profile. Please contact the studio.",
    });
  }
  return null;
}

const APP_CHECKOUT_HANDOFF_TTL_MS = 5 * 60 * 1000;
/** @type {Set<string>} */
const consumedAppCheckoutHandoffs = new Set();

export function resetAppCheckoutHandoffsForTests() {
  consumedAppCheckoutHandoffs.clear();
}

/**
 * Short-lived sealed handoff. Identity only — no clientId, no email authority.
 * @param {{ amareUserId: string }} input
 */
export function issueAppCheckoutHandoff(input) {
  const amareUserId = String(input?.amareUserId || "").trim();
  if (!amareUserId.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  const nonce = crypto.randomBytes(16).toString("base64url");
  const token = sealCookiePayload(
    {
      kind: "app_checkout_handoff",
      amare_user_id: amareUserId,
      nonce,
      exp: Date.now() + APP_CHECKOUT_HANDOFF_TTL_MS,
    },
    requireAmareSessionSecret(),
  );
  return { token, nonce, expiresIn: Math.floor(APP_CHECKOUT_HANDOFF_TTL_MS / 1000) };
}

/**
 * @param {string} raw
 * @returns {{ amareUserId: string } | null}
 */
export function consumeAppCheckoutHandoff(raw) {
  const sealed = String(raw || "").trim();
  if (!sealed) return null;
  try {
    const data = unsealCookiePayload(sealed, requireAmareSessionSecret());
    if (!data || data.kind !== "app_checkout_handoff") return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    const amareUserId = String(data.amare_user_id || "").trim();
    if (!amareUserId.startsWith("usr_")) return null;
    const nonce = String(data.nonce || "").trim();
    if (!nonce || consumedAppCheckoutHandoffs.has(nonce)) return null;
    consumedAppCheckoutHandoffs.add(nonce);
    return { amareUserId };
  } catch {
    return null;
  }
}

export function issueAmareSessFromAppCheckoutHandoff(amareUserId, headers = {}) {
  return maybeIssueAmareSession({ amare_user_id: amareUserId, headers });
}

/**
 * Deterministic Stripe Customer picker when several records share a Studio clientId.
 * Does not delete or merge. Prefers exact metadata, then an active subscription,
 * then the oldest created id.
 *
 * @param {Array<{ id?: string, metadata?: Record<string, string>, created?: number, hasActiveSubscription?: boolean, deleted?: boolean }>} candidates
 * @param {string | number} clientId
 */
export function pickStripeCustomerFromCandidates(candidates, clientId) {
  const idStr = String(clientId || "");
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.id && !c.deleted);
  const exact = list.filter((c) => c.metadata && String(c.metadata.mindbodyClientId || "") === idStr);
  if (exact.length === 1) {
    return { customer: exact[0], reason: "exact_metadata", duplicates: false };
  }
  if (exact.length > 1) {
    const withSub = exact.filter((c) => c.hasActiveSubscription === true);
    const pool = withSub.length ? withSub : exact;
    const sorted = [...pool].sort((a, b) => {
      const ac = typeof a.created === "number" ? a.created : 0;
      const bc = typeof b.created === "number" ? b.created : 0;
      if (ac !== bc) return ac - bc;
      return String(a.id).localeCompare(String(b.id));
    });
    return {
      customer: sorted[0],
      reason: withSub.length ? "exact_metadata_active_sub" : "exact_metadata_oldest",
      duplicates: true,
    };
  }
  return { customer: null, reason: "none", duplicates: false };
}
