/**
 * Live 2B member-read probe against http://127.0.0.1:4321
 * Run: node scripts/qa-amare-auth-2b-e2e.mjs
 *
 * PATH B (Email OTP) only. PATH A (Mindbody OAuth) remains a manual browser gate.
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
      throw new Error("refusing non-local database URL for 2B E2E");
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

function countRows(root, keys) {
  if (!root || typeof root !== "object") return 0;
  for (const key of keys) {
    if (Array.isArray(root[key])) return root[key].length;
  }
  return 0;
}

try {
  const flagsOn =
    (process.env.ENABLE_AMARE_AUTH || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_MEMBER_READ || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_STUDIO_OPERATIONS || "").trim() === "1";
  check("local 2B flags are on (auth + email OTP + member-read + studio-ops)", flagsOn);
  if (!flagsOn) throw new Error("2b_flags_off");

  const loginRes = await fetch(`${ORIGIN}/login`).catch(() => null);
  check("login page is reachable on 127.0.0.1:4321", Boolean(loginRes?.ok));
  if (!loginRes?.ok) throw new Error("login_page_down");

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
    check("E2E inbox address available", false, "set AMARE_OTP_E2E_EMAIL");
    throw new Error("e2e_email_missing");
  }

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  recoverOtpFromHash.hashOtpCode = hashOtpCode;
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  const req1 = await postJson("/api/amare/auth/email/request-code", { email });
  check("request-code generic success", req1.status === 200 && req1.json?.ok === true, `status=${req1.status}`);
  if (req1.status === 404) throw new Error("email_otp_route_unavailable_restart_4321");
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
  let cookie = ver.cookie;
  if (ver.json?.status === "pending_attach" || ver.json?.claimStatus === "candidate") {
    const confirm = await postJson("/api/amare/auth/claim/confirm", { explicitConfirm: true }, cookie);
    check("explicit claim confirm accepted", confirm.status === 200 && confirm.json?.ok === true);
    cookie = mergeCookie(cookie, confirm.cookie);
  }

  const sess = await getJson("/api/amare/auth/session", cookie);
  check("AMARÉ session signed in after Email OTP", sess.json?.signedIn === true && typeof sess.json?.amareUserId === "string");
  check(
    "session GET has no clientId",
    sess.json && !("clientId" in sess.json) && !("client_id" in sess.json) && !("studioAccess" in sess.json),
  );

  let access = await getJson("/api/amare/auth/member-access", cookie);
  check("member-access reachable", access.status === 200 && access.json?.signedIn === true);
  check(
    "member-access has no clientId",
    access.json && !("clientId" in access.json) && !("client_id" in access.json),
  );

  if (access.json?.studioAccess === "verified_pending_link") {
    const linked = await postJson("/api/amare/auth/association/link", { explicitPromote: true }, cookie);
    check("explicit verified → linked accepted", linked.status === 200 && linked.json?.status === "linked");
    check("link response has no clientId", linked.json && !("clientId" in linked.json) && !("client_id" in linked.json));
    access = await getJson("/api/amare/auth/member-access", cookie);
  }

  const studioAccess = access.json?.studioAccess || "none";
  check(
    "PATH B studioAccess is linked or an honest non-authorized state",
    ["linked", "verified_pending_link", "none", "conflict"].includes(studioAccess),
    `studioAccess=${studioAccess}`,
  );

  if (studioAccess === "linked") {
    check("PATH B studioOperations enabled without mb_sess", access.json?.studioOperations === true);
    const bookProbe = await postJson("/api/mindbody/class/book", { classId: 1 }, cookie);
    check(
      "PATH B book does not require mb_sess or Consumer link",
      bookProbe.status !== 401 && bookProbe.json?.error !== "studio_not_linked" && bookProbe.json?.error !== "not_authenticated",
      `status=${bookProbe.status} error=${bookProbe.json?.error || ""}`,
    );
    const summary = await getJson("/api/mindbody/member/summary", cookie);
    check("PATH B member/summary authorized without mb_sess", summary.status === 200 && summary.json?.ok === true);
    if (summary.json?.ok) {
      const credits = Number(summary.json?.wallet?.classCredits ?? summary.json?.classCredits ?? 0);
      const packs = countRows(summary.json?.clientServices, ["ClientServices", "Services", "clientServices"]);
      const mems = countRows(summary.json?.memberships, ["ClientMemberships", "Memberships", "memberships"]);
      const visits = countRows(summary.json?.clientVisits, ["Visits", "visits"]);
      check("PATH B summary has member-data shape", Number.isFinite(credits) && packs >= 0 && mems >= 0 && visits >= 0);
    }
    const users = await identityQuery(
      `SELECT a.amare_user_id, a.status, a.client_id
         FROM amare_studio_associations a
        WHERE a.amare_user_id = $1 AND a.status = 'linked'`,
      [sess.json.amareUserId],
    );
    check("PATH B one linked association for this AMARÉ user", users.rows.length === 1);
    const owners = await identityQuery(
      `SELECT amare_user_id FROM amare_studio_associations
        WHERE system = 'mindbody' AND site_id = $1 AND client_id = $2 AND status IN ('verified', 'linked')`,
      [String(process.env.MINDBODY_SITE_ID || "").trim(), users.rows[0]?.client_id],
    );
    check("PATH B no duplicate Studio client owner", owners.rows.length === 1);
  } else {
    check(
      "PATH B does not silently invent Studio authorization",
      studioAccess === "none" || studioAccess === "verified_pending_link",
      `studioAccess=${studioAccess}`,
    );
    console.log(
      "PATH B member-data parity: PENDING — this inbox has no linked Studio association. Manual QA must use a real existing studio customer.",
    );
  }

  const mb = await getJson("/api/mindbody/oauth/session", cookie);
  check(
    "Mindbody session still independent after AMARÉ login",
    mb.status === 200 && (mb.json?.authenticated === false || mb.json?.loggedIn === false),
  );

  await closeIdentityDb();
} catch (err) {
  check("2B live Email OTP member-read E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ 2B live check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2B live Email OTP member-read checks passed.");
console.log("PATH A (real Mindbody OAuth) remains a manual browser gate.");
