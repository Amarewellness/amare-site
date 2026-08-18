/**
 * AMARÉ notification event processor (Phase N1).
 * Ingests Mindbody webhook payloads into durable state + reminder rows + candidates.
 * Does not send FCM. Transaction-Key may suppress a future push, never correctness.
 */

import { findActiveAssociationByClientId } from "./amare-identity-store.mjs";

function notificationSiteId(siteId) {
  if (siteId != null && String(siteId).trim()) return String(siteId);
  return (process.env.MINDBODY_SITE_ID || "").trim() || "amare-unknown-site";
}

export const SCHEDULE_EVENT_IDS = Object.freeze([
  "class.updated",
  "classSchedule.created",
  "classSchedule.updated",
  "classSchedule.cancelled",
  "classDescription.updated",
]);

export const ROSTER_EVENT_IDS = Object.freeze([
  "classRosterBooking.created",
  "classRosterBookingStatus.updated",
  "classRosterBooking.cancelled",
  "classWaitlistRequest.created",
  "classWaitlistRequest.cancelled",
]);

export const PROCESSABLE_EVENT_IDS = Object.freeze([
  ...ROSTER_EVENT_IDS,
  "class.updated",
]);

export const FUTURE_SUBSCRIPTION_EVENT_UNION = Object.freeze([
  ...SCHEDULE_EVENT_IDS,
  ...ROSTER_EVENT_IDS,
]);

export function reminderLeadMinutes() {
  const n = parseInt(String(process.env.AMARE_CLASS_REMINDER_LEAD_MINUTES || "120"), 10);
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n : 120;
}

export function scheduledForFromClassStart(classStartAt, leadMinutes = reminderLeadMinutes()) {
  if (!classStartAt) return null;
  const ms = Date.parse(classStartAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - leadMinutes * 60 * 1000).toISOString();
}

export function parseWebhookEventMeta(payload) {
  if (!payload || typeof payload !== "object") {
    return { messageId: null, eventId: null, siteId: null, originationAt: null, transactionKey: null, eventData: {} };
  }
  const o = /** @type {Record<string, unknown>} */ (payload);
  const messageId =
    typeof o.messageId === "string" ? o.messageId.trim() : typeof o.MessageId === "string" ? o.MessageId.trim() : null;
  const eventId =
    typeof o.eventId === "string" ? o.eventId.trim() : typeof o.EventId === "string" ? o.EventId.trim() : null;
  const originationAt =
    typeof o.eventInstanceOriginationDateTime === "string"
      ? o.eventInstanceOriginationDateTime
      : typeof o.EventInstanceOriginationDateTime === "string"
        ? o.EventInstanceOriginationDateTime
        : null;
  const transactionKey =
    typeof o.transactionKey === "string"
      ? o.transactionKey.trim()
      : typeof o.TransactionKey === "string"
        ? o.TransactionKey.trim()
        : null;
  const eventData =
    o.eventData && typeof o.eventData === "object"
      ? /** @type {Record<string, unknown>} */ (o.eventData)
      : o.EventData && typeof o.EventData === "object"
        ? /** @type {Record<string, unknown>} */ (o.EventData)
        : {};
  const siteRaw = eventData.siteId ?? eventData.SiteId;
  const siteN = typeof siteRaw === "number" ? siteRaw : parseInt(String(siteRaw ?? ""), 10);
  return {
    messageId: messageId || null,
    eventId: eventId || null,
    siteId: Number.isFinite(siteN) ? siteN : null,
    originationAt,
    transactionKey: transactionKey || null,
    eventData,
  };
}

export function originationMs(iso) {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

export function isOlderOrEqualEvent(incomingIso, storedIso) {
  if (!storedIso) return false;
  return originationMs(incomingIso) <= originationMs(storedIso);
}

function num(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^\d{1,18}$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  return null;
}

function bool(raw) {
  if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
  return false;
}

function iso(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : raw;
}

function signedInToStatus(signedInStatus) {
  const s = String(signedInStatus || "").toLowerCase();
  if (s === "earlycancelled" || s === "early_cancelled") return "early_cancelled";
  if (s === "latecancelled" || s === "late_cancelled") return "late_cancelled";
  return null;
}

function isCancelStatus(status) {
  return status === "cancelled" || status === "early_cancelled" || status === "late_cancelled";
}

export async function resolveAmareUserForClient(siteId, clientId, deps = {}) {
  if (clientId == null || !Number.isFinite(Number(clientId))) return null;
  const site = notificationSiteId(siteId);
  const find = deps.findActiveAssociationByClientId || findActiveAssociationByClientId;
  try {
    const row = await find(site, Number(clientId));
    const id = row?.amare_user_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

async function emitCandidate(store, row) {
  if (!row.amareUserId) return null;
  return store.addCandidate({
    ...row,
    // Transaction-Key is stored for later AMARÉ-issued correlation.
    // Presence alone must not suppress desk/Manager candidates.
    suppressPush: row.suppressPush === true,
    transactionKey: row.transactionKey || null,
  });
}

async function upsertReminderForBooking(store, booking, originationAt) {
  if (!booking.amareUserId || booking.classRosterBookingId == null) return null;
  if (isCancelStatus(booking.status)) {
    const existing = await store.getReminder(booking.amareUserId, booking.siteId, booking.classRosterBookingId);
    if (!existing) return null;
    if (isOlderOrEqualEvent(originationAt, existing.lastEventOriginationAt)) return existing;
    return store.upsertReminder({
      ...existing,
      status: "cancelled",
      lastEventOriginationAt: originationAt,
    });
  }
  return store.upsertReminder({
    amareUserId: booking.amareUserId,
    siteId: booking.siteId,
    classId: booking.classId,
    classRosterBookingId: booking.classRosterBookingId,
    reminderType: "class_reminder",
    classStartAt: booking.classStartAt,
    scheduledFor: scheduledForFromClassStart(booking.classStartAt),
    status: "scheduled",
    lastEventOriginationAt: originationAt,
  });
}

async function applyRosterCreated(store, meta, deps) {
  const d = meta.eventData;
  const bookingId = num(d.classRosterBookingId ?? d.ClassRosterBookingId);
  if (meta.siteId == null || bookingId == null) return { ok: false, reason: "missing_booking_id" };
  const existing = await store.getBooking(meta.siteId, bookingId);
  if (existing && isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", booking: existing };
  }
  const clientId = num(d.clientId ?? d.ClientId ?? d.clientUniqueId ?? d.ClientUniqueId);
  const classId = num(d.classId ?? d.ClassId);
  const amareUserId = await resolveAmareUserForClient(meta.siteId, clientId, deps);
  const fromWaitlist = bool(d.bookingOriginatedFromWaitlist ?? d.BookingOriginatedFromWaitlist);
  const booking = await store.upsertBooking({
    siteId: meta.siteId,
    classRosterBookingId: bookingId,
    classId,
    clientId,
    amareUserId,
    classStartAt: iso(d.classStartDateTime ?? d.ClassStartDateTime),
    status: "booked",
    originatedFromWaitlist: fromWaitlist,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
    transactionKey: meta.transactionKey,
  });
  await upsertReminderForBooking(store, booking, booking.lastEventOriginationAt);
  if (amareUserId) await store.ensurePreferences(amareUserId);
  if (fromWaitlist && classId != null && clientId != null) {
    const active = await store.findActiveWaitlist(meta.siteId, classId, clientId);
    for (const w of active) {
      if (isOlderOrEqualEvent(meta.originationAt, w.lastEventOriginationAt)) continue;
      await store.upsertWaitlist({
        ...w,
        status: "promoted",
        lastEventOriginationAt: booking.lastEventOriginationAt,
      });
    }
    await emitCandidate(store, {
      kind: "waitlist_promoted",
      amareUserId,
      siteId: meta.siteId,
      classId,
      classRosterBookingId: bookingId,
      transactionKey: meta.transactionKey,
      payload: { bookingOriginatedFromWaitlist: true },
    });
  } else {
    await emitCandidate(store, {
      kind: "booking_created",
      amareUserId,
      siteId: meta.siteId,
      classId,
      classRosterBookingId: bookingId,
      transactionKey: meta.transactionKey,
      payload: { bookingOriginatedFromWaitlist: false },
    });
  }
  return { ok: true, booking };
}

async function applyRosterCancelled(store, meta, deps, status = "cancelled") {
  const d = meta.eventData;
  const bookingId = num(d.classRosterBookingId ?? d.ClassRosterBookingId);
  if (meta.siteId == null || bookingId == null) return { ok: false, reason: "missing_booking_id" };
  const existing = await store.getBooking(meta.siteId, bookingId);
  if (existing && isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", booking: existing };
  }
  const clientId = num(d.clientId ?? d.ClientId ?? existing?.clientId);
  const classId = num(d.classId ?? d.ClassId ?? existing?.classId);
  const amareUserId =
    existing?.amareUserId || (await resolveAmareUserForClient(meta.siteId, clientId, deps));
  const booking = await store.upsertBooking({
    siteId: meta.siteId,
    classRosterBookingId: bookingId,
    classId,
    clientId,
    amareUserId,
    classStartAt: existing?.classStartAt || iso(d.classStartDateTime ?? d.ClassStartDateTime),
    status,
    originatedFromWaitlist: existing?.originatedFromWaitlist === true,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
    transactionKey: meta.transactionKey || existing?.transactionKey || null,
  });
  await upsertReminderForBooking(store, booking, booking.lastEventOriginationAt);
  await emitCandidate(store, {
    kind: "booking_cancelled",
    amareUserId,
    siteId: meta.siteId,
    classId,
    classRosterBookingId: bookingId,
    transactionKey: meta.transactionKey,
    payload: { status },
  });
  return { ok: true, booking };
}

async function applyRosterStatusUpdated(store, meta, deps) {
  const status = signedInToStatus(meta.eventData.signedInStatus ?? meta.eventData.SignedInStatus);
  if (!status) return { ok: true, skipped: "status_not_cancel" };
  return applyRosterCancelled(store, meta, deps, status);
}

async function applyWaitlistCreated(store, meta, deps) {
  const d = meta.eventData;
  const entryId = num(d.waitlistEntryId ?? d.WaitlistEntryId);
  if (meta.siteId == null || entryId == null) return { ok: false, reason: "missing_waitlist_entry_id" };
  const existing = await store.getWaitlist(meta.siteId, entryId);
  if (existing && isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", waitlist: existing };
  }
  const clientId = num(d.clientId ?? d.ClientId ?? d.clientUniqueId ?? d.ClientUniqueId);
  const classId = num(d.classId ?? d.ClassId);
  const amareUserId = await resolveAmareUserForClient(meta.siteId, clientId, deps);
  const waitlist = await store.upsertWaitlist({
    siteId: meta.siteId,
    waitlistEntryId: entryId,
    classId,
    clientId,
    amareUserId,
    classStartAt: iso(d.classStartDateTime ?? d.ClassStartDateTime),
    status: "active",
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
  });
  if (amareUserId) await store.ensurePreferences(amareUserId);
  await emitCandidate(store, {
    kind: "waitlist_joined",
    amareUserId,
    siteId: meta.siteId,
    classId,
    waitlistEntryId: entryId,
    transactionKey: meta.transactionKey,
    payload: {},
  });
  return { ok: true, waitlist };
}

async function applyWaitlistCancelled(store, meta) {
  const d = meta.eventData;
  const entryId = num(d.waitlistEntryId ?? d.WaitlistEntryId);
  if (meta.siteId == null || entryId == null) return { ok: false, reason: "missing_waitlist_entry_id" };
  const existing = await store.getWaitlist(meta.siteId, entryId);
  if (!existing) return { ok: true, skipped: "missing_map" };
  if (isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", waitlist: existing };
  }
  const extraClassId = num(d.classId ?? d.ClassId);
  const extraClientId = num(d.clientId ?? d.ClientId);
  const next = await store.upsertWaitlist({
    ...existing,
    classId: existing.classId ?? extraClassId,
    clientId: existing.clientId ?? extraClientId,
    status: existing.status === "promoted" ? "promoted" : "cancelled",
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
  });
  if (existing.status === "promoted") {
    return { ok: true, waitlist: next, skipped: "already_promoted" };
  }
  if (existing.status === "cancelled") {
    return { ok: true, waitlist: next, skipped: "already_cancelled" };
  }
  await emitCandidate(store, {
    kind: "waitlist_removed",
    amareUserId: next.amareUserId,
    siteId: meta.siteId,
    classId: next.classId,
    waitlistEntryId: entryId,
    transactionKey: meta.transactionKey,
    payload: {},
  });
  return { ok: true, waitlist: next };
}

async function applyClassUpdated(store, meta) {
  const d = meta.eventData;
  const classId = num(d.classId ?? d.ClassId);
  if (meta.siteId == null || classId == null) return { ok: false, reason: "missing_class_id" };
  const existing = await store.getClassState(meta.siteId, classId);
  if (existing && isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", classState: existing };
  }
  const startAt = iso(d.startDateTime ?? d.StartDateTime);
  const isCancelled = bool(d.isCancelled ?? d.IsCancelled);
  const staffId = num(d.staffId ?? d.StaffId);
  const prevStart = existing?.startAt || null;
  const classState = await store.upsertClassState({
    siteId: meta.siteId,
    classId,
    startAt,
    isCancelled,
    staffId,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
  });
  const reminders = await store.listRemindersByClass(meta.siteId, classId);
  const orig = classState.lastEventOriginationAt;
  for (const rem of reminders) {
    if (isOlderOrEqualEvent(orig, rem.lastEventOriginationAt)) continue;
    if (isCancelled) {
      await store.upsertReminder({ ...rem, status: "cancelled", lastEventOriginationAt: orig });
      continue;
    }
    if (startAt && startAt !== rem.classStartAt) {
      await store.upsertReminder({
        ...rem,
        classStartAt: startAt,
        scheduledFor: scheduledForFromClassStart(startAt),
        status: rem.status === "cancelled" ? rem.status : "scheduled",
        lastEventOriginationAt: orig,
      });
    }
  }
  const users = new Set(
    reminders.filter((r) => r.status === "scheduled" && r.amareUserId).map((r) => r.amareUserId),
  );
  if (isCancelled) {
    for (const amareUserId of users) {
      await emitCandidate(store, {
        kind: "class_cancelled",
        amareUserId,
        siteId: meta.siteId,
        classId,
        payload: { isCancelled: true },
      });
    }
  } else if (startAt && prevStart && startAt !== prevStart) {
    for (const amareUserId of users) {
      await emitCandidate(store, {
        kind: "class_time_changed",
        amareUserId,
        siteId: meta.siteId,
        classId,
        payload: { previousStart: prevStart, startAt },
      });
    }
  }
  return { ok: true, classState };
}

export async function processNotificationEvent(store, payload, deps = {}) {
  const meta = parseWebhookEventMeta(payload);
  if (!meta.eventId || !PROCESSABLE_EVENT_IDS.includes(meta.eventId)) {
    return { ok: true, ignored: true, eventId: meta.eventId };
  }
  if (meta.eventId === "classRosterBooking.created") return applyRosterCreated(store, meta, deps);
  if (meta.eventId === "classRosterBooking.cancelled") return applyRosterCancelled(store, meta, deps);
  if (meta.eventId === "classRosterBookingStatus.updated") return applyRosterStatusUpdated(store, meta, deps);
  if (meta.eventId === "classWaitlistRequest.created") return applyWaitlistCreated(store, meta, deps);
  if (meta.eventId === "classWaitlistRequest.cancelled") return applyWaitlistCancelled(store, meta);
  if (meta.eventId === "class.updated") return applyClassUpdated(store, meta);
  return { ok: true, ignored: true, eventId: meta.eventId };
}

export async function ingestAndProcessWebhook(store, payload, deps = {}) {
  const meta = parseWebhookEventMeta(payload);
  const claim = await store.claimInbox({
    messageId: meta.messageId,
    eventId: meta.eventId,
    siteId: meta.siteId,
    eventOriginationAt: meta.originationAt,
    transactionKey: meta.transactionKey,
    payload,
  });
  if (claim.kind === "duplicate") {
    return { ok: true, duplicate: true, eventId: meta.eventId, messageId: meta.messageId };
  }
  if (!meta.eventId || !PROCESSABLE_EVENT_IDS.includes(meta.eventId)) {
    if (meta.messageId) await store.markInbox(meta.messageId, "ignored");
    return { ok: true, ignored: true, eventId: meta.eventId, messageId: meta.messageId };
  }
  const result = await processNotificationEvent(store, payload, deps);
  if (meta.messageId) await store.markInbox(meta.messageId, result.ok === false ? "failed" : "processed");
  return { ...result, messageId: meta.messageId, eventId: meta.eventId, duplicate: false };
}
