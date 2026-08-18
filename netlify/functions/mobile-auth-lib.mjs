import crypto from "node:crypto";

import { sealCookiePayload, sessionSecret, unsealCookiePayload } from "./oauth-lib.mjs";

const ACCESS_TTL_SEC = () => {
  const n = parseInt(process.env.MOBILE_JWT_ACCESS_TTL_SECONDS || "3600", 10);
  return Number.isFinite(n) && n >= 60 && n <= 86400 ? n : 3600;
};

const REFRESH_TTL_SEC = () => {
  const n = parseInt(process.env.MOBILE_JWT_REFRESH_TTL_SECONDS || "2592000", 10);
  return Number.isFinite(n) && n >= 3600 && n <= 7776000 ? n : 2592000;
};

/** @param {string | undefined} v */
function envTruthy(v) {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Kill switch — default OFF in production until mobile app is ready. */
export function mobileBearerAuthEnabled() {
  return envTruthy(process.env.ENABLE_MOBILE_BEARER_AUTH);
}

function mobileJwtSecret() {
  const dedicated = process.env.MOBILE_JWT_SECRET?.trim();
  if (dedicated) return dedicated;
  return sessionSecret();
}

/**
 * @param {Record<string, unknown>} payload
 * @param {number} ttlSec
 * @param {string} typ
 */
function newSid() {
  return crypto.randomBytes(16).toString("base64url");
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

/** @type {Map<string, number>} */
const revokedUntil = new Map();

function pruneRevoked(now = Date.now()) {
  for (const [key, exp] of revokedUntil) {
    if (exp <= now) revokedUntil.delete(key);
  }
}

export function resetMobileRevokeStoreForTests() {
  revokedUntil.clear();
}

/**
 * @param {{ sid?: string | null, token?: string | null, expMs?: number }} input
 */
export function revokeMobileCredential(input = {}) {
  const expMs = Number(input.expMs) > Date.now() ? Number(input.expMs) : Date.now() + REFRESH_TTL_SEC() * 1000;
  const sid = typeof input.sid === "string" ? input.sid.trim() : "";
  if (sid) revokedUntil.set(`sid:${sid}`, expMs);
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token) revokedUntil.set(`fp:${tokenFingerprint(token)}`, expMs);
}

export function isMobileCredentialRevoked(token, sid) {
  pruneRevoked();
  const sidKey = typeof sid === "string" && sid.trim() ? `sid:${sid.trim()}` : "";
  if (sidKey && revokedUntil.has(sidKey)) return true;
  const raw = typeof token === "string" ? token.trim() : "";
  return raw ? revokedUntil.has(`fp:${tokenFingerprint(raw)}`) : false;
}

function signMobileJwt(payload, ttlSec, typ) {
  const secret = mobileJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    typ,
    iat: now,
    exp: now + ttlSec,
  };
  const payloadB64 = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * @param {string} token
 * @param {string} expectedTyp
 */
function verifyMobileJwt(token, expectedTyp) {
  if (!token || typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const secret = mobileJwtSecret();
  const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!body || typeof body !== "object") return null;
    if (body.typ !== expectedTyp) return null;
    if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 */
export function parseBearerAuthorization(event) {
  const raw =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    /** @type {Record<string,string>|undefined} */ (event.headers)?.AUTHORIZATION ||
    "";
  const s = String(raw).trim();
  if (!s.toLowerCase().startsWith("bearer ")) return null;
  const token = s.slice(7).trim();
  return token || null;
}

/**
 * Issue mobile access + refresh JWTs wrapping the same sealed session blob as `mb_sess`.
 *
 * @param {Record<string, unknown>} sessionPayload
 */
export function issueMobileTokenPair(sessionPayload, opts = {}) {
  const secret = sessionSecret();
  const sealed = sealCookiePayload(sessionPayload, secret);
  const sid = typeof opts.sid === "string" && opts.sid.trim() ? opts.sid.trim() : newSid();
  const accessToken = signMobileJwt({ sess: sealed, sid }, ACCESS_TTL_SEC(), "mobile_access");
  const refreshToken = signMobileJwt({ sess: sealed, sid }, REFRESH_TTL_SEC(), "mobile_refresh");
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SEC(),
    tokenType: "Bearer",
    sessionKind: "mindbody",
    sid,
  };
}

/**
 * @param {string} accessToken
 * @returns {Record<string, unknown> | null}
 */
export function sessionFromMobileAccessToken(accessToken) {
  const body = verifyMobileJwt(accessToken, "mobile_access");
  if (!body || typeof body.sess !== "string") return null;
  if (isMobileCredentialRevoked(accessToken, body.sid)) return null;
  try {
    return unsealCookiePayload(body.sess, sessionSecret());
  } catch {
    return null;
  }
}

/**
 * @param {string} refreshToken
 * @returns {Record<string, unknown> | null}
 */
export function sessionFromMobileRefreshToken(refreshToken) {
  const body = verifyMobileJwt(refreshToken, "mobile_refresh");
  if (!body || typeof body.sess !== "string") return null;
  if (isMobileCredentialRevoked(refreshToken, body.sid)) return null;
  try {
    return unsealCookiePayload(body.sess, sessionSecret());
  } catch {
    return null;
  }
}

/**
 * @param {string} token
 * @returns {{ family: "amare" | "mindbody", typ: string, sid: string | null, amareUserId?: string | null, session?: Record<string, unknown> | null } | null}
 */
export function inspectMobileToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const amareAccess = verifyMobileJwt(raw, "amare_mobile_access");
  if (amareAccess) {
    const id = typeof amareAccess.amare_user_id === "string" ? amareAccess.amare_user_id.trim() : "";
    return {
      family: "amare",
      typ: "amare_mobile_access",
      sid: typeof amareAccess.sid === "string" ? amareAccess.sid : null,
      amareUserId: id.startsWith("usr_") ? id : null,
    };
  }
  const amareRefresh = verifyMobileJwt(raw, "amare_mobile_refresh");
  if (amareRefresh) {
    const id = typeof amareRefresh.amare_user_id === "string" ? amareRefresh.amare_user_id.trim() : "";
    return {
      family: "amare",
      typ: "amare_mobile_refresh",
      sid: typeof amareRefresh.sid === "string" ? amareRefresh.sid : null,
      amareUserId: id.startsWith("usr_") ? id : null,
    };
  }
  const mbAccess = verifyMobileJwt(raw, "mobile_access");
  if (mbAccess) {
    let session = null;
    try {
      session = typeof mbAccess.sess === "string" ? unsealCookiePayload(mbAccess.sess, sessionSecret()) : null;
    } catch {
      session = null;
    }
    return {
      family: "mindbody",
      typ: "mobile_access",
      sid: typeof mbAccess.sid === "string" ? mbAccess.sid : null,
      session,
    };
  }
  const mbRefresh = verifyMobileJwt(raw, "mobile_refresh");
  if (mbRefresh) {
    let session = null;
    try {
      session = typeof mbRefresh.sess === "string" ? unsealCookiePayload(mbRefresh.sess, sessionSecret()) : null;
    } catch {
      session = null;
    }
    return {
      family: "mindbody",
      typ: "mobile_refresh",
      sid: typeof mbRefresh.sid === "string" ? mbRefresh.sid : null,
      session,
    };
  }
  return null;
}

/**
 * Re-wrap session after Mindbody refresh rotation.
 *
 * @param {Record<string, unknown>} sessionPayload
 */
export function reissueMobileTokenPairFromSession(sessionPayload, opts = {}) {
  return issueMobileTokenPair(sessionPayload, opts);
}

/**
 * AMARÉ-owned mobile session. Identity only — no Studio clientId, no Mindbody tokens.
 * @param {string} amareUserId
 */
export function issueAmareMobileTokenPair(amareUserId, opts = {}) {
  const id = String(amareUserId || "").trim();
  if (!id.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  const sid = typeof opts.sid === "string" && opts.sid.trim() ? opts.sid.trim() : newSid();
  const accessToken = signMobileJwt({ amare_user_id: id, sid }, ACCESS_TTL_SEC(), "amare_mobile_access");
  const refreshToken = signMobileJwt({ amare_user_id: id, sid }, REFRESH_TTL_SEC(), "amare_mobile_refresh");
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SEC(),
    tokenType: "Bearer",
    sessionKind: "amare",
    sid,
  };
}

/**
 * @param {string} accessToken
 * @returns {string | null}
 */
export function amareUserIdFromMobileAccessToken(accessToken) {
  const body = verifyMobileJwt(accessToken, "amare_mobile_access");
  const id = body && typeof body.amare_user_id === "string" ? body.amare_user_id.trim() : "";
  if (!id.startsWith("usr_")) return null;
  if (isMobileCredentialRevoked(accessToken, body.sid)) return null;
  return id;
}

/**
 * @param {string} refreshToken
 * @returns {string | null}
 */
export function amareUserIdFromMobileRefreshToken(refreshToken) {
  const body = verifyMobileJwt(refreshToken, "amare_mobile_refresh");
  const id = body && typeof body.amare_user_id === "string" ? body.amare_user_id.trim() : "";
  if (!id.startsWith("usr_")) return null;
  if (isMobileCredentialRevoked(refreshToken, body.sid)) return null;
  return id;
}

export function sidFromMobileRefreshToken(refreshToken) {
  const body =
    verifyMobileJwt(refreshToken, "amare_mobile_refresh") || verifyMobileJwt(refreshToken, "mobile_refresh");
  return body && typeof body.sid === "string" ? body.sid : null;
}

/**
 * Capacitor / Vite app origins. Used only when mobile bearer auth is on.
 * Does not weaken same-site web CSRF.
 * @param {string} origin
 */
export function isTrustedMobileAppOrigin(origin) {
  if (!mobileBearerAuthEnabled()) return false;
  const raw = String(origin || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol === "capacitor:" || u.protocol === "ionic:") return true;
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return true;
    }
    const extra = String(process.env.AMARE_MOBILE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return extra.includes(raw.toLowerCase());
  } catch {
    return false;
  }
}
