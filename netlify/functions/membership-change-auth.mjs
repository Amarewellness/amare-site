/**
 * Authorization for admin membership plan changes.
 *
 * Layer 1 — `x-admin-token` (shared ADMIN_DEBUG_TOKEN, same as every /admin page). Read-only here.
 * Layer 2 — billing permission: `x-billing-actor` + `x-billing-key`, verified against the per-admin
 *           salted scrypt hash in Postgres (`amare_billing_admins`). Failed attempts are rate limited
 *           per admin id and per client IP. The shared token alone never authorizes billing writes.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const BILLING_ROLES = Object.freeze(["owner", "superadmin"]);
export const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
export const BILLING_KEY_MIN = 12;
const BILLING_KEY_MAX = 200;
const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** Failed attempts allowed inside the window before further attempts are refused. */
export const RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, perActor: 5, perIp: 20 });

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

/** Hashed client IP for rate limiting / audit (raw IPs are not stored). @param {{ headers?: Record<string, string | undefined> }} event */
export function clientIpHash(event) {
  const raw =
    header(event?.headers, "x-nf-client-connection-ip") ||
    header(event?.headers, "x-forwarded-for").split(",")[0].trim() ||
    header(event?.headers, "client-ip");
  if (!raw) return null;
  return createHash("sha256").update(`amare-billing-ip:${raw}`).digest("hex").slice(0, 32);
}

/** @param {string} key */
export function validateBillingKey(key) {
  const k = String(key ?? "");
  if (k.length < BILLING_KEY_MIN) return `billing_key_min_${BILLING_KEY_MIN}_chars`;
  if (k.length > BILLING_KEY_MAX) return "billing_key_too_long";
  return null;
}

/**
 * @param {string} key
 * @returns {{ keySalt: string, keyHash: string }}
 */
export function hashBillingKey(key) {
  const problem = validateBillingKey(key);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const hash = scryptSync(String(key), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { keySalt: salt.toString("hex"), keyHash: hash.toString("hex") };
}

/** @param {string} key @param {string} saltHex @param {string} hashHex */
function keyMatches(key, saltHex, hashHex) {
  const computed = scryptSync(String(key), Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN, SCRYPT_OPTS);
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === computed.length && timingSafeEqual(computed, expected);
}

const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "0".repeat(64);

/**
 * Verify the billing credential on a request. Rate limited, records every attempt.
 *
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {ReturnType<typeof import("./membership-billing-auth-store.mjs").createMemoryBillingAuthStore> | ReturnType<typeof import("./membership-billing-auth-store.mjs").createPostgresBillingAuthStore>} store
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ ok: true, actor: { id: string, role: string, displayName: string | null }, ipHash: string | null }
 *   | { ok: false, status: number, reason: string, ipHash: string | null }>}
 */
export async function verifyBillingActor(event, store, opts = {}) {
  const ipHash = clientIpHash(event);
  const actorId = header(event?.headers, "x-billing-actor").toLowerCase();
  const key = header(event?.headers, "x-billing-key");
  if (!actorId || !key) return { ok: false, status: 403, reason: "billing_credentials_missing", ipHash };
  if (!ACTOR_ID_RE.test(actorId) || key.length > BILLING_KEY_MAX) {
    await store.recordAttempt({ actorId: null, ipHash, success: false, reason: "malformed" });
    return { ok: false, status: 403, reason: "billing_credentials_invalid", ipHash };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const recent = await store.recentFailures({ actorId, ipHash, sinceMs: nowMs - RATE_LIMIT.windowMs });
  if (recent.actorFailures >= RATE_LIMIT.perActor || recent.ipFailures >= RATE_LIMIT.perIp) {
    await store.recordAttempt({ actorId, ipHash, success: false, reason: "rate_limited" });
    return { ok: false, status: 429, reason: "billing_auth_rate_limited", ipHash };
  }

  const admin = await store.getAdmin(actorId);
  const active = admin && admin.status === "active";
  const match = keyMatches(key, active ? admin.keySalt : DUMMY_SALT, active ? admin.keyHash : DUMMY_HASH);
  if (!active || !match) {
    await store.recordAttempt({ actorId, ipHash, success: false, reason: !admin ? "unknown_actor" : !active ? "revoked" : "bad_key" });
    return { ok: false, status: 403, reason: "billing_credentials_invalid", ipHash };
  }
  await store.recordAttempt({ actorId, ipHash, success: true, reason: null });
  await store.touchVerified(actorId);
  return { ok: true, actor: { id: admin.actorId, role: admin.role, displayName: admin.displayName }, ipHash };
}
