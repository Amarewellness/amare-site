/**
 * AMARÉ notification durable store (Phase N1).
 * Memory adapter for tests; Postgres when DATABASE_URL is configured.
 * Does not send push. Does not change auth or commerce.
 */

import { randomUUID } from "node:crypto";
import { getConnectionString, getDatabase } from "@netlify/database";

export const CANDIDATE_KINDS = Object.freeze([
  "booking_created",
  "booking_cancelled",
  "waitlist_joined",
  "waitlist_removed",
  "waitlist_promoted",
  "class_cancelled",
  "class_time_changed",
  "class_reminder_due",
]);

export const DEFAULT_PREFERENCES = Object.freeze({
  class_booking_updates: true,
  class_reminders: true,
  waitlist_updates: true,
  studio_news: false,
});

export const ALLOWED_PREFERENCE_KEYS = Object.freeze([
  "class_booking_updates",
  "class_reminders",
  "waitlist_updates",
  "studio_news",
]);

export function sanitizePreferencePatch(patch) {
  /** @type {Record<string, boolean>} */
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  const src = /** @type {Record<string, unknown>} */ (patch);
  for (const key of ALLOWED_PREFERENCE_KEYS) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  return out;
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function bookingKey(siteId, bookingId) {
  return `${siteId}:${bookingId}`;
}

function waitlistKey(siteId, entryId) {
  return `${siteId}:${entryId}`;
}

function reminderKey(userId, siteId, bookingId, type = "class_reminder") {
  return `${userId}:${siteId}:${bookingId}:${type}`;
}

function classKey(siteId, classId) {
  return `${siteId}:${classId}`;
}

function clone(row) {
  return row ? { ...row } : null;
}

export function createMemoryNotificationStore() {
  const inbox = new Map();
  const bookings = new Map();
  const waitlist = new Map();
  const reminders = new Map();
  const classState = new Map();
  const descriptions = new Map();
  const prefs = new Map();
  const installations = new Map();
  /** @type {Record<string, unknown>[]} */
  const candidates = [];

  return {
    kind: "memory",
    async claimInbox(row) {
      const id = String(row.messageId || "").trim();
      if (!id) return { kind: "skipped_no_message_id" };
      if (inbox.has(id)) {
        const existing = inbox.get(id);
        if (existing.status === "pending" || existing.status === "failed") {
          return { kind: "retry", row: clone(existing) };
        }
        return { kind: "duplicate", row: clone(existing) };
      }
      const stored = {
        messageId: id,
        eventId: row.eventId || "",
        siteId: row.siteId ?? null,
        eventOriginationAt: row.eventOriginationAt || null,
        transactionKey: row.transactionKey || null,
        payload: row.payload || {},
        status: "pending",
        receivedAt: row.receivedAt || new Date().toISOString(),
        processedAt: null,
      };
      inbox.set(id, stored);
      return { kind: "claimed", row: clone(stored) };
    },
    async markInbox(messageId, status) {
      const row = inbox.get(String(messageId || ""));
      if (!row) return null;
      row.status = status;
      row.processedAt = new Date().toISOString();
      return clone(row);
    },
    async getBooking(siteId, bookingId) {
      return clone(bookings.get(bookingKey(siteId, bookingId)));
    },
    async upsertBooking(row) {
      bookings.set(bookingKey(row.siteId, row.classRosterBookingId), { ...row, updatedAt: new Date().toISOString() });
      return clone(bookings.get(bookingKey(row.siteId, row.classRosterBookingId)));
    },
    async listBookingsByClass(siteId, classId) {
      return [...bookings.values()].filter((r) => r.siteId === siteId && r.classId === classId).map(clone);
    },
    async getWaitlist(siteId, entryId) {
      return clone(waitlist.get(waitlistKey(siteId, entryId)));
    },
    async upsertWaitlist(row) {
      waitlist.set(waitlistKey(row.siteId, row.waitlistEntryId), { ...row, updatedAt: new Date().toISOString() });
      return clone(waitlist.get(waitlistKey(row.siteId, row.waitlistEntryId)));
    },
    async findActiveWaitlist(siteId, classId, clientId) {
      return [...waitlist.values()]
        .filter(
          (r) =>
            r.siteId === siteId &&
            r.classId === classId &&
            r.clientId === clientId &&
            r.status === "active",
        )
        .map(clone);
    },
    async listWaitlistByClass(siteId, classId) {
      return [...waitlist.values()].filter((r) => r.siteId === siteId && r.classId === classId).map(clone);
    },
    async getReminder(userId, siteId, bookingId, type = "class_reminder") {
      return clone(reminders.get(reminderKey(userId, siteId, bookingId, type)));
    },
    async upsertReminder(row) {
      const type = row.reminderType || "class_reminder";
      const key = reminderKey(row.amareUserId, row.siteId, row.classRosterBookingId, type);
      const existing = reminders.get(key);
      const stored = {
        reminderId: existing?.reminderId || row.reminderId || newId("rem"),
        ...row,
        reminderType: type,
        updatedAt: new Date().toISOString(),
      };
      reminders.set(key, stored);
      return clone(stored);
    },
    async listRemindersByClass(siteId, classId) {
      return [...reminders.values()].filter((r) => r.siteId === siteId && r.classId === classId).map(clone);
    },
    async getClassState(siteId, classId) {
      return clone(classState.get(classKey(siteId, classId)));
    },
    async upsertClassState(row) {
      const key = classKey(row.siteId, row.classId);
      const existing = classState.get(key);
      const stored = {
        ...existing,
        ...row,
        className: row.className || existing?.className || null,
        classDescriptionId: row.classDescriptionId ?? existing?.classDescriptionId ?? null,
        updatedAt: new Date().toISOString(),
      };
      classState.set(key, stored);
      return clone(stored);
    },
    async getClassDescription(siteId, descriptionId) {
      return clone(descriptions.get(`${siteId}:${descriptionId}`));
    },
    async upsertClassDescription(row) {
      const key = `${row.siteId}:${row.classDescriptionId}`;
      const stored = { ...row, updatedAt: new Date().toISOString() };
      descriptions.set(key, stored);
      for (const [classKeyId, st] of classState) {
        if (st.siteId === row.siteId && st.classDescriptionId === row.classDescriptionId) {
          classState.set(classKeyId, { ...st, className: row.className || st.className, updatedAt: stored.updatedAt });
        }
      }
      return clone(stored);
    },
    async getPreferences(amareUserId) {
      return clone(prefs.get(amareUserId));
    },
    async ensurePreferences(amareUserId) {
      const existing = prefs.get(amareUserId);
      if (existing) return clone(existing);
      const row = { amareUserId, ...DEFAULT_PREFERENCES, updatedAt: new Date().toISOString() };
      prefs.set(amareUserId, row);
      return clone(row);
    },
    async updatePreferences(amareUserId, patch) {
      const current = await this.ensurePreferences(amareUserId);
      const clean = sanitizePreferencePatch(patch);
      const row = { ...current, ...clean, amareUserId, updatedAt: new Date().toISOString() };
      prefs.set(amareUserId, row);
      return clone(row);
    },
    async getInstallation(installationId) {
      return clone(installations.get(installationId));
    },
    async findInstallationByToken(pushToken) {
      if (!pushToken) return null;
      return clone([...installations.values()].find((r) => r.pushToken === pushToken && !r.revokedAt) || null);
    },
    async upsertInstallation(row) {
      const id = row.installationId || newId("ins");
      const existing = installations.get(id);
      const stored = {
        installationId: id,
        createdAt: existing?.createdAt || new Date().toISOString(),
        revokedAt: Object.prototype.hasOwnProperty.call(row, "revokedAt") ? row.revokedAt ?? null : existing?.revokedAt ?? null,
        pushToken: Object.prototype.hasOwnProperty.call(row, "pushToken") ? row.pushToken ?? null : existing?.pushToken ?? null,
        permissionState: row.permissionState || existing?.permissionState || "unknown",
        lastSeenAt: row.lastSeenAt || new Date().toISOString(),
        amareUserId: row.amareUserId,
        platform: row.platform || existing?.platform || "android",
      };
      installations.set(id, stored);
      return clone(stored);
    },
    async listInstallations(amareUserId) {
      return [...installations.values()].filter((r) => r.amareUserId === amareUserId).map(clone);
    },
    async listActiveInstallations(amareUserId) {
      return [...installations.values()]
        .filter((r) => r.amareUserId === amareUserId && !r.revokedAt && r.pushToken)
        .map(clone);
    },
    async revokeInstallation(installationId) {
      const row = installations.get(installationId);
      if (!row) return null;
      row.revokedAt = new Date().toISOString();
      row.permissionState = "revoked";
      row.pushToken = null;
      return clone(row);
    },
    async reassignInstallation(installationId, newUserId) {
      const row = installations.get(installationId);
      if (!row) return null;
      row.amareUserId = newUserId;
      row.pushToken = null;
      row.lastSeenAt = new Date().toISOString();
      return clone(row);
    },
    async addCandidate(row) {
      const stored = {
        candidateId: row.candidateId || newId("cand"),
        kind: row.kind,
        amareUserId: row.amareUserId ?? null,
        siteId: row.siteId ?? null,
        classId: row.classId ?? null,
        classRosterBookingId: row.classRosterBookingId ?? null,
        waitlistEntryId: row.waitlistEntryId ?? null,
        transactionKey: row.transactionKey ?? null,
        suppressPush: row.suppressPush === true,
        payload: row.payload || {},
        createdAt: new Date().toISOString(),
        deliveryStatus: "pending",
        claimedAt: null,
        deliveredAt: null,
        deliveryResult: null,
      };
      candidates.push(stored);
      return clone(stored);
    },
    async listCandidates(filter = {}) {
      return candidates
        .filter((c) => (filter.kind ? c.kind === filter.kind : true))
        .filter((c) => (filter.amareUserId ? c.amareUserId === filter.amareUserId : true))
        .map(clone);
    },
    async claimCandidate(candidateId, notBeforeIso = null) {
      const row = candidates.find((c) => c.candidateId === candidateId);
      if (!row || row.deliveryStatus !== "pending") return null;
      if (notBeforeIso && Date.parse(row.createdAt) < Date.parse(notBeforeIso)) return null;
      row.deliveryStatus = "claimed";
      row.claimedAt = new Date().toISOString();
      return clone(row);
    },
    async markCandidateDelivery(candidateId, status, result = null) {
      const row = candidates.find((c) => c.candidateId === candidateId);
      if (!row) return null;
      row.deliveryStatus = status;
      row.deliveryResult = result;
      if (status === "delivered") row.deliveredAt = new Date().toISOString();
      return clone(row);
    },
  };
}

function notificationDatabaseUrl() {
  try {
    const native = getConnectionString();
    if (typeof native === "string" && native.trim()) return native.trim();
  } catch {
    /* tests / local */
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

function getNotificationDb() {
  const url = notificationDatabaseUrl();
  if (!url) return null;
  if (cachedDb && cachedDb.url === url) return cachedDb.db;
  cachedDb = { url, db: getDatabase({ connectionString: url }) };
  return cachedDb.db;
}

async function q(text, values = []) {
  const db = getNotificationDb();
  if (!db) throw new Error("notification_db_unconfigured");
  const result = await db.pool.query(text, values);
  return { rows: result.rows || [] };
}

function mapCandidate(row) {
  if (!row) return null;
  return {
    candidateId: row.candidate_id,
    kind: row.kind,
    amareUserId: row.amare_user_id,
    siteId: row.site_id != null ? Number(row.site_id) : null,
    classId: row.class_id != null ? Number(row.class_id) : null,
    classRosterBookingId: row.class_roster_booking_id != null ? Number(row.class_roster_booking_id) : null,
    waitlistEntryId: row.waitlist_entry_id != null ? Number(row.waitlist_entry_id) : null,
    transactionKey: row.transaction_key || null,
    suppressPush: row.suppress_push === true,
    payload: row.payload || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    deliveryStatus: row.delivery_status || "pending",
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    deliveryResult: row.delivery_result || null,
  };
}

function mapBooking(row) {
  if (!row) return null;
  return {
    siteId: Number(row.site_id),
    classRosterBookingId: Number(row.class_roster_booking_id),
    classId: row.class_id != null ? Number(row.class_id) : null,
    clientId: row.client_id != null ? Number(row.client_id) : null,
    amareUserId: row.amare_user_id || null,
    classStartAt: row.class_start_at ? new Date(row.class_start_at).toISOString() : null,
    className: row.class_name || null,
    clientPassId: row.client_pass_id || null,
    itemId: row.item_id != null ? Number(row.item_id) : null,
    itemName: row.item_name || null,
    lastMessageId: row.last_message_id || null,
    status: row.status,
    originatedFromWaitlist: row.originated_from_waitlist === true,
    lastEventOriginationAt: row.last_event_origination_at
      ? new Date(row.last_event_origination_at).toISOString()
      : null,
    transactionKey: row.transaction_key || null,
  };
}

function mapWaitlist(row) {
  if (!row) return null;
  return {
    siteId: Number(row.site_id),
    waitlistEntryId: Number(row.waitlist_entry_id),
    classId: row.class_id != null ? Number(row.class_id) : null,
    clientId: row.client_id != null ? Number(row.client_id) : null,
    amareUserId: row.amare_user_id || null,
    classStartAt: row.class_start_at ? new Date(row.class_start_at).toISOString() : null,
    status: row.status,
    lastEventOriginationAt: row.last_event_origination_at
      ? new Date(row.last_event_origination_at).toISOString()
      : null,
  };
}

function mapReminder(row) {
  if (!row) return null;
  return {
    reminderId: row.reminder_id,
    amareUserId: row.amare_user_id,
    siteId: Number(row.site_id),
    classId: row.class_id != null ? Number(row.class_id) : null,
    classRosterBookingId: Number(row.class_roster_booking_id),
    reminderType: row.reminder_type,
    classStartAt: row.class_start_at ? new Date(row.class_start_at).toISOString() : null,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
    status: row.status,
    lastEventOriginationAt: row.last_event_origination_at
      ? new Date(row.last_event_origination_at).toISOString()
      : null,
  };
}

export function createPostgresNotificationStore() {
  return {
    kind: "postgres",
    async claimInbox(row) {
      const id = String(row.messageId || "").trim();
      if (!id) return { kind: "skipped_no_message_id" };
      const ins = await q(
        `INSERT INTO amare_notification_inbox
          (message_id, event_id, site_id, event_origination_at, transaction_key, payload, status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending')
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [
          id,
          row.eventId || "",
          row.siteId ?? null,
          row.eventOriginationAt || null,
          row.transactionKey || null,
          JSON.stringify(row.payload || {}),
        ],
      );
      if (ins.rows[0]) return { kind: "claimed" };
      const existing = await q(`SELECT status FROM amare_notification_inbox WHERE message_id = $1`, [id]);
      const status = existing.rows[0]?.status;
      if (status === "pending" || status === "failed") return { kind: "retry" };
      return { kind: "duplicate" };
    },
    async markInbox(messageId, status) {
      await q(
        `UPDATE amare_notification_inbox SET status = $2, processed_at = NOW() WHERE message_id = $1`,
        [messageId, status],
      );
      return { messageId, status };
    },
    async getBooking(siteId, bookingId) {
      const r = await q(
        `SELECT * FROM amare_roster_bookings WHERE site_id = $1 AND class_roster_booking_id = $2`,
        [siteId, bookingId],
      );
      return mapBooking(r.rows[0]);
    },
    async upsertBooking(row) {
      await q(
        `INSERT INTO amare_roster_bookings (
           site_id, class_roster_booking_id, class_id, client_id, amare_user_id,
           class_start_at, class_name, client_pass_id, item_id, item_name, last_message_id,
           status, originated_from_waitlist, last_event_origination_at, transaction_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (site_id, class_roster_booking_id) DO UPDATE SET
           class_id = EXCLUDED.class_id,
           client_id = EXCLUDED.client_id,
           amare_user_id = EXCLUDED.amare_user_id,
           class_start_at = EXCLUDED.class_start_at,
           class_name = COALESCE(EXCLUDED.class_name, amare_roster_bookings.class_name),
           client_pass_id = COALESCE(EXCLUDED.client_pass_id, amare_roster_bookings.client_pass_id),
           item_id = COALESCE(EXCLUDED.item_id, amare_roster_bookings.item_id),
           item_name = COALESCE(EXCLUDED.item_name, amare_roster_bookings.item_name),
           last_message_id = COALESCE(EXCLUDED.last_message_id, amare_roster_bookings.last_message_id),
           status = EXCLUDED.status,
           originated_from_waitlist = EXCLUDED.originated_from_waitlist,
           last_event_origination_at = EXCLUDED.last_event_origination_at,
           transaction_key = EXCLUDED.transaction_key,
           updated_at = NOW()`,
        [
          row.siteId,
          row.classRosterBookingId,
          row.classId ?? null,
          row.clientId ?? null,
          row.amareUserId ?? null,
          row.classStartAt ?? null,
          row.className ?? null,
          row.clientPassId ?? null,
          row.itemId ?? null,
          row.itemName ?? null,
          row.lastMessageId ?? null,
          row.status,
          row.originatedFromWaitlist === true,
          row.lastEventOriginationAt,
          row.transactionKey ?? null,
        ],
      );
      return row;
    },
    async listBookingsByClass(siteId, classId) {
      const r = await q(
        `SELECT * FROM amare_roster_bookings WHERE site_id = $1 AND class_id = $2`,
        [siteId, classId],
      );
      return r.rows.map(mapBooking);
    },
    async getWaitlist(siteId, entryId) {
      const r = await q(
        `SELECT * FROM amare_waitlist_entries WHERE site_id = $1 AND waitlist_entry_id = $2`,
        [siteId, entryId],
      );
      return mapWaitlist(r.rows[0]);
    },
    async upsertWaitlist(row) {
      await q(
        `INSERT INTO amare_waitlist_entries (
           site_id, waitlist_entry_id, class_id, client_id, amare_user_id,
           class_start_at, status, last_event_origination_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (site_id, waitlist_entry_id) DO UPDATE SET
           class_id = COALESCE(EXCLUDED.class_id, amare_waitlist_entries.class_id),
           client_id = COALESCE(EXCLUDED.client_id, amare_waitlist_entries.client_id),
           amare_user_id = COALESCE(EXCLUDED.amare_user_id, amare_waitlist_entries.amare_user_id),
           class_start_at = COALESCE(EXCLUDED.class_start_at, amare_waitlist_entries.class_start_at),
           status = EXCLUDED.status,
           last_event_origination_at = EXCLUDED.last_event_origination_at,
           updated_at = NOW()`,
        [
          row.siteId,
          row.waitlistEntryId,
          row.classId ?? null,
          row.clientId ?? null,
          row.amareUserId ?? null,
          row.classStartAt ?? null,
          row.status,
          row.lastEventOriginationAt,
        ],
      );
      return row;
    },
    async findActiveWaitlist(siteId, classId, clientId) {
      const r = await q(
        `SELECT * FROM amare_waitlist_entries
          WHERE site_id = $1 AND class_id = $2 AND client_id = $3 AND status = 'active'`,
        [siteId, classId, clientId],
      );
      return r.rows.map(mapWaitlist);
    },
    async listWaitlistByClass(siteId, classId) {
      const r = await q(
        `SELECT * FROM amare_waitlist_entries WHERE site_id = $1 AND class_id = $2`,
        [siteId, classId],
      );
      return r.rows.map(mapWaitlist);
    },
    async getReminder(userId, siteId, bookingId, type = "class_reminder") {
      const r = await q(
        `SELECT * FROM amare_class_reminders
          WHERE amare_user_id = $1 AND site_id = $2 AND class_roster_booking_id = $3 AND reminder_type = $4`,
        [userId, siteId, bookingId, type],
      );
      return mapReminder(r.rows[0]);
    },
    async upsertReminder(row) {
      const type = row.reminderType || "class_reminder";
      const id = row.reminderId || newId("rem");
      const r = await q(
        `INSERT INTO amare_class_reminders (
           reminder_id, amare_user_id, site_id, class_id, class_roster_booking_id, reminder_type,
           class_start_at, scheduled_for, status, last_event_origination_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (amare_user_id, site_id, class_roster_booking_id, reminder_type) DO UPDATE SET
           class_id = EXCLUDED.class_id,
           class_start_at = EXCLUDED.class_start_at,
           scheduled_for = EXCLUDED.scheduled_for,
           status = EXCLUDED.status,
           last_event_origination_at = EXCLUDED.last_event_origination_at,
           updated_at = NOW()
         RETURNING *`,
        [
          id,
          row.amareUserId,
          row.siteId,
          row.classId ?? null,
          row.classRosterBookingId,
          type,
          row.classStartAt ?? null,
          row.scheduledFor ?? null,
          row.status,
          row.lastEventOriginationAt,
        ],
      );
      return mapReminder(r.rows[0]);
    },
    async listRemindersByClass(siteId, classId) {
      const r = await q(
        `SELECT * FROM amare_class_reminders WHERE site_id = $1 AND class_id = $2`,
        [siteId, classId],
      );
      return r.rows.map(mapReminder);
    },
    async getClassState(siteId, classId) {
      const r = await q(
        `SELECT * FROM amare_class_notification_state WHERE site_id = $1 AND class_id = $2`,
        [siteId, classId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        siteId: Number(row.site_id),
        classId: Number(row.class_id),
        startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
        isCancelled: row.is_cancelled === true,
        staffId: row.staff_id != null ? Number(row.staff_id) : null,
        classDescriptionId: row.class_description_id != null ? Number(row.class_description_id) : null,
        className: row.class_name || null,
        lastEventOriginationAt: row.last_event_origination_at
          ? new Date(row.last_event_origination_at).toISOString()
          : null,
      };
    },
    async upsertClassState(row) {
      await q(
        `INSERT INTO amare_class_notification_state
           (site_id, class_id, start_at, is_cancelled, staff_id, class_description_id, class_name, last_event_origination_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (site_id, class_id) DO UPDATE SET
           start_at = EXCLUDED.start_at,
           is_cancelled = EXCLUDED.is_cancelled,
           staff_id = EXCLUDED.staff_id,
           class_description_id = COALESCE(EXCLUDED.class_description_id, amare_class_notification_state.class_description_id),
           class_name = COALESCE(EXCLUDED.class_name, amare_class_notification_state.class_name),
           last_event_origination_at = EXCLUDED.last_event_origination_at,
           updated_at = NOW()`,
        [
          row.siteId,
          row.classId,
          row.startAt ?? null,
          row.isCancelled === true,
          row.staffId ?? null,
          row.classDescriptionId ?? null,
          row.className ?? null,
          row.lastEventOriginationAt,
        ],
      );
      return row;
    },
    async getClassDescription(siteId, descriptionId) {
      const r = await q(
        `SELECT * FROM amare_class_descriptions WHERE site_id = $1 AND class_description_id = $2`,
        [siteId, descriptionId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        siteId: Number(row.site_id),
        classDescriptionId: Number(row.class_description_id),
        className: row.class_name || null,
        lastEventOriginationAt: row.last_event_origination_at
          ? new Date(row.last_event_origination_at).toISOString()
          : null,
      };
    },
    async upsertClassDescription(row) {
      await q(
        `INSERT INTO amare_class_descriptions
           (site_id, class_description_id, class_name, last_event_origination_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (site_id, class_description_id) DO UPDATE SET
           class_name = COALESCE(EXCLUDED.class_name, amare_class_descriptions.class_name),
           last_event_origination_at = EXCLUDED.last_event_origination_at,
           updated_at = NOW()`,
        [row.siteId, row.classDescriptionId, row.className ?? null, row.lastEventOriginationAt],
      );
      if (row.className) {
        await q(
          `UPDATE amare_class_notification_state
              SET class_name = $3, updated_at = NOW()
            WHERE site_id = $1 AND class_description_id = $2`,
          [row.siteId, row.classDescriptionId, row.className],
        );
      }
      return row;
    },
    async getPreferences(amareUserId) {
      const r = await q(`SELECT * FROM amare_notification_preferences WHERE amare_user_id = $1`, [amareUserId]);
      const row = r.rows[0];
      if (!row) return null;
      return {
        amareUserId: row.amare_user_id,
        class_booking_updates: row.class_booking_updates === true,
        class_reminders: row.class_reminders === true,
        waitlist_updates: row.waitlist_updates === true,
        studio_news: row.studio_news === true,
      };
    },
    async ensurePreferences(amareUserId) {
      const r = await q(
        `INSERT INTO amare_notification_preferences (amare_user_id)
         VALUES ($1)
         ON CONFLICT (amare_user_id) DO UPDATE SET amare_user_id = EXCLUDED.amare_user_id
         RETURNING *`,
        [amareUserId],
      );
      const row = r.rows[0];
      return {
        amareUserId: row.amare_user_id,
        class_booking_updates: row.class_booking_updates === true,
        class_reminders: row.class_reminders === true,
        waitlist_updates: row.waitlist_updates === true,
        studio_news: row.studio_news === true,
      };
    },
    async updatePreferences(amareUserId, patch) {
      const current = await this.ensurePreferences(amareUserId);
      const clean = sanitizePreferencePatch(patch);
      const next = { ...current, ...clean, amareUserId };
      await q(
        `UPDATE amare_notification_preferences
            SET class_booking_updates = $2,
                class_reminders = $3,
                waitlist_updates = $4,
                studio_news = $5,
                updated_at = NOW()
          WHERE amare_user_id = $1`,
        [
          amareUserId,
          next.class_booking_updates === true,
          next.class_reminders === true,
          next.waitlist_updates === true,
          next.studio_news === true,
        ],
      );
      return next;
    },
    async getInstallation(installationId) {
      const r = await q(`SELECT * FROM amare_push_installations WHERE installation_id = $1`, [installationId]);
      const x = r.rows[0];
      if (!x) return null;
      return {
        installationId: x.installation_id,
        amareUserId: x.amare_user_id,
        platform: x.platform,
        pushToken: x.push_token,
        permissionState: x.permission_state,
        lastSeenAt: x.last_seen_at,
        revokedAt: x.revoked_at,
        createdAt: x.created_at,
      };
    },
    async findInstallationByToken(pushToken) {
      if (!pushToken) return null;
      const r = await q(
        `SELECT * FROM amare_push_installations
          WHERE push_token = $1 AND revoked_at IS NULL
          LIMIT 1`,
        [pushToken],
      );
      const x = r.rows[0];
      if (!x) return null;
      return {
        installationId: x.installation_id,
        amareUserId: x.amare_user_id,
        platform: x.platform,
        pushToken: x.push_token,
        permissionState: x.permission_state,
        lastSeenAt: x.last_seen_at,
        revokedAt: x.revoked_at,
        createdAt: x.created_at,
      };
    },
    async upsertInstallation(row) {
      const id = row.installationId || newId("ins");
      const revokedAt = Object.prototype.hasOwnProperty.call(row, "revokedAt") ? row.revokedAt ?? null : null;
      const r = await q(
        `INSERT INTO amare_push_installations
           (installation_id, amare_user_id, platform, push_token, permission_state, last_seen_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6)
         ON CONFLICT (installation_id) DO UPDATE SET
           amare_user_id = EXCLUDED.amare_user_id,
           platform = EXCLUDED.platform,
           push_token = EXCLUDED.push_token,
           permission_state = EXCLUDED.permission_state,
           last_seen_at = NOW(),
           revoked_at = EXCLUDED.revoked_at
         RETURNING *`,
        [id, row.amareUserId, row.platform, row.pushToken ?? null, row.permissionState || "unknown", revokedAt],
      );
      const x = r.rows[0];
      return {
        installationId: x.installation_id,
        amareUserId: x.amare_user_id,
        platform: x.platform,
        pushToken: x.push_token,
        permissionState: x.permission_state,
        lastSeenAt: x.last_seen_at,
        revokedAt: x.revoked_at,
        createdAt: x.created_at,
      };
    },
    async listInstallations(amareUserId) {
      const r = await q(`SELECT * FROM amare_push_installations WHERE amare_user_id = $1`, [amareUserId]);
      return r.rows.map((x) => ({
        installationId: x.installation_id,
        amareUserId: x.amare_user_id,
        platform: x.platform,
        pushToken: x.push_token,
        permissionState: x.permission_state,
        lastSeenAt: x.last_seen_at,
        revokedAt: x.revoked_at,
        createdAt: x.created_at,
      }));
    },
    async listActiveInstallations(amareUserId) {
      const r = await q(
        `SELECT * FROM amare_push_installations
          WHERE amare_user_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL`,
        [amareUserId],
      );
      return r.rows.map((x) => ({
        installationId: x.installation_id,
        amareUserId: x.amare_user_id,
        platform: x.platform,
        pushToken: x.push_token,
        permissionState: x.permission_state,
        lastSeenAt: x.last_seen_at,
        revokedAt: x.revoked_at,
        createdAt: x.created_at,
      }));
    },
    async revokeInstallation(installationId) {
      const r = await q(
        `UPDATE amare_push_installations
            SET revoked_at = NOW(), permission_state = 'revoked', push_token = NULL
          WHERE installation_id = $1
          RETURNING *`,
        [installationId],
      );
      return r.rows[0] ? { installationId, revokedAt: r.rows[0].revoked_at } : null;
    },
    async reassignInstallation(installationId, newUserId) {
      const r = await q(
        `UPDATE amare_push_installations
            SET amare_user_id = $2, push_token = NULL, last_seen_at = NOW()
          WHERE installation_id = $1
          RETURNING *`,
        [installationId, newUserId],
      );
      return r.rows[0]
        ? { installationId, amareUserId: r.rows[0].amare_user_id, pushToken: null }
        : null;
    },
    async addCandidate(row) {
      const id = row.candidateId || newId("cand");
      const inserted = await q(
        `INSERT INTO amare_notification_candidates (
           candidate_id, kind, amare_user_id, site_id, class_id, class_roster_booking_id,
           waitlist_entry_id, transaction_key, suppress_push, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         RETURNING *`,
        [
          id,
          row.kind,
          row.amareUserId ?? null,
          row.siteId ?? null,
          row.classId ?? null,
          row.classRosterBookingId ?? null,
          row.waitlistEntryId ?? null,
          row.transactionKey ?? null,
          row.suppressPush === true,
          JSON.stringify(row.payload || {}),
        ],
      );
      return mapCandidate(inserted.rows[0]) || { ...row, candidateId: id };
    },
    async listCandidates(filter = {}) {
      const r = await q(
        `SELECT * FROM amare_notification_candidates
          WHERE ($1::text IS NULL OR kind = $1)
            AND ($2::text IS NULL OR amare_user_id = $2)
          ORDER BY created_at`,
        [filter.kind || null, filter.amareUserId || null],
      );
      return r.rows.map(mapCandidate);
    },
    async claimCandidate(candidateId, notBeforeIso = null) {
      const r = await q(
        `UPDATE amare_notification_candidates
            SET delivery_status = 'claimed', claimed_at = NOW()
          WHERE candidate_id = $1
            AND delivery_status = 'pending'
            AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          RETURNING *`,
        [candidateId, notBeforeIso],
      );
      return mapCandidate(r.rows[0]);
    },
    async markCandidateDelivery(candidateId, status, result = null) {
      const r = await q(
        `UPDATE amare_notification_candidates
            SET delivery_status = $2,
                delivery_result = $3,
                delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END
          WHERE candidate_id = $1
          RETURNING *`,
        [candidateId, status, result],
      );
      return mapCandidate(r.rows[0]);
    },
  };
}

export function openNotificationStore(preferred) {
  if (preferred) return preferred;
  if (notificationDatabaseUrl()) {
    try {
      return createPostgresNotificationStore();
    } catch {
      /* fall through */
    }
  }
  return createMemoryNotificationStore();
}
