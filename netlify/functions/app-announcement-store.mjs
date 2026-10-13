/**
 * Postgres store for AMARÉ in-app announcements.
 */

import { randomUUID } from "node:crypto";
import { identityQuery, withIdentityTransaction } from "./amare-identity-store.mjs";
import { amareSiteId } from "./amare-auth-lib.mjs";
import { mapAnnouncementRow } from "./app-announcement-lib.mjs";

export function announcementStoreAvailable() {
  try {
    return true;
  } catch {
    return false;
  }
}

/** @param {Record<string, unknown>} row */
function mapReceiptRow(row) {
  return {
    announcementId: String(row.announcement_id),
    amareUserId: String(row.amare_user_id),
    firstSeenAt:
      row.first_seen_at instanceof Date
        ? row.first_seen_at.toISOString()
        : row.first_seen_at != null
          ? String(row.first_seen_at)
          : null,
    acknowledgedAt:
      row.acknowledged_at instanceof Date
        ? row.acknowledged_at.toISOString()
        : row.acknowledged_at != null
          ? String(row.acknowledged_at)
          : null,
  };
}

export async function fetchEligibleAnnouncementRow() {
  const r = await identityQuery(
    `SELECT * FROM amare_app_announcements
      WHERE is_active = true
        AND starts_at <= NOW()
        AND expires_at > NOW()
      ORDER BY updated_at DESC
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/** @param {string} announcementId @param {string} amareUserId */
export async function fetchReceipt(announcementId, amareUserId) {
  const r = await identityQuery(
    `SELECT * FROM amare_app_announcement_receipts
      WHERE announcement_id = $1 AND amare_user_id = $2
      LIMIT 1`,
    [announcementId, amareUserId],
  );
  return r.rows[0] ?? null;
}

/** @param {string} amareUserId */
export async function getActiveAnnouncementForUser(amareUserId) {
  const row = await fetchEligibleAnnouncementRow();
  if (!row) return null;
  const ann = mapAnnouncementRow(row);
  if (!ann) return null;
  const receipt = await fetchReceipt(ann.id, amareUserId);
  return { announcement: ann, receipt };
}

/** @param {string} announcementId @param {string} amareUserId */
export async function recordSeen(announcementId, amareUserId) {
  const r = await identityQuery(
    `INSERT INTO amare_app_announcement_receipts (announcement_id, amare_user_id, first_seen_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (announcement_id, amare_user_id) DO UPDATE
       SET updated_at = NOW(),
           first_seen_at = COALESCE(amare_app_announcement_receipts.first_seen_at, EXCLUDED.first_seen_at)
     RETURNING *`,
    [announcementId, amareUserId],
  );
  return mapReceiptRow(r.rows[0]);
}

/** @param {string} announcementId @param {string} amareUserId */
export async function recordAcknowledgment(announcementId, amareUserId) {
  const r = await identityQuery(
    `INSERT INTO amare_app_announcement_receipts (announcement_id, amare_user_id, first_seen_at, acknowledged_at, updated_at)
     VALUES ($1, $2, NOW(), NOW(), NOW())
     ON CONFLICT (announcement_id, amare_user_id) DO UPDATE
       SET updated_at = NOW(),
           first_seen_at = COALESCE(amare_app_announcement_receipts.first_seen_at, NOW()),
           acknowledged_at = COALESCE(amare_app_announcement_receipts.acknowledged_at, NOW())
     RETURNING *`,
    [announcementId, amareUserId],
  );
  return mapReceiptRow(r.rows[0]);
}

/** Prefer active row for admin; else latest updated. */
export async function fetchAdminCurrentAnnouncement() {
  const active = await identityQuery(
    `SELECT * FROM amare_app_announcements WHERE is_active = true ORDER BY updated_at DESC LIMIT 1`,
  );
  if (active.rows[0]) return mapAnnouncementRow(active.rows[0]);
  const latest = await identityQuery(
    `SELECT * FROM amare_app_announcements ORDER BY updated_at DESC LIMIT 1`,
  );
  return latest.rows[0] ? mapAnnouncementRow(latest.rows[0]) : null;
}

/** @param {string} announcementId */
export async function fetchAnnouncementMetrics(announcementId) {
  const r = await identityQuery(
    `SELECT
        COUNT(*) FILTER (WHERE first_seen_at IS NOT NULL)::int AS seen_clients,
        COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged_clients
      FROM amare_app_announcement_receipts
      WHERE announcement_id = $1`,
    [announcementId],
  );
  const row = r.rows[0] || {};
  const seen = Number(row.seen_clients) || 0;
  const ack = Number(row.acknowledged_clients) || 0;
  return {
    seenClients: seen,
    acknowledgedClients: ack,
    ackRate: seen > 0 ? ack / seen : null,
  };
}

/** @param {string} announcementId @param {number} [limit] @param {number} [offset] */
export async function fetchAdminReceiptRows(announcementId, limit = 200, offset = 0) {
  const siteId = amareSiteId();
  const r = await identityQuery(
    `SELECT
        r.first_seen_at,
        r.acknowledged_at,
        (
          SELECT i.email FROM amare_identities i
           WHERE i.amare_user_id = r.amare_user_id
           ORDER BY i.created_at ASC
           LIMIT 1
        ) AS email,
        (
          SELECT a.client_id FROM amare_studio_associations a
           WHERE a.amare_user_id = r.amare_user_id
             AND a.site_id = $3
             AND a.status IN ('linked', 'verified')
           ORDER BY a.updated_at DESC
           LIMIT 1
        ) AS mindbody_client_id
      FROM amare_app_announcement_receipts r
      WHERE r.announcement_id = $1
      ORDER BY r.first_seen_at DESC NULLS LAST, r.updated_at DESC
      LIMIT $2 OFFSET $4`,
    [announcementId, Math.min(Math.max(limit, 1), 500), siteId, Math.max(offset, 0)],
  );
  return r.rows.map((row) => ({
    email: row.email != null ? String(row.email) : "",
    mindbodyClientId:
      row.mindbody_client_id != null && Number.isFinite(Number(row.mindbody_client_id))
        ? Number(row.mindbody_client_id)
        : null,
    firstSeenAt:
      row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : row.first_seen_at ?? null,
    acknowledged: row.acknowledged_at != null,
    acknowledgedAt:
      row.acknowledged_at instanceof Date
        ? row.acknowledged_at.toISOString()
        : row.acknowledged_at ?? null,
  }));
}

/**
 * @param {{
 *   id?: string | null;
 *   title: string;
 *   message: string;
 *   startsAt: Date;
 *   expiresAt: Date;
 *   requireAcknowledgment: boolean;
 *   ctaLabel: string;
 *   ctaUrl: string | null;
 *   isActive?: boolean;
 * }} input
 */
export async function saveAnnouncement(input) {
  const id = input.id || randomUUID();
  const existing = await identityQuery(`SELECT id FROM amare_app_announcements WHERE id = $1`, [id]);
  if (existing.rows[0]) {
    await identityQuery(
      `UPDATE amare_app_announcements SET
          title = $2,
          message = $3,
          starts_at = $4,
          expires_at = $5,
          require_acknowledgment = $6,
          cta_label = $7,
          cta_url = $8,
          updated_at = NOW()
        WHERE id = $1`,
      [
        id,
        input.title,
        input.message,
        input.startsAt,
        input.expiresAt,
        input.requireAcknowledgment,
        input.ctaLabel,
        input.ctaUrl,
      ],
    );
  } else {
    await identityQuery(
      `INSERT INTO amare_app_announcements (
          id, title, message, is_active, starts_at, expires_at,
          require_acknowledgment, cta_label, cta_url
        ) VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8)`,
      [
        id,
        input.title,
        input.message,
        input.startsAt,
        input.expiresAt,
        input.requireAcknowledgment,
        input.ctaLabel,
        input.ctaUrl,
      ],
    );
  }
  const row = await identityQuery(`SELECT * FROM amare_app_announcements WHERE id = $1`, [id]);
  return mapAnnouncementRow(row.rows[0]);
}

/** @param {string} announcementId */
export async function activateAnnouncement(announcementId) {
  await withIdentityTransaction(async (client) => {
    const exists = await client.query(`SELECT id FROM amare_app_announcements WHERE id = $1`, [
      announcementId,
    ]);
    if (!exists.rows[0]) throw new Error("announcement_not_found");
    await client.query(
      `UPDATE amare_app_announcements SET is_active = false, updated_at = NOW() WHERE is_active = true`,
    );
    await client.query(
      `UPDATE amare_app_announcements SET is_active = true, updated_at = NOW() WHERE id = $1`,
      [announcementId],
    );
  });
  return fetchAdminCurrentAnnouncement();
}

/** @param {string} announcementId */
export async function deactivateAnnouncement(announcementId) {
  await identityQuery(
    `UPDATE amare_app_announcements SET is_active = false, updated_at = NOW() WHERE id = $1`,
    [announcementId],
  );
}

/** In-memory store for unit tests. */
export function createMemoryAnnouncementStore() {
  /** @type {Map<string, Record<string, unknown>>} */
  const announcements = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const receipts = new Map();

  const receiptKey = (a, u) => `${a}:${u}`;

  return {
    kind: "memory",
    reset() {
      announcements.clear();
      receipts.clear();
    },
    upsertAnnouncement(row) {
      announcements.set(String(row.id), { ...row });
    },
    setOnlyActive(id) {
      for (const [k, v] of announcements) {
        announcements.set(k, { ...v, is_active: k === id });
      }
    },
    getReceipt(announcementId, amareUserId) {
      return receipts.get(receiptKey(announcementId, amareUserId)) ?? null;
    },
    recordSeen(announcementId, amareUserId) {
      const k = receiptKey(announcementId, amareUserId);
      const prev = receipts.get(k);
      const first = prev?.first_seen_at ?? new Date().toISOString();
      receipts.set(k, {
        announcement_id: announcementId,
        amare_user_id: amareUserId,
        first_seen_at: prev?.first_seen_at ?? first,
        acknowledged_at: prev?.acknowledged_at ?? null,
      });
      return receipts.get(k);
    },
    recordAck(announcementId, amareUserId) {
      const k = receiptKey(announcementId, amareUserId);
      const prev = receipts.get(k);
      receipts.set(k, {
        announcement_id: announcementId,
        amare_user_id: amareUserId,
        first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
        acknowledged_at: prev?.acknowledged_at ?? new Date().toISOString(),
      });
      return receipts.get(k);
    },
    countActive() {
      let n = 0;
      for (const v of announcements.values()) if (v.is_active === true) n += 1;
      return n;
    },
  };
}
