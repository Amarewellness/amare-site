/**
 * Class reminder worker + QA lead override.
 * Run: npm run test:amare-notifications-reminder
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryNotificationStore } from "../netlify/functions/amare-notification-store.mjs";
import {
  DAILY_REMINDER_WINDOW_HOURS,
  ingestAndProcessWebhook,
  qaReminderLeadMinutes,
  qaReminderUserId,
  reminderLeadMinutes,
  reminderLeadMinutesForUser,
  reminderPlanFromClassStart,
  scheduledForFromClassStart,
} from "../netlify/functions/amare-notification-lib.mjs";
import { formatClassWhen, renderPushCopy } from "../netlify/functions/amare-notification-copy.mjs";
import { lambdaHandler } from "../netlify/functions/amare-notification-reminder-scan.mjs";
import {
  processDueReminder,
  reminderSendAllowedForUser,
  runClassReminderScan,
} from "../netlify/functions/amare-notification-reminder-send.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const SITE = 5744068;
const QA_USER = "usr_WHB3H2RMWAMGC7S8YYTXTG";
const QA_CLIENT = 100002726;
const OTHER_USER = "usr_OTHERREMINDER00000000001";
const OTHER_CLIENT = 100009999;
const CLASS_ID = 88001;
const START_FAR = "2026-09-15T18:00:00.000Z";

const prevEnv = { ...process.env };
process.env.ENABLE_AMARE_PUSH = "0";
process.env.ENABLE_AMARE_PUSH_TEST = "1";
process.env.AMARE_CLASS_REMINDER_LEAD_MINUTES = "1440";
process.env.AMARE_PUSH_QA_REMINDER_USER_ID = QA_USER;
process.env.AMARE_PUSH_QA_REMINDER_LEAD_MINUTES = "10";
delete process.env.NETLIFY;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;

function restoreEnv() {
  for (const key of [
    "ENABLE_AMARE_PUSH",
    "ENABLE_AMARE_PUSH_TEST",
    "AMARE_CLASS_REMINDER_LEAD_MINUTES",
    "AMARE_PUSH_QA_REMINDER_USER_ID",
    "AMARE_PUSH_QA_REMINDER_LEAD_MINUTES",
    "NETLIFY",
    "AWS_LAMBDA_FUNCTION_NAME",
  ]) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
}

function findFor(userId, clientId) {
  return async (siteId, id) => {
    if (Number(siteId) !== SITE || Number(id) !== clientId) return null;
    return { amare_user_id: userId, client_id: clientId };
  };
}

function envelope(eventId, messageId, eventData, originationAt) {
  return {
    messageId,
    eventId,
    eventInstanceOriginationDateTime: originationAt,
    eventData: { siteId: SITE, ...eventData },
  };
}

async function book(store, { userId, clientId, bookingId, classId = CLASS_ID, startAt, messageId }) {
  return ingestAndProcessWebhook(
    store,
    envelope(
      "classRosterBooking.created",
      messageId,
      {
        classRosterBookingId: bookingId,
        classId,
        clientId,
        classStartDateTime: startAt,
        bookingOriginatedFromWaitlist: false,
      },
      "2026-08-21T12:00:00.000Z",
    ),
    { findActiveAssociationByClientId: findFor(userId, clientId) },
  );
}

check("Production reminder lead stays 1440", reminderLeadMinutes() === 1440);
check("QA reminder lead is 10 via env", qaReminderUserId() === QA_USER && qaReminderLeadMinutes() === 10);
check("QA user uses 10-minute lead", reminderLeadMinutesForUser(QA_USER) === 10);
check("Normal user still uses 1440", reminderLeadMinutesForUser(OTHER_USER) === 1440);

const copy = renderPushCopy("class_reminder", { className: "Reformer", classStartAt: START_FAR });
check(
  "Reminder copy",
  copy.title === "Class tomorrow ✨" && copy.body === `Reformer · ${formatClassWhen(START_FAR)}`,
);

const store = createMemoryNotificationStore();
await book(store, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91001,
  startAt: START_FAR,
  messageId: "msg-rem-qa-far",
});
const qaFar = await store.getReminder(QA_USER, SITE, 91001);
check(
  "QA far booking uses 10-minute scheduledFor",
  qaFar?.status === "scheduled" && qaFar?.scheduledFor === scheduledForFromClassStart(START_FAR, 10),
);

await book(store, {
  userId: OTHER_USER,
  clientId: OTHER_CLIENT,
  bookingId: 91002,
  startAt: START_FAR,
  messageId: "msg-rem-other-far",
});
const otherFar = await store.getReminder(OTHER_USER, SITE, 91002);
check(
  "Normal user booking uses 1440-minute scheduledFor",
  otherFar?.status === "scheduled" && otherFar?.scheduledFor === scheduledForFromClassStart(START_FAR, 1440),
);

const soonStart = new Date(Date.now() + 20 * 60 * 1000).toISOString();
const retroPlan = reminderPlanFromClassStart(soonStart, Date.now(), 1440);
check(
  "Short-notice future class stays scheduled even when 24h lead is retroactive",
  retroPlan.status === "scheduled",
);

const qaSoonPlan = reminderPlanFromClassStart(soonStart, Date.now(), 10);
check("QA 10-minute reminder still schedules when start is 20 minutes away", qaSoonPlan.status === "scheduled");

const tooSoon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
check(
  "Short-notice QA class within minutes stays scheduled",
  reminderPlanFromClassStart(tooSoon, Date.now(), 10).status === "scheduled",
);

const pastStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
check("Past class is suppressed at ingest plan time", reminderPlanFromClassStart(pastStart, Date.now(), 10).status === "suppressed");

await book(store, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91003,
  classId: 88003,
  startAt: soonStart,
  messageId: "msg-rem-qa-soon",
});
const qaSoon = await store.getReminder(QA_USER, SITE, 91003);
check("QA 20-minute class creates a scheduled 10-minute reminder", qaSoon?.status === "scheduled");

await store.ensurePreferences(QA_USER);
await store.upsertInstallation({
  installationId: "ins_qa_rem",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "qa-reminder-token",
  permissionState: "granted",
  revokedAt: null,
});
await store.upsertBooking({
  ...(await store.getBooking(SITE, 91003)),
  className: "Reformer",
});

const sent = [];
const outsideWindowStart = new Date(Date.now() + (DAILY_REMINDER_WINDOW_HOURS + 2) * 60 * 60 * 1000).toISOString();
await book(store, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91007,
  classId: 88007,
  startAt: outsideWindowStart,
  messageId: "msg-rem-outside-window",
});
const outsideListed = await store.listDueReminders({
  amareUserId: QA_USER,
  now: new Date().toISOString(),
});
check(
  "Class outside 36h window is not listed for daily batch",
  !outsideListed.some((r) => r.classRosterBookingId === 91007),
);

const first = await runClassReminderScan({
  store,
  now: new Date(Date.parse(soonStart) - 5 * 60 * 1000).toISOString(),
  send: async (token, message) => sent.push({ token, message }),
  fetchClassName: async () => ({ className: "Reformer" }),
});
const afterFirst = await store.getReminder(QA_USER, SITE, 91003);
const candidates = await store.listCandidates({ kind: "class_reminder_due" });
check(
  "Due worker claims and sends exactly once",
  first.sent === 1 &&
    sent.length === 1 &&
    sent[0].token === "qa-reminder-token" &&
    sent[0].message.title === "Class tomorrow ✨" &&
    sent[0].message.kind === "class_reminder" &&
    sent[0].message.path === "/my-classes" &&
    String(sent[0].message.classId) === "88003" &&
    afterFirst?.status === "sent" &&
    Boolean(afterFirst?.sentAt) &&
    candidates.length === 1 &&
    candidates[0].deliveryStatus === "delivered",
);

const second = await runClassReminderScan({
  store,
  now: new Date(Date.parse(qaSoon.scheduledFor) + 120000).toISOString(),
  send: async (token, message) => sent.push({ token, message }),
  fetchClassName: async () => ({ className: "Reformer" }),
});
check("Second worker execution does not resend", second.sent === 0 && sent.length === 1 && (await store.getReminder(QA_USER, SITE, 91003))?.status === "sent");

const claimNow = "2026-09-15T17:55:00.000Z";
const claimA = await store.claimReminder(qaFar.reminderId, claimNow);
const claimB = await store.claimReminder(qaFar.reminderId, claimNow);
check("Reminder claim is atomic", Boolean(claimA) && claimA.status === "due" && claimB == null);

check("Normal-user reminder is not send-eligible during QA", reminderSendAllowedForUser(OTHER_USER).ok === false);

await store.ensurePreferences(OTHER_USER);
await store.upsertInstallation({
  installationId: "ins_other_rem",
  amareUserId: OTHER_USER,
  platform: "android",
  pushToken: "other-reminder-token",
  permissionState: "granted",
  revokedAt: null,
});
const otherDue = await store.upsertReminder({
  ...otherFar,
  scheduledFor: new Date(Date.now() - 60 * 1000).toISOString(),
  status: "scheduled",
});
const otherScan = await runClassReminderScan({
  store,
  now: new Date().toISOString(),
  send: async (token, message) => sent.push({ token, message }),
});
const otherAfter = await store.getReminder(OTHER_USER, SITE, 91002);
check(
  "Worker does not send or claim a normal-user reminder while ENABLE_AMARE_PUSH=0",
  otherScan.sent === 0 &&
    sent.length === 1 &&
    otherAfter?.status === "scheduled" &&
    otherAfter?.reminderId === otherDue.reminderId,
);

const cancelStore = createMemoryNotificationStore();
await book(cancelStore, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91004,
  classId: 88004,
  startAt: soonStart,
  messageId: "msg-rem-cancel",
});
await ingestAndProcessWebhook(
  cancelStore,
  envelope(
    "classRosterBooking.cancelled",
    "msg-rem-cancel-2",
    { classRosterBookingId: 91004, classId: 88004, clientId: QA_CLIENT, classStartDateTime: soonStart },
    "2026-08-21T12:05:00.000Z",
  ),
  { findActiveAssociationByClientId: findFor(QA_USER, QA_CLIENT) },
);
const cancelledReminder = await cancelStore.getReminder(QA_USER, SITE, 91004);
await cancelStore.ensurePreferences(QA_USER);
await cancelStore.upsertInstallation({
  installationId: "ins_cancel",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "cancel-token",
  permissionState: "granted",
  revokedAt: null,
});
const cancelSends = [];
const cancelScan = await runClassReminderScan({
  store: cancelStore,
  now: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  send: async (token, message) => cancelSends.push({ token, message }),
});
check(
  "Cancelled booking reminder is not sent",
  cancelledReminder?.status === "cancelled" && cancelScan.sent === 0 && cancelSends.length === 0,
);

const classCancelStore = createMemoryNotificationStore();
await book(classCancelStore, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91005,
  classId: 88005,
  startAt: soonStart,
  messageId: "msg-rem-class-cancel",
});
await ingestAndProcessWebhook(
  classCancelStore,
  envelope("class.updated", "msg-rem-class-cancel-2", { classId: 88005, startDateTime: soonStart, isCancelled: true }, "2026-08-21T12:06:00.000Z"),
  { findActiveAssociationByClientId: findFor(QA_USER, QA_CLIENT) },
);
const classCancelledReminder = await classCancelStore.getReminder(QA_USER, SITE, 91005);
check("Class cancelled cancels pending reminders", classCancelledReminder?.status === "cancelled");

const timeStore = createMemoryNotificationStore();
const laterStart = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
await book(timeStore, {
  userId: QA_USER,
  clientId: QA_CLIENT,
  bookingId: 91006,
  classId: 88006,
  startAt: laterStart,
  messageId: "msg-rem-time",
});
const beforeChange = await timeStore.getReminder(QA_USER, SITE, 91006);
const newStart = new Date(Date.now() + 3 * 60 * 1000).toISOString();
await ingestAndProcessWebhook(
  timeStore,
  envelope("class.updated", "msg-rem-time-2", { classId: 88006, startDateTime: newStart, isCancelled: false }, "2026-08-21T12:07:00.000Z"),
  { findActiveAssociationByClientId: findFor(QA_USER, QA_CLIENT) },
);
const afterChange = await timeStore.getReminder(QA_USER, SITE, 91006);
check(
  "Time change recomputes classStartAt and keeps future class scheduled",
  beforeChange?.status === "scheduled" &&
    afterChange?.classStartAt === newStart &&
    afterChange?.scheduledFor === scheduledForFromClassStart(newStart, 10) &&
    afterChange?.status === "scheduled",
);

const pastStore = createMemoryNotificationStore();
const pastClassStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
await pastStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88010,
  classRosterBookingId: 91010,
  classStartAt: pastClassStart,
  scheduledFor: pastClassStart,
  status: "scheduled",
  lastEventOriginationAt: new Date().toISOString(),
});
await pastStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 91010,
  amareUserId: QA_USER,
  clientId: QA_CLIENT,
  classId: 88010,
  status: "booked",
  classStartAt: pastClassStart,
  lastEventOriginationAt: new Date().toISOString(),
});
await pastStore.ensurePreferences(QA_USER);
await pastStore.upsertInstallation({
  installationId: "ins_past",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "past-token",
  permissionState: "granted",
  revokedAt: null,
});
const pastScan = await runClassReminderScan({
  store: pastStore,
  now: new Date().toISOString(),
  send: async () => {},
});
const pastRem = await pastStore.getReminder(QA_USER, SITE, 91010);
check(
  "Past class reminder is suppressed and never sent",
  pastRem?.status === "suppressed" && pastScan.sent === 0 && (pastScan.expired || 0) >= 1,
);

const noInstStore = createMemoryNotificationStore();
const futureNoInstStart = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
await noInstStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88011,
  classRosterBookingId: 91011,
  classStartAt: futureNoInstStart,
  scheduledFor: futureNoInstStart,
  status: "scheduled",
  lastEventOriginationAt: new Date().toISOString(),
});
const noInstListed = await noInstStore.listDueReminders({
  amareUserId: QA_USER,
  now: new Date().toISOString(),
});
check("Future class without active installation is not listed", noInstListed.length === 0);

const raceStore = createMemoryNotificationStore();
const raceStart = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
await raceStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88012,
  classRosterBookingId: 91012,
  classStartAt: raceStart,
  scheduledFor: raceStart,
  status: "scheduled",
  lastEventOriginationAt: new Date().toISOString(),
});
await raceStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 91012,
  amareUserId: QA_USER,
  clientId: QA_CLIENT,
  classId: 88012,
  status: "booked",
  classStartAt: raceStart,
  lastEventOriginationAt: new Date().toISOString(),
});
await raceStore.ensurePreferences(QA_USER);
await raceStore.upsertInstallation({
  installationId: "ins_race",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "race-token",
  permissionState: "granted",
  revokedAt: null,
});
const raceNow = new Date().toISOString();
const raceListed = await raceStore.listDueReminders({ amareUserId: QA_USER, now: raceNow });
await raceStore.revokeInstallation("ins_race");
const raceResult = await processDueReminder(raceListed[0], {
  store: raceStore,
  now: raceNow,
  send: async () => {},
});
const raceRem = await raceStore.getReminder(QA_USER, SITE, 91012);
check(
  "Install race returns future reminder to scheduled",
  raceResult.skipped === "no_owned_active_installation" &&
    raceRem?.status === "scheduled" &&
    !raceRem?.claimedAt,
);

const pastRaceStore = createMemoryNotificationStore();
const pastRaceStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
await pastRaceStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88017,
  classRosterBookingId: 91017,
  classStartAt: pastRaceStart,
  scheduledFor: pastRaceStart,
  status: "scheduled",
  lastEventOriginationAt: new Date().toISOString(),
});
await pastRaceStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 91017,
  amareUserId: QA_USER,
  clientId: QA_CLIENT,
  classId: 88017,
  status: "booked",
  classStartAt: pastRaceStart,
  lastEventOriginationAt: new Date().toISOString(),
});
await pastRaceStore.ensurePreferences(QA_USER);
await pastRaceStore.upsertInstallation({
  installationId: "ins_past_race",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "past-race-token",
  permissionState: "granted",
  revokedAt: null,
});
const pastRaceNow = new Date().toISOString();
const pastRaceRow = await pastRaceStore.getReminder(QA_USER, SITE, 91017);
await pastRaceStore.revokeInstallation("ins_past_race");
const pastRaceResult = await processDueReminder(pastRaceRow, {
  store: pastRaceStore,
  now: pastRaceNow,
  send: async () => {},
});
const pastRaceRem = await pastRaceStore.getReminder(QA_USER, SITE, 91017);
check(
  "Install race on past class becomes suppressed not stuck in due",
  pastRaceResult.skipped === "expired_past_class" &&
    pastRaceRem?.status === "suppressed" &&
    pastRaceRem?.status !== "due",
);

const lateInstallStore = createMemoryNotificationStore();
const lateStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
await lateInstallStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88013,
  classRosterBookingId: 91013,
  classStartAt: lateStart,
  scheduledFor: lateStart,
  status: "scheduled",
  lastEventOriginationAt: new Date().toISOString(),
});
await lateInstallStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 91013,
  amareUserId: QA_USER,
  clientId: QA_CLIENT,
  classId: 88013,
  status: "booked",
  classStartAt: lateStart,
  lastEventOriginationAt: new Date().toISOString(),
});
await lateInstallStore.ensurePreferences(QA_USER);
const lateBefore = await lateInstallStore.listDueReminders({
  amareUserId: QA_USER,
  now: new Date().toISOString(),
});
await lateInstallStore.upsertInstallation({
  installationId: "ins_late",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "late-token",
  permissionState: "granted",
  revokedAt: null,
});
const lateAfter = await lateInstallStore.listDueReminders({
  amareUserId: QA_USER,
  now: new Date().toISOString(),
});
check(
  "User installing later becomes eligible on next daily batch",
  lateBefore.length === 0 && lateAfter.length === 1 && lateAfter[0].classRosterBookingId === 91013,
);

const boundaryStore = createMemoryNotificationStore();
const boundaryNow = new Date();
const boundaryNowIso = boundaryNow.toISOString();
const insideBoundary = new Date(boundaryNow.getTime() + DAILY_REMINDER_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
const outsideBoundary = new Date(
  boundaryNow.getTime() + DAILY_REMINDER_WINDOW_HOURS * 60 * 60 * 1000 + 60 * 1000,
).toISOString();
await boundaryStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88014,
  classRosterBookingId: 91014,
  classStartAt: insideBoundary,
  scheduledFor: insideBoundary,
  status: "scheduled",
  lastEventOriginationAt: boundaryNowIso,
});
await boundaryStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88015,
  classRosterBookingId: 91015,
  classStartAt: outsideBoundary,
  scheduledFor: outsideBoundary,
  status: "scheduled",
  lastEventOriginationAt: boundaryNowIso,
});
await boundaryStore.upsertInstallation({
  installationId: "ins_boundary",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "boundary-token",
  permissionState: "granted",
  revokedAt: null,
});
const boundaryListed = await boundaryStore.listDueReminders({
  amareUserId: QA_USER,
  now: boundaryNowIso,
});
check(
  "36-hour boundary includes inside and excludes outside",
  boundaryListed.some((r) => r.classRosterBookingId === 91014) &&
    !boundaryListed.some((r) => r.classRosterBookingId === 91015),
);

const starveStore = createMemoryNotificationStore();
const starveNow = new Date();
const starveNowIso = starveNow.toISOString();
for (let i = 0; i < 60; i += 1) {
  const staleStart = new Date(starveNow.getTime() - (i + 1) * 60 * 60 * 1000).toISOString();
  await starveStore.upsertReminder({
    reminderId: `rem_stale_${String(i).padStart(2, "0")}`,
    amareUserId: `usr_stale_${String(i).padStart(2, "0")}`,
    siteId: SITE,
    classId: 89000 + i,
    classRosterBookingId: 93000 + i,
    classStartAt: staleStart,
    scheduledFor: staleStart,
    status: "scheduled",
    lastEventOriginationAt: starveNowIso,
  });
}
const goodStart = new Date(starveNow.getTime() + 2 * 60 * 60 * 1000).toISOString();
await starveStore.upsertReminder({
  amareUserId: QA_USER,
  siteId: SITE,
  classId: 88016,
  classRosterBookingId: 91016,
  classStartAt: goodStart,
  scheduledFor: goodStart,
  status: "scheduled",
  lastEventOriginationAt: starveNowIso,
});
await starveStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 91016,
  amareUserId: QA_USER,
  clientId: QA_CLIENT,
  classId: 88016,
  status: "booked",
  classStartAt: goodStart,
  lastEventOriginationAt: starveNowIso,
});
await starveStore.ensurePreferences(QA_USER);
await starveStore.upsertInstallation({
  installationId: "ins_starve",
  amareUserId: QA_USER,
  platform: "android",
  pushToken: "starve-token",
  permissionState: "granted",
  revokedAt: null,
});
const starveListed = await starveStore.listDueReminders({
  amareUserId: QA_USER,
  now: starveNowIso,
});
check(
  "Starvation regression: valid sendable reminder is listed despite stale backlog",
  starveListed.length === 1 && starveListed[0].classRosterBookingId === 91016,
);

const http = await lambdaHandler({ httpMethod: "POST", headers: {}, body: "" });
check("Reminder scan HTTP is closed", http.statusCode === 404);

const [toml, scanSrc, sendSrc] = await Promise.all([
  readFile(path.join(root, "netlify.toml"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-notification-reminder-scan.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-notification-reminder-send.mjs"), "utf8"),
]);
check(
  "Worker cadence is once daily at 13:00 UTC",
  /\[functions\."amare-notification-reminder-scan"\][\s\S]*?schedule = "0 13 \* \* \*"/.test(toml),
);
check("Worker does not export a named handler", !/export (?:async function handler|const handler)/.test(scanSrc));
check("Worker send path uses the Cloud Run relay", sendSrc.includes("sendViaPushRelay") && !/firebase-admin|messaging\(\)\.send/.test(sendSrc));

restoreEnv();
if (failed) {
  console.error(`\n${failed} reminder check(s) failed`);
  process.exit(1);
}
console.log("\nAll reminder checks passed.");
