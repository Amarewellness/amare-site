/**
 * AMARÉ notification event processor (Phase N1).
 * Ingests Mindbody webhook payloads into durable state + reminder rows + candidates.
 * Does not send FCM. Transaction-Key may suppress a future push, never correctness.
 */

import { findActiveAssociationByClientId } from "./amare-identity-store.mjs";
import { QA_AUTO_PUSH_USER_ID } from "./amare-notification-auto-deliver.mjs";
import { enrichClassName } from "./amare-notification-class-name.mjs";

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
  "classDescription.updated",
]);

export const FUTURE_SUBSCRIPTION_EVENT_UNION = Object.freeze([
  ...SCHEDULE_EVENT_IDS,
  ...ROSTER_EVENT_IDS,
]);

export function reminderLeadMinutes() {
  const n = parseInt(String(process.env.AMARE_CLASS_REMINDER_LEAD_MINUTES || "1440"), 10);
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n : 1440;
}

function reminderQaGateOpen() {
  const test = (process.env.ENABLE_AMARE_PUSH_TEST || "").trim() === "1";
  const prodReminders =
    (process.env.ENABLE_AMARE_PUSH || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_PUSH_REMINDERS || "").trim() === "1";
  return test && !prodReminders;
}

export function qaReminderUserId() {
  const fromEnv = (process.env.AMARE_PUSH_QA_REMINDER_USER_ID || "").trim();
  if (fromEnv) return fromEnv;
  return reminderQaGateOpen() ? QA_AUTO_PUSH_USER_ID : "";
}

export function qaReminderLeadMinutes() {
  const n = parseInt(String(process.env.AMARE_PUSH_QA_REMINDER_LEAD_MINUTES || ""), 10);
  if (Number.isFinite(n) && n > 0 && n <= 24 * 60) return n;
  return reminderQaGateOpen() ? 10 : null;
}

export function reminderLeadMinutesForUser(amareUserId) {
  const qaUser = qaReminderUserId();
  const qaLead = qaReminderLeadMinutes();
  if (qaUser && qaLead && amareUserId === qaUser) return qaLead;
  return reminderLeadMinutes();
}

export function scheduledForFromClassStart(classStartAt, leadMinutes = reminderLeadMinutes()) {
  if (!classStartAt) return null;
  const ms = Date.parse(classStartAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - leadMinutes * 60 * 1000).toISOString();
}

export function reminderPlanFromClassStart(classStartAt, nowMs = Date.now(), leadMinutes = reminderLeadMinutes()) {
  const scheduledFor = scheduledForFromClassStart(classStartAt, leadMinutes);
  if (!scheduledFor) return { scheduledFor: null, status: "suppressed" };
  if (Date.parse(scheduledFor) <= nowMs) return { scheduledFor, status: "suppressed" };
  return { scheduledFor, status: "scheduled" };
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

async function resolveClassName(store, siteId, classId, extra = {}) {
  return enrichClassName(store, {
    siteId,
    classId,
    existingName: extra.existingName || null,
    classDescriptionId: extra.classDescriptionId ?? null,
    classStartAt: extra.classStartAt || null,
    fetchClassName: extra.fetchClassName,
  });
}

function copyPayload(booking, extra = {}) {
  return {
    className: booking.className || extra.className || null,
    classStartAt: booking.classStartAt || extra.classStartAt || null,
    bookingOriginatedFromWaitlist: booking.originatedFromWaitlist === true,
    ...extra,
  };
}

async function upsertReminderForBooking(store, booking, originationAt) {
  if (!booking.amareUserId || booking.classRosterBookingId == null) return null;
  if (isCancelStatus(booking.status)) {
    const existing = await store.getReminder(booking.amareUserId, booking.siteId, booking.classRosterBookingId);
    if (!existing) return null;
    if (isOlderOrEqualEvent(originationAt, existing.lastEventOriginationAt)) return existing;
    if (existing.status === "sent") return existing;
    return store.upsertReminder({
      ...existing,
      status: "cancelled",
      lastEventOriginationAt: originationAt,
    });
  }
  const existing = await store.getReminder(booking.amareUserId, booking.siteId, booking.classRosterBookingId);
  if (existing?.status === "sent" || existing?.status === "due") return existing;
  const plan = reminderPlanFromClassStart(
    booking.classStartAt,
    Date.now(),
    reminderLeadMinutesForUser(booking.amareUserId),
  );
  return store.upsertReminder({
    amareUserId: booking.amareUserId,
    siteId: booking.siteId,
    classId: booking.classId,
    classRosterBookingId: booking.classRosterBookingId,
    reminderType: "class_reminder",
    classStartAt: booking.classStartAt,
    scheduledFor: plan.scheduledFor,
    status: plan.status,
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
  const classStartAt = iso(d.classStartDateTime ?? d.ClassStartDateTime);
  const classDescriptionId = num(d.classDescriptionId ?? d.ClassDescriptionId);
  const enriched = await resolveClassName(store, meta.siteId, classId, {
    existingName: existing?.className,
    classDescriptionId,
    classStartAt,
    fetchClassName: deps.fetchClassName,
  });
  const className = enriched.className;
  const booking = await store.upsertBooking({
    siteId: meta.siteId,
    classRosterBookingId: bookingId,
    classId,
    clientId,
    amareUserId,
    classStartAt,
    className,
    clientPassId: d.clientPassId != null ? String(d.clientPassId) : d.ClientPassId != null ? String(d.ClientPassId) : null,
    itemId: num(d.itemId ?? d.ItemId),
    itemName: typeof (d.itemName ?? d.ItemName) === "string" ? String(d.itemName ?? d.ItemName) : null,
    lastMessageId: meta.messageId,
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
    const promoted = await emitCandidate(store, {
      kind: "waitlist_promoted",
      amareUserId,
      siteId: meta.siteId,
      classId,
      classRosterBookingId: bookingId,
      transactionKey: meta.transactionKey,
      payload: copyPayload(booking, { bookingOriginatedFromWaitlist: true }),
    });
    return { ok: true, booking, candidates: promoted ? [promoted] : [] };
  }
  const created = await emitCandidate(store, {
    kind: "booking_created",
    amareUserId,
    siteId: meta.siteId,
    classId,
    classRosterBookingId: bookingId,
    transactionKey: meta.transactionKey,
    payload: copyPayload(booking, {
      bookingOriginatedFromWaitlist: false,
      className: enriched.displayName,
      classNameSource: enriched.source,
      classNameFallback: enriched.fallbackUsed === true,
    }),
  });
  return { ok: true, booking, candidates: created ? [created] : [] };
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
  const alreadyCancelled = existing && isCancelStatus(existing.status);
  const enriched = await resolveClassName(store, meta.siteId, classId, {
    existingName: existing?.className,
    classStartAt: existing?.classStartAt || iso(d.classStartDateTime ?? d.ClassStartDateTime),
    fetchClassName: deps.fetchClassName,
  });
  const className = enriched.className || existing?.className || null;
  const booking = await store.upsertBooking({
    siteId: meta.siteId,
    classRosterBookingId: bookingId,
    classId,
    clientId,
    amareUserId,
    classStartAt: existing?.classStartAt || iso(d.classStartDateTime ?? d.ClassStartDateTime),
    className,
    clientPassId: existing?.clientPassId || null,
    itemId: existing?.itemId ?? null,
    itemName: existing?.itemName || null,
    lastMessageId: meta.messageId,
    status,
    originatedFromWaitlist: existing?.originatedFromWaitlist === true,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
    transactionKey: meta.transactionKey || existing?.transactionKey || null,
  });
  await upsertReminderForBooking(store, booking, booking.lastEventOriginationAt);
  const candidates = [];
  if (!alreadyCancelled) {
    const cancelled = await emitCandidate(store, {
      kind: "booking_cancelled",
      amareUserId,
      siteId: meta.siteId,
      classId,
      classRosterBookingId: bookingId,
      transactionKey: meta.transactionKey,
      payload: copyPayload(booking, {
        status,
        className: enriched.displayName,
        classNameSource: enriched.source,
        classNameFallback: enriched.fallbackUsed === true,
      }),
    });
    if (cancelled) candidates.push(cancelled);
  }
  return { ok: true, booking, candidates };
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
  const classDescriptionId = num(d.classDescriptionId ?? d.ClassDescriptionId);
  const prevStart = existing?.startAt || null;
  const description =
    classDescriptionId != null && store.getClassDescription
      ? await store.getClassDescription(meta.siteId, classDescriptionId)
      : null;
  const classState = await store.upsertClassState({
    siteId: meta.siteId,
    classId,
    startAt,
    isCancelled,
    staffId,
    classDescriptionId,
    className: description?.className || existing?.className || null,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
  });
  const reminders = await store.listRemindersByClass(meta.siteId, classId);
  const orig = classState.lastEventOriginationAt;
  for (const rem of reminders) {
    if (isOlderOrEqualEvent(orig, rem.lastEventOriginationAt)) continue;
    if (isCancelled) {
      if (rem.status === "scheduled" || rem.status === "due") {
        await store.upsertReminder({ ...rem, status: "cancelled", lastEventOriginationAt: orig });
      }
      continue;
    }
    if (startAt && startAt !== rem.classStartAt) {
      const plan = reminderPlanFromClassStart(
        startAt,
        Date.now(),
        reminderLeadMinutesForUser(rem.amareUserId),
      );
      const locked = rem.status === "cancelled" || rem.status === "sent" || rem.status === "due";
      await store.upsertReminder({
        ...rem,
        classStartAt: startAt,
        scheduledFor: plan.scheduledFor,
        status: locked ? rem.status : plan.status,
        lastEventOriginationAt: orig,
      });
    }
  }
  const bookings = await store.listBookingsByClass(meta.siteId, classId);
  const users = new Set(
    bookings.filter((b) => b.status === "booked" && b.amareUserId).map((b) => b.amareUserId),
  );
  const className = classState.className || null;
  if (isCancelled) {
    for (const amareUserId of users) {
      await emitCandidate(store, {
        kind: "class_cancelled",
        amareUserId,
        siteId: meta.siteId,
        classId,
        payload: { isCancelled: true, className, classStartAt: startAt || existing?.startAt || null },
      });
    }
  } else if (startAt && prevStart && startAt !== prevStart) {
    for (const amareUserId of users) {
      await emitCandidate(store, {
        kind: "class_time_changed",
        amareUserId,
        siteId: meta.siteId,
        classId,
        payload: { previousStart: prevStart, startAt, className, classStartAt: startAt },
      });
    }
  }
  return { ok: true, classState };
}

async function applyClassDescriptionUpdated(store, meta) {
  const d = meta.eventData;
  const descriptionId = num(d.id ?? d.Id ?? d.classDescriptionId ?? d.ClassDescriptionId);
  if (meta.siteId == null || descriptionId == null) return { ok: false, reason: "missing_class_description_id" };
  const existing = store.getClassDescription ? await store.getClassDescription(meta.siteId, descriptionId) : null;
  if (existing && isOlderOrEqualEvent(meta.originationAt, existing.lastEventOriginationAt)) {
    return { ok: true, skipped: "older_or_duplicate", description: existing };
  }
  const className = typeof (d.name ?? d.Name) === "string" ? String(d.name ?? d.Name).trim() : existing?.className || null;
  if (!store.upsertClassDescription) return { ok: true, skipped: "store_missing_description" };
  const description = await store.upsertClassDescription({
    siteId: meta.siteId,
    classDescriptionId: descriptionId,
    className,
    lastEventOriginationAt: meta.originationAt || new Date().toISOString(),
  });
  return { ok: true, description };
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
  if (meta.eventId === "classDescription.updated") return applyClassDescriptionUpdated(store, meta);
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
