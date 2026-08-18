/**
 * AMARÉ Auth 2A.2 — provider-neutral `amare_sess` session core.
 *
 * Cookie answers only: which AMARÉ user is this browser authenticated as?
 * It does not answer Studio clientId / Book authorization.
 *
 * Timestamps (`at`, `exp`) are Unix milliseconds, matching oauth-lib `verifyState`
 * and Mindbody `mb_sess` `at: Date.now()`. Cookie Max-Age is the same lifetime in seconds.
 *
 * Live Book / Waitlist / Cancel / Dashboard must ignore this cookie.
 */

import {
  cookieSecureFlag,
  parseCookies,
  sealCookiePayload,
  signState,
  unsealCookiePayload,
  verifyState,
} from "./oauth-lib.mjs";
import {
  amareUserIdFromMobileAccessToken,
  isTrustedMobileAppOrigin,
  mobileBearerAuthEnabled,
  parseBearerAuthorization,
} from "./mobile-auth-lib.mjs";

export const AMARE_SESS_COOKIE = "amare_sess";

/** Absolute session lifetime. Matches `mb_sess` Max-Age in mindbody-oauth-callback.mjs. */
export const AMARE_SESS_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AMARE_SESS_TTL_MS = AMARE_SESS_TTL_SECONDS * 1000;

export class AmareSessionConfigError extends Error {
  constructor(message = "amare_session_configuration_error") {
    super(message);
    this.name = "AmareSessionConfigError";
    this.code = "amare_session_configuration_error";
  }
}

export function amareAuthEnabled() {
  return (process.env.ENABLE_AMARE_AUTH || "").trim() === "1";
}

export function amareSessIssueEnabled() {
  return (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1";
}

/** Normal application issuance: both flags on and a usable secret. */
export function canIssueAmareSession() {
  return amareAuthEnabled() && amareSessIssueEnabled() && Boolean(amareSessionSecretOrNull());
}

export function amareSessionSecretOrNull() {
  const s = (process.env.AMARE_SESSION_SECRET || "").trim();
  return s.length >= 24 ? s : null;
}

export function requireAmareSessionSecret() {
  const secret = amareSessionSecretOrNull();
  if (!secret) throw new AmareSessionConfigError("missing_amare_session_secret");
  return secret;
}

export function isAmareUserId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  return id.startsWith("usr_");
}

function nowMs() {
  return Date.now();
}

function assertNoSessionAuthorityFields(payload) {
  if (!payload || typeof payload !== "object") return;
  for (const key of [
    "client_id",
    "clientId",
    "mindbody_client_id",
    "access_token",
    "refresh_token",
    "email",
    "phone",
  ]) {
    if (key in payload) throw new Error("amare_sess_must_not_carry_authority_fields");
  }
}

/**
 * Low-level seal. Testable without feature flags.
 * Application issuance must go through maybeIssueAmareSession / rotateAmareSession.
 *
 * @param {{ amare_user_id: string, at?: number, nowMs?: number }} input
 */
export function sealAmareSessPayload(input) {
  const secret = requireAmareSessionSecret();
  const id = String(input.amare_user_id || "").trim();
  if (!isAmareUserId(id)) throw new Error("invalid_amare_user_id");
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : nowMs();
  const payload = { amare_user_id: id, at, exp: at + AMARE_SESS_TTL_MS };
  assertNoSessionAuthorityFields(payload);
  return sealCookiePayload(payload, secret);
}

export const sealAmareSession = sealAmareSessPayload;

/**
 * @param {string} sealed
 * @returns {{ ok: true, session: { amare_user_id: string, at: number, exp: number } } | { ok: false, reason: string }}
 */
export function unsealAmareSession(sealed) {
  const secret = amareSessionSecretOrNull();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (typeof sealed !== "string" || !sealed.trim()) return { ok: false, reason: "invalid" };
  let data;
  try {
    data = unsealCookiePayload(sealed, secret);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!data || typeof data !== "object") return { ok: false, reason: "invalid" };
  const id = typeof data.amare_user_id === "string" ? data.amare_user_id.trim() : "";
  if (!isAmareUserId(id)) return { ok: false, reason: "invalid_amare_user_id" };
  if (typeof data.at !== "number" || !Number.isFinite(data.at)) return { ok: false, reason: "invalid" };
  if (typeof data.exp !== "number" || !Number.isFinite(data.exp)) {
    return { ok: false, reason: "missing_exp" };
  }
  if (data.exp <= nowMs()) return { ok: false, reason: "expired" };
  return { ok: true, session: { amare_user_id: id, at: data.at, exp: data.exp } };
}

/**
 * Phase 1-compatible helper. Null for missing/invalid/expired/no-exp/no-secret.
 * @param {string} sealed
 */
export function unsealAmareSessPayload(sealed) {
  const result = unsealAmareSession(sealed);
  return result.ok ? result.session : null;
}

export const unsealAmareSessionPayload = unsealAmareSessPayload;

/**
 * @param {string | undefined} cookieHeader
 */
export function readAmareSessFromCookieHeader(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[AMARE_SESS_COOKIE];
  if (!raw) return { present: false, session: null, reason: "absent" };
  const result = unsealAmareSession(raw);
  if (!result.ok) return { present: true, session: null, reason: result.reason };
  return { present: true, session: result.session, reason: null };
}

/**
 * @param {string} sealed
 * @param {Record<string, string | undefined>} [headers]
 */
export function buildAmareSessionCookie(sealed, headers = {}) {
  return `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AMARE_SESS_TTL_SECONDS}${cookieSecureFlag(headers)}`;
}

/**
 * @param {Record<string, string | undefined>} [headers]
 */
export function buildClearAmareSessionCookie(headers = {}) {
  return `${AMARE_SESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(headers)}`;
}

/**
 * Normal issuance. Returns null when flags are off (fail closed).
 * Throws AmareSessionConfigError when flags are on but the secret is missing.
 *
 * @param {{ amare_user_id: string, headers?: Record<string, string | undefined> }} input
 */
export function maybeIssueAmareSession(input) {
  if (!amareAuthEnabled() || !amareSessIssueEnabled()) return null;
  const secret = amareSessionSecretOrNull();
  if (!secret) throw new AmareSessionConfigError("missing_amare_session_secret");
  const sealed = sealAmareSessPayload({ amare_user_id: input.amare_user_id });
  const cookie = buildAmareSessionCookie(sealed, input.headers || {});
  console.log(JSON.stringify({ event: "amare_session_issued", amare_user_id: input.amare_user_id }));
  return { sealed, cookie, maxAgeSeconds: AMARE_SESS_TTL_SECONDS };
}

/**
 * Fresh seal / at / exp / ciphertext. Does not reuse the incoming cookie value.
 * Flag-gated like issuance.
 *
 * @param {{ amare_user_id: string, headers?: Record<string, string | undefined> }} input
 */
export function rotateAmareSession(input) {
  return maybeIssueAmareSession(input);
}

/**
 * Low-level rotation primitive for tests / future callbacks (new at, exp, ciphertext).
 * @param {string} amareUserId
 */
export function rotateAmareSessionValue(amareUserId) {
  return sealAmareSessPayload({ amare_user_id: amareUserId });
}

export function signAmareAuthState(obj) {
  return signState(obj, requireAmareSessionSecret());
}

export function verifyAmareAuthState(token) {
  return verifyState(token, requireAmareSessionSecret());
}

/**
 * Reject only when Origin proves the request is foreign. Missing Origin is allowed.
 * @param {{ headers?: Record<string, string | undefined> }} event
 */
export function isForeignOriginMutation(event) {
  const headers = event?.headers || {};
  const origin = String(headers.origin || headers.Origin || "").trim();
  if (!origin) return false;
  if (isTrustedMobileAppOrigin(origin)) return false;
  const host = String(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers.host || headers.Host || "")
    .trim()
    .split(",")[0]
    .trim();
  if (!host) return true;
  try {
    const originHost = new URL(origin).host;
    return originHost.toLowerCase() !== host.toLowerCase();
  } catch {
    return true;
  }
}

function header(event, name) {
  const headers = event?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

/**
 * Read + unseal + schema/exp. No DB. No Studio clientId.
 *
 * @param {{ headers?: Record<string, string | undefined> }} event
 */
export function resolveAmareSession(event) {
  const cookieHeader = header(event, "cookie") || header(event, "Cookie") || "";
  return readAmareSessFromCookieHeader(cookieHeader);
}

/**
 * Authenticated AMARÉ person, or signed out. Confirms `amare_users` row exists.
 * Does not resolve Studio clientId or call Mindbody.
 *
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {{ findUser?: (id: string) => Promise<unknown> }} [options]
 */
export async function resolveAmareUser(event, options = {}) {
  const cookieHeader = header(event, "cookie") || header(event, "Cookie") || "";
  let raw = parseCookies(cookieHeader)[AMARE_SESS_COOKIE];
  if (!raw && mobileBearerAuthEnabled()) {
    const bearer = parseBearerAuthorization(event);
    const fromBearer = bearer ? amareUserIdFromMobileAccessToken(bearer) : null;
    if (fromBearer) {
      const findUser =
        options.findUser ||
        (async (id) => {
          const { findAmareUserById } = await import("./amare-identity-store.mjs");
          return findAmareUserById(id);
        });
      let row = null;
      try {
        row = await findUser(fromBearer);
      } catch (err) {
        if (String(err?.message || err) === "invalid_amare_user_id") {
          return { signedIn: false, amareUserId: null, reason: "invalid_amare_user_id" };
        }
        throw err;
      }
      if (!row) return { signedIn: false, amareUserId: null, reason: "user_not_found" };
      return { signedIn: true, amareUserId: fromBearer, reason: null };
    }
  }
  if (!raw) return { signedIn: false, amareUserId: null, reason: "absent" };

  if (!amareSessionSecretOrNull()) {
    if (amareAuthEnabled()) throw new AmareSessionConfigError("missing_amare_session_secret");
    return { signedIn: false, amareUserId: null, reason: "missing_secret" };
  }

  const result = unsealAmareSession(raw);
  if (!result.ok) {
    if (result.reason === "expired") {
      console.log(JSON.stringify({ event: "amare_session_expired" }));
    } else if (result.reason !== "absent") {
      console.log(JSON.stringify({ event: "amare_session_invalid", reason: result.reason }));
    }
    return { signedIn: false, amareUserId: null, reason: result.reason };
  }

  const findUser =
    options.findUser ||
    (async (id) => {
      const { findAmareUserById } = await import("./amare-identity-store.mjs");
      return findAmareUserById(id);
    });
  let row = null;
  try {
    row = await findUser(result.session.amare_user_id);
  } catch (err) {
    if (String(err?.message || err) === "invalid_amare_user_id") {
      console.log(JSON.stringify({ event: "amare_session_invalid", reason: "invalid_amare_user_id" }));
      return { signedIn: false, amareUserId: null, reason: "invalid_amare_user_id" };
    }
    throw err;
  }
  if (!row) {
    console.log(
      JSON.stringify({
        event: "amare_session_invalid",
        reason: "user_not_found",
        amare_user_id: result.session.amare_user_id,
      }),
    );
    return { signedIn: false, amareUserId: null, reason: "user_not_found" };
  }

  return { signedIn: true, amareUserId: result.session.amare_user_id, reason: null };
}

/**
 * Compare dark `amare_sess` to live `mb_sess` client id. Logs only. Never authorizes.
 *
 * @param {{
 *   cookieHeader?: string;
 *   mbClientId?: number | null;
 *   lookupActiveClientId?: (amareUserId: string) => Promise<number | null>;
 * }} input
 */
export async function logAmareSessVersusMbSess(input) {
  const { present, session, reason } = readAmareSessFromCookieHeader(input.cookieHeader || "");
  if (!present) return { event: "amare_sess_absent" };

  if (!session) {
    console.warn(JSON.stringify({ event: "amare_sess_unseal_failed", reason: reason || "invalid" }));
    return { event: "amare_sess_unseal_failed", reason };
  }

  const mbClientId =
    typeof input.mbClientId === "number" && input.mbClientId > 0 ? input.mbClientId : null;

  let amareClientId = null;
  if (typeof input.lookupActiveClientId === "function") {
    try {
      amareClientId = await input.lookupActiveClientId(session.amare_user_id);
    } catch {
      amareClientId = null;
    }
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    amare_user_id: session.amare_user_id,
    mbClientId,
    amareClientId,
  };

  if (amareClientId == null) {
    payload.event = "amare_sess_present_no_db_compare";
    console.log(JSON.stringify(payload));
    return payload;
  }

  if (mbClientId != null && amareClientId === mbClientId) {
    payload.event = "amare_sess_aligns_mb_sess";
    console.log(JSON.stringify(payload));
    return payload;
  }

  payload.event = "amare_sess_conflicts_mb_sess";
  console.warn(JSON.stringify(payload));
  return payload;
}
