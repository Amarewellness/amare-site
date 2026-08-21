/**
 * Push V1 foundation: official Base64 HMAC, raw-body integrity, dedupe,
 * waitlist exclusivity, class-cancel recipients, reminder state, Push OFF.
 * Does not send FCM. Does not PATCH Mindbody. Does not flip ENABLE_AMARE_PUSH.
 *
 * Run: npm run test:amare-webhook-foundation
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryNotificationStore } from "../netlify/functions/amare-notification-store.mjs";
import {
  reminderPlanFromClassStart,
  scheduledForFromClassStart,
} from "../netlify/functions/amare-notification-lib.mjs";
import { fcmProductionSendingEnabled } from "../netlify/functions/amare-notification-send.mjs";
import {
  handleMindbodyScheduleWebhook,
  mindbodyWebhookSignatureHeader,
  verifyMindbodyWebhookSignature,
} from "../netlify/functions/mindbody-webhooks-schedule.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "foundation-hmac-secret";
const SITE = 321;
const USER = "usr_FOUNDATION00000000000001";
const OTHER = "usr_FOUNDATION00000000000002";
const CLIENT = 2002;
const CLASS_ID = 880;
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const prev = { ...process.env };
process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY = SECRET;
delete process.env.MINDBODY_WEBHOOK_SKIP_VERIFY;
process.env.MINDBODY_WEBHOOK_DEDUPE_BLOBS = "0";
process.env.MINDBODY_SITE_ID = String(SITE);
process.env.AMARE_CLASS_REMINDER_LEAD_MINUTES = "1440";
process.env.ENABLE_AMARE_PUSH = "0";
delete process.env.NETLIFY;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;

function restore() {
  for (const key of [
    "MINDBODY_WEBHOOK_SIGNATURE_KEY",
    "MINDBODY_WEBHOOK_SKIP_VERIFY",
    "MINDBODY_WEBHOOK_DEDUPE_BLOBS",
    "MINDBODY_SITE_ID",
    "AMARE_CLASS_REMINDER_LEAD_MINUTES",
    "ENABLE_AMARE_PUSH",
    "NETLIFY",
    "AWS_LAMBDA_FUNCTION_NAME",
  ]) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
}

function envelope(eventId, messageId, eventData, originationAt = "2026-08-21T12:00:00.000Z") {
  return {
    messageId,
    eventId,
    eventInstanceOriginationDateTime: originationAt,
    eventData: { siteId: SITE, ...eventData },
  };
}

function signed(payload, mutateBody) {
  let body = JSON.stringify(payload);
  const header = mindbodyWebhookSignatureHeader(body, SECRET);
  if (mutateBody) body = `${body} `;
  return {
    httpMethod: "POST",
    headers: { "X-Mindbody-Signature": header },
    body,
  };
}

function findLinked() {
  return async (_site, clientId) =>
    Number(clientId) === CLIENT ? { amare_user_id: USER, client_id: CLIENT } : null;
}

async function post(store, payload, extra = {}) {
  return handleMindbodyScheduleWebhook(signed(payload, extra.mutateBody), {
    notificationStore: store,
    findActiveAssociationByClientId: extra.find || findLinked(),
    expectedSiteId: SITE,
  });
}

const hexRejected = verifyMindbodyWebhookSignature(
  '{"a":1}',
  `sha256=${(await import("node:crypto")).createHmac("sha256", SECRET).update('{"a":1}', "utf8").digest("hex")}`,
  SECRET,
);
check("Hex HMAC is not accepted", hexRejected === false);

const raw = '{"eventId":"class.updated","messageId":"sig-ok"}';
check(
  "Valid Base64 HMAC is accepted",
  verifyMindbodyWebhookSignature(raw, mindbodyWebhookSignatureHeader(raw, SECRET), SECRET) === true,
);
check("Missing signature is rejected", verifyMindbodyWebhookSignature(raw, "", SECRET) === false);
check(
  "Invalid signature is rejected",
  verifyMindbodyWebhookSignature(raw, "sha256=not-a-valid-signature==", SECRET) === false,
);

const store = createMemoryNotificationStore();
const start = "2026-09-15T18:00:00.000Z";
const created = envelope(
  "classRosterBooking.created",
  "fnd-book-1",
  {
    classRosterBookingId: 501,
    classId: CLASS_ID,
    clientId: CLIENT,
    classStartDateTime: start,
    bookingOriginatedFromWaitlist: false,
    clientPassId: "pass-9",
    itemId: 100134,
    itemName: "Monthly 8",
  },
);

const t0 = Date.now();
const ok1 = await post(store, created);
const latencyMs = Date.now() - t0;
const ok2 = await post(store, created);
const booking = await store.getBooking(SITE, 501);
const reminder = await store.getReminder(USER, SITE, 501);
const booked = await store.listCandidates({ kind: "booking_created" });
const promoted = await store.listCandidates({ kind: "waitlist_promoted" });
check("Valid signed POST → 2xx", ok1.statusCode === 200);
check("POST latency under 10s in-process", latencyMs < 10000, `ms=${latencyMs}`);
check("Duplicate signed POST → 2xx", ok2.statusCode === 200 && JSON.parse(ok2.body).duplicate === true);
check("Dedupe keeps one booking/reminder/candidate", booked.length === 1 && promoted.length === 0 && reminder?.status === "scheduled");
check(
  "Roster created persists pass/item diagnostics, not as class name",
  booking?.clientPassId === "pass-9" && booking?.itemId === 100134 && booking?.itemName === "Monthly 8" && booking?.className == null,
);

const missing = await handleMindbodyScheduleWebhook(
  { httpMethod: "POST", headers: {}, body: JSON.stringify(created) },
  { notificationStore: store, findActiveAssociationByClientId: findLinked(), expectedSiteId: SITE },
);
check("Missing signature header → 401", missing.statusCode === 401);

const bad = await handleMindbodyScheduleWebhook(
  { httpMethod: "POST", headers: { "X-Mindbody-Signature": "sha256=deadbeef" }, body: JSON.stringify(created) },
  { notificationStore: store, findActiveAssociationByClientId: findLinked(), expectedSiteId: SITE },
);
check("Invalid signature → 401", bad.statusCode === 401);

const mutated = await post(store, envelope("classRosterBooking.created", "fnd-mut", { classRosterBookingId: 502, classId: CLASS_ID, clientId: CLIENT, classStartDateTime: start }), {
  mutateBody: true,
});
check("Body changed by one byte → 401", mutated.statusCode === 401 && !(await store.getBooking(SITE, 502)));

const promoStore = createMemoryNotificationStore();
await post(
  promoStore,
  envelope("classWaitlistRequest.created", "fnd-wl", {
    waitlistEntryId: 77,
    classId: CLASS_ID,
    clientId: CLIENT,
    classStartDateTime: start,
  }),
);
await post(
  promoStore,
  envelope("classRosterBooking.created", "fnd-promo", {
    classRosterBookingId: 601,
    classId: CLASS_ID,
    clientId: CLIENT,
    classStartDateTime: start,
    bookingOriginatedFromWaitlist: true,
  }),
);
const promoBooked = await promoStore.listCandidates({ kind: "booking_created" });
const promoIn = await promoStore.listCandidates({ kind: "waitlist_promoted" });
const promoRem = await promoStore.getReminder(USER, SITE, 601);
check("Waitlist promotion emits only waitlist_promoted", promoIn.length === 1 && promoBooked.length === 0);
check("Waitlist promotion >24h schedules a reminder", promoRem?.status === "scheduled");

const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const lateStore = createMemoryNotificationStore();
await post(
  lateStore,
  envelope("classRosterBooking.created", "fnd-late", {
    classRosterBookingId: 701,
    classId: CLASS_ID,
    clientId: CLIENT,
    classStartDateTime: soon,
    bookingOriginatedFromWaitlist: true,
  }),
);
const lateRem = await lateStore.getReminder(USER, SITE, 701);
check("Promotion inside 24h suppresses retroactive reminder", lateRem?.status === "suppressed");
check("Reminder plan helper matches 24h lead", reminderPlanFromClassStart(start).scheduledFor === scheduledForFromClassStart(start));

await post(
  store,
  envelope(
    "classRosterBooking.cancelled",
    "fnd-cancel",
    { classRosterBookingId: 501, classId: CLASS_ID, clientId: CLIENT },
    "2026-08-21T13:00:00.000Z",
  ),
);
const afterCancel = await store.getReminder(USER, SITE, 501);
const cancelCands = await store.listCandidates({ kind: "booking_cancelled" });
await post(
  store,
  envelope(
    "classRosterBookingStatus.updated",
    "fnd-cancel-2",
    {
      classRosterBookingId: 501,
      classId: CLASS_ID,
      clientId: CLIENT,
      signedInStatus: "LateCancelled",
    },
    "2026-08-21T13:05:00.000Z",
  ),
);
const cancelCands2 = await store.listCandidates({ kind: "booking_cancelled" });
check("Booking cancel cancels the reminder", afterCancel?.status === "cancelled");
check("Cancel candidate emitted once", cancelCands.length === 1 && cancelCands2.length === 1);

const classStore = createMemoryNotificationStore();
await classStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 801,
  classId: CLASS_ID,
  clientId: CLIENT,
  amareUserId: USER,
  classStartAt: start,
  status: "booked",
  originatedFromWaitlist: false,
  lastEventOriginationAt: "2026-08-21T10:00:00.000Z",
});
await classStore.upsertBooking({
  siteId: SITE,
  classRosterBookingId: 802,
  classId: CLASS_ID,
  clientId: 9999,
  amareUserId: OTHER,
  classStartAt: start,
  status: "cancelled",
  originatedFromWaitlist: false,
  lastEventOriginationAt: "2026-08-21T10:00:00.000Z",
});
await post(
  classStore,
  envelope("class.updated", "fnd-class-cancel", { classId: CLASS_ID, startDateTime: start, isCancelled: true }),
);
const classCands = await classStore.listCandidates({ kind: "class_cancelled" });
check(
  "Class cancel notifies only active booked users",
  classCands.length === 1 && classCands[0].amareUserId === USER,
);

await post(
  store,
  envelope("class.updated", "fnd-time", { classId: CLASS_ID, startDateTime: "2026-09-15T20:00:00.000Z", isCancelled: false }, "2026-08-21T15:00:00.000Z"),
);
const moved = await store.getReminder(USER, SITE, 501);
check("Cancelled reminder is not rescheduled after a later time change", moved?.status === "cancelled");

const timeStore = createMemoryNotificationStore();
await post(
  timeStore,
  envelope("classRosterBooking.created", "fnd-time-b", {
    classRosterBookingId: 901,
    classId: 990,
    clientId: CLIENT,
    classStartDateTime: start,
  }),
);
await post(
  timeStore,
  envelope("class.updated", "fnd-time-u", { classId: 990, startDateTime: "2026-09-15T21:00:00.000Z", isCancelled: false }, "2026-08-21T16:00:00.000Z"),
);
const rescheduled = await timeStore.getReminder(USER, SITE, 901);
check(
  "Class time change reschedules a live reminder",
  rescheduled?.status === "scheduled" && rescheduled.classStartAt === "2026-09-15T21:00:00.000Z",
);

check("FCM production send stays off", fcmProductionSendingEnabled() === false);

const [webhookSrc, envExample, envProd, controllerSrc, arrivalSrc, deferred] = await Promise.all([
  readFile(path.join(root, "netlify/functions/mindbody-webhooks-schedule.mjs"), "utf8"),
  readFile(path.join(root, ".env.example"), "utf8"),
  readFile(path.join(root, "amare-app/.env.production"), "utf8"),
  readFile(path.join(root, "amare-app/src/push/PushController.tsx"), "utf8"),
  readFile(path.join(root, "amare-app/src/push/push-arrival.ts"), "utf8"),
  readFile(path.join(root, "netlify/database/deferred/20260817193000_amare_notifications.sql"), "utf8"),
]);
check("Webhook uses withLambda default export", webhookSrc.includes("export default withLambda(lambdaHandler)"));
check("Webhook does not fire-and-forget via waitUntil", !/waitUntil/.test(webhookSrc) && !/processAsync/.test(webhookSrc));
check("ENABLE_AMARE_PUSH stays 0", /ENABLE_AMARE_PUSH=0/.test(envExample) && !/ENABLE_AMARE_PUSH=1/.test(envExample));
check("Production Vite Push flag is 0", /VITE_ENABLE_AMARE_PUSH=0/.test(envProd));
check("PushController returns children when off", /isAmarePushClientEnabled\(\)/.test(controllerSrc) && /return children/.test(controllerSrc));
check("Arrival listeners gated off", /isAmarePushClientEnabled/.test(arrivalSrc));
check("Stale deferred SQL is not applied verbatim", /Superseded/.test(deferred) && !/CREATE TABLE amare_notification_inbox/.test(deferred));

restore();
if (failed) {
  console.error(`\n${failed} foundation check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ webhook foundation checks passed.");
