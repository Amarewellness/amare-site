/**
 * Staged production push rollout checks (webhook + reminder flags).
 * Run: npm run test:amare-push-production-rollout
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deliverProductionWebhookCandidate,
  deliverQaAutoCandidate,
  deliverWebhookCandidates,
  PRODUCTION_WEBHOOK_KINDS,
  QA_AUTO_PUSH_USER_ID,
} from "../netlify/functions/amare-notification-auto-deliver.mjs";
import {
  decideCandidateDelivery,
  fcmProductionRemindersEnabled,
  fcmProductionWebhooksEnabled,
} from "../netlify/functions/amare-notification-send.mjs";
import { DEFAULT_PREFERENCES, createMemoryNotificationStore } from "../netlify/functions/amare-notification-store.mjs";
import { reminderSendAllowedForUser, runClassReminderScan } from "../netlify/functions/amare-notification-reminder-send.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const OTHER_USER = "usr_OTHER00000000000000000001";
const BOUNDARY = "2026-08-21T20:00:00.000Z";
const PROD_BOUNDARY = "2026-08-25T00:00:00.000Z";

const prevEnv = { ...process.env };

function restoreEnv() {
  for (const key of [
    "ENABLE_AMARE_PUSH",
    "ENABLE_AMARE_PUSH_TEST",
    "ENABLE_AMARE_PUSH_WEBHOOKS",
    "ENABLE_AMARE_PUSH_REMINDERS",
    "AMARE_PUSH_QA_STARTED_AT",
    "AMARE_PUSH_WEBHOOKS_STARTED_AT",
  ]) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
}

function resetQaEnv() {
  process.env.ENABLE_AMARE_PUSH = "0";
  process.env.ENABLE_AMARE_PUSH_TEST = "1";
  delete process.env.ENABLE_AMARE_PUSH_WEBHOOKS;
  delete process.env.ENABLE_AMARE_PUSH_REMINDERS;
  process.env.AMARE_PUSH_QA_STARTED_AT = BOUNDARY;
  delete process.env.AMARE_PUSH_WEBHOOKS_STARTED_AT;
}

function resetProductionWebhookEnv() {
  process.env.ENABLE_AMARE_PUSH = "1";
  process.env.ENABLE_AMARE_PUSH_WEBHOOKS = "1";
  process.env.ENABLE_AMARE_PUSH_TEST = "1";
  delete process.env.ENABLE_AMARE_PUSH_REMINDERS;
  process.env.AMARE_PUSH_WEBHOOKS_STARTED_AT = PROD_BOUNDARY;
  process.env.AMARE_PUSH_QA_STARTED_AT = BOUNDARY;
}

async function seedInstall(store, userId, installationId, token) {
  await store.ensurePreferences(userId);
  await store.upsertInstallation({
    installationId,
    amareUserId: userId,
    platform: "android",
    pushToken: token,
    permissionState: "granted",
    revokedAt: null,
  });
}

// 1. QA path still works when production webhooks OFF
resetQaEnv();
check("Production webhooks disabled during QA", fcmProductionWebhooksEnabled() === false);

const qaStore = createMemoryNotificationStore();
await seedInstall(qaStore, QA_AUTO_PUSH_USER_ID, "ins_qa", "qa-token");
const qaTokens = [];
const qaCand = await qaStore.addCandidate({
  kind: "booking_created",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  classId: 11,
  payload: { className: "Reformer", classStartAt: "2026-09-01T18:00:00.000Z" },
});
const qaSend = await deliverQaAutoCandidate(qaCand, {
  store: qaStore,
  send: async (token, message) => qaTokens.push({ token, message }),
});
check(
  "QA snir5 booking push still works when production webhooks OFF",
  qaSend.sent === 1 && qaSend.skipped == null && qaTokens.length === 1 && qaSend.deliveryPath === "qa",
);

// 2. Production webhooks ON → non-QA user eligible
resetProductionWebhookEnv();
check("Production webhooks enabled with global push", fcmProductionWebhooksEnabled() === true);

const prodStore = createMemoryNotificationStore();
await seedInstall(prodStore, OTHER_USER, "ins_other", "other-token");
const otherCand = await prodStore.addCandidate({
  kind: "booking_created",
  amareUserId: OTHER_USER,
  classId: 22,
  payload: { className: "Reformer Flow", classStartAt: "2026-09-02T18:00:00.000Z" },
});
const prodTokens = [];
const otherSend = await deliverProductionWebhookCandidate(otherCand, {
  store: prodStore,
  send: async (token, message) => prodTokens.push({ token, message }),
});
check(
  "Non-QA user receives production webhook push",
  otherSend.sent === 1 &&
    otherSend.skipped == null &&
    prodTokens.length === 1 &&
    otherSend.deliveryPath === "production" &&
    otherSend.skipped !== "not_qa_user",
);

// Router uses production path only when enabled
const routed = await deliverWebhookCandidates([otherCand], {
  store: prodStore,
  send: async () => {
    throw new Error("should_not_resend");
  },
});
check("Router skips already-claimed candidate on production path", routed[0].skipped === "already_claimed_or_old");

// 3. snir5 no double-send when production ON
const qaProdStore = createMemoryNotificationStore();
await seedInstall(qaProdStore, QA_AUTO_PUSH_USER_ID, "ins_qa_prod", "qa-prod-token");
const qaProdCand = await qaProdStore.addCandidate({
  kind: "booking_cancelled",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  classId: 33,
  payload: { className: "Reformer", classStartAt: "2026-09-03T18:00:00.000Z" },
});
const qaProdTokens = [];
const qaProdFirst = await deliverWebhookCandidates([qaProdCand], {
  store: qaProdStore,
  send: async (token, message) => qaProdTokens.push({ token, message }),
});
const qaProdSecond = await deliverWebhookCandidates([qaProdCand], {
  store: qaProdStore,
  send: async (token) => qaProdTokens.push({ token }),
});
check(
  "snir5 gets one production push, not duplicate on retry",
  qaProdFirst[0].sent === 1 &&
    qaProdFirst[0].deliveryPath === "production" &&
    qaProdSecond[0].sent === 0 &&
    qaProdSecond[0].skipped === "already_claimed_or_old" &&
    qaProdTokens.length === 1,
);

// QA auto path not used when production webhooks ON
const qaOnlyAttempt = await deliverQaAutoCandidate(qaProdCand, {
  store: qaProdStore,
  send: async () => {
    throw new Error("qa_should_not_run");
  },
});
check(
  "QA auto path is disabled when production webhooks ON",
  qaOnlyAttempt.skipped === "production_webhooks_enabled" || qaOnlyAttempt.skipped === "already_claimed_or_old",
);

// 4. prefs OFF skips booking push
const offStore = createMemoryNotificationStore();
await offStore.ensurePreferences(OTHER_USER);
await offStore.updatePreferences(OTHER_USER, { class_booking_updates: false });
await offStore.upsertInstallation({
  installationId: "ins_off",
  amareUserId: OTHER_USER,
  platform: "android",
  pushToken: "off-token",
  permissionState: "granted",
  revokedAt: null,
});
const offCand = await offStore.addCandidate({
  kind: "booking_created",
  amareUserId: OTHER_USER,
  payload: { className: "Reformer" },
});
const offSend = await deliverProductionWebhookCandidate(offCand, {
  store: offStore,
  send: async () => {
    throw new Error("pref_off_should_not_send");
  },
});
check(
  "Booking push skipped when class_booking_updates OFF",
  offSend.sent === 0 && offSend.skipped === "pref_class_booking_updates_off",
);

// 5. no active installation skips safely
const noInstStore = createMemoryNotificationStore();
await noInstStore.ensurePreferences(OTHER_USER);
const noInstCand = await noInstStore.addCandidate({
  kind: "booking_created",
  amareUserId: OTHER_USER,
  payload: { className: "Reformer" },
});
const noInstSend = await deliverProductionWebhookCandidate(noInstCand, {
  store: noInstStore,
  send: async () => {
    throw new Error("no_install_should_not_send");
  },
});
check(
  "No active installation skips safely",
  noInstSend.sent === 0 && noInstSend.skipped === "no_owned_active_installation",
);

// 6. ENABLE_AMARE_PUSH=1 without reminders flag → no global reminders
process.env.ENABLE_AMARE_PUSH = "1";
process.env.ENABLE_AMARE_PUSH_TEST = "1";
delete process.env.ENABLE_AMARE_PUSH_REMINDERS;
check("Production reminders stay OFF without explicit flag", fcmProductionRemindersEnabled() === false);
check(
  "Normal user reminders blocked when reminders flag unset",
  reminderSendAllowedForUser(OTHER_USER).ok === false && reminderSendAllowedForUser(OTHER_USER).reason === "not_qa_user",
);
check(
  "QA user reminders still allowed when global push ON but reminders OFF",
  reminderSendAllowedForUser(QA_AUTO_PUSH_USER_ID).ok === true,
);

const reminderStore = createMemoryNotificationStore();
await seedInstall(reminderStore, OTHER_USER, "ins_rem", "rem-token");
await reminderStore.upsertReminder({
  reminderId: "rem_other_1",
  amareUserId: OTHER_USER,
  siteId: 5744068,
  classRosterBookingId: 99001,
  classId: 99001,
  classStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  scheduledFor: new Date(Date.now() - 60 * 1000).toISOString(),
  status: "scheduled",
});
const reminderSent = [];
const reminderScan = await runClassReminderScan({
  store: reminderStore,
  now: new Date().toISOString(),
  send: async (token, message) => reminderSent.push({ token, message }),
});
check(
  "Reminder worker does not send globally when ENABLE_AMARE_PUSH_REMINDERS unset",
  reminderScan.sent === 0 && reminderSent.length === 0,
);

process.env.ENABLE_AMARE_PUSH_REMINDERS = "1";
check("Production reminders ON when both flags set", fcmProductionRemindersEnabled() === true);
check("Normal user reminders allowed when reminders flag ON", reminderSendAllowedForUser(OTHER_USER).ok === true);

// 7. studio_news default false + opt-in gate
check("Default prefs keep studio_news false", DEFAULT_PREFERENCES.studio_news === false);
const studioDecision = decideCandidateDelivery(DEFAULT_PREFERENCES, {
  kind: "studio_news",
  amareUserId: OTHER_USER,
  payload: { title: "News" },
});
check(
  "studio_news remains opt-in only",
  studioDecision.allowed === false && studioDecision.reason === "studio_news_off",
);

// 8. MVP kinds + kill switch
check(
  "MVP production webhook kinds are booking_created and booking_cancelled",
  PRODUCTION_WEBHOOK_KINDS.length === 2 &&
    PRODUCTION_WEBHOOK_KINDS.includes("booking_created") &&
    PRODUCTION_WEBHOOK_KINDS.includes("booking_cancelled"),
);

process.env.ENABLE_AMARE_PUSH = "0";
check("Global kill switch disables production webhooks", fcmProductionWebhooksEnabled() === false);
const killCand = await createMemoryNotificationStore().addCandidate({
  kind: "booking_created",
  amareUserId: OTHER_USER,
  payload: { className: "Reformer" },
});
const killSend = await deliverProductionWebhookCandidate(killCand, {
  store: createMemoryNotificationStore(),
  send: async () => {
    throw new Error("kill_switch_should_block");
  },
});
check(
  "Production webhook delivery blocked when ENABLE_AMARE_PUSH=0",
  killSend.skipped === "production_webhooks_disabled",
);

const [webhookSrc, envExample] = await Promise.all([
  readFile(path.join(root, "netlify/functions/mindbody-webhooks-schedule.mjs"), "utf8"),
  readFile(path.join(root, ".env.example"), "utf8"),
]);
check("Webhook uses unified deliverWebhookCandidates router", webhookSrc.includes("deliverWebhookCandidates"));
check("Env example documents staged push flags", /ENABLE_AMARE_PUSH_WEBHOOKS/.test(envExample) && /ENABLE_AMARE_PUSH_REMINDERS/.test(envExample));

restoreEnv();
if (failed) {
  console.error(`\n${failed} production rollout check(s) failed`);
  process.exit(1);
}
console.log("\nAll production push rollout checks passed.");
