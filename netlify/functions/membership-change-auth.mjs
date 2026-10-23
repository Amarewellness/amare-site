/**
 * Authorization for admin membership plan changes.
 *
 * Layer 1 — `x-admin-token` (shared ADMIN_DEBUG_TOKEN, same as every /admin page).
 * Layer 2 — billing permission: `x-billing-actor` + `x-billing-key` checked against
 *           `MEMBERSHIP_BILLING_ADMINS` (scrypt hashes; plaintext keys are never stored).
 *           The front-desk token alone cannot preview or change billing.
 *
 * `MEMBERSHIP_BILLING_ADMINS` format, entries separated by `;`:
 *   <actorId>:<role>:<saltHex>:<scryptHex>
 * Roles allowed to change billing: owner, superadmin.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const BILLING_ROLES = Object.freeze(["owner", "superadmin"]);
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const SCRYPT_KEYLEN = 32;

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

/** @param {Record<string, string | undefined> | undefined} headers @param {string} name */
function header(headers, name) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === name) return String(headers?.[k] ?? "").trim();
  }
  return "";
}

/** @param {{ headers?: Record<string, string | undefined> }} event */
export function adminTokenAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  const got = header(event?.headers, "x-admin-token");
  return Boolean(got) && timingSafeStrEq(got, expected);
}

/**
 * @param {string} raw
 * @returns {Array<{ actorId: string, role: string, salt: Buffer, hash: Buffer }>}
 */
export function parseBillingAdmins(raw) {
  return String(raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [actorId, role, saltHex, hashHex] = entry.split(":");
      if (!ACTOR_ID_RE.test(actorId || "") || !BILLING_ROLES.includes(role || "")) return null;
      if (!/^[0-9a-f]{32,}$/i.test(saltHex || "") || !/^[0-9a-f]{64}$/i.test(hashHex || "")) return null;
      return { actorId, role, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
    })
    .filter((x) => x !== null);
}

/**
 * @param {string} actorId
 * @param {string} role
 * @param {string} key
 */
export function billingAdminEntry(actorId, role, key) {
  if (!ACTOR_ID_RE.test(actorId)) throw new Error("invalid_actor_id");
  if (!BILLING_ROLES.includes(role)) throw new Error("invalid_role");
  if (String(key).length < 12) throw new Error("billing_key_too_short");
  const salt = randomBytes(16);
  const hash = scryptSync(String(key), salt, SCRYPT_KEYLEN);
  return `${actorId}:${role}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @returns {{ ok: true, actor: { id: string, role: string } } | { ok: false, reason: string }}
 */
export function billingActorFromEvent(event) {
  const admins = parseBillingAdmins(process.env.MEMBERSHIP_BILLING_ADMINS || "");
  if (!admins.length) return { ok: false, reason: "billing_admins_not_configured" };
  const actorId = header(event?.headers, "x-billing-actor").toLowerCase();
  const key = header(event?.headers, "x-billing-key");
  if (!actorId || !key) return { ok: false, reason: "billing_credentials_missing" };
  const entry = admins.find((a) => a.actorId === actorId);
  const salt = entry?.salt ?? Buffer.alloc(16);
  const computed = scryptSync(key, salt, SCRYPT_KEYLEN);
  if (!entry || !timingSafeEqual(computed, entry.hash)) return { ok: false, reason: "billing_credentials_invalid" };
  return { ok: true, actor: { id: entry.actorId, role: entry.role } };
}
