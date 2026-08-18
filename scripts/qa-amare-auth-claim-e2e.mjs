/**
 * Live Staff-claim recovery for the existing local Email user.
 * Run: node scripts/qa-amare-auth-claim-e2e.mjs
 * Does not print emails or secrets.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:4321";
const TARGET_USER = "usr_TRDWTEVFRGNME66PQ645RR";
const EXPECTED_CLIENT = 100002726;
let localDbKeeper = null;
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function cookieHeaderFromResponse(res) {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
}

function mergeCookie(prev, next) {
  const map = new Map();
  for (const part of String(prev || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) map.set(k, rest.join("="));
  }
  for (const part of String(next || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) map.set(k, rest.join("="));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function hasCookie(header, name) {
  return String(header || "")
    .split(";")
    .some((part) => part.trim().startsWith(`${name}=`) && !part.includes(`${name}=;`) && part.split("=")[1]);
}

function stopLocalDbKeeper() {
  if (!localDbKeeper || localDbKeeper.killed) return;
  try {
    localDbKeeper.stdin?.write("\\q\n");
  } catch {
    /* ignore */
  }
  localDbKeeper.kill();
  localDbKeeper = null;
}

async function resolveLocalDbUrl() {
  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();
  if (existing) {
    if (!/localhost|127\.0\.0\.1|\.local(?:[:/]|$)/i.test(existing)) {
      throw new Error("refusing non-local database URL");
    }
    process.env.NETLIFY_DB_URL = existing;
    return;
  }
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  localDbKeeper = child;
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      stopLocalDbKeeper();
      reject(new Error("local_netlify_db_connect_timeout"));
    }, 20000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`local_netlify_db_connect_exited:${code}`)));
  });
  process.env.NETLIFY_DB_URL = url;
}

function recoverOtpFromHash(email, expectedHash, pepper, hashOtpCode) {
  for (let i = 0; i < 1_000_000; i += 1) {
    const code = String(i).padStart(6, "0");
    if (hashOtpCode(email, code, pepper) === expectedHash) return code;
  }
  return null;
}

async function postJson(pathname, body, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "127.0.0.1:4321",
      "content-type": "application/json",
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    cookie: cookieHeaderFromResponse(res),
  };
}

async function getJson(pathname, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: { origin: ORIGIN, accept: "application/json", ...(cookie ? { cookie } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function loginEmailOtp(email, pepper, hashOtpCode, identityQuery) {
  const req = await postJson("/api/amare/auth/email/request-code", { email });
  if (req.status !== 200) return { ok: false, reason: `request_${req.status}`, req };
  await new Promise((r) => setTimeout(r, 800));
  let row = await identityQuery(
    `SELECT code_hash, consumed_at FROM amare_otp_challenges WHERE email_normalized = $1 ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  if (row.rows[0]?.consumed_at) {
    await new Promise((r) => setTimeout(r, 61000));
    await postJson("/api/amare/auth/email/request-code", { email });
    row = await identityQuery(
      `SELECT code_hash, consumed_at FROM amare_otp_challenges WHERE email_normalized = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
  }
  const code = recoverOtpFromHash(email, String(row.rows[0]?.code_hash || ""), pepper, hashOtpCode);
  if (!code) return { ok: false, reason: "otp_not_recovered" };
  const ver = await postJson("/api/amare/auth/email/verify-code", { email, code });
  return { ok: ver.status === 200 && Boolean(ver.json?.signedIn || ver.json?.ok), ver };
}

try {
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  if (pepper.length < 24) throw new Error("otp_pepper_missing");
  const loginRes = await fetch(`${ORIGIN}/login`).catch(() => null);
  check("login page reachable", Boolean(loginRes?.ok));
  if (!loginRes?.ok) throw new Error("login_page_down");

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  const ident = await identityQuery(
    `SELECT provider_sub FROM amare_identities WHERE amare_user_id = $1 AND provider = 'email' LIMIT 1`,
    [TARGET_USER],
  );
  const email = String(ident.rows[0]?.provider_sub || "").trim().toLowerCase();
  check("target Email identity exists", Boolean(email), TARGET_USER);
  if (!email) throw new Error("target_email_missing");

  const usersBefore = await identityQuery(`SELECT COUNT(*)::int AS n FROM amare_users`);
  const emailIdsBefore = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );

  await postJson("/api/amare/auth/logout/all", {});
  const first = await loginEmailOtp(email, pepper, hashOtpCode, identityQuery);
  check("Email OTP verify succeeded", first.ok === true, first.reason || `status=${first.ver?.status}`);
  if (!first.ok) throw new Error("first_login_failed");

  check("EMAIL LOGIN REUSED SAME USER", first.ver.json?.amareUserId === TARGET_USER, first.ver.json?.amareUserId || "");
  check("CANDIDATE CREATED", first.ver.json?.claimStatus === "candidate", `claimStatus=${first.ver.json?.claimStatus}`);
  check("verify did not write linked", first.ver.json?.claimStatus !== "linked");

  let cookie = first.ver.cookie;
  const confirm = await postJson("/api/amare/auth/claim/confirm", { explicitConfirm: true }, cookie);
  cookie = mergeCookie(cookie, confirm.cookie);
  check("EXPLICIT CONFIRM", confirm.status === 200 && confirm.json?.ok === true, `status=${confirm.status} error=${confirm.json?.error || ""}`);

  const assoc = await identityQuery(
    `SELECT status, client_id FROM amare_studio_associations
      WHERE amare_user_id = $1 AND system = 'mindbody'
      ORDER BY updated_at DESC LIMIT 1`,
    [TARGET_USER],
  );
  check(
    "FINAL ASSOCIATION linked to expected client",
    assoc.rows[0]?.status === "linked" && Number(assoc.rows[0]?.client_id) === EXPECTED_CLIENT,
    JSON.stringify(assoc.rows[0] || {}),
  );

  const access = await getJson("/api/amare/auth/member-access", cookie);
  check(
    "member-access linked after confirm",
    access.status === 200 &&
      access.json?.signedIn === true &&
      access.json?.studioAccess === "linked" &&
      access.json?.studioOperations === true &&
      !("clientId" in (access.json || {})),
    `studioAccess=${access.json?.studioAccess || ""}`,
  );
  check(
    "member-access includes display email",
    typeof access.json?.email === "string" && String(access.json.email).includes("@") && !("clientId" in (access.json || {})),
  );

  const summary = await getJson("/api/mindbody/member/summary", cookie);
  check("member/summary authorized without mb_sess", summary.status === 200 && summary.json?.ok === true, `status=${summary.status}`);
  check("summary client matches Staff claim", Number(summary.json?.clientId) === EXPECTED_CLIENT, `clientId=${summary.json?.clientId ?? "none"}`);

  const mb = await getJson("/api/mindbody/oauth/session", cookie);
  check(
    "mb_sess absent after Email OTP",
    mb.status === 200 && (mb.json?.authenticated === false || mb.json?.loggedIn === false),
  );

  const bookProbe = await postJson("/api/mindbody/class/book", { classId: 1 }, cookie);
  check(
    "Book does not require mb_sess or Consumer link",
    bookProbe.status !== 401 && bookProbe.json?.error !== "studio_not_linked" && bookProbe.json?.error !== "not_authenticated",
    `status=${bookProbe.status} error=${bookProbe.json?.error || ""}`,
  );

  await postJson("/api/amare/auth/logout/all", {}, cookie);
  const second = await loginEmailOtp(email, pepper, hashOtpCode, identityQuery);
  check("second Email OTP succeeded", second.ok === true, second.reason || "");
  check("second login same user", second.ver?.json?.amareUserId === TARGET_USER);
  const cookie2 = second.ver?.cookie || "";
  check("second login has amare_sess", hasCookie(cookie2, "amare_sess"));
  check("second login has no mb_sess", !hasCookie(cookie2, "mb_sess"));
  const access2 = await getJson("/api/amare/auth/member-access", cookie2);
  check(
    "second Email OTP still linked without Mindbody",
    access2.json?.signedIn === true && access2.json?.studioAccess === "linked" && access2.json?.studioOperations === true,
    `studioAccess=${access2.json?.studioAccess || ""}`,
  );
  const summary2 = await getJson("/api/mindbody/member/summary", cookie2);
  check("second Email OTP member data loads", summary2.status === 200 && summary2.json?.ok === true && Number(summary2.json?.clientId) === EXPECTED_CLIENT);

  const usersAfter = await identityQuery(`SELECT COUNT(*)::int AS n FROM amare_users`);
  const emailIdsAfter = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );
  check("no duplicate AMARÉ user", usersAfter.rows[0].n === usersBefore.rows[0].n);
  check("no duplicate email identity", emailIdsAfter.rows[0].n === emailIdsBefore.rows[0].n && emailIdsAfter.rows[0].n === 1);
  const owners = await identityQuery(
    `SELECT amare_user_id FROM amare_studio_associations
      WHERE system = 'mindbody' AND site_id = $1 AND client_id = $2 AND status IN ('verified', 'linked')`,
    [String(process.env.MINDBODY_SITE_ID || "").trim(), EXPECTED_CLIENT],
  );
  check("no duplicate Studio client owner", owners.rows.length === 1 && owners.rows[0].amare_user_id === TARGET_USER);

  await closeIdentityDb();
} catch (err) {
  check("live claim E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ claim live check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ claim live Email OTP checks passed.");
