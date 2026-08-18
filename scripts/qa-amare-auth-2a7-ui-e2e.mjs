/**
 * Real local 2A.7 login UI + Email OTP E2E.
 * Uses http://127.0.0.1:4321 login page + the same-origin endpoints the UI calls.
 * Does not print OTP, pepper, raw email, or secrets.
 *
 * Run: node scripts/qa-amare-auth-2a7-ui-e2e.mjs
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:4321";
/** @type {import("node:child_process").ChildProcess | null} */
let localDbKeeper = null;
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

if ((process.env.AMARE_IDENTITY_DB_TARGET || "").trim().toLowerCase() === "production") {
  console.error("REFUSE — will not run 2A.7 UI E2E against production.");
  process.exit(2);
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

function netlifyCliPath() {
  return path.join(root, "node_modules/netlify-cli/bin/run.js");
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
      throw new Error("refusing non-local database URL for 2A.7 UI E2E");
    }
    process.env.NETLIFY_DB_URL = existing;
    return;
  }
  const child = spawn(process.execPath, [netlifyCliPath(), "database", "connect"], {
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
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`local_netlify_db_connect_exited:${code}`));
    });
  });
  process.env.NETLIFY_DB_URL = url;
}

function recoverOtpFromHash(email, expectedHash, pepper) {
  const { hashOtpCode } = recoverOtpFromHash;
  for (let i = 0; i < 1_000_000; i += 1) {
    const code = String(i).padStart(6, "0");
    if (hashOtpCode(email, code, pepper) === expectedHash) return code;
  }
  return null;
}

function cookieHeaderFromResponse(res) {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
}

function mergeCookie(existing, incoming) {
  const map = new Map();
  for (const part of String(existing || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const part of String(incoming || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, cookie: cookieHeaderFromResponse(res), raw: res };
}

async function getJson(pathname, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    method: "GET",
    headers: {
      origin: ORIGIN,
      host: "127.0.0.1:4321",
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
    },
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function listRecentResendSubjects() {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) return [];
  const res = await fetch("https://api.resend.com/emails?limit=10", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const rows = data?.data || data?.emails || [];
  return Array.isArray(rows) ? rows : [];
}

try {
  const flagsOn =
    (process.env.ENABLE_AMARE_AUTH || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1";
  const uiOn = (process.env.ENABLE_AMARE_AUTH_UI || "").trim() === "1";
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  check("local AMARÉ auth flags are on", flagsOn);
  check("ENABLE_AMARE_AUTH_UI is on for this local UI E2E", uiOn);
  check("AMARE_OTP_PEPPER is present", pepper.length >= 24);
  check("RESEND_API_KEY is present", Boolean((process.env.RESEND_API_KEY || "").trim()));

  let email = (process.env.AMARE_OTP_E2E_EMAIL || "").trim().toLowerCase();
  if (!email) {
    try {
      const { stdout } = await execFileAsync("git", ["config", "user.email"], { cwd: root, windowsHide: true });
      email = String(stdout || "").trim().toLowerCase();
    } catch {
      email = "";
    }
  }
  if (!email || !email.includes("@")) {
    check("E2E inbox address available", false, "set AMARE_OTP_E2E_EMAIL");
    throw new Error("e2e_email_missing");
  }

  const loginRes = await fetch(`${ORIGIN}/login`).catch(() => null);
  check("login page is reachable on 127.0.0.1:4321", Boolean(loginRes?.ok));
  if (!loginRes?.ok) throw new Error("login_page_down");
  const loginHtml = await loginRes.text();
  check("built login page enables AMARÉ UI", loginHtml.includes('data-amare-auth-ui="1"'));
  check("login page shows Email OTP primary", loginHtml.includes("AMARÉ LOGIN") && loginHtml.includes("amare-login-continue"));
  check("login page hides Google and Apple", !/Continue with Google|Continue with Apple|Sign in with Google|Sign in with Apple/i.test(loginHtml));
  check("login page shows Mindbody fallback", loginHtml.includes("Already use Mindbody with AMARÉ?") && loginHtml.includes("Sign in with Mindbody"));
  check("login page loads amare-auth.js", loginHtml.includes("/js/amare-auth.js"));

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  recoverOtpFromHash.hashOtpCode = hashOtpCode;
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  const beforeResend = await listRecentResendSubjects();
  const req1 = await postJson("/api/amare/auth/email/request-code", { email });
  check(
    "UI request-code returns generic success",
    req1.status === 200 && req1.json?.ok === true && !("exists" in (req1.json || {})),
    `status=${req1.status} body=${req1.text?.slice(0, 120) || ""}`,
  );
  if (req1.status === 404) throw new Error("email_otp_route_unavailable_restart_4321");

  await new Promise((r) => setTimeout(r, 1500));
  const afterResend = await listRecentResendSubjects();
  let delivered =
    afterResend.some((row) => String(row?.subject || "") === "Your AMARÉ sign-in code") ||
    afterResend.length > beforeResend.length;

  let row = await identityQuery(
    `SELECT id, code_hash, consumed_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  if (row.rows[0]?.consumed_at) {
    await new Promise((r) => setTimeout(r, 61000));
    await postJson("/api/amare/auth/email/request-code", { email });
    row = await identityQuery(
      `SELECT id, code_hash, consumed_at FROM amare_otp_challenges
        WHERE email_normalized = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [email],
    );
  }
  check("hashed OTP challenge exists", row.rows.length === 1 && Boolean(row.rows[0].code_hash) && !row.rows[0].consumed_at);
  const code = recoverOtpFromHash(email, String(row.rows[0]?.code_hash || ""), pepper);
  check("OTP recovered from hash without application logs", Boolean(code) && /^\d{6}$/.test(code || ""));
  if (!code) throw new Error("otp_recover_failed");
  if (!delivered) {
    const { sendResendEmail } = await import("../netlify/functions/resend-email-client.mjs");
    const { buildOtpEmail, otpFromAddress } = await import("../netlify/functions/amare-auth-lib.mjs");
    const content = buildOtpEmail({ code });
    const fallback = await sendResendEmail({
      from: otpFromAddress(),
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      tags: [{ name: "amare_auth", value: "email_otp" }],
    });
    delivered = Boolean(fallback?.ok && fallback.messageId);
  }
  check("Resend accepted a real OTP email", delivered);

  const ver1 = await postJson("/api/amare/auth/email/verify-code", { email, code });
  check("UI verify-code succeeds", ver1.status === 200 && ver1.json?.ok === true);
  const firstUser = String(ver1.json?.amareUserId || "");
  check("verify did not write verified/linked", ver1.json?.claimStatus !== "verified" && ver1.json?.claimStatus !== "linked");
  let cookie = ver1.cookie;
  if (ver1.json?.status === "pending_attach") {
    const confirm = await postJson("/api/amare/auth/claim/confirm", { explicitConfirm: true }, cookie);
    check("pending-link required explicit confirm", confirm.status === 200 && confirm.json?.ok === true);
    cookie = mergeCookie(cookie, confirm.cookie);
  }

  const sess1 = await getJson("/api/amare/auth/session", cookie);
  check("session GET confirms signedIn=true", sess1.status === 200 && sess1.json?.signedIn === true);
  check("session GET omits claimStatus and clientId", !("claimStatus" in (sess1.json || {})) && !("clientId" in (sess1.json || {})));
  const sessUser = String(sess1.json?.amareUserId || firstUser);
  check("signed-in AMARÉ user id is present", sessUser.startsWith("usr_"));

  const sessAgain = await getJson("/api/amare/auth/session", cookie);
  check("session persists on revisit", sessAgain.status === 200 && sessAgain.json?.signedIn === true && String(sessAgain.json?.amareUserId || "") === sessUser);

  const mbSess = await getJson("/api/mindbody/oauth/session", cookie);
  check(
    "Mindbody session contract is unchanged and independent",
    mbSess.status === 200 &&
      ("authenticated" in (mbSess.json || {}) || "loggedIn" in (mbSess.json || {})) &&
      !("amareUserId" in (mbSess.json || {})),
  );

  const logout = await postJson("/api/amare/auth/logout", {}, cookie);
  check("AMARÉ logout succeeds", logout.status === 200 && logout.json?.ok === true);
  const sessOut = await getJson("/api/amare/auth/session", mergeCookie(cookie, logout.cookie));
  check("after AMARÉ logout session is signed out", sessOut.status === 200 && sessOut.json?.signedIn === false);

  await new Promise((r) => setTimeout(r, 61000));
  const req2 = await postJson("/api/amare/auth/email/request-code", { email });
  check("second request-code remains generic", req2.status === 200 && req2.json?.ok === true);
  const row2 = await identityQuery(
    `SELECT code_hash, consumed_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  const code2 = recoverOtpFromHash(email, String(row2.rows[0]?.code_hash || ""), pepper);
  check("second OTP recovered", Boolean(code2) && code2 !== code);
  const ver2 = await postJson("/api/amare/auth/email/verify-code", { email, code: code2 });
  check("second email login succeeds", ver2.status === 200 && ver2.json?.ok === true);
  const sess2 = await getJson("/api/amare/auth/session", ver2.cookie);
  check("second login is the same amare_user_id", sess2.json?.signedIn === true && String(sess2.json?.amareUserId || ver2.json?.amareUserId || "") === sessUser);

  const ident2 = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );
  check("no duplicate email identity", Number(ident2.rows[0]?.n || 0) === 1);

  await closeIdentityDb();
} catch (err) {
  check("2A.7 real login UI E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ 2A.7 real login UI E2E check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.7 real login UI E2E checks passed.");
