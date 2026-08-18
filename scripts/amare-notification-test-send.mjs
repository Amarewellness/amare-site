/**
 * Local/test-only candidate delivery.
 * Usage: node scripts/amare-notification-test-send.mjs --kind booking_created --user usr_...
 * Requires ENABLE_AMARE_PUSH_TEST=1 and ADMIN_DEBUG_TOKEN. Blocked on production host.
 * FCM transport: impersonated Firebase Admin SA via AMARÉ gcloud config. No ADC overwrite.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import "./load-env.mjs";
import { handleNotificationTestSend } from "../netlify/functions/amare-notification-http.mjs";

if (!process.env.NETLIFY_DB_URL && fs.existsSync(".cursor-local-db-url.txt")) {
  process.env.NETLIFY_DB_URL = fs.readFileSync(".cursor-local-db-url.txt", "utf8").trim();
}
process.env.ENABLE_AMARE_PUSH_TEST = process.env.ENABLE_AMARE_PUSH_TEST || "1";
process.env.SITE_URL = process.env.SITE_URL || "http://127.0.0.1:4321";

const args = process.argv.slice(2);
function flag(name, fallback = "") {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1] || "") : fallback;
}

const kind = flag("kind", "booking_created");
const amareUserId = flag("user");
const className = flag("class", "Reformer");
const classId = flag("classId", "555");
const startAt = flag("start", new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
const sa =
  process.env.FIREBASE_IMPERSONATE_SA ||
  "firebase-adminsdk-fbsvc@amare-auth.iam.gserviceaccount.com";

if (!amareUserId) {
  console.error("Missing --user usr_...");
  process.exit(1);
}

function impersonatedAccessToken() {
  return execFileSync(
    "cmd.exe",
    [
      "/c",
      "gcloud",
      "--configuration=amare",
      "auth",
      "print-access-token",
      `--impersonate-service-account=${sa}`,
      "--project=amare-auth",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

async function impersonatedFcmSend(deviceToken, message) {
  const accessToken = impersonatedAccessToken();
  const res = await fetch("https://fcm.googleapis.com/v1/projects/amare-auth/messages:send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: message.title, body: message.body },
        data: {
          path: String(message.path || "/"),
          kind: String(message.kind || ""),
          classId: message.classId != null ? String(message.classId) : "",
        },
        android: {
          priority: "HIGH",
          notification: { channel_id: "amare-class" },
        },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const status = body?.error?.status || "";
    const err = new Error(String(body?.error?.message || `fcm_${res.status}`).slice(0, 300));
    if (status === "NOT_FOUND" || /requested entity was not found/i.test(err.message)) {
      err.code = "messaging/registration-token-not-registered";
    }
    throw err;
  }
  return body.name;
}

const event = {
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN || "" },
  body: JSON.stringify({
    kind,
    amareUserId,
    payload: { className, classId: Number(classId), classStartAt: startAt, leadMinutes: 120 },
  }),
};

const res = await handleNotificationTestSend(event, { send: impersonatedFcmSend });
console.log(res.statusCode, res.body);
if (res.statusCode >= 400) process.exit(1);
