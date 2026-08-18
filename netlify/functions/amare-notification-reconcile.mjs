/**
 * Class-centric bootstrap / reconciliation for AMARÉ notification state.
 * Read-only against Mindbody Public API. Writes only AMARÉ durable state.
 * Does not send push. Does not poll per-user member summary. Not a production cron yet.
 */

import { fetchMb, getMindbodyStaffAccessTokenCached, MB_API_VERSION } from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import {
  isOlderOrEqualEvent,
  reminderLeadMinutes,
  resolveAmareUserForClient,
  scheduledForFromClassStart,
} from "./amare-notification-lib.mjs";

export const BOOTSTRAP_ORIGIN_FALLBACK = "1970-01-01T00:00:00.000Z";

function num(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^-?\d{1,18}$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  return null;
}

function iso(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

function bool(raw) {
  return raw === true || raw === "true" || raw === 1 || raw === "1";
}

function rowsFrom(data, keys) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of keys) {
    if (Array.isArray(d[key])) return d[key];
  }
  return [];
}

export function visitIsCancelled(visit) {
  if (!visit || typeof visit !== "object") return false;
  const v = /** @type {Record<string, unknown>} */ (visit);
  if (bool(v.LateCancelled ?? v.lateCancelled)) return true;
  if (bool(v.EarlyCancelled ?? v.earlyCancelled)) return true;
  if (bool(v.Cancelled ?? v.cancelled ?? v.IsCancelled ?? v.isCancelled)) return true;
  const status = String(v.SignedInStatus ?? v.signedInStatus ?? "").toLowerCase();
  return status === "earlycancelled" || status === "early_cancelled" || status === "latecancelled" || status === "late_cancelled";
}

export function visitCancelStatus(visit) {
  if (!visit || typeof visit !== "object") return "cancelled";
  const v = /** @type {Record<string, unknown>} */ (visit);
  if (bool(v.LateCancelled ?? v.lateCancelled)) return "late_cancelled";
  if (bool(v.EarlyCancelled ?? v.earlyCancelled)) return "early_cancelled";
  const status = String(v.SignedInStatus ?? v.signedInStatus ?? "").toLowerCase();
  if (status === "latecancelled" || status === "late_cancelled") return "late_cancelled";
  if (status === "earlycancelled" || status === "early_cancelled") return "early_cancelled";
  return "cancelled";
}

export function parseClassRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const classId = num(r.Id ?? r.id ?? r.ClassId ?? r.classId);
  if (classId == null) return null;
  return {
    classId,
    startAt: iso(String(r.StartDateTime ?? r.startDateTime ?? "")),
    isCancelled: bool(r.IsCancelled ?? r.isCancelled),
    staffId: num(r.StaffId ?? r.staffId),
    lastModifiedAt: iso(String(r.LastModifiedDateTime ?? r.lastModifiedDateTime ?? r.LastModified ?? "")),
  };
}

export function parseVisitRow(raw, fallbackClassId = null) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const classRosterBookingId = num(r.Id ?? r.id ?? r.VisitId ?? r.visitId ?? r.ClassRosterBookingId ?? r.classRosterBookingId);
  if (classRosterBookingId == null) return null;
  const nestedClient = r.Client && typeof r.Client === "object" ? /** @type {Record<string, unknown>} */ (r.Client) : null;
  const nestedClass = r.Class && typeof r.Class === "object" ? /** @type {Record<string, unknown>} */ (r.Class) : null;
  return {
    classRosterBookingId,
    classId: num(r.ClassId ?? r.classId ?? nestedClass?.Id ?? nestedClass?.id) ?? fallbackClassId,
    clientId: num(r.ClientId ?? r.clientId ?? nestedClient?.Id ?? nestedClient?.id ?? r.UniqueId ?? r.uniqueId),
    classStartAt: iso(String(r.StartDateTime ?? r.startDateTime ?? r.ClassStartDateTime ?? r.classStartDateTime ?? "")),
    lastModifiedAt: iso(String(r.LastModifiedDateTime ?? r.lastModifiedDateTime ?? "")),
    cancelled: visitIsCancelled(r),
    status: visitIsCancelled(r) ? visitCancelStatus(r) : "booked",
  };
}

export function parseWaitlistRow(raw, fallbackClassId = null) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const waitlistEntryId = num(r.Id ?? r.id ?? r.WaitlistEntryId ?? r.waitlistEntryId);
  if (waitlistEntryId == null) return null;
  const nestedClient = r.Client && typeof r.Client === "object" ? /** @type {Record<string, unknown>} */ (r.Client) : null;
  const nestedClass = r.Class && typeof r.Class === "object" ? /** @type {Record<string, unknown>} */ (r.Class) : null;
  return {
    waitlistEntryId,
    classId: num(r.ClassId ?? r.classId ?? nestedClass?.Id ?? nestedClass?.id) ?? fallbackClassId,
    clientId: num(r.ClientId ?? r.clientId ?? nestedClient?.Id ?? nestedClient?.id),
    classStartAt: iso(
      String(r.ClassDate ?? r.classDate ?? r.StartDateTime ?? r.startDateTime ?? r.ClassStartDateTime ?? r.classStartDateTime ?? ""),
    ),
    lastModifiedAt: iso(String(r.EnrollmentDateTime ?? r.enrollmentDateTime ?? r.RequestDateTime ?? r.requestDateTime ?? "")),
  };
}

function seedOrigination(lastModifiedAt) {
  return lastModifiedAt || BOOTSTRAP_ORIGIN_FALLBACK;
}

async function applyClassSeed(store, siteId, cls, nowIso) {
  const orig = seedOrigination(cls.lastModifiedAt);
  const existing = await store.getClassState(siteId, cls.classId);
  if (existing && isOlderOrEqualEvent(orig === BOOTSTRAP_ORIGIN_FALLBACK ? nowIso : orig, existing.lastEventOriginationAt)) {
    if (cls.startAt && existing.startAt && cls.startAt !== existing.startAt && orig === BOOTSTRAP_ORIGIN_FALLBACK) {
      /* Public API is current: repair drift with now. */
    } else if (!(cls.isCancelled && !existing.isCancelled)) {
      return existing;
    }
  }
  const stamp = existing && orig === BOOTSTRAP_ORIGIN_FALLBACK ? nowIso : orig;
  if (existing && isOlderOrEqualEvent(stamp, existing.lastEventOriginationAt) && existing.isCancelled === cls.isCancelled && existing.startAt === cls.startAt) {
    return existing;
  }
  return store.upsertClassState({
    siteId,
    classId: cls.classId,
    startAt: cls.startAt,
    isCancelled: cls.isCancelled === true,
    staffId: cls.staffId,
    lastEventOriginationAt: existing && isOlderOrEqualEvent(stamp, existing.lastEventOriginationAt) ? existing.lastEventOriginationAt : stamp,
  });
}

async function applyVisitSeed(store, siteId, visit, deps, nowIso, stats) {
  const orig = seedOrigination(visit.lastModifiedAt);
  const existing = await store.getBooking(siteId, visit.classRosterBookingId);
  const stamp = !visit.lastModifiedAt && existing ? nowIso : orig;
  if (existing && isOlderOrEqualEvent(stamp, existing.lastEventOriginationAt) && existing.status === (visit.cancelled ? visit.status : "booked")) {
    stats.bookingUnchanged += 1;
    return existing;
  }
  if (existing && isOlderOrEqualEvent(stamp, existing.lastEventOriginationAt)) {
    stats.bookingUnchanged += 1;
    return existing;
  }
  const clientId = visit.clientId ?? existing?.clientId ?? null;
  const classId = visit.classId ?? existing?.classId ?? null;
  const amareUserId =
    existing?.amareUserId || (clientId != null ? await resolveAmareUserForClient(siteId, clientId, deps) : null);
  const status = visit.cancelled ? visit.status : "booked";
  const classStartAt = visit.classStartAt || existing?.classStartAt || null;
  const booking = await store.upsertBooking({
    siteId,
    classRosterBookingId: visit.classRosterBookingId,
    classId,
    clientId,
    amareUserId,
    classStartAt,
    status,
    originatedFromWaitlist: existing?.originatedFromWaitlist === true,
    lastEventOriginationAt: stamp,
    transactionKey: existing?.transactionKey || null,
  });
  if (amareUserId) await store.ensurePreferences(amareUserId);
  if (amareUserId && booking.classRosterBookingId != null) {
    const rem = await store.getReminder(amareUserId, siteId, booking.classRosterBookingId);
    if (!rem || !isOlderOrEqualEvent(stamp, rem.lastEventOriginationAt)) {
      await store.upsertReminder({
        amareUserId,
        siteId,
        classId,
        classRosterBookingId: booking.classRosterBookingId,
        reminderType: "class_reminder",
        classStartAt,
        scheduledFor: scheduledForFromClassStart(classStartAt),
        status: status === "booked" ? "scheduled" : "cancelled",
        lastEventOriginationAt: stamp,
      });
    }
  }
  if (!existing) stats.bookingsCreated += 1;
  else stats.bookingsUpdated += 1;
  return booking;
}

async function applyWaitlistSeed(store, siteId, entry, deps, nowIso, stats) {
  const orig = seedOrigination(entry.lastModifiedAt);
  const existing = await store.getWaitlist(siteId, entry.waitlistEntryId);
  const stamp = !entry.lastModifiedAt && existing ? nowIso : orig;
  if (existing && isOlderOrEqualEvent(stamp, existing.lastEventOriginationAt)) {
    stats.waitlistUnchanged += 1;
    return existing;
  }
  const clientId = entry.clientId ?? existing?.clientId ?? null;
  const classId = entry.classId ?? existing?.classId ?? null;
  const amareUserId =
    existing?.amareUserId || (clientId != null ? await resolveAmareUserForClient(siteId, clientId, deps) : null);
  const waitlist = await store.upsertWaitlist({
    siteId,
    waitlistEntryId: entry.waitlistEntryId,
    classId,
    clientId,
    amareUserId,
    classStartAt: entry.classStartAt || existing?.classStartAt || null,
    status: existing?.status === "promoted" ? "promoted" : "active",
    lastEventOriginationAt: stamp,
  });
  if (amareUserId) await store.ensurePreferences(amareUserId);
  if (!existing) stats.waitlistsCreated += 1;
  else stats.waitlistsUpdated += 1;
  return waitlist;
}

async function repairRemindersForClass(store, siteId, cls, bookedVisitIds, nowIso, stats) {
  const reminders = await store.listRemindersByClass(siteId, cls.classId);
  for (const rem of reminders) {
    if (rem.status !== "scheduled") continue;
    if (cls.isCancelled) {
      await store.upsertReminder({ ...rem, status: "cancelled", lastEventOriginationAt: nowIso });
      stats.remindersCancelled += 1;
      continue;
    }
    if (rem.classRosterBookingId != null && !bookedVisitIds.has(rem.classRosterBookingId)) {
      await store.upsertReminder({ ...rem, status: "cancelled", lastEventOriginationAt: nowIso });
      stats.remindersCancelled += 1;
      continue;
    }
    if (cls.startAt && rem.classStartAt && cls.startAt !== rem.classStartAt) {
      await store.upsertReminder({
        ...rem,
        classStartAt: cls.startAt,
        scheduledFor: scheduledForFromClassStart(cls.startAt),
        lastEventOriginationAt: nowIso,
      });
      stats.remindersRescheduled += 1;
    }
  }
}

async function defaultStaffHeaders() {
  const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
  if (issued.ok === true) {
    const bearer = mindbodyStaffBearerHeaders(issued.accessToken);
    if (bearer) return bearer;
  }
  return mindbodyStaffApiHeaders();
}

export async function defaultFetchUpcomingClasses({ startAt, endAt, limit = 200 }) {
  const headers = await defaultStaffHeaders();
  if (!headers) return { ok: false, reason: "staff_headers_unavailable", classes: [] };
  /** @type {ReturnType<typeof parseClassRow>[]} */
  const classes = [];
  for (let offset = 0; offset < limit; offset += 100) {
    const q = new URLSearchParams();
    q.set("request.startDateTime", startAt);
    q.set("request.endDateTime", endAt);
    q.set("request.limit", "100");
    q.set("request.offset", String(offset));
    const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/class/classes?${q}`, headers, null, { timeoutMs: 20000 });
    if (!r.ok) return { ok: false, reason: `classes_${r.status}`, classes };
    const rows = rowsFrom(r.data, ["Classes", "classes"]);
    for (const raw of rows) {
      const parsed = parseClassRow(raw);
      if (parsed) classes.push(parsed);
    }
    if (rows.length < 100) break;
  }
  return { ok: true, classes: classes.slice(0, limit) };
}

export async function defaultFetchClassVisits(classId) {
  const headers = await defaultStaffHeaders();
  if (!headers) return { ok: false, reason: "staff_headers_unavailable", visits: [] };
  const q = new URLSearchParams();
  q.set("request.classID", String(classId));
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/class/classvisits?${q}`, headers, null, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: `classvisits_${r.status}`, visits: [] };
  const rows = rowsFrom(r.data, ["Visits", "visits", "ClassVisits", "classVisits"]);
  return { ok: true, visits: rows.map((raw) => parseVisitRow(raw, classId)).filter(Boolean) };
}

export async function defaultFetchClassWaitlist(classId) {
  const headers = await defaultStaffHeaders();
  if (!headers) return { ok: false, available: false, reason: "staff_headers_unavailable", entries: [] };
  const q = new URLSearchParams();
  q.set("request.classIds", String(classId));
  q.set("request.hidePastEntries", "true");
  q.set("request.limit", "200");
  q.set("request.offset", "0");
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/class/waitlistentries?${q}`, headers, null, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, available: false, reason: `waitlist_${r.status}`, entries: [] };
  const rows = rowsFrom(r.data, ["WaitlistEntries", "waitlistEntries"]);
  return { ok: true, available: true, entries: rows.map((raw) => parseWaitlistRow(raw, classId)).filter(Boolean) };
}

/**
 * Seed / repair booking, waitlist, and reminder rows from upcoming classes.
 * @param {{
 *   store: Record<string, Function>,
 *   siteId: number,
 *   now?: Date,
 *   windowDays?: number,
 *   fetchUpcomingClasses?: Function,
 *   fetchClassVisits?: Function,
 *   fetchClassWaitlist?: Function,
 *   findActiveAssociationByClientId?: Function,
 * }} opts
 */
export async function runNotificationReconciliation(opts) {
  const store = opts.store;
  if (!store) throw new Error("notification_store_required");
  const siteId = num(opts.siteId);
  if (siteId == null) throw new Error("site_id_required");
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowIso = now.toISOString();
  const windowDays = Number.isFinite(Number(opts.windowDays)) ? Number(opts.windowDays) : 21;
  const startAt = now.toISOString();
  const endAt = new Date(now.getTime() + windowDays * 86400000).toISOString();
  const fetchUpcomingClasses = opts.fetchUpcomingClasses || defaultFetchUpcomingClasses;
  const fetchClassVisits = opts.fetchClassVisits || defaultFetchClassVisits;
  const fetchClassWaitlist = opts.fetchClassWaitlist || defaultFetchClassWaitlist;
  const deps = { findActiveAssociationByClientId: opts.findActiveAssociationByClientId };

  const stats = {
    classes: 0,
    bookingsCreated: 0,
    bookingsUpdated: 0,
    bookingUnchanged: 0,
    bookingsCancelled: 0,
    waitlistsCreated: 0,
    waitlistsUpdated: 0,
    waitlistUnchanged: 0,
    remindersCancelled: 0,
    remindersRescheduled: 0,
    waitlistAvailable: true,
    waitlistReason: null,
    leadMinutes: reminderLeadMinutes(),
  };

  const classResult = await fetchUpcomingClasses({ startAt, endAt });
  const classes = classResult.classes || [];
  stats.classes = classes.length;
  if (classResult.ok === false) stats.classFetchReason = classResult.reason || "classes_unavailable";

  for (const cls of classes) {
    await applyClassSeed(store, siteId, cls, nowIso);
    const visitResult = await fetchClassVisits(cls.classId);
    const visits = visitResult.visits || [];
    /** @type {Set<number>} */
    const bookedVisitIds = new Set();
    for (const visit of visits) {
      if (!visit.cancelled) bookedVisitIds.add(visit.classRosterBookingId);
      await applyVisitSeed(store, siteId, { ...visit, classId: visit.classId ?? cls.classId, classStartAt: visit.classStartAt || cls.startAt }, deps, nowIso, stats);
    }

    const existingBookings = await store.listBookingsByClass(siteId, cls.classId);
    for (const booking of existingBookings) {
      if (booking.status !== "booked") continue;
      if (bookedVisitIds.has(booking.classRosterBookingId)) continue;
      await store.upsertBooking({
        ...booking,
        status: "cancelled",
        lastEventOriginationAt: nowIso,
      });
      if (booking.amareUserId) {
        const rem = await store.getReminder(booking.amareUserId, siteId, booking.classRosterBookingId);
        if (rem && rem.status === "scheduled") {
          await store.upsertReminder({ ...rem, status: "cancelled", lastEventOriginationAt: nowIso });
          stats.remindersCancelled += 1;
        }
      }
      stats.bookingsCancelled += 1;
    }

    const waitlistResult = await fetchClassWaitlist(cls.classId);
    if (waitlistResult.available === false || waitlistResult.ok === false) {
      stats.waitlistAvailable = false;
      stats.waitlistReason = waitlistResult.reason || "waitlist_unavailable";
    } else {
      for (const entry of waitlistResult.entries || []) {
        await applyWaitlistSeed(store, siteId, { ...entry, classId: entry.classId ?? cls.classId, classStartAt: entry.classStartAt || cls.startAt }, deps, nowIso, stats);
      }
    }

    await repairRemindersForClass(store, siteId, cls, bookedVisitIds, nowIso, stats);
  }

  return { ok: true, siteId, windowDays, stats };
}

/** Same class-centric routine used to seed state before the live roster subscription. */
export const bootstrapNotificationState = runNotificationReconciliation;
