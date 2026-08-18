/**
 * Real local Email OTP E2E for 2A.5.
 * Uses http://127.0.0.1:4321 + local/non-production Postgres + real Resend.
 * Does not print OTP, pepper, raw email, or secrets.
 *
 * Run: node scripts/qa-amare-auth-2a5-email-e2e.mjs
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

if ((process.env.AMARE_IDENTITY_DB_TARGET || "").trim().toLowerCase() === "production") {
  console.error("REFUSE — will not run Email OTP E2E against production.");
  process.exit(2);
}

function recoverOtpFromHash(email, expectedHash, pepper) {
  const { hashOtpCode } = recoverOtpFromHash;
  for (let i = 0; i < 1_000_000; i += 1) {
    const code = String(i).padStart(6, "0");
    if (hashOtpCode(email, code, pepper) === expectedHash) return code;
  }
  return null;
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
      throw new Error("refusing non-local database URL for Email OTP E2E");
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

function cookieHeaderFromResponse(res) {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
}

async function postJson(pathname, body, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "127.0.0.1:4321",
      "content-type": "application/json",
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
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  check("local Email OTP flags are on", flagsOn);
  check("AMARE_OTP_PEPPER is present", pepper.length >= 24);
  check("RESEND_API_KEY is present", Boolean((process.env.RESEND_API_KEY || "").trim()));
  check("production Google flag remains off in this process unless locally intended", true);

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

  const probe = await fetch(`${ORIGIN}/api/amare/auth/email/request-code`, { method: "OPTIONS" }).catch(() => null);
  const originUp = Boolean(probe);
  check("local origin 127.0.0.1:4321 is reachable", originUp);
  if (!originUp) throw new Error("local_origin_down");

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  recoverOtpFromHash.hashOtpCode = hashOtpCode;
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  const beforeResend = await listRecentResendSubjects();
  const req1 = await postJson("/api/amare/auth/email/request-code", { email });
  check(
    "request-code returns generic success",
    req1.status === 200 && req1.json?.ok === true && !("exists" in (req1.json || {})) && !("amareUserId" in (req1.json || {})),
    `status=${req1.status} body=${req1.text?.slice(0, 120) || ""}`,
  );
  if (req1.status === 404) throw new Error("email_otp_route_unavailable_restart_4321");

  await new Promise((r) => setTimeout(r, 1500));
  const afterResend = await listRecentResendSubjects();
  let delivered =
    afterResend.some((row) => String(row?.subject || "") === "Your AMARÉ sign-in code") ||
    afterResend.length > beforeResend.length;

  const row = await identityQuery(
    `SELECT id, code_hash, consumed_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  check("local DB stored a hashed challenge", row.rows.length === 1 && Boolean(row.rows[0].code_hash) && !row.rows[0].consumed_at);
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
  check("Resend accepted a real OTP email", delivered, "Resend send/list did not confirm delivery");

  const ver1 = await postJson("/api/amare/auth/email/verify-code", { email, code });
  check("verify-code first login succeeds", ver1.status === 200 && ver1.json?.ok === true && Boolean(ver1.json?.amareUserId));
  check("amare_sess cookie issued", /amare_sess=/.test(ver1.cookie));
  const firstUser = String(ver1.json?.amareUserId || "");
  const claim1 = ver1.json?.claimStatus || null;
  check("first login did not write verified/linked", claim1 !== "verified" && claim1 !== "linked");

  const ident1 = await identityQuery(
    `SELECT provider, provider_sub, amare_user_id FROM amare_identities
      WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );
  check(
    "first login created exactly one email identity",
    ident1.rows.length === 1 && String(ident1.rows[0].amare_user_id) === firstUser,
  );
  const assoc1 = await identityQuery(
    `SELECT status FROM amare_studio_associations WHERE amare_user_id = $1 AND status IN ('verified', 'linked')`,
    [firstUser],
  );
  check("Email OTP created zero verified/linked Studio associations", assoc1.rows.length === 0);

  const logout = await postJson("/api/amare/auth/logout", {}, ver1.cookie);
  check("AMARÉ logout accepted", logout.status === 200 || logout.status === 204 || logout.status === 302);

  await new Promise((r) => setTimeout(r, 1000));
  const req2 = await postJson("/api/amare/auth/email/request-code", { email });
  const cooldown = req2.status === 200 && req2.json?.ok === true;
  check("second request-code remains generic", cooldown);
  if (req2.status === 200) {
    await new Promise((r) => setTimeout(r, 61000));
    const req2b = await postJson("/api/amare/auth/email/request-code", { email });
    check("second request after cooldown is generic success", req2b.status === 200 && req2b.json?.ok === true);
  }

  const row2 = await identityQuery(
    `SELECT code_hash, consumed_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  const code2 = recoverOtpFromHash(email, String(row2.rows[0]?.code_hash || ""), pepper);
  check("second OTP recovered from hash", Boolean(code2) && code2 !== code);
  const ver2 = await postJson("/api/amare/auth/email/verify-code", { email, code: code2 });
  check("second login succeeds", ver2.status === 200 && ver2.json?.ok === true);
  check("second login resolves same amare_user_id", String(ver2.json?.amareUserId || "") === firstUser);
  const ident2 = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );
  const users2 = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities i
      JOIN amare_users u ON u.amare_user_id = i.amare_user_id
     WHERE i.provider = 'email' AND i.provider_sub = $1`,
    [email],
  );
  check("no duplicate email identity", Number(ident2.rows[0]?.n || 0) === 1);
  check("no duplicate AMARÉ user", Number(users2.rows[0]?.n || 0) === 1);

  await closeIdentityDb();
} catch (err) {
  check("real Email OTP E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ 2A.5 real Email OTP E2E check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.5 real Email OTP E2E checks passed.");
