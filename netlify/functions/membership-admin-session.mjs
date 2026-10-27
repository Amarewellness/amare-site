/**
 * HttpOnly admin session cookie. Billing authority comes from the session's
 * PostgreSQL admin row (owner / superadmin), never from the shared admin token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookieSecureFlag, parseCookies } from "./oauth-lib.mjs";
import { billingAdminUsable } from "./membership-billing-auth-store.mjs";

export const ADMIN_SESSION_COOKIE = "amare_admin_sess";
export const CSRF_HEADER = "x-csrf-token";
/** Absolute lifetime. Signing in again issues a new session. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** @param {Record<string, string | undefined> | undefined} headers @param {string} name */
function header(headers, name) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === name) return String(headers?.[k] ?? "").trim();
  }
  return "";
}

/** @param {string} a @param {string} b */
function timingSafeStrEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** @param {{ headers?: Record<string, string | undefined> }} event */
export function hasSessionCookie(event) {
  return header(event?.headers, "cookie").includes(`${ADMIN_SESSION_COOKIE}=`);
}

/** @param {{ headers?: Record<string, string | undefined> }} event */
export function readSessionCookie(event) {
  const cookies = parseCookies(header(event?.headers, "cookie"));
  return cookies[ADMIN_SESSION_COOKIE] || "";
}

/**
 * @param {number} [ttlMs]
 * @returns {{ token: string, sessionHash: string, csrfToken: string, expiresAt: string }}
 */
export function issueSessionMaterial(ttlMs = SESSION_TTL_MS) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    sessionHash: createHash("sha256").update(token).digest("hex"),
    csrfToken: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/** @param {string} token */
export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/**
 * One Set-Cookie only. Netlify can 502 when Set-Cookie is an array.
 * @param {string} token empty clears the cookie
 * @param {Record<string, string | undefined> | undefined} headers
 * @param {number} maxAgeSeconds
 */
export function adminSessionSetCookie(token, headers, maxAgeSeconds) {
  const value = token ? `${ADMIN_SESSION_COOKIE}=${token}` : `${ADMIN_SESSION_COOKIE}=`;
  return `${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecureFlag(headers || {})}`;
}

/**
 * Load the session and re-check the billing admin row so revocation and expiry apply immediately.
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {{ getSession: (hash: string) => Promise<any>, getAdmin: (id: string) => Promise<any> }} store
 */
export async function resolveAdminSession(event, store) {
  const token = readSessionCookie(event);
  if (!token) return { ok: false, present: false, status: 401, reason: "session_missing" };
  const row = await store.getSession(hashSessionToken(token));
  if (!row) return { ok: false, present: true, status: 401, reason: "session_invalid" };
  if (row.role === "frontdesk") {
    return {
      ok: true,
      present: true,
      actor: { id: null, role: "frontdesk", displayName: null, mustRotate: false },
      csrfToken: row.csrfToken,
      canBill: false,
    };
  }
  const admin = row.actorId ? await store.getAdmin(row.actorId) : null;
  if (!admin || !billingAdminUsable(admin)) {
    return { ok: false, present: true, status: 401, reason: "session_revoked" };
  }
  const mustRotate = admin.mustRotate === true;
  return {
    ok: true,
    present: true,
    actor: {
      id: admin.actorId,
      role: admin.role,
      displayName: admin.displayName,
      mustRotate,
    },
    csrfToken: row.csrfToken,
    canBill: !mustRotate && (admin.role === "owner" || admin.role === "superadmin"),
  };
}

/** @param {{ headers?: Record<string, string | undefined> }} event @param {string} expected */
export function csrfMatches(event, expected) {
  const got = header(event?.headers, CSRF_HEADER);
  return Boolean(expected) && Boolean(got) && timingSafeStrEq(got, expected);
}
