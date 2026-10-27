/**
 * Billing administrator store (Postgres `amare_billing_admins`, `amare_billing_auth_attempts`,
 * `amare_billing_audit_log`). Memory adapter mirrors the same rules for tests.
 */
import { membershipChangeDatabaseUrl, membershipChangeDbQuery } from "./membership-change-store.mjs";

/**
 * @typedef {{
 *   actorId: string,
 *   displayName: string | null,
 *   role: "owner" | "superadmin",
 *   keySalt: string,
 *   keyHash: string,
 *   status: "active" | "revoked",
 *   createdBy: string,
 *   createdAt: string | null,
 *   keyRotatedAt: string | null,
 *   revokedAt: string | null,
 *   revokedBy: string | null,
 *   lastVerifiedAt: string | null,
 *   mustRotate: boolean,
 *   expiresAt: string | null,
 * }} BillingAdmin
 */

/** @param {unknown} v */
function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** @param {Record<string, any>} r @returns {BillingAdmin} */
function mapAdmin(r) {
  return {
    actorId: String(r.actor_id),
    displayName: r.display_name == null ? null : String(r.display_name),
    role: r.role,
    keySalt: String(r.key_salt),
    keyHash: String(r.key_hash),
    status: r.status,
    createdBy: String(r.created_by),
    createdAt: iso(r.created_at),
    keyRotatedAt: iso(r.key_rotated_at),
    revokedAt: iso(r.revoked_at),
    revokedBy: r.revoked_by == null ? null : String(r.revoked_by),
    lastVerifiedAt: iso(r.last_verified_at),
    mustRotate: r.must_rotate === true,
    expiresAt: iso(r.expires_at),
  };
}

/** @param {BillingAdmin} a @param {number} [nowMs] */
export function billingAdminUsable(a, nowMs = Date.now()) {
  if (!a || a.status !== "active") return false;
  if (a.expiresAt && Date.parse(a.expiresAt) <= nowMs) return false;
  return true;
}

/** Public view (never includes salt/hash). @param {BillingAdmin} a */
export function publicBillingAdmin(a) {
  const expired = Boolean(a.expiresAt && Date.parse(a.expiresAt) <= Date.now());
  return {
    actorId: a.actorId,
    displayName: a.displayName,
    role: a.role,
    status: a.status === "active" && expired ? "expired" : a.status,
    mustRotate: a.mustRotate,
    expiresAt: a.expiresAt,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    keyRotatedAt: a.keyRotatedAt,
    revokedAt: a.revokedAt,
    revokedBy: a.revokedBy,
    lastVerifiedAt: a.lastVerifiedAt,
  };
}

/** @param {Record<string, any>} r */
function mapSession(r) {
  return {
    sessionHash: String(r.session_hash),
    actorId: r.actor_id == null ? null : String(r.actor_id),
    role: r.role,
    csrfToken: String(r.csrf_token),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
  };
}

export function createMemoryBillingAuthStore() {
  /** @type {Map<string, Record<string, any>>} */
  const admins = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const sessions = new Map();
  /** @type {Array<Record<string, any>>} */
  const attempts = [];
  /** @type {Array<Record<string, any>>} */
  const audit = [];
  const now = () => new Date().toISOString();
  const activeOwners = () => [...admins.values()].filter((a) => a.role === "owner" && a.status === "active").length;

  return {
    kind: /** @type {const} */ ("memory"),
    audit,
    attempts,
    /** @param {string} actorId */
    async getAdmin(actorId) {
      const r = admins.get(actorId);
      return r ? mapAdmin(r) : null;
    },
    async listAdmins() {
      return [...admins.values()].map(mapAdmin).sort((a, b) => a.actorId.localeCompare(b.actorId));
    },
    /** @param {{ actorId: string, displayName?: string | null, role: string, keySalt: string, keyHash: string, createdBy: string, mustRotate?: boolean, expiresAt?: string | null }} input */
    async enrollAdmin(input) {
      const existing = admins.get(input.actorId);
      if (existing && existing.status === "active") return { ok: false, reason: "already_enrolled" };
      admins.set(input.actorId, {
        actor_id: input.actorId,
        display_name: input.displayName ?? null,
        role: input.role,
        key_salt: input.keySalt,
        key_hash: input.keyHash,
        status: "active",
        created_by: input.createdBy,
        created_at: now(),
        key_rotated_at: null,
        revoked_at: null,
        revoked_by: null,
        last_verified_at: null,
        must_rotate: input.mustRotate === true,
        expires_at: input.expiresAt ?? null,
      });
      return { ok: true, admin: mapAdmin(admins.get(input.actorId)) };
    },
    /** @param {string} actorId @param {string} keySalt @param {string} keyHash */
    async rotateKey(actorId, keySalt, keyHash) {
      const r = admins.get(actorId);
      if (!r || r.status !== "active") return { ok: false, reason: "not_active" };
      Object.assign(r, { key_salt: keySalt, key_hash: keyHash, key_rotated_at: now(), must_rotate: false });
      return { ok: true };
    },
    /** @param {string} actorId @param {string} revokedBy */
    async revokeAdmin(actorId, revokedBy) {
      const r = admins.get(actorId);
      if (!r || r.status !== "active") return { ok: false, reason: "not_active" };
      if (r.role === "owner" && activeOwners() <= 1) return { ok: false, reason: "last_owner" };
      Object.assign(r, { status: "revoked", revoked_at: now(), revoked_by: revokedBy });
      for (const s of sessions.values()) {
        if (s.actor_id === actorId && !s.revoked_at) s.revoked_at = now();
      }
      return { ok: true };
    },
    /**
     * @param {{ sessionHash: string, actorId: string | null, role: string, csrfToken: string, expiresAt: string, ipHash?: string | null }} input
     */
    async createSession(input) {
      sessions.set(input.sessionHash, {
        session_hash: input.sessionHash,
        actor_id: input.actorId,
        role: input.role,
        csrf_token: input.csrfToken,
        expires_at: input.expiresAt,
        revoked_at: null,
        ip_hash: input.ipHash ?? null,
        created_at: now(),
      });
      return { ok: true };
    },
    /** @param {string} sessionHash */
    async getSession(sessionHash) {
      const r = sessions.get(sessionHash);
      if (!r || r.revoked_at) return null;
      if (Date.parse(r.expires_at) <= Date.now()) return null;
      return mapSession(r);
    },
    /** @param {string} sessionHash */
    async revokeSession(sessionHash) {
      const r = sessions.get(sessionHash);
      if (r && !r.revoked_at) r.revoked_at = now();
    },
    /** @param {string} role */
    async revokeSessionsByRole(role) {
      for (const s of sessions.values()) {
        if (s.role === role && !s.revoked_at) s.revoked_at = now();
      }
    },
    /** @param {{ actorId: string | null, ipHash: string | null, sinceMs: number }} q */
    async recentFailures(q) {
      const recent = attempts.filter((a) => !a.success && Date.parse(a.created_at) >= q.sinceMs);
      return {
        actorFailures: q.actorId ? recent.filter((a) => a.actor_id === q.actorId).length : 0,
        ipFailures: q.ipHash ? recent.filter((a) => a.ip_hash === q.ipHash).length : 0,
      };
    },
    /** @param {{ actorId: string | null, ipHash: string | null, success: boolean, reason: string | null }} a */
    async recordAttempt(a) {
      attempts.push({ actor_id: a.actorId, ip_hash: a.ipHash, success: a.success, reason: a.reason, created_at: now() });
    },
    /** @param {string} actorId */
    async touchVerified(actorId) {
      const r = admins.get(actorId);
      if (r) r.last_verified_at = now();
    },
    /** @param {{ actorId: string | null, action: string, subscriptionRecordId?: string | null, operationId?: string | null, outcome: string, detail?: Record<string, unknown>, ipHash?: string | null }} e */
    async appendAudit(e) {
      audit.push({ ...e, created_at: now() });
    },
  };
}

export function createPostgresBillingAuthStore() {
  const q = membershipChangeDbQuery;
  return {
    kind: /** @type {const} */ ("postgres"),
    /** @param {string} actorId */
    async getAdmin(actorId) {
      const r = await q(`SELECT * FROM amare_billing_admins WHERE actor_id = $1`, [actorId]);
      return r.rows[0] ? mapAdmin(r.rows[0]) : null;
    },
    async listAdmins() {
      const r = await q(`SELECT * FROM amare_billing_admins ORDER BY actor_id`);
      return r.rows.map(mapAdmin);
    },
    /** @param {{ actorId: string, displayName?: string | null, role: string, keySalt: string, keyHash: string, createdBy: string, mustRotate?: boolean, expiresAt?: string | null }} input */
    async enrollAdmin(input) {
      const r = await q(
        `INSERT INTO amare_billing_admins (actor_id, display_name, role, key_salt, key_hash, created_by, must_rotate, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (actor_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           key_salt = EXCLUDED.key_salt,
           key_hash = EXCLUDED.key_hash,
           created_by = EXCLUDED.created_by,
           must_rotate = EXCLUDED.must_rotate,
           expires_at = EXCLUDED.expires_at,
           status = 'active',
           revoked_at = NULL,
           revoked_by = NULL,
           key_rotated_at = NOW(),
           updated_at = NOW()
         WHERE amare_billing_admins.status = 'revoked'
         RETURNING *`,
        [
          input.actorId,
          input.displayName ?? null,
          input.role,
          input.keySalt,
          input.keyHash,
          input.createdBy,
          input.mustRotate === true,
          input.expiresAt ?? null,
        ],
      );
      if (!r.rows[0]) return { ok: false, reason: "already_enrolled" };
      return { ok: true, admin: mapAdmin(r.rows[0]) };
    },
    /** @param {string} actorId @param {string} keySalt @param {string} keyHash */
    async rotateKey(actorId, keySalt, keyHash) {
      const r = await q(
        `UPDATE amare_billing_admins
            SET key_salt = $2, key_hash = $3, key_rotated_at = NOW(), must_rotate = FALSE, updated_at = NOW()
          WHERE actor_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING actor_id`,
        [actorId, keySalt, keyHash],
      );
      return r.rows[0] ? { ok: true } : { ok: false, reason: "not_active" };
    },
    /** @param {string} actorId @param {string} revokedBy */
    async revokeAdmin(actorId, revokedBy) {
      const r = await q(
        `UPDATE amare_billing_admins a
            SET status = 'revoked', revoked_at = NOW(), revoked_by = $2, updated_at = NOW()
          WHERE a.actor_id = $1
            AND a.status = 'active'
            AND (a.role <> 'owner'
                 OR (SELECT COUNT(*) FROM amare_billing_admins o WHERE o.role = 'owner' AND o.status = 'active') > 1)
          RETURNING a.actor_id`,
        [actorId, revokedBy],
      );
      if (r.rows[0]) {
        await q(
          `UPDATE amare_admin_sessions SET revoked_at = NOW() WHERE actor_id = $1 AND revoked_at IS NULL`,
          [actorId],
        );
        return { ok: true };
      }
      const cur = await this.getAdmin(actorId);
      if (!cur || cur.status !== "active") return { ok: false, reason: "not_active" };
      return { ok: false, reason: "last_owner" };
    },
    /**
     * @param {{ sessionHash: string, actorId: string | null, role: string, csrfToken: string, expiresAt: string, ipHash?: string | null }} input
     */
    async createSession(input) {
      await q(
        `INSERT INTO amare_admin_sessions (session_hash, actor_id, role, csrf_token, expires_at, ip_hash)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6)`,
        [input.sessionHash, input.actorId, input.role, input.csrfToken, input.expiresAt, input.ipHash ?? null],
      );
      return { ok: true };
    },
    /** @param {string} sessionHash */
    async getSession(sessionHash) {
      const r = await q(`SELECT * FROM amare_admin_sessions WHERE session_hash = $1`, [sessionHash]);
      const row = r.rows[0];
      if (!row || row.revoked_at) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) return null;
      return mapSession(row);
    },
    /** @param {string} sessionHash */
    async revokeSession(sessionHash) {
      await q(
        `UPDATE amare_admin_sessions SET revoked_at = NOW() WHERE session_hash = $1 AND revoked_at IS NULL`,
        [sessionHash],
      );
    },
    /** @param {string} role */
    async revokeSessionsByRole(role) {
      await q(`UPDATE amare_admin_sessions SET revoked_at = NOW() WHERE role = $1 AND revoked_at IS NULL`, [role]);
    },
    /** @param {{ actorId: string | null, ipHash: string | null, sinceMs: number }} p */
    async recentFailures(p) {
      const since = new Date(p.sinceMs).toISOString();
      const r = await q(
        `SELECT
           COUNT(*) FILTER (WHERE actor_id = $1) AS actor_failures,
           COUNT(*) FILTER (WHERE ip_hash = $2) AS ip_failures
         FROM amare_billing_auth_attempts
         WHERE success = FALSE AND created_at >= $3::timestamptz AND (actor_id = $1 OR ip_hash = $2)`,
        [p.actorId, p.ipHash, since],
      );
      return {
        actorFailures: Number(r.rows[0]?.actor_failures || 0),
        ipFailures: Number(r.rows[0]?.ip_failures || 0),
      };
    },
    /** @param {{ actorId: string | null, ipHash: string | null, success: boolean, reason: string | null }} a */
    async recordAttempt(a) {
      await q(
        `INSERT INTO amare_billing_auth_attempts (actor_id, ip_hash, success, reason) VALUES ($1, $2, $3, $4)`,
        [a.actorId, a.ipHash, a.success, a.reason],
      );
    },
    /** @param {string} actorId */
    async touchVerified(actorId) {
      await q(`UPDATE amare_billing_admins SET last_verified_at = NOW() WHERE actor_id = $1`, [actorId]);
    },
    /** @param {{ actorId: string | null, action: string, subscriptionRecordId?: string | null, operationId?: string | null, outcome: string, detail?: Record<string, unknown>, ipHash?: string | null }} e */
    async appendAudit(e) {
      await q(
        `INSERT INTO amare_billing_audit_log (actor_id, action, subscription_record_id, operation_id, outcome, detail, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          e.actorId,
          e.action,
          e.subscriptionRecordId ?? null,
          e.operationId ?? null,
          e.outcome,
          JSON.stringify(e.detail ?? {}),
          e.ipHash ?? null,
        ],
      );
    },
  };
}

/** @type {ReturnType<typeof createMemoryBillingAuthStore> | null} */
let sharedMemory = null;

export function openBillingAuthStore() {
  const envMemory =
    !(process.env.NETLIFY || "").trim() && (process.env.MEMBERSHIP_CHANGE_STORE_MEMORY || "").trim() === "1";
  if (envMemory) {
    if (!sharedMemory) sharedMemory = createMemoryBillingAuthStore();
    return sharedMemory;
  }
  if (!membershipChangeDatabaseUrl()) {
    throw Object.assign(new Error("membership_change_db_unconfigured"), { code: "membership_change_db_unconfigured" });
  }
  return createPostgresBillingAuthStore();
}
