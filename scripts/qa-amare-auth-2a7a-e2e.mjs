/**
 * Live 2A.7a entry-surface probe against http://127.0.0.1:4321
 * Run: node scripts/qa-amare-auth-2a7a-e2e.mjs
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

function cookieHeaderFromResponse(res) {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
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
      throw new Error("refusing non-local database URL for 2A.7a E2E");
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

async function getText(pathname) {
  const res = await fetch(`${ORIGIN}${pathname}`);
  return { status: res.status, text: await res.text() };
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, cookie: cookieHeaderFromResponse(res), text };
}

async function getJson(pathname, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: {
      origin: ORIGIN,
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
    },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function headerMembersHref(html) {
  const match = html.match(/class="header-members"[^>]*href="([^"]+)"/);
  return match ? match[1] : "";
}

try {
  const uiOn = (process.env.ENABLE_AMARE_AUTH_UI || "").trim() === "1";
  check("local ENABLE_AMARE_AUTH_UI is on for this probe", uiOn);

  const classes = await getText("/classes");
  const pricing = await getText("/pricing");
  const member = await getText("/member");
  const login = await getText("/login?return=/classes");
  check("classes page reachable", classes.status === 200);
  check("pricing page reachable", pricing.status === 200);
  check("member page reachable", member.status === 200);
  check("login return=/classes reachable", login.status === 200);

  const classesHref = headerMembersHref(classes.text);
  const pricingHref = headerMembersHref(pricing.text);
  check(
    "classes header Members goes to AMARÉ /login",
    /login/.test(classesHref) && /return=/.test(classesHref) && /classes/.test(decodeURIComponent(classesHref)),
    classesHref,
  );
  check(
    "pricing header Members goes to AMARÉ /login",
    /login/.test(pricingHref) && /return=/.test(pricingHref) && /pricing/.test(decodeURIComponent(pricingHref)),
    pricingHref,
  );
  check("login page is Email OTP primary", login.text.includes("AMARÉ LOGIN") && login.text.includes("amare-login-continue"));
  check("Mindbody fallback visible on login", login.text.includes("Already use Mindbody with AMARÉ?") && login.text.includes("Sign in with Mindbody"));
  check("Google/Apple hidden on login and classes", !/Continue with Google|Continue with Apple|Sign in with Google|Sign in with Apple/i.test(login.text + classes.text));
  check("classes Book copy still Mindbody", classes.text.includes("Sign in with Mindbody") || classes.text.includes("mb-auth-strip"));
  check("member page still has Mindbody gate", member.text.includes("data-mb-gate") && member.text.includes("/api/mindbody/oauth/start"));
  check("member page does not treat AMARÉ session as loaded dashboard", member.text.includes("Loading your account") && member.text.includes("data-mb-content hidden"));

  let email = (process.env.AMARE_OTP_E2E_EMAIL || "").trim().toLowerCase();
  if (!email) {
    try {
      const { stdout } = await execFileAsync("git", ["config", "user.email"], { cwd: root, windowsHide: true });
      email = String(stdout || "").trim().toLowerCase();
    } catch {
      email = "";
    }
  }
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  if (!email || pepper.length < 24) {
    check("return-flow inbox available", false, "set AMARE_OTP_E2E_EMAIL");
    throw new Error("e2e_email_missing");
  }

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  recoverOtpFromHash.hashOtpCode = hashOtpCode;
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  const req1 = await postJson("/api/amare/auth/email/request-code", { email });
  check("request-code generic success", req1.status === 200 && req1.json?.ok === true);
  if (req1.status !== 200) throw new Error("request_failed");
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
  const code = recoverOtpFromHash(email, String(row.rows[0]?.code_hash || ""), pepper);
  check("OTP recovered", Boolean(code));
  const ver = await postJson("/api/amare/auth/email/verify-code", { email, code });
  check("Email OTP issued amare_sess", ver.status === 200 && /amare_sess=/.test(ver.cookie));
  const sess = await getJson("/api/amare/auth/session", ver.cookie);
  check("AMARÉ session signed in after login", sess.json?.signedIn === true);
  const mb = await getJson("/api/mindbody/oauth/session", ver.cookie);
  check(
    "Mindbody session still independent after AMARÉ login",
    mb.status === 200 && (mb.json?.authenticated === false || mb.json?.loggedIn === false),
  );
  const memberAuthed = await fetch(`${ORIGIN}/member`, { headers: { cookie: ver.cookie } });
  const memberHtml = await memberAuthed.text();
  check("member.html with amare_sess only still ships Mindbody gate, not a loaded dashboard", memberHtml.includes("data-mb-gate") && memberHtml.includes("data-mb-content hidden"));
  check("safe return path /classes is accepted by login page", login.text.includes("amare-auth.js"));

  await closeIdentityDb();
} catch (err) {
  check("2A.7a live entry E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ 2A.7a live entry check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.7a live entry checks passed.");
