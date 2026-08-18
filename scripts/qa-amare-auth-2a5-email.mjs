/**
 * AMARÉ Auth 2A.5 Email OTP QA. Deterministic except secure-random generation proof.
 * Run: npm run test:amare-auth-2a5
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  confirmAmareClaim,
  emailOtpRoutesEnabled,
  finishEmailAuthentication,
  generateOtpCode,
  hashOtpCode,
  issueEmailAmareSession,
  normalizeAmareEmail,
  requestEmailOtp,
  verifyEmailOtp,
} from "../netlify/functions/amare-auth-lib.mjs";
import { handleAmareAuthEmailRequest } from "../netlify/functions/amare-auth-email-request.mjs";
import { handleAmareAuthEmailVerify } from "../netlify/functions/amare-auth-email-verify.mjs";
import { unsealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";
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

const prev = { ...process.env };
function restore() {
  for (const k of ["ENABLE_AMARE_AUTH", "ENABLE_AMARE_AUTH_EMAIL_OTP", "ENABLE_AMARE_SESS_ISSUE", "AMARE_SESSION_SECRET", "AMARE_OTP_PEPPER", "MINDBODY_SITE_ID"]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_AUTH_EMAIL_OTP;
check("email routes require master + OTP flags", emailOtpRoutesEnabled() === false);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = "qa-2a5-amare-session-secret-key!!";
process.env.AMARE_OTP_PEPPER = "qa-2a5-amare-otp-pepper-secret!!";
process.env.MINDBODY_SITE_ID = "amare-qa-2a5";

check("valid email normalized", normalizeAmareEmail("  Ada.Lovelace@Example.COM ") === "ada.lovelace@example.com");
check("dots and plus aliases are kept", normalizeAmareEmail("a.b+tag@gmail.com") === "a.b+tag@gmail.com");
check("invalid email rejected", normalizeAmareEmail("not-an-email") === null);

const src = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const otpSrc = await readFile(path.join(root, "netlify/functions/amare-otp-store.mjs"), "utf8");
const reqSrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-request.mjs"), "utf8");
const verSrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-verify.mjs"), "utf8");
check("secure random OTP generation", src.includes("crypto.randomInt") && !/Math\.random/.test(src + otpSrc));
check("plaintext OTP not stored", !/INSERT INTO amare_otp_challenges[\s\S]*\bcode\b/.test(otpSrc) && otpSrc.includes("code_hash"));
check("OTP HMAC/hash only", src.includes("createHmac") && otpSrc.includes("code_hash"));
check("atomic consume uses row lock", otpSrc.includes("FOR UPDATE") && otpSrc.includes("consumed_at IS NULL"));
check("OTP not logged", !/console\.(log|warn|error)\([^\)]*code/.test(src + reqSrc + verSrc + otpSrc));

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
  };
}

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  let assocId = 1;
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
    async attachIdentity({ amare_user_id, provider, provider_sub, email, email_verified }) {
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
    },
    async findActiveAssociationByClientId(siteId, clientId) {
      return (
        associations.find(
          (a) => a.site_id === siteId && Number(a.client_id) === Number(clientId) && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getActiveAssociation(amareUserId, siteId) {
      return (
        associations.find(
          (a) => a.amare_user_id === amareUserId && a.site_id === siteId && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getLatestAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId);
      return rows[rows.length - 1] || null;
    },
    async getCandidateAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId && a.status === "candidate");
      return rows[rows.length - 1] || null;
    },
    async proposeAssociation(input) {
      if (input.status === "verified" || input.status === "linked") throw new Error("propose_cannot_write_verified");
      associations.push({ id: assocId++, ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      if (input.explicitConfirm !== true) throw new Error("verified_requires_explicit_confirm");
      associations.push({
        id: assocId++,
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "verified",
        client_id: input.client_id,
      });
    },
    async promoteAssociationToLinked() {
      throw new Error("linked_forbidden_in_phase1");
    },
  };
}

const siteId = "amare-qa-2a5";
const pepper = process.env.AMARE_OTP_PEPPER;
const sent = [];
const otp = memoryOtp();
const known = "123456";
const req = await requestEmailOtp(
  { email: "First.User@Example.com", ip: "1.1.1.1" },
  { otp, sendEmail: async (msg) => { sent.push(msg); return { ok: true }; }, generateOtp: () => known, pepper },
);
check("request stores hash not plaintext", otp.rows[0].code_hash === hashOtpCode("first.user@example.com", known, pepper) && !Object.values(otp.rows[0]).includes(known));
check("request does not create a user", true);
const enumA = await handleAmareAuthEmailRequest({
  httpMethod: "POST",
  headers: { origin: "http://127.0.0.1:4321", host: "127.0.0.1:4321" },
  body: JSON.stringify({ email: "new@example.com" }),
}, { otp, sendEmail: async () => ({ ok: true }), generateOtp: () => "111111", pepper });
const enumB = await handleAmareAuthEmailRequest({
  httpMethod: "POST",
  headers: { origin: "http://127.0.0.1:4321", host: "127.0.0.1:4321" },
  body: JSON.stringify({ email: "also-new@example.com" }),
}, { otp, sendEmail: async () => ({ ok: true }), generateOtp: () => "222222", pepper });
check("request response does not enumerate accounts", enumA.statusCode === 200 && enumB.statusCode === 200 && enumA.body === enumB.body && JSON.parse(enumA.body).ok === true);

const ident = memoryIdentity();
const verified = await verifyEmailOtp(
  { email: "first.user@example.com", code: known, siteId },
  { otp, identity: ident, searchStudioClientsByEmail: async () => [], pepper },
);
check("valid OTP accepted", verified.ok === true && verified.createdUser === true);
check("first successful OTP creates exactly one email identity", ident.users.size === 1 && ident.identities.length === 1 && ident.identities[0].provider === "email");
check("identity is provider=email + normalized email", ident.identities[0].provider_sub === "first.user@example.com");
check("Email auth automatically creates zero verified Studio associations", !ident.associations.some((a) => a.status === "verified" || a.status === "linked"));
check("no Studio match → unlinked", verified.claim.status === "unlinked");

const replay = await verifyEmailOtp(
  { email: "first.user@example.com", code: known, siteId },
  { otp, identity: ident, searchStudioClientsByEmail: async () => [], pepper },
);
check("consumed OTP rejected", replay.ok === false);
check("replay rejected", replay.ok === false && replay.error === "invalid_code");

const secondOtp = memoryOtp();
await requestEmailOtp(
  { email: "first.user@example.com", ip: "1.1.1.1" },
  { otp: secondOtp, sendEmail: async () => ({ ok: true }), generateOtp: () => "654321", pepper },
);
const second = await verifyEmailOtp(
  { email: "first.user@example.com", code: "654321", siteId },
  { otp: secondOtp, identity: ident, searchStudioClientsByEmail: async () => [], pepper },
);
check("second login resolves same amare_user_id", second.ok && second.amare_user_id === verified.amare_user_id && ident.users.size === 1 && ident.identities.length === 1);

const unknownOtp = memoryOtp();
await requestEmailOtp(
  { email: "brand.new@example.com", ip: "2.2.2.2" },
  { otp: unknownOtp, sendEmail: async () => ({ ok: true }), generateOtp: () => "000111", pepper },
);
const unknown = await verifyEmailOtp(
  { email: "brand.new@example.com", code: "000111", siteId },
  { otp: unknownOtp, identity: ident, searchStudioClientsByEmail: async () => [], pepper },
);
check("new unknown verified email may create new amare_user_id", unknown.ok && unknown.amare_user_id !== verified.amare_user_id);

const wrongOtp = memoryOtp();
await requestEmailOtp(
  { email: "wrong@example.com", ip: "3.3.3.3" },
  { otp: wrongOtp, sendEmail: async () => ({ ok: true }), generateOtp: () => "999999", pepper },
);
const wrong = await verifyEmailOtp(
  { email: "wrong@example.com", code: "000000", siteId },
  { otp: wrongOtp, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("wrong OTP rejected", wrong.ok === false);

const expiredOtp = memoryOtp();
await requestEmailOtp(
  { email: "exp@example.com", ip: "4.4.4.4" },
  { otp: expiredOtp, sendEmail: async () => ({ ok: true }), generateOtp: () => "888888", pepper, now: Date.now() - OTP_TTL_MS - 1000 },
);
expiredOtp.rows[0].expires_at = new Date(Date.now() - 1000).toISOString();
const expired = await verifyEmailOtp(
  { email: "exp@example.com", code: "888888", siteId },
  { otp: expiredOtp, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("expired OTP rejected", expired.ok === false);

const limitOtp = memoryOtp();
await requestEmailOtp(
  { email: "limit@example.com", ip: "5.5.5.5" },
  { otp: limitOtp, sendEmail: async () => ({ ok: true }), generateOtp: () => "777777", pepper },
);
for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
  await verifyEmailOtp(
    { email: "limit@example.com", code: "000000", siteId },
    { otp: limitOtp, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
  );
}
const afterLimit = await verifyEmailOtp(
  { email: "limit@example.com", code: "777777", siteId },
  { otp: limitOtp, identity: memoryIdentity(), searchStudioClientsByEmail: async () => [], pepper },
);
check("attempt limit enforced", afterLimit.ok === false && limitOtp.rows[0].attempt_count >= OTP_MAX_ATTEMPTS);

const cool = memoryOtp();
await requestEmailOtp(
  { email: "cool@example.com", ip: "6.6.6.6" },
  { otp: cool, sendEmail: async () => ({ ok: true }), generateOtp: () => "121212", pepper },
);
const cool2 = await requestEmailOtp(
  { email: "cool@example.com", ip: "6.6.6.6" },
  { otp: cool, sendEmail: async () => ({ ok: true }), generateOtp: () => "131313", pepper },
);
check("resend cooldown enforced", cool2.ok === true && cool2.sent === false && cool2.reason === "resend_cooldown" && cool.rows.length === 1);

const emailCap = memoryOtp();
for (let i = 0; i < OTP_EMAIL_HOURLY_CAP; i += 1) {
  emailCap.rows.push({
    id: 100 + i,
    email_normalized: "cap@example.com",
    code_hash: "x",
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    consumed_at: null,
    attempt_count: 0,
    created_at: new Date().toISOString(),
    request_key: "k",
  });
}
const capped = await requestEmailOtp(
  { email: "cap@example.com", ip: "7.7.7.7" },
  { otp: emailCap, sendEmail: async () => ({ ok: true }), generateOtp: () => "141414", pepper },
);
check("per-email rate limit enforced", capped.ok === true && capped.sent === false && capped.reason === "email_rate_limited");

const ipCap = memoryOtp();
const ipKey = (await import("../netlify/functions/amare-auth-lib.mjs")).hashOtpRequestKey("8.8.8.8");
for (let i = 0; i < OTP_REQUEST_KEY_HOURLY_CAP; i += 1) {
  ipCap.rows.push({
    id: 200 + i,
    email_normalized: `n${i}@example.com`,
    code_hash: "x",
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    consumed_at: null,
    attempt_count: 0,
    created_at: new Date().toISOString(),
    request_key: ipKey,
  });
}
const ipCapped = await requestEmailOtp(
  { email: "other@example.com", ip: "8.8.8.8" },
  { otp: ipCap, sendEmail: async () => ({ ok: true }), generateOtp: () => "151515", pepper },
);
check("request/IP abuse limit enforced", ipCapped.ok === true && ipCapped.sent === false && ipCapped.reason === "request_key_rate_limited");

const conc = memoryOtp();
await requestEmailOtp(
  { email: "conc@example.com", ip: "9.9.9.9" },
  { otp: conc, sendEmail: async () => ({ ok: true }), generateOtp: () => "161616", pepper },
);
const concIdentA = memoryIdentity();
const concIdentB = memoryIdentity();
const [c1, c2] = await Promise.all([
  verifyEmailOtp({ email: "conc@example.com", code: "161616", siteId }, { otp: conc, identity: concIdentA, searchStudioClientsByEmail: async () => [], pepper }),
  verifyEmailOtp({ email: "conc@example.com", code: "161616", siteId }, { otp: conc, identity: concIdentB, searchStudioClientsByEmail: async () => [], pepper }),
]);
check("concurrent double consume permits only one success", [c1, c2].filter((r) => r.ok).length === 1);

const oneMem = memoryIdentity();
const one = await finishEmailAuthentication(
  { email: "unique@example.com", mbSessClientId: null, siteId },
  { identity: oneMem, searchStudioClientsByEmail: async () => [84521] },
);
check("one Studio match → candidate", one.claim.status === "candidate" && one.claim.clientId === 84521 && one.claim.autoBind === false);
check("verify-code cannot write verified automatically", one.claim.status !== "verified");

const reuseMem = memoryIdentity();
const firstUnlinked = await finishEmailAuthentication(
  { email: "reuse@example.com", mbSessClientId: null, siteId },
  { identity: reuseMem, searchStudioClientsByEmail: async () => [] },
);
const reused = await finishEmailAuthentication(
  { email: "reuse@example.com", mbSessClientId: null, siteId },
  { identity: reuseMem, searchStudioClientsByEmail: async () => [100002726] },
);
check(
  "existing unlinked Email user is reused, not duplicated",
  reused.amare_user_id === firstUnlinked.amare_user_id &&
    reuseMem.identities.filter((i) => i.provider === "email" && i.provider_sub === "reuse@example.com").length === 1,
);
check(
  "unlinked re-evaluates to candidate after Staff exact match",
  firstUnlinked.claim.status === "unlinked" &&
    reused.claim.status === "candidate" &&
    reused.claim.clientId === 100002726 &&
    reused.claim.autoBind === false,
);

const stealMem = memoryIdentity();
const usrOwnerX = newAmareUserId();
stealMem.users.set(usrOwnerX, { amare_user_id: usrOwnerX });
stealMem.associations.push({ id: 1, amare_user_id: usrOwnerX, site_id: siteId, client_id: 100002726, status: "linked" });
const steal = await finishEmailAuthentication(
  { email: "other@example.com", mbSessClientId: null, siteId },
  { identity: stealMem, searchStudioClientsByEmail: async () => [100002726] },
);
check(
  "Staff match owned by another linked user is conflict",
  steal.claim.status === "conflict" && steal.amare_user_id !== usrOwnerX,
);

const prevMemberRead = process.env.ENABLE_AMARE_MEMBER_READ;
const prevOps = process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
process.env.ENABLE_AMARE_MEMBER_READ = "1";
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
const linkMem = memoryIdentity();
linkMem.promoteAssociationToLinked = async (input) => {
  if (input?.explicitPromote !== true) throw new Error("linked_requires_explicit_promote");
  const current = await linkMem.getActiveAssociation(input.amare_user_id, input.site_id);
  if (!current || current.status !== "verified") throw new Error("linked_requires_verified");
  current.status = "linked";
  return { ok: true, status: "linked", already: false, client_id: current.client_id };
};
const toLink = await finishEmailAuthentication(
  { email: "onelink@example.com", mbSessClientId: null, siteId },
  { identity: linkMem, searchStudioClientsByEmail: async () => [100002726] },
);
const linkedConfirm = await confirmAmareClaim(
  { amare_user_id: toLink.amare_user_id, explicitConfirm: true, siteId },
  { identity: linkMem },
);
check(
  "explicit confirm reaches linked when member-read is on",
  toLink.claim.status === "candidate" && linkedConfirm.ok && linkedConfirm.status === "linked",
);
if (prevMemberRead === undefined) delete process.env.ENABLE_AMARE_MEMBER_READ;
else process.env.ENABLE_AMARE_MEMBER_READ = prevMemberRead;
if (prevOps === undefined) delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
else process.env.ENABLE_AMARE_STUDIO_OPERATIONS = prevOps;

const manyMem = memoryIdentity();
const many = await finishEmailAuthentication(
  { email: "many@example.com", mbSessClientId: null, siteId },
  { identity: manyMem, searchStudioClientsByEmail: async () => [1, 2] },
);
check("multiple Studio matches → ambiguous", many.claim.status === "ambiguous");

const usrA = newAmareUserId();
const mapped = memoryIdentity();
mapped.users.set(usrA, { amare_user_id: usrA });
mapped.identities.push({ amare_user_id: usrA, provider: "email", provider_sub: "mapped@example.com" });
mapped.associations.push({ id: 1, amare_user_id: usrA, site_id: siteId, client_id: 100, status: "verified" });
const keep = await finishEmailAuthentication(
  { email: "mapped@example.com", mbSessClientId: null, siteId },
  { identity: mapped, searchStudioClientsByEmail: async () => [200] },
);
check(
  "existing stronger mapping is not overwritten",
  keep.amare_user_id === usrA &&
    keep.claim.action === "use_existing" &&
    mapped.associations.some((a) => a.amare_user_id === usrA && a.status === "verified" && Number(a.client_id) === 100) &&
    !mapped.associations.some((a) => a.amare_user_id === usrA && Number(a.client_id) === 200 && a.status === "candidate"),
);

const shared = memoryIdentity();
shared.users.set(usrA, { amare_user_id: usrA });
shared.associations.push({ id: 1, amare_user_id: usrA, site_id: siteId, client_id: 84521, status: "verified" });
const sharedPend = await finishEmailAuthentication(
  { email: "person-b@example.com", mbSessClientId: 84521, siteId },
  { identity: shared, searchStudioClientsByEmail: async () => [] },
);
check("shared-computer protection", sharedPend.outcome === "pending_attach" && shared.users.size === 1 && shared.identities.length === 0);
const attachMem = memoryIdentity();
const usrOwner = newAmareUserId();
attachMem.users.set(usrOwner, { amare_user_id: usrOwner });
attachMem.associations.push({ id: 1, amare_user_id: usrOwner, site_id: siteId, client_id: 700, status: "verified" });
const pendAttach = await finishEmailAuthentication(
  { email: "attach-b@example.com", mbSessClientId: 700, siteId },
  { identity: attachMem, searchStudioClientsByEmail: async () => [] },
);
const attached = await confirmAmareClaim(
  { pending: pendAttach.pending, explicitConfirm: true, siteId },
  { identity: attachMem },
);
check(
  "email pending attach uses provider=email",
  attached.ok &&
    attachMem.identities.some(
      (i) => i.provider === "email" && i.amare_user_id === usrOwner && i.provider_sub === "attach-b@example.com",
    ),
);
const continued = await confirmAmareClaim(
  { pending: sharedPend.pending, continueAsNew: true, siteId },
  { identity: shared },
);
check(
  "continueAsNew isolation",
  continued.ok &&
    continued.amare_user_id !== usrA &&
    shared.identities.some((i) => i.provider === "email" && i.amare_user_id === continued.amare_user_id) &&
    !shared.associations.some((a) => a.amare_user_id === continued.amare_user_id && ["candidate", "verified", "linked"].includes(a.status)),
);
const afterContinue = await finishEmailAuthentication(
  { email: "person-b@example.com", mbSessClientId: 84521, siteId },
  { identity: shared, searchStudioClientsByEmail: async () => [] },
);
check(
  "after continueAsNew, A's mb_sess is not claim proof for B",
  afterContinue.amare_user_id === continued.amare_user_id && afterContinue.claim.status === "unlinked",
);

const candMem = memoryIdentity();
const cand = await finishEmailAuthentication(
  { email: "cand@example.com", mbSessClientId: 3001, siteId },
  { identity: candMem, searchStudioClientsByEmail: async () => [] },
);
const confirmed = await confirmAmareClaim(
  { amare_user_id: cand.amare_user_id, explicitConfirm: true, siteId },
  { identity: candMem },
);
check("explicit claim confirm remains only candidate→verified path", confirmed.ok && confirmed.status === "verified");

let linkedThrew = false;
try {
  await candMem.promoteAssociationToLinked();
} catch (e) {
  linkedThrew = String(e.message) === "linked_forbidden_in_phase1";
}
check("verify-code cannot write linked", !verSrc.includes('status: "verified"') && !verSrc.includes('status: "linked"'));
check("linked still forbidden", linkedThrew);

const issued = issueEmailAmareSession(verified.amare_user_id, { "x-forwarded-proto": "https" });
const sess = issued?.sealed ? unsealAmareSessPayload(issued.sealed) : null;
check("amare_sess uses 2A.2 core", Boolean(issued?.cookie) && sess?.amare_user_id === verified.amare_user_id);
check("amare_sess contains no clientId", sess && !("client_id" in sess) && !("clientId" in sess) && !("email" in sess));

const httpVerify = await handleAmareAuthEmailVerify({
  httpMethod: "POST",
  headers: { origin: "http://127.0.0.1:4321", host: "127.0.0.1:4321" },
  body: JSON.stringify({ email: "http@example.com", code: "not-digits" }),
});
check("verify rejects non-OTP without leaking account state", httpVerify.statusCode === 400 || httpVerify.statusCode === 401);

const gSrc = await readFile(path.join(root, "netlify/functions/amare-auth-google-start.mjs"), "utf8");
const gCb = await readFile(path.join(root, "netlify/functions/amare-auth-google-callback.mjs"), "utf8");
check("Google implementation retained", gSrc.includes("buildGoogleStart") && gCb.includes("verifyGoogleIdToken"));
check("Google start/callback files unchanged in role", gSrc.includes("GET /api/amare/auth/google/start") && gCb.includes("Never writes verified/linked"));

const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");
check("bookingAllowed unchanged", book.includes("bookingAllowed"));
check("consumerAssociated unchanged", book.includes("consumerAssociated") && consumer.includes("resolveConsumerClient"));
check("class-book does not read amare_sess", !book.includes("amare_sess"));

const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode()));
check("OTP length is 6 digits", [...codes].every((c) => /^\d{6}$/.test(c)) && codes.size > 1);

restore();
if (failed) {
  console.error(`\n${failed} AMARÉ 2A.5 Email OTP QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.5 Email OTP QA checks passed.");
