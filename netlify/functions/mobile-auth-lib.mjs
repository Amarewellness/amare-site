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

function newSid() {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * @param {Record<string, unknown>} payload
 * @param {number} ttlSec
 * @param {string} typ
 */
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
export function issueMobileTokenPair(sessionPayload) {
  const secret = sessionSecret();
  const sealed = sealCookiePayload(sessionPayload, secret);
  const accessToken = signMobileJwt({ sess: sealed }, ACCESS_TTL_SEC(), "mobile_access");
  const refreshToken = signMobileJwt({ sess: sealed }, REFRESH_TTL_SEC(), "mobile_refresh");
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SEC(),
    tokenType: "Bearer",
  };
}

/**
 * @param {string} accessToken
 * @returns {Record<string, unknown> | null}
 */
export function sessionFromMobileAccessToken(accessToken) {
  const body = verifyMobileJwt(accessToken, "mobile_access");
  if (!body || typeof body.sess !== "string") return null;
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
  try {
    return unsealCookiePayload(body.sess, sessionSecret());
  } catch {
    return null;
  }
}

/**
 * Re-wrap session after Mindbody refresh rotation.
 *
 * @param {Record<string, unknown>} sessionPayload
 */
export function reissueMobileTokenPairFromSession(sessionPayload) {
  return issueMobileTokenPair(sessionPayload);
}

/**
 * AMARÉ-owned bearer session. Identity only — no Studio clientId or Mindbody tokens.
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

/** @param {string} accessToken */
export function amareUserIdFromMobileAccessToken(accessToken) {
  const body = verifyMobileJwt(accessToken, "amare_mobile_access");
  const id = body && typeof body.amare_user_id === "string" ? body.amare_user_id.trim() : "";
  return id.startsWith("usr_") ? id : null;
}

/**
 * Capacitor/Vite origins remain gated by the existing bearer-auth kill switch.
 * Same-site web CSRF behavior is unchanged.
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
