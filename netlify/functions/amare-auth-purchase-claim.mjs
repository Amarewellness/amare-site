/**
 * Narrow anonymous-purchase claim helpers.
 * Browser orderId / clientId / email are never ownership — only a lookup key
 * into a server OrderRecord, then these checks.
 */

import { isApplePrivateRelayEmail } from "./amare-identity-policy.mjs";

export const ANONYMOUS_PURCHASE_AUTO_LINK_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeAmareEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) return null;
  if (/\s/.test(email)) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain || !domain.includes(".")) return null;
  return email;
}

const ORDER_ID_RE = /^ord_[A-Z0-9]{8,40}$/i;

export function sanitizeOrderIdHint(raw) {
  const id = String(raw || "").trim();
  return ORDER_ID_RE.test(id) ? id : null;
}

/**
 * Mask the verified OTP email for candidate UI. Never use a browser-supplied address.
 * @param {unknown} email
 * @returns {string | null}
 */
export function maskVerifiedEmailForClaimUi(email) {
  const normalized = normalizeAmareEmail(email);
  if (!normalized) return null;
  const at = normalized.indexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local.slice(0, 1)}••••@${domain}`;
}

function orderClientId(order) {
  const resolved = Number(order?.resolvedMindbodyClientId);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : null;
}

function isAnonymousPurchaseOrder(order) {
  if (!order || typeof order !== "object") return false;
  const source = String(order.commerceAuthSource || "").trim();
  return source === "" || source === "SIGNED_OUT" || source === "anonymous";
}

function orderProvenanceMs(order) {
  const raw = order?.fulfillmentSyncedAt || order?.updatedAt || order?.createdAt;
  const ms = Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {{
 *   verifiedEmail?: unknown;
 *   candidateClientId?: unknown;
 *   candidateCount?: unknown;
 *   currentAmareUserId?: unknown;
 *   existingOwnerUserId?: unknown;
 *   dualSessionConflict?: boolean;
 *   order?: Record<string, unknown> | null;
 *   nowMs?: number;
 * }} input
 * @returns {{ ok: true; orderId: string; clientId: number } | { ok: false; reason: string }}
 */
export function evaluateAnonymousPurchaseAutoLink(input) {
  const verifiedEmail = normalizeAmareEmail(input?.verifiedEmail);
  if (!verifiedEmail) return { ok: false, reason: "email_not_verified" };
  if (isApplePrivateRelayEmail(verifiedEmail)) return { ok: false, reason: "apple_relay_email" };
  if (input?.dualSessionConflict === true) return { ok: false, reason: "dual_session_conflict" };
  if (Number(input?.candidateCount) !== 1) return { ok: false, reason: "ambiguous_or_empty" };

  const candidateId = Number(input?.candidateClientId);
  if (!Number.isFinite(candidateId) || candidateId <= 0) return { ok: false, reason: "no_candidate" };

  const currentUser = String(input?.currentAmareUserId || "");
  if (!currentUser.startsWith("usr_")) return { ok: false, reason: "no_amare_sess_user" };

  const owner = input?.existingOwnerUserId ? String(input.existingOwnerUserId) : "";
  if (owner && owner !== currentUser) return { ok: false, reason: "conflicting_owner" };

  const order = input?.order && typeof input.order === "object" ? input.order : null;
  if (!order) return { ok: false, reason: "no_trusted_order" };

  const orderEmail = normalizeAmareEmail(order.customerEmail);
  if (!orderEmail || orderEmail !== verifiedEmail) return { ok: false, reason: "order_email_mismatch" };

  const resolved = orderClientId(order);
  if (resolved == null) return { ok: false, reason: "order_client_unresolved" };
  if (resolved !== candidateId) return { ok: false, reason: "order_client_mismatch" };

  if (String(order.mindbodySyncStatus || "") !== "mindbody_synced") {
    return { ok: false, reason: "order_not_synced" };
  }
  if (!isAnonymousPurchaseOrder(order)) return { ok: false, reason: "not_anonymous_order" };

  const bound = typeof order.amareUserId === "string" ? order.amareUserId : "";
  if (bound && bound !== currentUser) return { ok: false, reason: "order_bound_other_user" };

  const when = orderProvenanceMs(order);
  const now = Number(input?.nowMs) || Date.now();
  if (!Number.isFinite(when)) return { ok: false, reason: "order_expired" };
  if (now < when - 60_000) return { ok: false, reason: "order_expired" };
  if (now - when > ANONYMOUS_PURCHASE_AUTO_LINK_WINDOW_MS) return { ok: false, reason: "order_expired" };

  const orderId = sanitizeOrderIdHint(order.orderId);
  if (!orderId) return { ok: false, reason: "no_trusted_order" };

  return { ok: true, orderId, clientId: resolved };
}
