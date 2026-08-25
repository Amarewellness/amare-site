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
/** OIDC Core `sub` maximum length. Provenance is the caller's duty, not shape. */
export const PROVIDER_SUB_MAX_LENGTH = 255;

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
  assertIdentityProvider(provider);
  if (typeof raw !== "string") throw new Error("invalid_provider_sub");
  const sub = raw.trim();
  if (!sub) throw new Error("invalid_provider_sub");
  if (sub.length > PROVIDER_SUB_MAX_LENGTH) throw new Error("invalid_provider_sub");
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

/** Presence-only probe. Never returns a connection string. */
export function identityDbBindingProbe() {
  let native = "EMPTY";
  try {
    const v = getConnectionString();
    if (typeof v === "string" && v.trim()) native = "NONEMPTY";
  } catch {
    native = "EMPTY";
  }
  const present = (key) => ((process.env[key] || "").trim() ? "NONEMPTY" : "EMPTY");
  return {
    getConnectionString: native,
    NETLIFY_DB_URL: present("NETLIFY_DB_URL"),
    NETLIFY_DATABASE_URL: present("NETLIFY_DATABASE_URL"),
    DATABASE_URL: present("DATABASE_URL"),
  };
}

let bindingLogged = false;

function logIdentityDbBindingOnce() {
  if (bindingLogged) return;
  bindingLogged = true;
  console.log(
    JSON.stringify({
      event: "amare_identity_db_binding",
      ...identityDbBindingProbe(),
    }),
  );
}

/** @type {{ url: string, db: import("@netlify/database").DatabaseConnection } | null} */
let cachedDb = null;

function getIdentityDb() {
  logIdentityDbBindingOnce();
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

/**
 * One connection, BEGIN/COMMIT. Used by OTP consume so two verifiers cannot both succeed.
 * @template T
 * @param {(client: { query: Function }) => Promise<T>} fn
 */
export async function withIdentityTransaction(fn) {
  const client = await getIdentityDb().pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
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
 * Read-only. Does not touch associations.
 * @param {string} amareUserId
 */
/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isAmareUserDeleted(row) {
  if (!row || typeof row !== "object") return false;
  return String(row.status || "active") === "deleted";
}

function isMissingDeletionSchemaError(err) {
  const msg = String(err?.message || err);
  return (
    err?.code === "42703" ||
    /column "status" does not exist/i.test(msg) ||
    /column "deleted_at" does not exist/i.test(msg) ||
    /column "deletion_requested_at" does not exist/i.test(msg)
  );
}

export async function findAmareUserById(amareUserId) {
  const id = String(amareUserId || "").trim();
  if (!id.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  try {
    const r = await identityQuery(
      `SELECT amare_user_id, status, deleted_at, deletion_requested_at, created_at
         FROM amare_users WHERE amare_user_id = $1 LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      amare_user_id: String(row.amare_user_id),
      status: String(row.status || "active"),
      deleted_at: row.deleted_at ?? null,
      deletion_requested_at: row.deletion_requested_at ?? null,
      created_at: row.created_at ?? null,
    };
  } catch (err) {
    if (!isMissingDeletionSchemaError(err)) throw err;
    const legacy = await identityQuery(
      `SELECT amare_user_id, created_at FROM amare_users WHERE amare_user_id = $1 LIMIT 1`,
      [id],
    );
    const row = legacy.rows[0];
    if (!row) return null;
    return {
      amare_user_id: String(row.amare_user_id),
      status: "active",
      deleted_at: null,
      deletion_requested_at: null,
      created_at: row.created_at ?? null,
    };
  }
}

/**
 * Soft-delete AMARÉ app account: tombstone user, delete identities, unlink associations.
 * Policy A: identity rows are removed so the same email may register as a new usr_* later.
 *
 * @param {string} amareUserId
 * @param {{ siteId?: string }} [deps]
 */
export async function deactivateAmareAppAccount(amareUserId, deps = {}) {
  const id = String(amareUserId || "").trim();
  if (!id.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  const siteId = String(deps.siteId || process.env.MINDBODY_SITE_ID || "").trim() || "amare-unknown-site";

  return withIdentityTransaction(async (client) => {
    const userRes = await client.query(
      `SELECT amare_user_id, status FROM amare_users WHERE amare_user_id = $1 FOR UPDATE`,
      [id],
    );
    const user = userRes.rows[0];
    if (!user) throw new Error("user_not_found");
    if (String(user.status || "active") === "deleted") {
      return { ok: true, alreadyDeleted: true, amare_user_id: id, emails: [] };
    }

    const idRes = await client.query(
      `SELECT email, provider, provider_sub FROM amare_identities WHERE amare_user_id = $1`,
      [id],
    );
    /** @type {string[]} */
    const emails = [];
    for (const row of idRes.rows) {
      const direct = String(row.email || "").trim().toLowerCase();
      if (direct && direct.includes("@")) emails.push(direct);
      if (String(row.provider || "") === "email") {
        const sub = String(row.provider_sub || "").trim().toLowerCase();
        if (sub && sub.includes("@")) emails.push(sub);
      }
    }

    await client.query(
      `UPDATE amare_studio_associations
          SET status = 'unlinked', block_reason = 'account_deleted', updated_at = NOW()
        WHERE amare_user_id = $1
          AND system = 'mindbody'
          AND site_id = $2
          AND status IN ('verified', 'linked', 'candidate', 'ambiguous')`,
      [id, siteId],
    );

    await client.query(`DELETE FROM amare_identities WHERE amare_user_id = $1`, [id]);

    await client.query(
      `UPDATE amare_users
          SET status = 'deleted',
              deleted_at = NOW(),
              deletion_requested_at = COALESCE(deletion_requested_at, NOW())
        WHERE amare_user_id = $1`,
      [id],
    );

    console.log(
      JSON.stringify({
        event: "amare_app_account_deactivated",
        amare_user_id: id,
        site_id: siteId,
      }),
    );

    return { ok: true, alreadyDeleted: false, amare_user_id: id, emails: [...new Set(emails)] };
  });
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
export async function getLinkedAssociation(amareUserId, siteId) {
  const r = await identityQuery(
    `SELECT * FROM amare_studio_associations
     WHERE amare_user_id = $1 AND system = 'mindbody' AND site_id = $2
       AND status = 'linked'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [amareUserId, siteId],
  );
  return r.rows[0] || null;
}

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
 * Active (verified/linked) owner of a Studio clientId, if any.
 * @param {string} siteId
 * @param {number} clientId
 */
export async function findActiveAssociationByClientId(siteId, clientId) {
  const n = Number(clientId);
  if (!siteId || !Number.isFinite(n) || n <= 0) return null;
  const r = await identityQuery(
    `SELECT * FROM amare_studio_associations
      WHERE system = 'mindbody' AND site_id = $1 AND client_id = $2
        AND status = ANY($3::text[])
      ORDER BY updated_at DESC
      LIMIT 1`,
    [siteId, n, [...ACTIVE_ASSOCIATION_STATUSES]],
  );
  return r.rows[0] || null;
}

/**
 * Latest association row for a user on a site (any status).
 * @param {string} amareUserId
 * @param {string} siteId
 */
export async function getLatestAssociation(amareUserId, siteId) {
  const r = await identityQuery(
    `SELECT * FROM amare_studio_associations
      WHERE amare_user_id = $1 AND system = 'mindbody' AND site_id = $2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [amareUserId, siteId],
  );
  return r.rows[0] || null;
}

/**
 * Current candidate row used by /claim/confirm. Server-side authority.
 * @param {string} amareUserId
 * @param {string} siteId
 */
export async function getCandidateAssociation(amareUserId, siteId) {
  const r = await identityQuery(
    `SELECT * FROM amare_studio_associations
      WHERE amare_user_id = $1 AND system = 'mindbody' AND site_id = $2
        AND status = 'candidate'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [amareUserId, siteId],
  );
  return r.rows[0] || null;
}

/**
 * Propose a non-active association (candidate / ambiguous / unlinked+relay).
 * Never writes verified or linked.
 *
 * @param {{
 *   amare_user_id: string;
 *   site_id: string;
 *   status: "candidate" | "ambiguous" | "unlinked" | "conflict";
 *   client_id?: number | null;
 *   candidate_client_ids?: number[] | null;
 *   block_reason?: string | null;
 * }} input
 */
export async function proposeAssociation(input) {
  if (input.status === "verified" || input.status === "linked") {
    throw new Error("propose_cannot_write_active_status");
  }
  if (!["candidate", "ambiguous", "unlinked", "conflict"].includes(input.status)) {
    throw new Error("propose_invalid_status");
  }
  if (input.block_reason === "apple_relay" || input.status === "unlinked") {
    if (input.status !== "unlinked") throw new Error("relay_must_be_unlinked");
  }
  await identityQuery(
    `INSERT INTO amare_studio_associations
      (amare_user_id, system, site_id, client_id, status, claim_method, candidate_client_ids, block_reason, claim_proof_ref)
     VALUES ($1, 'mindbody', $2, $3, $4, 'none', $5::jsonb, $6, $7)`,
    [
      input.amare_user_id,
      input.site_id,
      input.client_id ?? null,
      input.status,
      input.candidate_client_ids ? JSON.stringify(input.candidate_client_ids) : null,
      input.block_reason ?? null,
      input.claim_proof_ref ?? null,
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
 *   claim_method: "mb_sess_confirmed" | "email_unique_confirmed" | "email_phone_confirmed" | "staff_manual" | "new_profile_created";
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

function amareMemberReadFlagOn() {
  return (
    (process.env.ENABLE_AMARE_AUTH || "").trim() === "1" &&
    ((process.env.ENABLE_AMARE_MEMBER_READ || "").trim() === "1" ||
      (process.env.ENABLE_AMARE_STUDIO_OPERATIONS || "").trim() === "1")
  );
}

/**
 * Explicit verified → linked. Flag-gated. Never called from login.
 *
 * @param {{
 *   amare_user_id: string;
 *   site_id: string;
 *   explicitPromote: true;
 * }} input
 */
export async function promoteAssociationToLinked(input) {
  if (!amareMemberReadFlagOn()) throw new Error("linked_forbidden_in_phase1");
  if (input?.explicitPromote !== true) throw new Error("linked_requires_explicit_promote");
  assertAssociationTransition("verified", "linked", { phase: 2 });

  const current = await getActiveAssociation(input.amare_user_id, input.site_id);
  if (current && current.status === "linked") {
    return { ok: true, status: "linked", already: true, client_id: current.client_id };
  }
  if (!current || current.status !== "verified") throw new Error("linked_requires_verified");
  const clientId = Number(current.client_id);
  if (!Number.isFinite(clientId) || clientId <= 0) throw new Error("invalid_client_id");

  const owner = await findActiveAssociationByClientId(input.site_id, clientId);
  if (owner && String(owner.amare_user_id) !== String(input.amare_user_id)) {
    throw new Error("claim_conflict");
  }

  let updated;
  try {
    updated = await identityQuery(
      `UPDATE amare_studio_associations
       SET status = 'linked', updated_at = NOW()
       WHERE id = $1 AND amare_user_id = $2 AND status = 'verified'
       RETURNING id, client_id, status`,
      [current.id, input.amare_user_id],
    );
  } catch (err) {
    if (err?.code === "23505" || /unique|duplicate/i.test(String(err?.message || ""))) {
      throw new Error("claim_conflict");
    }
    throw err;
  }
  if (!updated.rows[0]) throw new Error("linked_requires_verified");
  console.log(
    JSON.stringify({
      event: "amare_association_linked",
      amare_user_id: input.amare_user_id,
      status: "linked",
    }),
  );
  return { ok: true, status: "linked", already: false, client_id: updated.rows[0].client_id };
}

/** Session-level advisory lock for D28 profile create. Released in finally. */
export const AMARE_PROFILE_LOCK_NS = 872314;

/**
 * @template T
 * @param {string} lockKey
 * @param {() => Promise<T>} fn
 */
export async function withAmareOnboardingLock(lockKey, fn) {
  const key = String(lockKey || "").trim();
  if (!key) return fn();
  const client = await getIdentityDb().pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [AMARE_PROFILE_LOCK_NS, key]);
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [AMARE_PROFILE_LOCK_NS, key]);
    } catch {
      /* ignore */
    }
    client.release();
  }
}

/**
 * New-profile-only: candidate → verified → linked in one explicit create action.
 * Does not add a general unlinked → linked transition.
 *
 * @param {{
 *   amare_user_id: string;
 *   site_id: string;
 *   client_id: number;
 *   verifiedEmail?: string | null;
 *   explicitCreate: true;
 * }} input
 */
export async function completeNewProfileCreatedAssociation(input) {
  if (input?.explicitCreate !== true) throw new Error("explicit_create_required");
  const clientId = Number(input.client_id);
  if (!Number.isFinite(clientId) || clientId <= 0) throw new Error("invalid_client_id");
  const email = String(input.verifiedEmail || "").trim().toLowerCase();

  await proposeAssociation({
    amare_user_id: input.amare_user_id,
    site_id: input.site_id,
    status: "candidate",
    client_id: clientId,
    claim_proof_ref: email ? `new_profile_pending:${email}` : "new_profile_pending",
  });
  await confirmAssociation({
    amare_user_id: input.amare_user_id,
    site_id: input.site_id,
    fromStatus: "candidate",
    client_id: clientId,
    claim_method: "new_profile_created",
    claim_proof_ref: email || null,
    explicitConfirm: true,
  });
  return promoteAssociationToLinked({
    amare_user_id: input.amare_user_id,
    site_id: input.site_id,
    explicitPromote: true,
  });
}
