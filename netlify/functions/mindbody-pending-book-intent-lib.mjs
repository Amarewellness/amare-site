/**
 * Sealed HttpOnly cookie proving the buyer reached checkout from a real
 * `402 no_bookable_credits` booking failure — not auth/link errors.
 */

import { parseCookies, sealCookiePayload, sessionSecret, unsealCookiePayload, cookieSecureFlag } from "./oauth-lib.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} name */
function header(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : "";
}

export const BOOK_FAIL_INTENT_COOKIE = "mb_book_fail_intent";

/** Phase 1 one-time SKUs only — no memberships, no same-day drop-in unless added explicitly. */
export const DEFERRED_BOOK_ONE_TIME_SKUS = new Set([
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "pack_10_classes",
  "pack_20_classes",
]);

export const DEFERRED_BOOK_CTA = "classes_booking_fail_packages";

/** Anonymous guest on `/classes` — purchase + deferred book without OAuth sign-in first. */
export const DEFERRED_BOOK_ANONYMOUS_CTA = "classes_anonymous_book_packages";

export const ANONYMOUS_BOOK_INTENT_COOKIE = "mb_anonymous_book_intent";

const INTENT_TTL_SEC = 30 * 60;

/**
 * @typedef {Object} BookFailIntentPayload
 * @property {number} classId
 * @property {string} classStartIso
 * @property {string=} className
 * @property {string=} selectedDayKey
 * @property {number} clientId
 * @property {"book"} source
 * @property {false} waitlist
 * @property {"no_bookable_credits"} reason
 * @property {number} capturedAt
 * @property {number} expiresAt
 */

/**
 * @param {string | null | undefined} localSku
 */
export function isDeferredBookEligibleSku(localSku) {
  return typeof localSku === "string" && DEFERRED_BOOK_ONE_TIME_SKUS.has(localSku);
}

/**
 * @param {string | null | undefined} ctaLocation
 */
export function isDeferredBookEligibleCta(ctaLocation) {
  return ctaLocation === DEFERRED_BOOK_CTA || ctaLocation === DEFERRED_BOOK_ANONYMOUS_CTA;
}

/**
 * @param {{
 *   classId: number;
 *   classStartIso: string;
 *   className?: string;
 *   selectedDayKey?: string;
 *   clientId: number;
 * }} fields
 * @returns {BookFailIntentPayload}
 */
export function buildBookFailIntentPayload(fields) {
  const now = Date.now();
  return {
    classId: fields.classId,
    classStartIso: fields.classStartIso,
    className: fields.className,
    selectedDayKey: fields.selectedDayKey,
    clientId: fields.clientId,
    source: "book",
    waitlist: false,
    reason: "no_bookable_credits",
    capturedAt: now,
    expiresAt: now + INTENT_TTL_SEC * 1000,
  };
}

/**
 * @param {BookFailIntentPayload} payload
 * @param {Record<string, string | string[] | undefined>} [headers]
 */
export function bookFailIntentSetCookieHeader(payload, headers) {
  const sealed = sealCookiePayload(payload, sessionSecret());
  return `${BOOK_FAIL_INTENT_COOKIE}=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INTENT_TTL_SEC}${cookieSecureFlag(headers)}`;
}

/**
 * @param {Record<string, string | string[] | undefined>} [headers]
 */
export function bookFailIntentClearCookieHeader(headers) {
  return `${BOOK_FAIL_INTENT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(headers)}`;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @returns {BookFailIntentPayload | null}
 */
export function readBookFailIntentFromEvent(event) {
  try {
    const cookieHeader = (header(event, "cookie") || header(event, "Cookie") || "").trim();
    if (!cookieHeader) return null;
    const raw = parseCookies(cookieHeader)[BOOK_FAIL_INTENT_COOKIE];
    if (!raw) return null;
    const data = unsealCookiePayload(raw, sessionSecret());
    if (!data || typeof data !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (data);
    if (d.reason !== "no_bookable_credits" || d.source !== "book" || d.waitlist !== false) return null;
    const classId = Number(d.classId);
    const clientId = Number(d.clientId);
    const classStartIso = typeof d.classStartIso === "string" ? d.classStartIso : "";
    const expiresAt = Number(d.expiresAt);
    if (!Number.isFinite(classId) || classId <= 0) return null;
    if (!Number.isFinite(clientId) || clientId <= 0) return null;
    if (!classStartIso) return null;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return /** @type {BookFailIntentPayload} */ ({
      classId,
      clientId,
      classStartIso,
      className: typeof d.className === "string" ? d.className.slice(0, 160) : undefined,
      selectedDayKey: typeof d.selectedDayKey === "string" ? d.selectedDayKey.slice(0, 32) : undefined,
      source: "book",
      waitlist: false,
      reason: "no_bookable_credits",
      capturedAt: Number(d.capturedAt) || Date.now(),
      expiresAt,
    });
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} PendingBookRecord
 * @property {number} classId
 * @property {string} classStartIso
 * @property {string=} className
 * @property {string=} selectedDayKey
 * @property {"book"} source
 * @property {false} waitlist
 * @property {string} capturedAt
 * @property {string} expiresAt
 */

/**
 * @param {BookFailIntentPayload} intent
 * @returns {PendingBookRecord}
 */
export function pendingBookFromIntent(intent) {
  return {
    classId: intent.classId,
    classStartIso: intent.classStartIso,
    className: intent.className,
    selectedDayKey: intent.selectedDayKey,
    source: "book",
    waitlist: false,
    capturedAt: new Date(intent.capturedAt).toISOString(),
    expiresAt: new Date(intent.expiresAt).toISOString(),
  };
}

/**
 * Validate checkout body `pendingBook` against the sealed intent + resolved client id.
 *
 * @param {BookFailIntentPayload | null} intent
 * @param {unknown} pendingBookBody
 * @param {number | null} knownClientId
 */
export function validatePendingBookForCheckout(intent, pendingBookBody, knownClientId) {
  if (!intent) return { ok: false, reason: "missing_book_fail_intent" };
  if (knownClientId == null || knownClientId !== intent.clientId) {
    return { ok: false, reason: "intent_client_mismatch" };
  }
  if (!pendingBookBody || typeof pendingBookBody !== "object") {
    return { ok: false, reason: "missing_pending_book_body" };
  }
  const pb = /** @type {Record<string, unknown>} */ (pendingBookBody);
  const classIdRaw = pb.classId ?? pb.ClassId;
  const classId =
    typeof classIdRaw === "number"
      ? classIdRaw
      : typeof classIdRaw === "string"
        ? parseInt(classIdRaw, 10)
        : NaN;
  if (!Number.isFinite(classId) || classId !== intent.classId) {
    return { ok: false, reason: "pending_book_class_mismatch" };
  }
  if (pb.source !== "book" || pb.waitlist === true) {
    return { ok: false, reason: "pending_book_scope_invalid" };
  }
  return { ok: true, pendingBook: pendingBookFromIntent(intent) };
}

/**
 * @typedef {Object} AnonymousBookIntentPayload
 * @property {number} classId
 * @property {string} classStartIso
 * @property {string=} className
 * @property {string=} selectedDayKey
 * @property {"book"} source
 * @property {false} waitlist
 * @property {"anonymous_book"} reason
 * @property {number} capturedAt
 * @property {number} expiresAt
 */

/**
 * @param {string | undefined} classStartIso
 */
export function classStartIsoHasPassed(classStartIso) {
  if (!classStartIso) return false;
  const t = Date.parse(classStartIso);
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * @param {{
 *   classId: number;
 *   classStartIso: string;
 *   className?: string;
 *   selectedDayKey?: string;
 * }} fields
 * @returns {AnonymousBookIntentPayload}
 */
export function buildAnonymousBookIntentPayload(fields) {
  const now = Date.now();
  return {
    classId: fields.classId,
    classStartIso: fields.classStartIso,
    className: fields.className,
    selectedDayKey: fields.selectedDayKey,
    source: "book",
    waitlist: false,
    reason: "anonymous_book",
    capturedAt: now,
    expiresAt: now + INTENT_TTL_SEC * 1000,
  };
}

/**
 * @param {AnonymousBookIntentPayload} payload
 * @param {Record<string, string | string[] | undefined>} [headers]
 */
export function anonymousBookIntentSetCookieHeader(payload, headers) {
  const sealed = sealCookiePayload(payload, sessionSecret());
  return `${ANONYMOUS_BOOK_INTENT_COOKIE}=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INTENT_TTL_SEC}${cookieSecureFlag(headers)}`;
}

/**
 * @param {Record<string, string | string[] | undefined>} [headers]
 */
export function anonymousBookIntentClearCookieHeader(headers) {
  return `${ANONYMOUS_BOOK_INTENT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(headers)}`;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @returns {AnonymousBookIntentPayload | null}
 */
export function readAnonymousBookIntentFromEvent(event) {
  try {
    const cookieHeader = (header(event, "cookie") || header(event, "Cookie") || "").trim();
    if (!cookieHeader) return null;
    const raw = parseCookies(cookieHeader)[ANONYMOUS_BOOK_INTENT_COOKIE];
    if (!raw) return null;
    const data = unsealCookiePayload(raw, sessionSecret());
    if (!data || typeof data !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (data);
    if (d.reason !== "anonymous_book" || d.source !== "book" || d.waitlist !== false) return null;
    const classId = Number(d.classId);
    const classStartIso = typeof d.classStartIso === "string" ? d.classStartIso : "";
    const expiresAt = Number(d.expiresAt);
    if (!Number.isFinite(classId) || classId <= 0) return null;
    if (!classStartIso) return null;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    if (classStartIsoHasPassed(classStartIso)) return null;
    return /** @type {AnonymousBookIntentPayload} */ ({
      classId,
      classStartIso,
      className: typeof d.className === "string" ? d.className.slice(0, 160) : undefined,
      selectedDayKey: typeof d.selectedDayKey === "string" ? d.selectedDayKey.slice(0, 32) : undefined,
      source: "book",
      waitlist: false,
      reason: "anonymous_book",
      capturedAt: Number(d.capturedAt) || Date.now(),
      expiresAt,
    });
  } catch {
    return null;
  }
}

/**
 * @param {AnonymousBookIntentPayload} intent
 * @returns {PendingBookRecord}
 */
export function pendingBookFromAnonymousIntent(intent) {
  return {
    classId: intent.classId,
    classStartIso: intent.classStartIso,
    className: intent.className,
    selectedDayKey: intent.selectedDayKey,
    source: "book",
    waitlist: false,
    capturedAt: new Date(intent.capturedAt).toISOString(),
    expiresAt: new Date(intent.expiresAt).toISOString(),
  };
}

/**
 * Validate anonymous `/classes` checkout `pendingBook` against sealed guest intent (no clientId).
 *
 * @param {AnonymousBookIntentPayload | null} intent
 * @param {unknown} pendingBookBody
 */
export function validateAnonymousPendingBookForCheckout(intent, pendingBookBody) {
  if (!intent) return { ok: false, reason: "missing_anonymous_book_intent" };
  if (!pendingBookBody || typeof pendingBookBody !== "object") {
    return { ok: false, reason: "missing_pending_book_body" };
  }
  const pb = /** @type {Record<string, unknown>} */ (pendingBookBody);
  const classIdRaw = pb.classId ?? pb.ClassId;
  const classId =
    typeof classIdRaw === "number"
      ? classIdRaw
      : typeof classIdRaw === "string"
        ? parseInt(classIdRaw, 10)
        : NaN;
  if (!Number.isFinite(classId) || classId !== intent.classId) {
    return { ok: false, reason: "pending_book_class_mismatch" };
  }
  if (pb.source !== "book" || pb.waitlist === true) {
    return { ok: false, reason: "pending_book_scope_invalid" };
  }
  return { ok: true, pendingBook: pendingBookFromAnonymousIntent(intent) };
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 */
export function orderNeedsDeferredBookAttempt(order) {
  if (!isDeferredBookEligibleCta(order.ctaLocation)) return false;
  if (!isDeferredBookEligibleSku(order.localSku)) return false;
  const pb = order.pendingBook;
  if (!pb || pb.source !== "book" || pb.waitlist !== false) return false;
  if (order.mindbodySyncStatus !== "mindbody_synced") return false;
  const db = order.deferredBook;
  if (!db) return true;
  const terminal = new Set(["booked", "class_full", "class_past", "skipped"]);
  if (terminal.has(db.status)) return false;
  return db.status === "pending" || db.status === "attempting";
}

/**
 * Seal the buyer's Mindbody refresh token at checkout so the webhook can re-book with
 * `SendEmail: true` under the **consumer** token (staff token returns 200 but does not
 * trigger Reservation Confirmations emails on this studio).
 *
 * @param {{ orderId: string; clientId: number; refreshToken: string }} fields
 */
export function sealDeferredBookConsumerAuth(fields) {
  return sealCookiePayload(
    {
      orderId: fields.orderId,
      clientId: fields.clientId,
      refresh_token: fields.refreshToken,
      capturedAt: Date.now(),
    },
    sessionSecret(),
  );
}

/**
 * @param {string} sealed
 * @param {number} expectedClientId
 * @returns {{ refresh_token: string } | null}
 */
export function readDeferredBookConsumerAuth(sealed, expectedClientId) {
  try {
    const data = unsealCookiePayload(sealed, sessionSecret());
    if (!data || typeof data !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (data);
    if (Number(d.clientId) !== expectedClientId) return null;
    const refresh = typeof d.refresh_token === "string" ? d.refresh_token.trim() : "";
    if (!refresh) return null;
    return { refresh_token: refresh };
  } catch {
    return null;
  }
}
