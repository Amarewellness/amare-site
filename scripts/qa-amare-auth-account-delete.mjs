/**
 * AMARÉ app account deletion — handler + policy unit checks.
 * Run: npm run test:amare-auth-account-delete
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleAmareAuthAccountDelete } from "../netlify/functions/amare-auth-account-delete.mjs";
import { isAmareUserDeleted } from "../netlify/functions/amare-identity-store.mjs";
import { resolveAmareUser } from "../netlify/functions/amare-sess-lib.mjs";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { sealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const prev = {
  ENABLE_AMARE_AUTH: process.env.ENABLE_AMARE_AUTH,
  ENABLE_AMARE_AUTH_EMAIL_OTP: process.env.ENABLE_AMARE_AUTH_EMAIL_OTP,
  AMARE_SESSION_SECRET: process.env.AMARE_SESSION_SECRET,
  AMARE_OTP_PEPPER: process.env.AMARE_OTP_PEPPER,
  ENABLE_MOBILE_BEARER_AUTH: process.env.ENABLE_MOBILE_BEARER_AUTH,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const migration = await readFile(
  path.join(root, "netlify/database/migrations/20260825103000_amare_account_deletion.sql"),
  "utf8",
);
check("migration adds amare_users.status", /amare_users[\s\S]*status TEXT/.test(migration));
check("migration adds deleted_at", /deleted_at TIMESTAMPTZ/.test(migration));
check("migration adds account_deleted block_reason", /'account_deleted'/.test(migration));

check("isAmareUserDeleted active", isAmareUserDeleted({ status: "active" }) === false);
check("isAmareUserDeleted deleted", isAmareUserDeleted({ status: "deleted" }) === true);
check("isAmareUserDeleted null", isAmareUserDeleted(null) === false);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.AMARE_SESSION_SECRET = "qa-account-delete-amare-secret!!";
process.env.AMARE_OTP_PEPPER = "qa-account-delete-otp-pepper-secret";

const userId = newAmareUserId();
const email = "delete-me@example.com";
let userRow = { amare_user_id: userId, status: "active" };
/** @type {Record<string, unknown>[]} */
let identities = [
  { provider: "email", provider_sub: email, email },
];
let deactivated = false;

const findUser = async () => userRow;
const listIdentities = async () => identities;

const noAuth = await handleAmareAuthAccountDelete({
  httpMethod: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, email, code: "123456" }),
});
check("requires authentication", noAuth.statusCode === 401);

const sealed = sealAmareSessPayload({ amare_user_id: userId });
const cookie = `amare_sess=${encodeURIComponent(sealed)}`;

const needsConfirm = await handleAmareAuthAccountDelete({
  httpMethod: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ email, code: "123456" }),
  isBase64Encoded: false,
}, { findUser, listIdentities });
check("requires confirm:true", needsConfirm.statusCode === 400);

const badEmail = await handleAmareAuthAccountDelete({
  httpMethod: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, email: "other@example.com", code: "123456" }),
}, {
  findUser,
  listIdentities,
  otp: {
    consumeOtpChallenge: async () => ({ ok: true }),
    deleteOtpChallengesByEmail: async () => {},
  },
});
check("email must match identity", badEmail.statusCode === 403);

const deactivateAmareAppAccount = async () => {
  deactivated = true;
  userRow = { ...userRow, status: "deleted" };
  identities = [];
  return { ok: true, alreadyDeleted: false, amare_user_id: userId, emails: [email] };
};

const notificationStore = {
  revokeAllInstallationsForUser: async () => {},
  deletePreferencesForUser: async () => {},
  cancelPendingRemindersForUser: async () => {},
  clearNotificationUserLinks: async () => {},
};

const ok = await handleAmareAuthAccountDelete({
  httpMethod: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, email, code: "123456" }),
}, {
  findUser,
  listIdentities,
  deactivateAmareAppAccount,
  notificationStore,
  otp: {
    consumeOtpChallenge: async () => ({ ok: true }),
    deleteOtpChallengesByEmail: async () => {},
  },
});
check("deletion succeeds with OTP", ok.statusCode === 200);
const okBody = JSON.parse(String(ok.body || "{}"));
check("response deleted=true", okBody.deleted === true);
check("studio records retained flag", okBody.studioRecordsRetained === true);
check("deactivate called", deactivated === true);
check("clears amare_sess cookie", Array.isArray(ok.multiValueHeaders?.["Set-Cookie"]) && ok.multiValueHeaders["Set-Cookie"].some((c) => /amare_sess=;/i.test(c)));

const signedInAfter = await resolveAmareUser(
  { headers: { cookie } },
  { findUser },
);
check("deleted user cannot reuse session", signedInAfter.signedIn === false && signedInAfter.reason === "account_deleted");

const again = await handleAmareAuthAccountDelete({
  httpMethod: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, email, code: "123456" }),
}, {
  findUser,
  listIdentities,
  deactivateAmareAppAccount,
  notificationStore,
  otp: {
    consumeOtpChallenge: async () => ({ ok: true }),
    deleteOtpChallengesByEmail: async () => {},
  },
});
check("idempotent already deleted", again.statusCode === 200 && JSON.parse(String(again.body)).alreadyDeleted === true);

restoreEnv();

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll account deletion checks passed.");
process.exit(failed ? 1 : 0);
