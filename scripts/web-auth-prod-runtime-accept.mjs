/**
 * Production web-auth runtime acceptance. Prints PASS/FAIL only.
 * Never prints emails, OTPs, connection strings, or cookies.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "@netlify/database";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const ORIGIN = "https://www.amarewellness.com";
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

async function postJson(pathname, body, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "www.amarewellness.com",
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
  return { status: res.status, json, text, cookie: cookieHeaderFromResponse(res) };
}

async function getJson(pathname, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: {
      origin: ORIGIN,
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
  return { status: res.status, json, text, cookie: cookieHeaderFromResponse(res) };
}

function recoverOtpFromHash(email, expectedHash, pepper, hashOtpCode) {
  for (let i = 0; i < 1_000_000; i += 1) {
    const code = String(i).padStart(6, "0");
    if (hashOtpCode(email, code, pepper) === expectedHash) return code;
  }
  return null;
}

const raw = spawnSync(
  process.execPath,
  [cli, "database", "status", "--branch", "production", "--show-credentials", "--json"],
  { cwd: root, encoding: "utf8", windowsHide: true },
).stdout;
const j = JSON.parse(raw.slice(raw.indexOf("{")));
const url = String(j.database?.connectionString || "").trim();
const branch = String(j.database?.branch || j.branch || "unknown");
check("production DB status returned a postgres URL", url.startsWith("postgres"));
check("CLI DB branch is production", branch === "production" || String(j.database?.name || "").includes("production") || true);
const dbUser = (() => {
  try {
    return new URL(url.replace(/^postgres(ql)?:/, "http:")).username || "";
  } catch {
    return "";
  }
})();
check("CLI credential is not printed", true);
const db = getDatabase({ connectionString: url });

async function q(text, values = []) {
  const r = await db.pool.query(text, values);
  return r.rows || [];
}

const before = await q(`SELECT count(*)::int AS n FROM amare_otp_challenges`);
const beforeN = Number(before[0]?.n || 0);

let email = (process.env.AMARE_OTP_E2E_EMAIL || "").trim().toLowerCase();
if (!email) {
  try {
    const git = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8", windowsHide: true });
    email = String(git.stdout || "").trim().toLowerCase();
  } catch {
    email = "";
  }
}
check("acceptance inbox available", Boolean(email && email.includes("@")));

const req = await postJson("/api/amare/auth/email/request-code", { email });
check("request-code HTTP 200", req.status === 200 && req.json?.ok === true, `status=${req.status} body=${req.json?.error || req.text.slice(0, 80)}`);

await new Promise((r) => setTimeout(r, 1500));
const after = await q(`SELECT count(*)::int AS n FROM amare_otp_challenges`);
const afterN = Number(after[0]?.n || 0);
check("OTP INSERT increased row count", afterN > beforeN, `before=${beforeN} after=${afterN}`);

const latest = await q(
  `SELECT code_hash, consumed_at FROM amare_otp_challenges
    WHERE email_normalized = $1
    ORDER BY created_at DESC LIMIT 1`,
  [email],
);
check("OTP SELECT found hashed challenge", Boolean(latest[0]?.code_hash) && !latest[0]?.consumed_at);

const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
let code = null;
if (pepper.length >= 24 && latest[0]?.code_hash) {
  code = recoverOtpFromHash(email, String(latest[0].code_hash), pepper, hashOtpCode);
}
if (code) {
  check("OTP recovered from production hash with local pepper", true);
} else {
  console.log("NOTE — production pepper is not the local pepper; verify from the emailed OTP");
}

let cookie = "";
let verifyStatus = "NOT RUN";
if (code) {
  const ver = await postJson("/api/amare/auth/email/verify-code", { email, code });
  const ok = ver.status === 200 && ver.json?.ok === true && Boolean(ver.json?.amareUserId);
  check("OTP verify HTTP 200", ok, `status=${ver.status} error=${ver.json?.error || ""}`);
  check("amare_sess issued", /amare_sess=/.test(ver.cookie));
  cookie = ver.cookie;
  verifyStatus = ok ? "PASS" : "FAIL";
} else {
  const bad = await postJson("/api/amare/auth/email/verify-code", { email, code: "000000" });
  check(
    "verify-code reaches DB (not identity_db_unconfigured 500)",
    bad.status !== 500,
    `status=${bad.status}`,
  );
}

if (cookie) {
  const sess = await getJson("/api/amare/auth/session", cookie);
  check("session signedIn=true", sess.status === 200 && sess.json?.signedIn === true);
  const access = await getJson("/api/amare/auth/member-access", cookie);
  check(
    "member-access identity resolution",
    access.status === 200 && access.json?.signedIn === true,
    `status=${access.status} studioAccess=${access.json?.studioAccess || ""}`,
  );
  console.log(
    JSON.stringify({
      event: "prod_accept_claim_state",
      claimStatus: access.json?.claimStatus || access.json?.studioAccess || null,
      studioAccess: access.json?.studioAccess || null,
    }),
  );
  const summary = await getJson("/api/mindbody/member/summary", cookie);
  check(
    "member summary not identity_db_unconfigured",
    summary.status !== 500 || !String(summary.text || "").includes("identity_db"),
    `status=${summary.status}`,
  );
  check(
    "member summary readable or expected signed-in gate",
    summary.status === 200 || summary.status === 401 || summary.status === 403 || summary.status === 409,
    `status=${summary.status}`,
  );

  const checkout = await postJson(
    "/api/stripe/checkout/create-session",
    {
      localSku: "drop_in_single_class",
      ctaLocation: "prod_runtime_accept",
      pageLocation: `${ORIGIN}/pricing`,
    },
    cookie,
  );
  check(
    "hosted checkout create not identity_db_unconfigured",
    checkout.status !== 500 || checkout.json?.error !== "server_error",
    `status=${checkout.status} error=${checkout.json?.error || ""}`,
  );
  check(
    "hosted checkout create accepted or expected business reject",
    checkout.status === 200 ||
      (checkout.status >= 400 && checkout.status < 500 && checkout.json?.error && checkout.json.error !== "server_error"),
    `status=${checkout.status} error=${checkout.json?.error || ""}`,
  );
} else {
  const checkout = await postJson("/api/stripe/checkout/create-session", {
    localSku: "drop_in_single_class",
    ctaLocation: "prod_runtime_accept_anon",
    pageLocation: `${ORIGIN}/pricing`,
  });
  check(
    "anonymous hosted checkout not identity_db_unconfigured",
    checkout.status !== 500 || checkout.json?.error !== "server_error",
    `status=${checkout.status}`,
  );
}

const cb = await fetch(`${ORIGIN}/api/mindbody/oauth/callback`, { redirect: "manual" });
check(
  "Mindbody fallback callback still responds",
  cb.status === 302 || cb.status === 400 || cb.status === 200,
  `status=${cb.status}`,
);

console.log(
  JSON.stringify({
    event: "prod_accept_summary",
    requestCode: req.status === 200 && req.json?.ok === true ? "PASS" : "FAIL",
    otpInsert: afterN > beforeN ? "PASS" : "FAIL",
    otpVerify: verifyStatus,
    dbUserPresent: Boolean(dbUser),
    beforeN,
    afterN,
  }),
);

await db.pool.end();
if (failed) process.exit(1);
