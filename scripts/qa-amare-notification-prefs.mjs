/**
 * Preference PATCH CORS + persist. Reproduces the physical Android failure:
 * OPTIONS Access-Control-Request-Method PATCH was disallowed, so the WebView
 * never reached the handler (`MethodDisallowedByPreflightResponse`).
 * Run: npm run test:amare-notification-prefs
 */
import { createMemoryNotificationStore } from "../netlify/functions/amare-notification-store.mjs";
import { handleNotificationPreferences } from "../netlify/functions/amare-notification-http.mjs";
import { MOBILE_API_CORS, MOBILE_PREF_CORS, mobileApiPreflight } from "../netlify/functions/mobile-api-cors.mjs";

const USER = "usr_PREFTEST000000000000001";
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function event(method, body, headers = {}) {
  return { httpMethod: method, headers, body: body ? JSON.stringify(body) : "" };
}

const defaultMethods = String(MOBILE_API_CORS["Access-Control-Allow-Methods"] || "");
check("Default mobile CORS still omits PATCH (prefs-only allow)", !defaultMethods.includes("PATCH") && defaultMethods.includes("POST"));

const preflight = mobileApiPreflight(
  event("OPTIONS", null, {
    Origin: "https://localhost",
    "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization,content-type,ngrok-skip-browser-warning",
  }),
  MOBILE_PREF_CORS,
);
const allowMethods = String(preflight.headers?.["Access-Control-Allow-Methods"] || "");
const allowHeaders = String(preflight.headers?.["Access-Control-Allow-Headers"] || "").toLowerCase();
check("Prefs preflight is 204", preflight.statusCode === 204);
check("Prefs preflight allows PATCH", allowMethods.split(",").map((s) => s.trim()).includes("PATCH"), allowMethods);
check(
  "Prefs preflight allows Authorization, Content-Type, ngrok-skip-browser-warning",
  allowHeaders.includes("authorization") && allowHeaders.includes("content-type") && allowHeaders.includes("ngrok-skip-browser-warning"),
  allowHeaders,
);

const store = createMemoryNotificationStore();
const resolveUser = async () => ({ signedIn: true, amareUserId: USER, reason: null });
const resolveNone = async () => ({ signedIn: false, amareUserId: null, reason: "absent" });

const unsigned = await handleNotificationPreferences(event("PATCH", { waitlist_updates: false }), {
  notificationStore: store,
  resolveAmareUser: resolveNone,
});
check("PATCH rejects unsigned caller", unsigned.statusCode === 401);

const forged = await handleNotificationPreferences(
  event("PATCH", { waitlist_updates: false, amareUserId: "usr_other", email: "x@y.com", clientId: 99 }),
  { notificationStore: store, resolveAmareUser: resolveUser },
);
check("Device amareUserId/email/clientId are unknown keys", forged.statusCode === 400 && JSON.parse(forged.body).error === "unknown_preference_keys");

async function getWaitlist() {
  const res = await handleNotificationPreferences(event("GET"), {
    notificationStore: store,
    resolveAmareUser: resolveUser,
  });
  return JSON.parse(res.body).preferences.waitlist_updates;
}

const first = await handleNotificationPreferences(event("PATCH", { waitlist_updates: true }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
check("waitlist_updates true", first.statusCode === 200 && JSON.parse(first.body).preferences.waitlist_updates === true);
check("GET after true", (await getWaitlist()) === true);

const off = await handleNotificationPreferences(event("PATCH", { waitlist_updates: false }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
check("waitlist_updates false persists (not optimistic-only)", off.statusCode === 200 && JSON.parse(off.body).preferences.waitlist_updates === false);
check("GET after false", (await getWaitlist()) === false);

const on = await handleNotificationPreferences(event("PATCH", { waitlist_updates: true }), {
  notificationStore: store,
  resolveAmareUser: resolveUser,
});
check("waitlist_updates true again", on.statusCode === 200 && JSON.parse(on.body).preferences.waitlist_updates === true);
check("GET after true again", (await getWaitlist()) === true);

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
