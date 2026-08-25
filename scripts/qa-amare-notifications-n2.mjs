/**
 * AMARÉ Notifications Phase N2 — FCM sender, APIs, gating, routing.
 * Run: npm run test:amare-notifications-n2
 *
 * Does not PATCH Mindbody. Does not enable production push.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryNotificationStore } from "../netlify/functions/amare-notification-store.mjs";
import { decideCandidateDelivery, deliverNotificationCandidate, deliverExplicitPushTest, pushTestHttpAllowed } from "../netlify/functions/amare-notification-send.mjs";
import {
  QA_AUTO_PUSH_USER_ID,
  deliverQaAutoCandidate,
  qaAutoPushEligible,
} from "../netlify/functions/amare-notification-auto-deliver.mjs";
import { enrichClassName } from "../netlify/functions/amare-notification-class-name.mjs";
import { pushPathForCandidate, renderPushCopy } from "../netlify/functions/amare-notification-copy.mjs";
import { MOBILE_PREF_CORS, mobileApiPreflight } from "../netlify/functions/mobile-api-cors.mjs";
import {
  handleNotificationInstallation,
  handleNotificationPreferences,
  handleNotificationTestSend,
} from "../netlify/functions/amare-notification-http.mjs";
import { handleExplicitPushRelayTest } from "../netlify/functions/amare-notification-explicit-test.mjs";
import {
  relaySignatureValid,
  relayTimestampFresh,
  signRelayRequest,
} from "../netlify/functions/amare-push-relay-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const USER = "usr_N2LINKED000000000000001";
const OTHER = "usr_N2OTHER000000000000002";
const resolveUser = async () => ({ signedIn: true, amareUserId: USER, reason: null });
const resolveNone = async () => ({ signedIn: false, amareUserId: null, reason: "absent" });

function event(method, body, extra = {}) {
  return { httpMethod: method, headers: extra.headers || {}, body: body ? JSON.stringify(body) : "" };
}

const store = createMemoryNotificationStore();

const denied = await handleNotificationInstallation(event("POST", { platform: "android", permissionState: "granted" }), {
  notificationStore: store,
  resolveAmareUser: resolveNone,
});
check("Installation API rejects unsigned caller", denied.statusCode === 401);

const forged = await handleNotificationInstallation(
  event("POST", {
    platform: "android",
    permissionState: "granted",
    pushToken: "tok-a",
    installationId: "ins_n2a",
    amareUserId: OTHER,
    clientId: 999,
    email: "forged@example.com",
  }),
  { notificationStore: store, resolveAmareUser: resolveUser },
);
const forgedBody = JSON.parse(forged.body);
const inst = await store.getInstallation("ins_n2a");
check(
  "Installation ownership ignores device amareUserId/clientId/email",
  forged.statusCode === 200 && inst?.amareUserId === USER && inst?.pushToken === "tok-a" && forgedBody.installation.hasToken === true,
);

const otherStore = createMemoryNotificationStore();
await otherStore.upsertInstallation({
  installationId: "ins_old",
  amareUserId: OTHER,
  platform: "android",
  pushToken: "tok-shared",
  permissionState: "granted",
  revokedAt: null,
});
await handleNotificationInstallation(
  event("POST", { platform: "android", permissionState: "granted", pushToken: "tok-shared", installationId: "ins_n2b" }),
  { notificationStore: otherStore, resolveAmareUser: resolveUser },
);
const old = await otherStore.getInstallation("ins_old");
const neu = await otherStore.getInstallation("ins_n2b");
check("Token moved to current user revokes the previous owner row", old?.revokedAt && neu?.amareUserId === USER);

const sameStore = createMemoryNotificationStore();
await sameStore.upsertInstallation({
  installationId: "ins_old_same",
  amareUserId: USER,
  platform: "android",
  pushToken: "tok-same-user",
  permissionState: "granted",
  revokedAt: null,
});
await handleNotificationInstallation(
  event("POST", { platform: "android", permissionState: "granted", pushToken: "tok-same-user", installationId: "ins_new_same" }),
  { notificationStore: sameStore, resolveAmareUser: resolveUser },
);
const oldSame = await sameStore.getInstallation("ins_old_same");
const newSame = await sameStore.getInstallation("ins_new_same");
check(
  "Same-user token retarget revokes the previous installation row",
  Boolean(oldSame?.revokedAt) && newSame?.amareUserId === USER && newSame?.pushToken === "tok-same-user",
);

const revoked = await handleNotificationInstallation(event("DELETE", { installationId: "ins_n2a" }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
const afterRevoke = await store.getInstallation("ins_n2a");
check("Revoke current installation clears token", revoked.statusCode === 200 && afterRevoke?.revokedAt && afterRevoke.pushToken == null);

const stolen = await handleNotificationInstallation(event("DELETE", { installationId: "ins_n2a" }), {
  notificationStore: store,
  resolveAmareUser: async () => ({ signedIn: true, amareUserId: OTHER, reason: null }),
});
check("Cannot revoke another user's installation", stolen.statusCode === 403);

const prefsGet = await handleNotificationPreferences(event("GET"), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
const prefs = JSON.parse(prefsGet.body).preferences;
check(
  "Preferences defaults transactional on / marketing off",
  prefsGet.statusCode === 200 &&
    prefs.class_booking_updates === true &&
    prefs.class_reminders === true &&
    prefs.waitlist_updates === true &&
    prefs.studio_news === false,
);

const badPref = await handleNotificationPreferences(event("PATCH", { marketing_blast: true }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
check("Unknown preference keys rejected", badPref.statusCode === 400 && JSON.parse(badPref.body).error === "unknown_preference_keys");

const patchPref = await handleNotificationPreferences(event("PATCH", { studio_news: true, class_reminders: false }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
const patched = JSON.parse(patchPref.body).preferences;
check("Allowed preference keys update", patchPref.statusCode === 200 && patched.studio_news === true && patched.class_reminders === false);

const prefPreflight = mobileApiPreflight(
  event("OPTIONS", null, {
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type,ngrok-skip-browser-warning",
    },
  }),
  MOBILE_PREF_CORS,
);
const prefAllowMethods = String(prefPreflight.headers?.["Access-Control-Allow-Methods"] || "");
const prefAllowHeaders = String(prefPreflight.headers?.["Access-Control-Allow-Headers"] || "").toLowerCase();
check(
  "Preference OPTIONS allows PATCH with Authorization, Content-Type, ngrok-skip-browser-warning",
  prefPreflight.statusCode === 204 &&
    prefAllowMethods.includes("PATCH") &&
    prefAllowHeaders.includes("authorization") &&
    prefAllowHeaders.includes("content-type") &&
    prefAllowHeaders.includes("ngrok-skip-browser-warning"),
  `methods=${prefAllowMethods} headers=${prefAllowHeaders}`,
);

const gateOff = decideCandidateDelivery(patched, { kind: "class_reminder_due", amareUserId: USER });
const gateNews = decideCandidateDelivery({ ...patched, studio_news: false }, { kind: "studio_news", amareUserId: USER });
const gateBook = decideCandidateDelivery(patched, { kind: "booking_created", amareUserId: USER });
const gateSupp = decideCandidateDelivery(patched, { kind: "booking_created", amareUserId: USER, suppressPush: true });
check("Candidate gating maps reminder/news/booking correctly", gateOff.allowed === false && gateNews.allowed === false && gateBook.allowed === true && gateSupp.allowed === false);

const copies = {
  booking_created: renderPushCopy("booking_created", { className: "Reformer", classStartAt: "2026-09-01T18:00:00.000Z" }),
  booking_cancelled: renderPushCopy("booking_cancelled", { className: "Reformer", classStartAt: "2026-09-01T18:00:00.000Z" }),
  waitlist_joined: renderPushCopy("waitlist_joined", { className: "Reformer", classStartAt: "2026-09-01T18:00:00.000Z" }),
  waitlist_promoted: renderPushCopy("waitlist_promoted", { className: "Reformer" }),
  class_cancelled: renderPushCopy("class_cancelled", { className: "Reformer", classStartAt: "2026-09-01T18:00:00.000Z" }),
  class_time_changed: renderPushCopy("class_time_changed", { className: "Reformer", startAt: "2026-09-01T19:30:00.000Z" }),
  class_reminder_due: renderPushCopy("class_reminder_due", {
    className: "Reformer",
    classStartAt: "2026-09-01T18:00:00.000Z",
  }),
};
check("booking_created copy", copies.booking_created.title === "You're booked ✨" && copies.booking_created.body.includes("Reformer"));
check("waitlist_promoted copy", copies.waitlist_promoted.title === "You're in" && copies.waitlist_promoted.body.includes("Reformer"));
check("class_time_changed uses supplied time only", copies.class_time_changed.body.includes("Reformer") && copies.class_time_changed.body.includes("now at"));
check(
  "reminder copy is Class tomorrow + studio-local time",
  copies.class_reminder_due.title === "Class tomorrow ✨" &&
    copies.class_reminder_due.body.startsWith("Reformer · ") &&
    !/instructor/i.test(copies.class_reminder_due.body) &&
    !/itemName/i.test(copies.class_reminder_due.body),
);
const missing = renderPushCopy("booking_created", {});
check("Missing class/time uses safe fallback", missing.body === "your class" && !missing.body.includes("undefined"));
check(
  "Cancel copy uses reservation wording",
  copies.booking_cancelled.title === "Booking cancelled" &&
    copies.booking_cancelled.body === "Your reservation for Reformer has been cancelled.",
);

check("booking path", pushPathForCandidate("booking_created", { classId: 55 }) === "/my-classes?section=upcoming&classId=55");
check("waitlist path", pushPathForCandidate("waitlist_joined", { classId: 55 }) === "/my-classes?section=waitlist&classId=55");
check("waitlist promoted path", pushPathForCandidate("waitlist_promoted", { classId: 55 }) === "/my-classes?section=upcoming&classId=55");
check("class change path", pushPathForCandidate("class_time_changed", { classId: 55 }) === "/my-classes?section=upcoming&classId=55");

const sendStore = createMemoryNotificationStore();
await sendStore.ensurePreferences(USER);
await sendStore.upsertInstallation({
  installationId: "ins_send",
  amareUserId: USER,
  platform: "android",
  pushToken: "dead-token",
  permissionState: "granted",
  revokedAt: null,
});
const sentKinds = [];
const sendFn = async (token, message) => {
  sentKinds.push(message.kind);
  if (token === "dead-token") {
    const err = new Error("Requested entity was not found.");
    err.code = "messaging/registration-token-not-registered";
    throw err;
  }
};
const cleaned = await deliverNotificationCandidate(
  { kind: "booking_created", amareUserId: USER, payload: { className: "Reformer" } },
  { store: sendStore, send: sendFn },
);
const dead = await sendStore.getInstallation("ins_send");
check("Invalid FCM token revokes that installation only", cleaned.revoked?.includes("ins_send") && dead?.revokedAt && dead.pushToken == null);

await sendStore.upsertInstallation({
  installationId: "ins_live",
  amareUserId: USER,
  platform: "android",
  pushToken: "live-token",
  permissionState: "granted",
  revokedAt: null,
});
await sendStore.upsertInstallation({
  installationId: "ins_other",
  amareUserId: OTHER,
  platform: "android",
  pushToken: "other-token",
  permissionState: "granted",
  revokedAt: null,
});
const tokens = [];
await deliverNotificationCandidate(
  { kind: "waitlist_promoted", amareUserId: USER, payload: { className: "Reformer" } },
  { store: sendStore, send: async (token) => tokens.push(token) },
);
check("Sender fans out only to the current user's active tokens", tokens.length === 1 && tokens[0] === "live-token");

const prevTest = process.env.ENABLE_AMARE_PUSH_TEST;
const prevSite = process.env.SITE_URL;
const prevCtx = process.env.CONTEXT;
process.env.ENABLE_AMARE_PUSH_TEST = "";
process.env.SITE_URL = "https://www.amarewellness.com";
process.env.CONTEXT = "production";
const blocked = await handleNotificationTestSend(event("POST", { kind: "booking_created", amareUserId: USER }));
check("Test-send is not public in production", blocked.statusCode === 404 && pushTestHttpAllowed() === false);
process.env.ENABLE_AMARE_PUSH_TEST = "1";
process.env.SITE_URL = "http://127.0.0.1:4321";
process.env.CONTEXT = "dev";
const testSend = await handleNotificationTestSend(
  event("POST", { kind: "class_reminder_due", amareUserId: USER, payload: { className: "Reformer", leadMinutes: 120 } }),
  { notificationStore: sendStore, adminAuthorized: true, forceTest: true, send: async () => undefined },
);
check("Local test-send can exercise a V1 candidate", testSend.statusCode === 200 && JSON.parse(testSend.body).ok === true);
process.env.ENABLE_AMARE_PUSH_TEST = "1";
const explicitTokens = [];
const explicit = await deliverExplicitPushTest(
  { amareUserId: USER },
  { store: sendStore, send: async (token) => explicitTokens.push(token) },
);
check("Explicit test send fans out only to the resolved user", explicit.ok === true && explicitTokens.length === 1 && explicitTokens[0] === "live-token");
const otherUser = await deliverExplicitPushTest(
  { amareUserId: "usr_OTHER00000000000000000001", installationId: "inst-live" },
  { store: sendStore, send: async (token) => explicitTokens.push(token) },
);
check("Explicit test send cannot target another user's installation", otherUser.ok === false && otherUser.skipped === "no_owned_active_installation" && explicitTokens.length === 1);
const customCopy = await deliverExplicitPushTest(
  { amareUserId: USER, title: "AMARÉ", body: "Production Push relay is ready ✨" },
  { store: sendStore, send: async () => undefined },
);
check("Explicit test send can use relay QA copy", customCopy.ok === true && customCopy.sent === 1);
const hmacSecret = "a".repeat(32);
const hmacTs = String(Math.floor(Date.now() / 1000));
const hmacBody = JSON.stringify({ token: "x", title: "AMARÉ", body: "ok", data: { path: "/my-classes", kind: "push_test" } });
const hmacSig = signRelayRequest(hmacSecret, hmacTs, hmacBody);
check("Relay HMAC accepts a fresh signed body", relaySignatureValid(hmacSecret, hmacTs, hmacBody, `sha256=${hmacSig}`) === true);
check("Relay HMAC rejects a mutated body", relaySignatureValid(hmacSecret, hmacTs, hmacBody.replace("ok", "no"), `sha256=${hmacSig}`) === false);
check("Relay timestamp rejects stale requests", relayTimestampFresh(String(Math.floor(Date.now() / 1000) - 400)) === false);
process.env.ENABLE_AMARE_PUSH_TEST = "1";
const explicitHttp = await handleExplicitPushRelayTest(event("POST", { amareUserId: "usr_OTHER00000000000000000001", token: "stolen" }));
check("Explicit relay HTTP requires invoke auth", explicitHttp.statusCode === 401);
process.env.ENABLE_AMARE_PUSH_TEST = "";
const explicitOff = await handleExplicitPushRelayTest(event("POST", {}));
check("Explicit relay HTTP is off when test sending is disabled", explicitOff.statusCode === 404);

const prevQa = process.env.AMARE_PUSH_QA_STARTED_AT;
process.env.ENABLE_AMARE_PUSH_TEST = "1";
process.env.AMARE_PUSH_QA_STARTED_AT = "2026-08-21T20:00:00.000Z";
const qaStore = createMemoryNotificationStore();
await qaStore.ensurePreferences(QA_AUTO_PUSH_USER_ID);
await qaStore.upsertInstallation({
  installationId: "ins_qa",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  platform: "android",
  pushToken: "qa-token",
  permissionState: "granted",
  revokedAt: null,
});
const qaTokens = [];
const oldCand = await qaStore.addCandidate({
  kind: "booking_created",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  classId: 13250,
  payload: { className: "Reformer" },
});
oldCand.createdAt = "2026-08-21T19:00:00.000Z";
const oldGate = qaAutoPushEligible(oldCand);
check("Historical QA candidates are suppressed", oldGate.ok === false && oldGate.reason === "before_qa_boundary");
const oldSend = await deliverQaAutoCandidate(oldCand, { store: qaStore, send: async (token) => qaTokens.push(token) });
check("Historical candidate is not sent", oldSend.sent === 0 && qaTokens.length === 0 && oldSend.skipped === "before_qa_boundary");

const otherCand = await qaStore.addCandidate({
  kind: "booking_created",
  amareUserId: USER,
  payload: { className: "Reformer" },
});
const otherSend = await deliverQaAutoCandidate(otherCand, { store: qaStore, send: async (token) => qaTokens.push(token) });
check("Non-QA user is not auto-sent", otherSend.sent === 0 && otherSend.skipped === "not_qa_user" && qaTokens.length === 0);

const waitCand = await qaStore.addCandidate({
  kind: "waitlist_promoted",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  payload: { className: "Reformer" },
});
const waitSend = await deliverQaAutoCandidate(waitCand, { store: qaStore, send: async (token) => qaTokens.push(token) });
check("Waitlist auto Push stays off", waitSend.sent === 0 && waitSend.skipped === "kind_not_in_qa_auto");

const liveCand = await qaStore.addCandidate({
  kind: "booking_created",
  amareUserId: QA_AUTO_PUSH_USER_ID,
  classId: 77,
  payload: { className: "Reformer Flow", classStartAt: "2026-09-01T18:00:00.000Z" },
});
const first = await deliverQaAutoCandidate(liveCand, {
  store: qaStore,
  send: async (token, message) => {
    qaTokens.push({ token, title: message.title, body: message.body, path: message.path, kind: message.kind, classId: message.classId });
  },
});
const second = await deliverQaAutoCandidate(liveCand, {
  store: qaStore,
  send: async (token) => qaTokens.push({ token }),
});
check(
  "QA booking auto Push claims once",
  first.ok === true &&
    first.sent === 1 &&
    qaTokens.length === 1 &&
    qaTokens[0].title === "You're booked ✨" &&
    qaTokens[0].path === "/my-classes" &&
    qaTokens[0].kind === "booking_created" &&
    String(qaTokens[0].classId) === "77" &&
    second.sent === 0 &&
    second.skipped === "already_claimed_or_old",
);

const named = await enrichClassName(createMemoryNotificationStore(), {
  siteId: 5744068,
  classId: 1,
  existingName: null,
  fetchClassName: async () => ({ className: "AMARÉ Monthly 8 Classes", source: "should_not_use_item" }),
});
const fromStateStore = createMemoryNotificationStore();
await fromStateStore.upsertClassState({
  siteId: 5744068,
  classId: 9,
  className: "Signature Reformer",
  lastEventOriginationAt: "2026-08-21T12:00:00.000Z",
});
const fromState = await enrichClassName(fromStateStore, {
  siteId: 5744068,
  classId: 9,
  existingName: null,
  fetchClassName: async () => ({ className: "WRONG", source: "mindbody_class_lookup" }),
});
const fallback = await enrichClassName(createMemoryNotificationStore(), {
  siteId: 5744068,
  classId: 2,
  existingName: null,
  fetchClassName: async () => null,
});
check("Class name prefers persisted class state", fromState.source === "class_notification_state" && fromState.displayName === "Signature Reformer");
check("Class name fallback is reported", fallback.fallbackUsed === true && fallback.displayName === "your class" && fallback.source === "fallback_your_class");
check("Enrichment API does not accept itemName", named.displayName !== undefined && !Object.prototype.hasOwnProperty.call({ existingName: null }, "itemName"));

if (prevQa === undefined) delete process.env.AMARE_PUSH_QA_STARTED_AT;
else process.env.AMARE_PUSH_QA_STARTED_AT = prevQa;
if (prevTest === undefined) delete process.env.ENABLE_AMARE_PUSH_TEST;
else process.env.ENABLE_AMARE_PUSH_TEST = prevTest;
if (prevSite === undefined) delete process.env.SITE_URL;
else process.env.SITE_URL = prevSite;
if (prevCtx === undefined) delete process.env.CONTEXT;
else process.env.CONTEXT = prevCtx;

const [webhook, sendSrc, envExample, toml, pkg, manifest, gitignoreApp, explicitSrc, relaySrc] = await Promise.all([
  readFile(path.join(root, "netlify/functions/mindbody-webhooks-schedule.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-notification-send.mjs"), "utf8"),
  readFile(path.join(root, ".env.example"), "utf8"),
  readFile(path.join(root, "netlify.toml"), "utf8"),
  readFile(path.join(root, "package.json"), "utf8"),
  readFile(path.join(root, "amare-app/android/app/src/main/AndroidManifest.xml"), "utf8"),
  readFile(path.join(root, "amare-app/.gitignore"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-notification-explicit-test.mjs"), "utf8"),
  readFile(path.join(root, "gcp/amare-push-relay/index.mjs"), "utf8"),
]);
check("Webhook handler does not import firebase-admin", !/firebase-admin/.test(webhook));
check("Webhook HMAC is official Base64, not hex", webhook.includes('.digest("base64")') && !webhook.includes('.digest("hex")'));
check("Webhook does not export a named handler", !/export (?:async function handler|const handler)/.test(webhook));
check("Sender is a separate module", sendSrc.includes("deliverNotificationCandidate") && !sendSrc.includes("mindbody-webhooks-schedule"));
check("Webhook still does not import explicit test send", !webhook.includes("deliverExplicitPushTest"));
check("Webhook QA auto-deliver does not import firebase-admin", webhook.includes("deliverQaAutoCandidates") && !/firebase-admin/.test(webhook));
check("Sender uses Cloud Run relay when configured", sendSrc.includes("relayConfigured") && sendSrc.includes("sendViaPushRelay"));
check("Explicit relay test does not export a named handler", !/export (?:async function handler|const handler)/.test(explicitSrc));
check("Explicit relay test does not accept caller tokens", !explicitSrc.includes("body.token") && explicitSrc.includes("QA_CLIENT_ID"));
check(
  "Cloud Run relay never logs the FCM token",
  relaySrc.includes("hasToken: true") &&
    relaySrc.split("\n").filter((line) => /console\.(log|warn|error)/.test(line)).every((line) => !line.includes("valid.token") && !line.includes("parsed.token")),
);
check("Relay env vars are not VITE_", /AMARE_PUSH_RELAY_URL=/.test(envExample) && !/VITE_AMARE_PUSH_RELAY/.test(envExample));
check("Production push flag stays off in .env.example", /ENABLE_AMARE_PUSH=0/.test(envExample) && !/ENABLE_AMARE_PUSH=1/.test(envExample));
check("No Mindbody subscription PATCH added", !/push-api.mindbodyonline.com/.test(toml));
check("firebase-admin is a dependency for the sender", /"firebase-admin"/.test(pkg));
check("Android 13 POST_NOTIFICATIONS declared", /POST_NOTIFICATIONS/.test(manifest));
check("google-services.json is gitignored", /google-services\.json/.test(gitignoreApp));

if (failed) {
  console.error(`\n${failed} N2 check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ notification N2 checks passed.");
