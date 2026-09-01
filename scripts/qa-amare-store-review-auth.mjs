/**
 * Store reviewer access QA — Google Play + Apple App Review bypass paths.
 * Run: npm run test:amare-store-review-auth
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  hashOtpCode,
  normalizeAmareEmail,
  requestEmailOtp,
  verifyEmailOtp,
} from "../netlify/functions/amare-auth-lib.mjs";
import { handleAmareAuthAccountDelete } from "../netlify/functions/amare-auth-account-delete.mjs";
import {
  hashStoreReviewCode,
  isStoreReviewEmail,
  listActiveStoreReviewPlatforms,
  resolveStoreReviewPlatform,
  STORE_REVIEW_PLATFORM,
  verifyStoreReviewCode,
} from "../netlify/functions/amare-store-review-auth.mjs";
import { sealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";
import {
  OTP_EMAIL_HOURLY_CAP,
  OTP_MAX_ATTEMPTS,
  OTP_REQUEST_KEY_HOURLY_CAP,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from "../netlify/functions/amare-otp-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const PLAY_EMAIL = "play-review@amarewellness.com";
const APPLE_EMAIL = "apple-review@amarewellness.com";
const NORMAL_EMAIL = "member@example.com";

const prev = {
  ENABLE_AMARE_AUTH: process.env.ENABLE_AMARE_AUTH,
  ENABLE_AMARE_AUTH_EMAIL_OTP: process.env.ENABLE_AMARE_AUTH_EMAIL_OTP,
  ENABLE_AMARE_SESS_ISSUE: process.env.ENABLE_AMARE_SESS_ISSUE,
  AMARE_SESSION_SECRET: process.env.AMARE_SESSION_SECRET,
  AMARE_OTP_PEPPER: process.env.AMARE_OTP_PEPPER,
  MINDBODY_SITE_ID: process.env.MINDBODY_SITE_ID,
  ENABLE_AMARE_STORE_REVIEW_AUTH: process.env.ENABLE_AMARE_STORE_REVIEW_AUTH,
  ENABLE_AMARE_PLAY_REVIEW_AUTH: process.env.ENABLE_AMARE_PLAY_REVIEW_AUTH,
  ENABLE_AMARE_APPLE_REVIEW_AUTH: process.env.ENABLE_AMARE_APPLE_REVIEW_AUTH,
  AMARE_PLAY_REVIEW_EMAIL: process.env.AMARE_PLAY_REVIEW_EMAIL,
  AMARE_PLAY_REVIEW_CODE: process.env.AMARE_PLAY_REVIEW_CODE,
  AMARE_PLAY_REVIEW_CODE_HASH: process.env.AMARE_PLAY_REVIEW_CODE_HASH,
  AMARE_APPLE_REVIEW_EMAIL: process.env.AMARE_APPLE_REVIEW_EMAIL,
  AMARE_APPLE_REVIEW_CODE_HASH: process.env.AMARE_APPLE_REVIEW_CODE_HASH,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function baseAuthEnv() {
  process.env.ENABLE_AMARE_AUTH = "1";
  process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
  process.env.ENABLE_AMARE_SESS_ISSUE = "1";
  process.env.AMARE_SESSION_SECRET = "qa-store-review-amare-session-secret!!";
  process.env.AMARE_OTP_PEPPER = "qa-store-review-otp-pepper-secret!!";
  process.env.MINDBODY_SITE_ID = "amare-qa-store-review";
}

function clearStoreReviewEnv() {
  delete process.env.ENABLE_AMARE_STORE_REVIEW_AUTH;
  delete process.env.ENABLE_AMARE_PLAY_REVIEW_AUTH;
  delete process.env.ENABLE_AMARE_APPLE_REVIEW_AUTH;
  delete process.env.AMARE_PLAY_REVIEW_EMAIL;
  delete process.env.AMARE_PLAY_REVIEW_CODE;
  delete process.env.AMARE_PLAY_REVIEW_CODE_HASH;
  delete process.env.AMARE_APPLE_REVIEW_EMAIL;
  delete process.env.AMARE_APPLE_REVIEW_CODE_HASH;
}

function setStoreReviewEnv({
  master = "1",
  play = "0",
  apple = "0",
  playCode = "111111",
  appleCode = "222222",
  playPlainCode = "",
  playHash = true,
} = {}) {
  process.env.ENABLE_AMARE_STORE_REVIEW_AUTH = master;
  process.env.ENABLE_AMARE_PLAY_REVIEW_AUTH = play;
  process.env.ENABLE_AMARE_APPLE_REVIEW_AUTH = apple;
  process.env.AMARE_PLAY_REVIEW_EMAIL = PLAY_EMAIL;
  process.env.AMARE_APPLE_REVIEW_EMAIL = APPLE_EMAIL;
  delete process.env.AMARE_PLAY_REVIEW_CODE;
  delete process.env.AMARE_PLAY_REVIEW_CODE_HASH;
  if (playPlainCode) process.env.AMARE_PLAY_REVIEW_CODE = playPlainCode;
  if (playHash) process.env.AMARE_PLAY_REVIEW_CODE_HASH = hashStoreReviewCode(PLAY_EMAIL, playCode);
  if (!playPlainCode && !playHash) {
    // inactive play code config
  }
  process.env.AMARE_APPLE_REVIEW_CODE_HASH = hashStoreReviewCode(APPLE_EMAIL, appleCode);
  return { playCode, appleCode, playPlainCode: playPlainCode || playCode };
}

function memoryOtp() {
  const rows = [];
  let id = 1;
  let lock = Promise.resolve();
  function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.then(() => {}, () => {});
    return run;
  }
  return {
    rows,
    OTP_EMAIL_HOURLY_CAP,
    OTP_REQUEST_KEY_HOURLY_CAP,
    OTP_RESEND_COOLDOWN_MS,
    OTP_TTL_MS,
    async insertOtpChallenge(input) {
      const row = {
        id: id++,
        email_normalized: input.email_normalized,
        code_hash: input.code_hash,
        expires_at: input.expires_at,
        consumed_at: null,
        attempt_count: 0,
        created_at: new Date().toISOString(),
        request_key: input.request_key || null,
      };
      rows.push(row);
      return row;
    },
    async countRecentOtpChallenges({ emailNormalized, requestKey, since }) {
      const t = new Date(since).getTime();
      return {
        email: rows.filter((r) => r.email_normalized === emailNormalized && new Date(r.created_at).getTime() >= t).length,
        requestKey: rows.filter((r) => r.request_key === requestKey && new Date(r.created_at).getTime() >= t).length,
      };
    },
    async latestOtpCreatedAt(emailNormalized) {
      const hits = rows.filter((r) => r.email_normalized === emailNormalized);
      return hits.length ? hits[hits.length - 1].created_at : null;
    },
    async consumeOtpChallenge({ emailNormalized, codeHash, now = new Date() }) {
      return withLock(async () => {
        const row = [...rows].reverse().find((r) => r.email_normalized === emailNormalized);
        if (!row) return { ok: false, reason: "no_challenge" };
        if (row.consumed_at) return { ok: false, reason: "consumed" };
        if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
        if (row.attempt_count >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "attempt_limit" };
        if (row.code_hash !== codeHash) {
          row.attempt_count += 1;
          return { ok: false, reason: "wrong_code" };
        }
        row.consumed_at = now.toISOString();
        return { ok: true, id: row.id };
      });
    },
    async deleteExpiredOtpChallenges() {},
    async deleteOtpChallengesByEmail() {},
  };
}

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  return {
    users,
    identities,
    associations,
    async findIdentity(provider, sub) {
      return identities.find((i) => i.provider === provider && i.provider_sub === sub) || null;
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
    },
    async attachIdentity() {},
    async findActiveAssociationByClientId() {
      return null;
    },
    async getActiveAssociation() {
      return null;
    },
    async getLatestAssociation() {
      return null;
    },
    async getCandidateAssociation() {
      return null;
    },
    async proposeAssociation(input) {
      associations.push({ ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation() {
      throw new Error("not_used");
    },
    async promoteAssociationToLinked() {
      throw new Error("linked_forbidden");
    },
  };
}

const storeReviewSrc = await readFile(path.join(root, "netlify/functions/amare-store-review-auth.mjs"), "utf8");
const authLibSrc = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const deleteSrc = await readFile(path.join(root, "netlify/functions/amare-auth-account-delete.mjs"), "utf8");
const appSrc = await readFile(path.join(root, "amare-app/src/api/amare-auth.ts"), "utf8");

check("store review module exists", storeReviewSrc.includes("google_play") && storeReviewSrc.includes("apple_app_review"));
check("auth lib hooks requestEmailOtp", authLibSrc.includes("store_review_otp_request_suppressed"));
check("auth lib hooks verifyEmailOtp", authLibSrc.includes("store_review_auth_failure"));
check("account delete hooks store review", deleteSrc.includes("store_review_account_delete_verified"));
check("no review secrets in mobile auth client", !/AMARE_(PLAY|APPLE)_REVIEW|STORE_REVIEW_AUTH/i.test(appSrc));
check("no code logging in store review module", !/console\.(log|warn|error)\([^\)]*\bcode\b/i.test(storeReviewSrc));
check("plaintext play code env supported", storeReviewSrc.includes("AMARE_PLAY_REVIEW_CODE"));

// ── flags off ────────────────────────────────────────────────────────────────
baseAuthEnv();
clearStoreReviewEnv();
check("flags off: no active platforms", listActiveStoreReviewPlatforms().length === 0);
check("flags off: play email not review", isStoreReviewEmail(PLAY_EMAIL) === false);

const pepper = process.env.AMARE_OTP_PEPPER;
const otpOff = memoryOtp();
const sentOff = [];
await requestEmailOtp(
  { email: PLAY_EMAIL, ip: "10.0.0.1" },
  {
    otp: otpOff,
    sendEmail: async (msg) => {
      sentOff.push(msg);
      return { ok: true };
    },
    generateOtp: () => "333333",
    pepper,
  },
);
check("flags off: play request still sends email OTP path", otpOff.rows.length === 1 && sentOff.length === 1);

const identOff = memoryIdentity();
const offBypass = await verifyEmailOtp(
  { email: PLAY_EMAIL, code: "111111", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpOff, identity: identOff, searchStudioClientsByEmail: async () => [], pepper },
);
check("flags off: static review code rejected", offBypass.ok === false);

// ── Play enabled only ───────────────────────────────────────────────────────
baseAuthEnv();
const { playCode, appleCode } = setStoreReviewEnv({ play: "1", apple: "0" });
check("play only: one platform active", listActiveStoreReviewPlatforms().length === 1);
check(
  "play only: platform tag",
  listActiveStoreReviewPlatforms()[0].platform === STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
);
check(
  "play only: resolve play",
  resolveStoreReviewPlatform(PLAY_EMAIL)?.platform === STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
);
check("play only: apple inactive", resolveStoreReviewPlatform(APPLE_EMAIL) === null);
check(
  "play only: verify play code",
  verifyStoreReviewCode(PLAY_EMAIL, playCode) === STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
);
check("play only: wrong play code", verifyStoreReviewCode(PLAY_EMAIL, "000000") === null);
check("play only: apple code on play email fails", verifyStoreReviewCode(PLAY_EMAIL, appleCode) === null);

const otpPlay = memoryOtp();
const sentPlay = [];
const playReq = await requestEmailOtp(
  { email: PLAY_EMAIL, ip: "10.0.0.2" },
  {
    otp: otpPlay,
    sendEmail: async (msg) => {
      sentPlay.push(msg);
      return { ok: true };
    },
    generateOtp: () => "444444",
    pepper,
  },
);
check("play only: request suppresses email", playReq.sent === false && playReq.reason === "store_review_static_code");
check("play only: request skips OTP insert", otpPlay.rows.length === 0 && sentPlay.length === 0);

const identPlay = memoryIdentity();
const playLogin = await verifyEmailOtp(
  { email: PLAY_EMAIL, code: playCode, siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpPlay, identity: identPlay, searchStudioClientsByEmail: async () => [], pepper },
);
check("play only: login without OTP row", playLogin.ok === true && otpPlay.rows.length === 0);

const playWrong = await verifyEmailOtp(
  { email: PLAY_EMAIL, code: "999999", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpPlay, identity: identPlay, searchStudioClientsByEmail: async () => [], pepper },
);
check("play only: wrong code invalid_code", playWrong.ok === false && playWrong.error === "invalid_code");

// Apple email still normal OTP when apple flag off
const otpAppleNormal = memoryOtp();
await requestEmailOtp(
  { email: APPLE_EMAIL, ip: "10.0.0.3" },
  {
    otp: otpAppleNormal,
    sendEmail: async () => ({ ok: true }),
    generateOtp: () => "555555",
    pepper,
  },
);
const appleNormal = await verifyEmailOtp(
  { email: APPLE_EMAIL, code: "555555", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpAppleNormal, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("play only: apple email uses normal OTP", appleNormal.ok === true && otpAppleNormal.rows.length === 1);

// ── Play plaintext code ───────────────────────────────────────────────────────
baseAuthEnv();
const plainPlayCode = "123789";
setStoreReviewEnv({ play: "1", apple: "0", playPlainCode: plainPlayCode, playHash: false });
check(
  "plaintext: verify play code",
  verifyStoreReviewCode(PLAY_EMAIL, plainPlayCode) === STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
);
check("plaintext: wrong play code", verifyStoreReviewCode(PLAY_EMAIL, "000000") === null);
check("plaintext: non-six-digit code rejected", verifyStoreReviewCode(PLAY_EMAIL, "12345") === null);
check("plaintext: seven-digit code rejected", verifyStoreReviewCode(PLAY_EMAIL, "1234567") === null);

const otpPlain = memoryOtp();
const plainReq = await requestEmailOtp(
  { email: PLAY_EMAIL, ip: "10.0.0.5" },
  {
    otp: otpPlain,
    sendEmail: async () => ({ ok: true }),
    generateOtp: () => "777777",
    pepper,
  },
);
check("plaintext: request suppressed", plainReq.sent === false && plainReq.reason === "store_review_static_code");
check("plaintext: request skips OTP insert", otpPlain.rows.length === 0);

const identPlain = memoryIdentity();
const plainLogin = await verifyEmailOtp(
  { email: PLAY_EMAIL, code: plainPlayCode, siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpPlain, identity: identPlain, searchStudioClientsByEmail: async () => [], pepper },
);
check("plaintext: login works", plainLogin.ok === true);
const plainWrong = await verifyEmailOtp(
  { email: PLAY_EMAIL, code: "999999", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpPlain, identity: identPlain, searchStudioClientsByEmail: async () => [], pepper },
);
check("plaintext: wrong code invalid_code", plainWrong.ok === false && plainWrong.error === "invalid_code");

const otpPlainNormal = memoryOtp();
await requestEmailOtp(
  { email: NORMAL_EMAIL, ip: "10.0.0.6" },
  {
    otp: otpPlainNormal,
    sendEmail: async () => ({ ok: true }),
    generateOtp: () => "888888",
    pepper,
  },
);
const plainNormalOk = await verifyEmailOtp(
  { email: NORMAL_EMAIL, code: "888888", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpPlainNormal, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("plaintext: normal OTP still works", plainNormalOk.ok === true);

check("plaintext: apple inactive", resolveStoreReviewPlatform(APPLE_EMAIL) === null);

// plaintext preferred over hash when both set
baseAuthEnv();
setStoreReviewEnv({ play: "1", apple: "0", playPlainCode: plainPlayCode, playHash: true, playCode: "111111" });
check(
  "plaintext preferred over hash",
  verifyStoreReviewCode(PLAY_EMAIL, plainPlayCode) === STORE_REVIEW_PLATFORM.GOOGLE_PLAY &&
    verifyStoreReviewCode(PLAY_EMAIL, "111111") === null,
);

// hash fallback when plaintext absent
baseAuthEnv();
setStoreReviewEnv({ play: "1", apple: "0", playHash: true, playCode: "111111" });
delete process.env.AMARE_PLAY_REVIEW_CODE;
check(
  "hash fallback works",
  verifyStoreReviewCode(PLAY_EMAIL, "111111") === STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
);

// ── Apple enabled only ────────────────────────────────────────────────────────
baseAuthEnv();
setStoreReviewEnv({ play: "0", apple: "1" });
check("apple only: one platform active", listActiveStoreReviewPlatforms().length === 1);
check(
  "apple only: platform tag",
  listActiveStoreReviewPlatforms()[0].platform === STORE_REVIEW_PLATFORM.APPLE_APP_REVIEW,
);
check(
  "apple only: verify apple code",
  verifyStoreReviewCode(APPLE_EMAIL, appleCode) === STORE_REVIEW_PLATFORM.APPLE_APP_REVIEW,
);
check("apple only: play inactive", verifyStoreReviewCode(PLAY_EMAIL, playCode) === null);

// ── both enabled ─────────────────────────────────────────────────────────────
baseAuthEnv();
setStoreReviewEnv({ play: "1", apple: "1" });
check("both enabled: two platforms", listActiveStoreReviewPlatforms().length === 2);
check(
  "both enabled: cross codes fail",
  verifyStoreReviewCode(PLAY_EMAIL, appleCode) === null &&
    verifyStoreReviewCode(APPLE_EMAIL, playCode) === null,
);

// ── normal user isolation ─────────────────────────────────────────────────────
const otpNormal = memoryOtp();
await requestEmailOtp(
  { email: NORMAL_EMAIL, ip: "10.0.0.4" },
  {
    otp: otpNormal,
    sendEmail: async () => ({ ok: true }),
    generateOtp: () => "666666",
    pepper,
  },
);
const normalWithReviewCode = await verifyEmailOtp(
  { email: NORMAL_EMAIL, code: playCode, siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpNormal, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("normal user: review code rejected", normalWithReviewCode.ok === false);

const normalOk = await verifyEmailOtp(
  { email: NORMAL_EMAIL, code: "666666", siteId: process.env.MINDBODY_SITE_ID },
  { otp: otpNormal, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("normal user: OTP still works", normalOk.ok === true);

// ── account deletion review code ──────────────────────────────────────────────
baseAuthEnv();
setStoreReviewEnv({ play: "1", apple: "1" });
const reviewUserId = newAmareUserId();
const sealed = sealAmareSessPayload({ amare_user_id: reviewUserId });
const cookie = `amare_sess=${encodeURIComponent(sealed)}`;
let reviewDeleted = false;

const reviewDeleteOk = await handleAmareAuthAccountDelete(
  {
    httpMethod: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, email: PLAY_EMAIL, code: playCode }),
  },
  {
    findUser: async () => ({ amare_user_id: reviewUserId, status: "active" }),
    listIdentities: async () => [{ provider: "email", provider_sub: PLAY_EMAIL, email: PLAY_EMAIL }],
    deactivateAmareAppAccount: async () => {
      reviewDeleted = true;
      return { ok: true, alreadyDeleted: false, amare_user_id: reviewUserId, emails: [PLAY_EMAIL] };
    },
    notificationStore: {
      revokeAllInstallationsForUser: async () => {},
      deletePreferencesForUser: async () => {},
      cancelPendingRemindersForUser: async () => {},
      clearNotificationUserLinks: async () => {},
    },
    otp: {
      consumeOtpChallenge: async () => {
        throw new Error("otp_should_not_run_for_review_delete");
      },
    },
  },
);
check(
  "account delete: play review code accepted",
  reviewDeleteOk.statusCode === 200 && reviewDeleted === true,
);

const reviewDeleteBad = await handleAmareAuthAccountDelete(
  {
    httpMethod: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, email: PLAY_EMAIL, code: "000000" }),
  },
  {
    findUser: async () => ({ amare_user_id: reviewUserId, status: "active" }),
    listIdentities: async () => [{ provider: "email", provider_sub: PLAY_EMAIL, email: PLAY_EMAIL }],
    otp: {
      consumeOtpChallenge: async () => ({ ok: true }),
    },
  },
);
check("account delete: wrong review code rejected", reviewDeleteBad.statusCode === 401);

// ── email normalization ───────────────────────────────────────────────────────
check(
  "exact normalized email match",
  resolveStoreReviewPlatform("  Play-Review@AmareWellness.com ")?.email === normalizeAmareEmail(PLAY_EMAIL),
);

const diffNames = spawnSync("git", ["diff", "--name-only", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).stdout;
check(
  "FINAL_PLAY_UPLOAD untouched by this change",
  !String(diffNames || "").split(/\r?\n/).some((p) => p.includes("FINAL_PLAY_UPLOAD")),
);

restoreEnv();

console.log("");
if (failed) {
  console.error(`Store review auth QA: ${failed} failure(s).`);
  process.exit(1);
}
console.log("Store review auth QA: all checks passed.");
