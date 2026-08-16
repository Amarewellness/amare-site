/**
 * AMARÉ Auth identity adapter (Phase 1 + 2A.1 groundwork).
 *
 * No `handler` export. No public HTTP. Tests and future gated admin import this module.
 * Live booking / member APIs must not call write methods.
 *
 * D26: creating a user + identity does not claim a Studio Client.
 */

import { getConnectionString, getDatabase } from "@netlify/database";
import {
  ACTIVE_ASSOCIATION_STATUSES,
  assertAssociationTransition,
  isApplePrivateRelayEmail,
  newAmareUserId,
  PHASE1_WRITE_CEILING,
} from "./amare-identity-policy.mjs";

export const IDENTITY_PROVIDERS = Object.freeze(["google", "apple", "email", "mindbody"]);

/**
 * @param {unknown} provider
 * @returns {"google" | "apple" | "email" | "mindbody"}
 */
export function assertIdentityProvider(provider) {
  const p = typeof provider === "string" ? provider.trim() : "";
  if (!IDENTITY_PROVIDERS.includes(p)) throw new Error("unknown_identity_provider");
  return /** @type {"google" | "apple" | "email" | "mindbody"} */ (p);
}

/**
 * @param {"google" | "apple" | "email" | "mindbody"} provider
 * @param {unknown} raw
 */
export function assertProviderSub(provider, raw) {
  const sub = typeof raw === "string" ? raw.trim() : "";
  if (!sub) throw new Error("invalid_provider_sub");
  if (provider === "mindbody") {
    if (sub.includes("@")) throw new Error("mindbody_provider_sub_must_be_oidc_sub");
    if (/^\d+$/.test(sub)) throw new Error("mindbody_provider_sub_must_not_be_client_id");
  }
  return sub;
}

export function identityDatabaseUrl() {
  try {
    const native = getConnectionString();
    if (typeof native === "string" && native.trim()) return native.trim();
  } catch {
    /* local CLI / tests: fall back to explicit env */
  }
  return (
    (process.env.NETLIFY_DB_URL || "").trim() ||
    (process.env.NETLIFY_DATABASE_URL || "").trim() ||
    (process.env.DATABASE_URL || "").trim() ||
    ""
  );
}

/** @type {{ url: string, db: import("@netlify/database").DatabaseConnection } | null} */
let cachedDb = null;

function getIdentityDb() {
  const url = identityDatabaseUrl();
  if (!url) throw new Error("identity_db_unconfigured");
  if (cachedDb && cachedDb.url === url) return cachedDb.db;
  cachedDb = { url, db: getDatabase({ connectionString: url }) };
  return cachedDb.db;
}

/**
 * Parameterized SQL via the native Netlify Database pool (`pg` on server, Neon on Functions).
 * @param {string} text
 * @param {unknown[]} [values]
 * @returns {Promise<{ rows: Record<string, unknown>[] }>}
 */
export async function identityQuery(text, values = []) {
  const result = await getIdentityDb().pool.query(text, values);
  return { rows: result.rows || [] };
}

export async function closeIdentityDb() {
  if (!cachedDb) return;
  const pool = cachedDb.db.pool;
  cachedDb = null;
  if (pool && typeof pool.end === "function") await pool.end();
}

export async function createAmareUser() {
  const amare_user_id = newAmareUserId();
  await identityQuery("INSERT INTO amare_users (amare_user_id) VALUES ($1)", [amare_user_id]);
  console.log(JSON.stringify({ event: "amare_user_created", amare_user_id }));
  return { amare_user_id };
}

/**
 * @param {string} provider
 * @param {string} providerSub
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findIdentity(provider, providerSub) {
  const p = assertIdentityProvider(provider);
  const sub = assertProviderSub(p, providerSub);
  const r = await identityQuery(
    `SELECT * FROM amare_identities WHERE provider = $1 AND provider_sub = $2 LIMIT 1`,
    [p, sub],
  );
  return r.rows[0] || null;
}

/**
 * @param {string} amareUserId
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listIdentities(amareUserId) {
  const id = String(amareUserId || "").trim();
  if (!id.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  const r = await identityQuery(
    `SELECT * FROM amare_identities WHERE amare_user_id = $1 ORDER BY created_at ASC, id ASC`,
    [id],
  );
  return r.rows;
}

/**
 * @param {{
 *   amare_user_id: string;
 *   provider: "google" | "apple" | "email" | "mindbody";
 *   provider_sub: string;
 *   email?: string | null;
 *   email_verified?: boolean;
 * }} input
 */
export async function attachIdentity(input) {
  const provider = assertIdentityProvider(input.provider);
  const provider_sub = assertProviderSub(provider, input.provider_sub);
  const email = (input.email || "").trim().toLowerCase() || null;
  const is_private_relay = email ? isApplePrivateRelayEmail(email) : false;
  await identityQuery(
    `INSERT INTO amare_identities
      (amare_user_id, provider, provider_sub, email, email_verified, is_private_relay)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.amare_user_id, provider, provider_sub, email, input.email_verified === true, is_private_relay],
  );
  console.log(
    JSON.stringify({
      event: "amare_identity_attached",
      amare_user_id: input.amare_user_id,
      provider,
      is_private_relay,
    }),
  );
}

/**
 * Create amare_users + amare_identities in one transaction.
 * Does not write amare_studio_associations (D26).
 *
 * @param {{
 *   provider: "google" | "apple" | "email" | "mindbody";
 *   provider_sub?: string;
 *   providerSub?: string;
 *   email?: string | null;
 *   email_verified?: boolean;
 * }} input
 */
export async function createUserWithIdentity(input) {
  const provider = assertIdentityProvider(input.provider);
  const provider_sub = assertProviderSub(provider, input.provider_sub ?? input.providerSub);
  const email = (input.email || "").trim().toLowerCase() || null;
  const is_private_relay = email ? isApplePrivateRelayEmail(email) : false;
  const amare_user_id = newAmareUserId();
  const client = await getIdentityDb().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO amare_users (amare_user_id) VALUES ($1)", [amare_user_id]);
    await client.query(
      `INSERT INTO amare_identities
        (amare_user_id, provider, provider_sub, email, email_verified, is_private_relay)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [amare_user_id, provider, provider_sub, email, input.email_verified === true, is_private_relay],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ event: "amare_user_created", amare_user_id }));
  console.log(
    JSON.stringify({
      event: "amare_identity_attached",
      amare_user_id,
      provider,
      is_private_relay,
    }),
  );
  return { amare_user_id, provider, provider_sub };
}

/**
 * @param {string} amareUserId
 * @param {string} siteId
 */
export async function getActiveAssociation(amareUserId, siteId) {
  const r = await identityQuery(
    `SELECT * FROM amare_studio_associations
     WHERE amare_user_id = $1 AND system = 'mindbody' AND site_id = $2
       AND status = ANY($3::text[])
     ORDER BY updated_at DESC
     LIMIT 1`,
    [amareUserId, siteId, [...ACTIVE_ASSOCIATION_STATUSES]],
  );
  return r.rows[0] || null;
}

/**
 * @param {string} amareUserId
 */
export async function lookupActiveClientId(amareUserId) {
  const siteId = (process.env.MINDBODY_SITE_ID || "").trim();
  if (!siteId) return null;
  const row = await getActiveAssociation(amareUserId, siteId);
  const raw = row?.client_id;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Propose a non-active association (candidate / ambiguous / unlinked+relay).
 * Never writes verified or linked.
 *
 * @param {{
 *   amare_user_id: string;
 *   site_id: string;
 *   status: "candidate" | "ambiguous" | "unlinked";
 *   client_id?: number | null;
 *   candidate_client_ids?: number[] | null;
 *   block_reason?: string | null;
 * }} input
 */
export async function proposeAssociation(input) {
  if (input.status === "verified" || input.status === "linked") {
    throw new Error("propose_cannot_write_active_status");
  }
  if (input.block_reason === "apple_relay" || input.status === "unlinked") {
    if (input.status !== "unlinked") throw new Error("relay_must_be_unlinked");
  }
  await identityQuery(
    `INSERT INTO amare_studio_associations
      (amare_user_id, system, site_id, client_id, status, claim_method, candidate_client_ids, block_reason)
     VALUES ($1, 'mindbody', $2, $3, $4, 'none', $5::jsonb, $6)`,
    [
      input.amare_user_id,
      input.site_id,
      input.client_id ?? null,
      input.status,
      input.candidate_client_ids ? JSON.stringify(input.candidate_client_ids) : null,
      input.block_reason ?? null,
    ],
  );
  const event =
    input.block_reason === "apple_relay" ? "amare_association_blocked_relay" : "amare_association_proposed";
  console.log(
    JSON.stringify({
      event,
      amare_user_id: input.amare_user_id,
      status: input.status,
      block_reason: input.block_reason ?? null,
    }),
  );
}

/**
 * Explicit confirm only. Phase 1 ceiling: verified.
 *
 * @param {{
 *   amare_user_id: string;
 *   site_id: string;
 *   fromStatus: string;
 *   client_id: number;
 *   claim_method: "mb_sess_confirmed" | "email_unique_confirmed" | "email_phone_confirmed" | "staff_manual";
 *   claim_proof_ref?: string | null;
 *   explicitConfirm: true;
 * }} input
 */
export async function confirmAssociation(input) {
  if (input.explicitConfirm !== true) throw new Error("verified_requires_explicit_confirm");
  assertAssociationTransition(input.fromStatus, "verified", {
    phase: 1,
    explicitConfirm: true,
  });
  if (PHASE1_WRITE_CEILING !== "verified") throw new Error("phase1_ceiling_changed");
  const clientId = Number(input.client_id);
  if (!Number.isFinite(clientId) || clientId <= 0) throw new Error("invalid_client_id");

  await identityQuery(
    `INSERT INTO amare_studio_associations
      (amare_user_id, system, site_id, client_id, status, claim_method, claim_proof_ref, claimed_at)
     VALUES ($1, 'mindbody', $2, $3, 'verified', $4, $5, NOW())`,
    [
      input.amare_user_id,
      input.site_id,
      clientId,
      input.claim_method,
      input.claim_proof_ref ?? null,
    ],
  );
  console.log(
    JSON.stringify({
      event: "amare_association_confirmed",
      amare_user_id: input.amare_user_id,
      status: "verified",
      claim_method: input.claim_method,
    }),
  );
}

/**
 * @param {{ amare_user_id: string; site_id: string; fromStatus: "verified" | "linked"; block_reason?: string }} input
 */
export async function markAssociationConflict(input) {
  assertAssociationTransition(input.fromStatus, "conflict", { phase: 1 });
  await identityQuery(
    `UPDATE amare_studio_associations
     SET status = 'conflict', block_reason = $3, updated_at = NOW()
     WHERE amare_user_id = $1 AND site_id = $2 AND status = $4`,
    [input.amare_user_id, input.site_id, input.block_reason || "session_conflict", input.fromStatus],
  );
  console.warn(
    JSON.stringify({
      event: "amare_association_conflict",
      amare_user_id: input.amare_user_id,
      from: input.fromStatus,
    }),
  );
}

/** Forbidden in Phase 1. */
export async function promoteAssociationToLinked() {
  throw new Error("linked_forbidden_in_phase1");
}
