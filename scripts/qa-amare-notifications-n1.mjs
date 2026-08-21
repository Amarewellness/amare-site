/**
 * AMARÉ Notifications Phase N1 — durable inbox / state / reminder matrix.
 * Run: npm run test:amare-notifications-n1
 *
 * Does not send FCM. Does not PATCH Mindbody. Does not flip production flags.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createMemoryNotificationStore, DEFAULT_PREFERENCES } from "../netlify/functions/amare-notification-store.mjs";
import {
  FUTURE_SUBSCRIPTION_EVENT_UNION,
  ingestAndProcessWebhook,
  scheduledForFromClassStart,
} from "../netlify/functions/amare-notification-lib.mjs";
import { runNotificationReconciliation } from "../netlify/functions/amare-notification-reconcile.mjs";
import { handleMindbodyScheduleWebhook, lambdaHandler } from "../netlify/functions/mindbody-webhooks-schedule.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const SECRET = "n1-webhook-test-secret";
const SITE = 123;
const USER = "usr_N1LINKED000000000000001";
const CLIENT = 1001;
const CLASS_ID = 555;
const BOOKING_ID = 9001;
const WAITLIST_ID = 7001;
const START = "2026-09-01T18:00:00.000Z";
const START_NEW = "2026-09-01T19:30:00.000Z";

const prevEnv = { ...process.env };
process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY = SECRET;
process.env.MINDBODY_WEBHOOK_SKIP_VERIFY = "";
process.env.MINDBODY_WEBHOOK_DEDUPE_BLOBS = "0";
process.env.MINDBODY_SITE_ID = String(SITE);
process.env.AMARE_CLASS_REMINDER_LEAD_MINUTES = "120";
delete process.env.NETLIFY;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;

function restoreEnv() {
  for (const key of [
    "MINDBODY_WEBHOOK_SIGNATURE_KEY",
    "MINDBODY_WEBHOOK_SKIP_VERIFY",
    "MINDBODY_WEBHOOK_DEDUPE_BLOBS",
    "MINDBODY_SITE_ID",
    "AMARE_CLASS_REMINDER_LEAD_MINUTES",
    "NETLIFY",
    "AWS_LAMBDA_FUNCTION_NAME",
  ]) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
}

function sign(body) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64")}`;
}

function signedEvent(payload) {
  const body = JSON.stringify(payload);
  return {
    httpMethod: "POST",
    headers: { "X-Mindbody-Signature": sign(body) },
    body,
  };
}

function findLinked() {
  return async (siteId, clientId) => {
    if (String(siteId) !== String(SITE)) return null;
    if (Number(clientId) !== CLIENT) return null;
    return { amare_user_id: USER, client_id: CLIENT };
  };
}

function findNone() {
  return async () => null;
}

function envelope(eventId, messageId, eventData, originationAt, extra = {}) {
  return {
    messageId,
    eventId,
    eventInstanceOriginationDateTime: originationAt,
    eventData: { siteId: SITE, ...eventData },
    ...extra,
  };
}

async function post(store, payload, deps = {}) {
  return handleMindbodyScheduleWebhook(signedEvent(payload), {
    notificationStore: store,
    findActiveAssociationByClientId: deps.findActiveAssociationByClientId || findLinked(),
    expectedSiteId: deps.expectedSiteId !== undefined ? deps.expectedSiteId : SITE,
  });
}

async function ingest(store, payload, find = findLinked()) {
  return ingestAndProcessWebhook(store, payload, { findActiveAssociationByClientId: find });
}

const store = createMemoryNotificationStore();

// ── WEBHOOK ────────────────────────────────────────────────────────────────

const createdPayload = envelope(
  "classRosterBooking.created",
  "msg-w1",
  {
    classRosterBookingId: BOOKING_ID,
    classId: CLASS_ID,
    clientId: CLIENT,
    classStartDateTime: START,
    bookingOriginatedFromWaitlist: false,
  },
  "2026-08-17T12:00:00.000Z",
);

const w1a = await post(store, createdPayload);
const w1b = await post(store, createdPayload);
const w1booking = await store.getBooking(SITE, BOOKING_ID);
const w1reminder = await store.getReminder(USER, SITE, BOOKING_ID);
const w1candidates = await store.listCandidates({ kind: "booking_created" });
check("W1 duplicate messageId → one processing effect", w1a.statusCode === 200 && w1b.statusCode === 200 && w1booking?.status === "booked" && w1reminder?.status === "scheduled" && w1candidates.length === 1);

const badSig = await handleMindbodyScheduleWebhook(
  {
    httpMethod: "POST",
    headers: { "X-Mindbody-Signature": "sha256=deadbeef" },
    body: JSON.stringify(envelope("classRosterBooking.created", "msg-w2", { classRosterBookingId: 1, clientId: CLIENT, classId: CLASS_ID }, "2026-08-17T12:00:00.000Z")),
  },
  { notificationStore: store, findActiveAssociationByClientId: findLinked(), expectedSiteId: SITE },
);
const w2booking = await store.getBooking(SITE, 1);
check("W2 invalid signature → rejected", badSig.statusCode === 401 && !w2booking);

const beforeUnknown = (await store.listCandidates()).length;
const unknown = await post(store, envelope("client.created", "msg-w3", { clientId: CLIENT, email: "should-not-be-used@example.com" }, "2026-08-17T12:00:00.000Z"));
const afterUnknown = (await store.listCandidates()).length;
check("W3 unsupported event → ACK / no state change", unknown.statusCode === 200 && JSON.parse(unknown.body).ignored === true && afterUnknown === beforeUnknown);

const mismatchStore = createMemoryNotificationStore();
const mismatch = await post(
  mismatchStore,
  envelope("classRosterBooking.created", "msg-w4", { classRosterBookingId: 44, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START }, "2026-08-17T12:00:00.000Z"),
  { expectedSiteId: 999 },
);
check("W4 site mismatch → safe ACK / no booking", mismatch.statusCode === 200 && JSON.parse(mismatch.body).reason === "site_mismatch" && !(await mismatchStore.getBooking(SITE, 44)));

const getOk = await lambdaHandler({ httpMethod: "GET" });
check("GET probe still 200", getOk.statusCode === 200);

// ── BOOKING ────────────────────────────────────────────────────────────────

const bStore = createMemoryNotificationStore();
await ingest(
  bStore,
  envelope(
    "classRosterBooking.created",
    "msg-b1",
    { classRosterBookingId: BOOKING_ID, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T13:00:00.000Z",
  ),
);
const b1booking = await bStore.getBooking(SITE, BOOKING_ID);
const b1reminder = await bStore.getReminder(USER, SITE, BOOKING_ID);
check(
  "B1 booking.created → booking state + reminder",
  b1booking?.status === "booked" &&
    b1booking?.amareUserId === USER &&
    b1reminder?.status === "scheduled" &&
    b1reminder?.scheduledFor === scheduledForFromClassStart(START),
);

const nameStore = createMemoryNotificationStore();
await nameStore.upsertClassState({
  siteId: SITE,
  classId: CLASS_ID,
  className: "Signature Reformer",
  lastEventOriginationAt: "2026-08-17T10:00:00.000Z",
});
await ingest(
  nameStore,
  envelope(
    "classRosterBooking.created",
    "msg-b1-name",
    {
      classRosterBookingId: 9101,
      classId: CLASS_ID,
      clientId: CLIENT,
      classStartDateTime: START,
      itemName: "AMARÉ Monthly 8 Classes",
    },
    "2026-08-17T13:05:00.000Z",
  ),
);
const namedBooking = await nameStore.getBooking(SITE, 9101);
const namedCand = (await nameStore.listCandidates({ kind: "booking_created" }))[0];
check(
  "Class name comes from persisted class state, never itemName",
  namedBooking?.className === "Signature Reformer" &&
    namedCand?.payload?.className === "Signature Reformer" &&
    namedCand?.payload?.className !== "AMARÉ Monthly 8 Classes" &&
    namedCand?.payload?.classNameFallback !== true,
);

const fallbackStore = createMemoryNotificationStore();
await ingest(
  fallbackStore,
  envelope(
    "classRosterBooking.created",
    "msg-b1-fallback",
    {
      classRosterBookingId: 9102,
      classId: 9999,
      clientId: CLIENT,
      classStartDateTime: START,
      itemName: "AMARÉ Monthly 8 Classes",
    },
    "2026-08-17T13:06:00.000Z",
  ),
);
const fallbackBooking = await fallbackStore.getBooking(SITE, 9102);
const fallbackCand = (await fallbackStore.listCandidates({ kind: "booking_created" }))[0];
check(
  "Missing class name uses your class fallback and does not persist itemName",
  fallbackBooking?.className == null &&
    fallbackBooking?.itemName === "AMARÉ Monthly 8 Classes" &&
    fallbackCand?.payload?.className === "your class" &&
    fallbackCand?.payload?.classNameFallback === true,
);

await ingest(
  bStore,
  envelope(
    "classRosterBooking.created",
    "msg-b2",
    { classRosterBookingId: BOOKING_ID, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T13:00:01.000Z",
  ),
);
const b2reminders = [await bStore.getReminder(USER, SITE, BOOKING_ID)];
check("B2 duplicate booking.created → no duplicate reminder", b2reminders.length === 1 && b2reminders[0]?.reminderId === b1reminder.reminderId);

await ingest(
  bStore,
  envelope(
    "classRosterBooking.cancelled",
    "msg-b3",
    { classRosterBookingId: BOOKING_ID, classId: CLASS_ID, clientId: CLIENT },
    "2026-08-17T14:00:00.000Z",
  ),
);
const b3booking = await bStore.getBooking(SITE, BOOKING_ID);
const b3reminder = await bStore.getReminder(USER, SITE, BOOKING_ID);
check("B3 booking.cancelled → reminder cancelled", b3booking?.status === "cancelled" && b3reminder?.status === "cancelled");

const ooStore = createMemoryNotificationStore();
await ingest(
  ooStore,
  envelope(
    "classRosterBooking.created",
    "msg-b4-seed",
    { classRosterBookingId: 8001, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T14:00:00.000Z",
  ),
);
await ingest(
  ooStore,
  envelope(
    "classRosterBooking.cancelled",
    "msg-b4-new",
    { classRosterBookingId: 8001, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T16:00:00.000Z",
  ),
);
await ingest(
  ooStore,
  envelope(
    "classRosterBooking.created",
    "msg-b4-old",
    { classRosterBookingId: 8001, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T15:00:00.000Z",
  ),
);
const b4 = await ooStore.getBooking(SITE, 8001);
const b4rem = await ooStore.getReminder(USER, SITE, 8001);
check("B4 newer cancelled then older created → remains cancelled", b4?.status === "cancelled" && b4rem?.status === "cancelled");

const stStore = createMemoryNotificationStore();
await ingest(
  stStore,
  envelope(
    "classRosterBooking.created",
    "msg-b5-c",
    { classRosterBookingId: 8002, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T10:00:00.000Z",
  ),
);
await ingest(
  stStore,
  envelope(
    "classRosterBookingStatus.updated",
    "msg-b5-e",
    { classRosterBookingId: 8002, classId: CLASS_ID, clientId: CLIENT, signedInStatus: "EarlyCancelled" },
    "2026-08-17T11:00:00.000Z",
  ),
);
const b5e = await stStore.getBooking(SITE, 8002);
await ingest(
  stStore,
  envelope(
    "classRosterBooking.created",
    "msg-b5-c2",
    { classRosterBookingId: 8003, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T10:00:00.000Z",
  ),
);
await ingest(
  stStore,
  envelope(
    "classRosterBookingStatus.updated",
    "msg-b5-l",
    { classRosterBookingId: 8003, signedInStatus: "LateCancelled" },
    "2026-08-17T11:00:00.000Z",
  ),
);
const b5l = await stStore.getBooking(SITE, 8003);
const b5er = await stStore.getReminder(USER, SITE, 8002);
const b5lr = await stStore.getReminder(USER, SITE, 8003);
check(
  "B5 status updated EarlyCancelled/LateCancelled → cancelled state",
  b5e?.status === "early_cancelled" && b5l?.status === "late_cancelled" && b5er?.status === "cancelled" && b5lr?.status === "cancelled",
);

// ── WAITLIST ───────────────────────────────────────────────────────────────

const wlStore = createMemoryNotificationStore();
await ingest(
  wlStore,
  envelope(
    "classWaitlistRequest.created",
    "msg-wl1",
    { waitlistEntryId: WAITLIST_ID, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T09:00:00.000Z",
  ),
);
const wl1 = await wlStore.getWaitlist(SITE, WAITLIST_ID);
check("WL1 waitlist.created → durable mapping", wl1?.status === "active" && wl1?.amareUserId === USER && wl1?.classId === CLASS_ID && wl1?.clientId === CLIENT);

await ingest(
  wlStore,
  envelope("classWaitlistRequest.cancelled", "msg-wl2", { waitlistEntryId: WAITLIST_ID }, "2026-08-17T09:30:00.000Z"),
);
const wl2 = await wlStore.getWaitlist(SITE, WAITLIST_ID);
const wl2removed = await wlStore.listCandidates({ kind: "waitlist_removed" });
check("WL2 waitlist.cancelled with only waitlistEntryId → mapped user/class", wl2?.status === "cancelled" && wl2?.amareUserId === USER && wl2?.classId === CLASS_ID && wl2removed.length === 1);

const wl3 = await ingest(
  wlStore,
  envelope("classWaitlistRequest.cancelled", "msg-wl3", { waitlistEntryId: 7999 }, "2026-08-17T09:31:00.000Z"),
);
const wl3removed = await wlStore.listCandidates({ kind: "waitlist_removed" });
check("WL3 cancelled with missing map → no guess", wl3.skipped === "missing_map" && wl3removed.length === 1 && !(await wlStore.getWaitlist(SITE, 7999)));

const promoStore = createMemoryNotificationStore();
await ingest(
  promoStore,
  envelope(
    "classWaitlistRequest.created",
    "msg-wl4-w",
    { waitlistEntryId: 7100, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T08:00:00.000Z",
  ),
);
await ingest(
  promoStore,
  envelope(
    "classRosterBooking.created",
    "msg-wl4-b",
    {
      classRosterBookingId: 9100,
      classId: CLASS_ID,
      clientId: CLIENT,
      classStartDateTime: START,
      bookingOriginatedFromWaitlist: true,
    },
    "2026-08-17T08:10:00.000Z",
  ),
);
const wl4w = await promoStore.getWaitlist(SITE, 7100);
const wl4b = await promoStore.getBooking(SITE, 9100);
const wl4r = await promoStore.getReminder(USER, SITE, 9100);
const wl4p = await promoStore.listCandidates({ kind: "waitlist_promoted" });
const wl4left = await promoStore.listCandidates({ kind: "waitlist_removed" });
check(
  "WL4 roster booking from waitlist → promoted + booking reminder",
  wl4w?.status === "promoted" && wl4b?.status === "booked" && wl4b?.originatedFromWaitlist === true && wl4r?.status === "scheduled" && wl4p.length === 1,
);

await ingest(
  promoStore,
  envelope("classWaitlistRequest.cancelled", "msg-wl5", { waitlistEntryId: 7100 }, "2026-08-17T08:20:00.000Z"),
);
const wl5left = await promoStore.listCandidates({ kind: "waitlist_removed" });
const wl5w = await promoStore.getWaitlist(SITE, 7100);
check("WL5 promotion then waitlist.cancelled → no duplicate left-waitlist candidate", wl5w?.status === "promoted" && wl5left.length === wl4left.length);

// ── CLASS ──────────────────────────────────────────────────────────────────

const cStore = createMemoryNotificationStore();
await ingest(
  cStore,
  envelope(
    "classRosterBooking.created",
    "msg-c1-b",
    { classRosterBookingId: 9200, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T07:00:00.000Z",
  ),
);
await ingest(
  cStore,
  envelope("class.updated", "msg-c1", { classId: CLASS_ID, startDateTime: START_NEW, isCancelled: false }, "2026-08-17T07:10:00.000Z"),
);
const c1r = await cStore.getReminder(USER, SITE, 9200);
check(
  "C1 class start time changes → reminders rescheduled",
  c1r?.classStartAt === START_NEW && c1r?.scheduledFor === scheduledForFromClassStart(START_NEW) && c1r?.status === "scheduled",
);

await ingest(
  cStore,
  envelope("class.updated", "msg-c2", { classId: CLASS_ID, startDateTime: START, isCancelled: false }, "2026-08-17T07:05:00.000Z"),
);
const c2r = await cStore.getReminder(USER, SITE, 9200);
check("C2 older class.updated arrives later → no rollback", c2r?.classStartAt === START_NEW && c2r?.scheduledFor === scheduledForFromClassStart(START_NEW));

await ingest(
  cStore,
  envelope("class.updated", "msg-c3", { classId: CLASS_ID, startDateTime: START_NEW, isCancelled: true }, "2026-08-17T07:20:00.000Z"),
);
const c3r = await cStore.getReminder(USER, SITE, 9200);
check("C3 class isCancelled=true → reminders cancelled", c3r?.status === "cancelled");

// ── BOOTSTRAP / RECONCILE ──────────────────────────────────────────────────

const bsStore = createMemoryNotificationStore();
const futureStart = "2026-09-10T15:00:00.000Z";
const bsResult1 = await runNotificationReconciliation({
  store: bsStore,
  siteId: SITE,
  now: new Date("2026-08-17T12:00:00.000Z"),
  windowDays: 30,
  findActiveAssociationByClientId: findLinked(),
  fetchUpcomingClasses: async () => ({
    ok: true,
    classes: [{ classId: 601, startAt: futureStart, isCancelled: false, staffId: 1, lastModifiedAt: "2026-08-01T00:00:00.000Z" }],
  }),
  fetchClassVisits: async () => ({
    ok: true,
    visits: [
      {
        classRosterBookingId: 9300,
        classId: 601,
        clientId: CLIENT,
        classStartAt: futureStart,
        lastModifiedAt: "2026-08-02T00:00:00.000Z",
        cancelled: false,
        status: "booked",
      },
    ],
  }),
  fetchClassWaitlist: async () => ({
    ok: true,
    available: true,
    entries: [
      {
        waitlistEntryId: 7200,
        classId: 601,
        clientId: CLIENT,
        classStartAt: futureStart,
        lastModifiedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  }),
});
const bs1b = await bsStore.getBooking(SITE, 9300);
const bs1r = await bsStore.getReminder(USER, SITE, 9300);
const bs1w = await bsStore.getWaitlist(SITE, 7200);
const bs1cands = await bsStore.listCandidates();
check("BS1 existing future booking → bootstrap creates reminder", bsResult1.ok === true && bs1b?.status === "booked" && bs1r?.status === "scheduled" && bs1r?.classStartAt === futureStart);
check("BS3 existing waitlist mapping when Public API exposes Id/ClassId/ClientId", bs1w?.waitlistEntryId === 7200 && bs1w?.classId === 601 && bs1w?.amareUserId === USER && bs1w?.status === "active");

const remId = bs1r.reminderId;
await runNotificationReconciliation({
  store: bsStore,
  siteId: SITE,
  now: new Date("2026-08-17T12:05:00.000Z"),
  windowDays: 30,
  findActiveAssociationByClientId: findLinked(),
  fetchUpcomingClasses: async () => ({
    ok: true,
    classes: [{ classId: 601, startAt: futureStart, isCancelled: false, staffId: 1, lastModifiedAt: "2026-08-01T00:00:00.000Z" }],
  }),
  fetchClassVisits: async () => ({
    ok: true,
    visits: [
      {
        classRosterBookingId: 9300,
        classId: 601,
        clientId: CLIENT,
        classStartAt: futureStart,
        lastModifiedAt: "2026-08-02T00:00:00.000Z",
        cancelled: false,
        status: "booked",
      },
    ],
  }),
  fetchClassWaitlist: async () => ({
    ok: true,
    available: true,
    entries: [
      {
        waitlistEntryId: 7200,
        classId: 601,
        clientId: CLIENT,
        classStartAt: futureStart,
        lastModifiedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  }),
});
const bs2r = await bsStore.getReminder(USER, SITE, 9300);
const bs2w = await bsStore.getWaitlist(SITE, 7200);
check("BS2 rerun bootstrap → no duplicate reminder/waitlist", bs2r?.reminderId === remId && bs2w?.waitlistEntryId === 7200 && bs1cands.length === 0 && (await bsStore.listCandidates()).length === 0);

const recStore = createMemoryNotificationStore();
await recStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 9400,
  classId: 602,
  clientId: CLIENT,
  amareUserId: USER,
  classStartAt: "2026-09-11T15:00:00.000Z",
  status: "booked",
  originatedFromWaitlist: false,
  lastEventOriginationAt: "2026-08-01T00:00:00.000Z",
});
await recStore.upsertReminder({
  amareUserId: USER,
  siteId: SITE,
  classId: 602,
  classRosterBookingId: 9400,
  reminderType: "class_reminder",
  classStartAt: "2026-09-11T15:00:00.000Z",
  scheduledFor: scheduledForFromClassStart("2026-09-11T15:00:00.000Z"),
  status: "scheduled",
  lastEventOriginationAt: "2026-08-01T00:00:00.000Z",
});
await runNotificationReconciliation({
  store: recStore,
  siteId: SITE,
  now: new Date("2026-08-17T12:00:00.000Z"),
  findActiveAssociationByClientId: findLinked(),
  fetchUpcomingClasses: async () => ({
    ok: true,
    classes: [{ classId: 602, startAt: "2026-09-11T16:00:00.000Z", isCancelled: false, lastModifiedAt: "2026-08-16T00:00:00.000Z" }],
  }),
  fetchClassVisits: async () => ({ ok: true, visits: [] }),
  fetchClassWaitlist: async () => ({ ok: true, available: true, entries: [] }),
});
const recB = await recStore.getBooking(SITE, 9400);
const recR = await recStore.getReminder(USER, SITE, 9400);
check("Reconciliation repairs missed cancel + does not emit candidates", recB?.status === "cancelled" && recR?.status === "cancelled" && (await recStore.listCandidates()).length === 0);

const driftStore = createMemoryNotificationStore();
await driftStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 9401,
  classId: 603,
  clientId: CLIENT,
  amareUserId: USER,
  classStartAt: "2026-09-12T15:00:00.000Z",
  status: "booked",
  originatedFromWaitlist: false,
  lastEventOriginationAt: "2026-08-01T00:00:00.000Z",
});
await driftStore.upsertReminder({
  amareUserId: USER,
  siteId: SITE,
  classId: 603,
  classRosterBookingId: 9401,
  reminderType: "class_reminder",
  classStartAt: "2026-09-12T15:00:00.000Z",
  scheduledFor: scheduledForFromClassStart("2026-09-12T15:00:00.000Z"),
  status: "scheduled",
  lastEventOriginationAt: "2026-08-01T00:00:00.000Z",
});
await runNotificationReconciliation({
  store: driftStore,
  siteId: SITE,
  now: new Date("2026-08-17T12:00:00.000Z"),
  findActiveAssociationByClientId: findLinked(),
  fetchUpcomingClasses: async () => ({
    ok: true,
    classes: [{ classId: 603, startAt: "2026-09-12T17:00:00.000Z", isCancelled: false, lastModifiedAt: "2026-08-16T00:00:00.000Z" }],
  }),
  fetchClassVisits: async () => ({
    ok: true,
    visits: [
      {
        classRosterBookingId: 9401,
        classId: 603,
        clientId: CLIENT,
        classStartAt: "2026-09-12T17:00:00.000Z",
        lastModifiedAt: "2026-08-16T00:00:00.000Z",
        cancelled: false,
        status: "booked",
      },
    ],
  }),
  fetchClassWaitlist: async () => ({ ok: true, available: true, entries: [] }),
});
const driftR = await driftStore.getReminder(USER, SITE, 9401);
check(
  "Reconciliation repairs class start-time drift",
  driftR?.status === "scheduled" &&
    driftR?.classStartAt === "2026-09-12T17:00:00.000Z" &&
    driftR?.scheduledFor === scheduledForFromClassStart("2026-09-12T17:00:00.000Z"),
);

const schedStore = createMemoryNotificationStore();
const schedRes = await post(
  schedStore,
  envelope("classSchedule.created", "msg-sched", { classScheduleId: 12, classId: CLASS_ID }, "2026-08-17T04:00:00.000Z"),
);
check(
  "Existing schedule events still ACK without roster state",
  schedRes.statusCode === 200 &&
    !(await schedStore.getBooking(SITE, BOOKING_ID)) &&
    (await schedStore.listCandidates()).length === 0,
);

// ── IDENTITY ───────────────────────────────────────────────────────────────

const iStore = createMemoryNotificationStore();
let emailLookup = 0;
const findNoEmail = async (siteId, clientId, extra) => {
  if (extra != null) emailLookup += 1;
  if (Number(clientId) === CLIENT) return { amare_user_id: USER };
  return null;
};
await ingest(
  iStore,
  envelope(
    "classRosterBooking.created",
    "msg-i1",
    { classRosterBookingId: 9500, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START, email: "owner@example.com" },
    "2026-08-17T06:00:00.000Z",
  ),
  findNoEmail,
);
const i1 = await iStore.getBooking(SITE, 9500);
const i1c = await iStore.listCandidates({ kind: "booking_created" });
check("I1 webhook clientId maps to linked AMARÉ user → candidate allowed", i1?.amareUserId === USER && i1c.length === 1 && i1c[0].amareUserId === USER);

const i2store = createMemoryNotificationStore();
await ingest(
  i2store,
  envelope(
    "classRosterBooking.created",
    "msg-i2",
    { classRosterBookingId: 9501, classId: CLASS_ID, clientId: 4242, classStartDateTime: START, email: "stranger@example.com" },
    "2026-08-17T06:00:00.000Z",
  ),
  findNone(),
);
const i2 = await i2store.getBooking(SITE, 9501);
const i2c = await i2store.listCandidates();
const i2r = await i2store.getReminder(USER, SITE, 9501);
check("I2 no association → store integrity, no AMARÉ recipient", i2?.status === "booked" && i2?.amareUserId == null && i2c.length === 0 && !i2r);

const libSrc = await readFile(path.join(root, "netlify/functions/amare-notification-lib.mjs"), "utf8");
const recSrc = await readFile(path.join(root, "netlify/functions/amare-notification-reconcile.mjs"), "utf8");
check(
  "I3 never use email to resolve ownership",
  emailLookup === 0 &&
    !/find.*email|email.*fallback|client\/clients/i.test(libSrc) &&
    !/find.*email|email.*fallback|member\/summary/i.test(recSrc),
);

// ── PREFERENCES / INSTALLATIONS ────────────────────────────────────────────

const pStore = createMemoryNotificationStore();
const prefs = await pStore.ensurePreferences(USER);
check(
  "P1 defaults transactional=true / marketing=false",
  prefs.class_booking_updates === true &&
    prefs.class_reminders === true &&
    prefs.waitlist_updates === true &&
    prefs.studio_news === false &&
    DEFAULT_PREFERENCES.studio_news === false,
);

const insA = await pStore.upsertInstallation({ installationId: "ins_a", amareUserId: USER, platform: "android" });
const insB = await pStore.upsertInstallation({ installationId: "ins_b", amareUserId: USER, platform: "ios" });
const listed = await pStore.listInstallations(USER);
check("P2 multiple installations supported", listed.length === 2 && insA.installationId !== insB.installationId && listed.every((r) => r.amareUserId === USER));

const other = "usr_N1OTHER000000000000002";
const switched = await pStore.reassignInstallation("ins_a", other);
const revoked = await pStore.revokeInstallation("ins_b");
const afterA = await pStore.listInstallations(USER);
const afterOther = await pStore.listInstallations(other);
check(
  "P3 account switch can detach old owner without touching the other device",
  switched?.amareUserId === other &&
    switched?.pushToken == null &&
    revoked?.revokedAt &&
    afterA.every((r) => r.installationId !== "ins_a") &&
    afterOther.length === 1 &&
    afterOther[0].installationId === "ins_a" &&
    afterOther[0].amareUserId === other,
);

// ── TRANSACTION KEY / CANDIDATES / GUARDRAILS ──────────────────────────────

const tkStore = createMemoryNotificationStore();
await ingest(
  tkStore,
  envelope(
    "classRosterBooking.created",
    "msg-tk",
    { classRosterBookingId: 9600, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: START },
    "2026-08-17T05:00:00.000Z",
    { transactionKey: "tk-amare-book-1" },
  ),
);
const tkB = await tkStore.getBooking(SITE, 9600);
const tkR = await tkStore.getReminder(USER, SITE, 9600);
const tkC = await tkStore.listCandidates({ kind: "booking_created" });
check(
  "Transaction-Key stored for later correlation; reminder still created",
  tkB?.transactionKey === "tk-amare-book-1" &&
    tkR?.status === "scheduled" &&
    tkC[0]?.transactionKey === "tk-amare-book-1" &&
    tkC[0]?.suppressPush === false,
);

const union = [...FUTURE_SUBSCRIPTION_EVENT_UNION];
const expectedUnion = [
  "class.updated",
  "classSchedule.created",
  "classSchedule.updated",
  "classSchedule.cancelled",
  "classDescription.updated",
  "classRosterBooking.created",
  "classRosterBookingStatus.updated",
  "classRosterBooking.cancelled",
  "classWaitlistRequest.created",
  "classWaitlistRequest.cancelled",
];
check("Future event union locked", union.join("|") === expectedUnion.join("|"));

const [pkg, bookSrc, cancelSrc, waitSrc, toml, envExample] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-cancel.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-waitlist-remove.mjs"), "utf8"),
  readFile(path.join(root, "netlify.toml"), "utf8"),
  readFile(path.join(root, ".env.example"), "utf8"),
]);
const webhookSrc = await readFile(path.join(root, "netlify/functions/mindbody-webhooks-schedule.mjs"), "utf8");
const n1Lib = await readFile(path.join(root, "netlify/functions/amare-notification-lib.mjs"), "utf8");
check("N1 webhook/process path does not import firebase-admin or send FCM", !/firebase-admin|messaging\(\)\.send/i.test(webhookSrc + n1Lib));
check("Book/cancel/waitlist do not send Transaction-Key (correlation only)", !/Transaction-Key/.test(bookSrc) && !/Transaction-Key/.test(cancelSrc) && !/Transaction-Key/.test(waitSrc));
check("No production cron for notification reconcile", !/amare-notification-reconcile/.test(toml));
check("No production feature-flag flip in .env.example", !/ENABLE_AMARE_PUSH=1|ENABLE_FCM=1/.test(envExample));

const kinds = (await store.listCandidates()).map((c) => c.kind);
check(
  "Candidate boundary only (no send)",
  kinds.every((k) =>
    [
      "booking_created",
      "booking_cancelled",
      "waitlist_joined",
      "waitlist_removed",
      "waitlist_promoted",
      "class_cancelled",
      "class_time_changed",
      "class_reminder_due",
    ].includes(k),
  ),
);

restoreEnv();

if (failed) {
  console.error(`\n${failed} N1 check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ notification N1 checks passed.");
