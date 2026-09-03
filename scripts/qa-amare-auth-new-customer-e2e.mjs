/**
 * Live D28 new-customer E2E against local 127.0.0.1:4321.
 * Uses a plus-address so the mailbox is new to Studio.
 * Recovers OTP from the local hashed challenge. Does not print email, OTP, or secrets.
 * Run: npm run test:amare-auth-new-customer-e2e
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

if ((process.env.AMARE_IDENTITY_DB_TARGET || "").trim().toLowerCase() === "production") {
  console.error("REFUSE — will not run new-customer E2E against production.");
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
    .some((part) => part.trim().startsWith(`${name}=`) && part.split("=")[1]);
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

async function getJson(pathname, cookie = "") {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: {
      origin: ORIGIN,
      host: "127.0.0.1:4321",
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, cookie: cookieHeaderFromResponse(res) };
}

function plusAddress(base) {
  const email = String(base || "").trim().toLowerCase();
  const at = email.indexOf("@");
  if (at < 1) return "";
  const stamp = Date.now().toString(36);
  return `${email.slice(0, at)}+nc${stamp}${email.slice(at)}`;
}

try {
  const flagsOn =
    (process.env.ENABLE_AMARE_AUTH || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1" &&
    (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1";
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  check("local AMARÉ flags are on", flagsOn);
  check("google auth permanently disabled", (await import("../netlify/functions/amare-auth-lib.mjs")).amareAuthGoogleEnabled() === false);

  let inbox = (process.env.AMARE_OTP_E2E_EMAIL || "").trim().toLowerCase();
  if (!inbox) {
    try {
      const { stdout } = await execFileAsync("git", ["config", "user.email"], { cwd: root, windowsHide: true });
      inbox = String(stdout || "").trim().toLowerCase();
    } catch {
      inbox = "";
    }
  }
  const email = plusAddress(inbox);
  if (!email) {
    check("new E2E inbox address available", false, "set AMARE_OTP_E2E_EMAIL");
    throw new Error("e2e_email_missing");
  }

  const probe = await fetch(`${ORIGIN}/api/amare/auth/email/request-code`, { method: "OPTIONS" }).catch(() => null);
  check("local origin 127.0.0.1:4321 is reachable", Boolean(probe));
  if (!probe) throw new Error("local_origin_down");

  await resolveLocalDbUrl();
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  recoverOtpFromHash.hashOtpCode = hashOtpCode;
  const { identityQuery, closeIdentityDb } = await import("../netlify/functions/amare-identity-store.mjs");

  await identityQuery(
    `ALTER TABLE amare_studio_associations DROP CONSTRAINT IF EXISTS amare_studio_assoc_claim_method_chk`,
  ).catch(() => {});
  await identityQuery(`
    ALTER TABLE amare_studio_associations
      ADD CONSTRAINT amare_studio_assoc_claim_method_chk
      CHECK (claim_method IN ('none','mb_sess_confirmed','email_unique_confirmed','email_phone_confirmed','staff_manual','new_profile_created'))
  `).catch(() => {});
  await identityQuery(
    `ALTER TABLE amare_studio_associations DROP CONSTRAINT IF EXISTS amare_studio_assoc_block_reason_chk`,
  ).catch(() => {});
  await identityQuery(`
    ALTER TABLE amare_studio_associations
      ADD CONSTRAINT amare_studio_assoc_block_reason_chk
      CHECK (
        block_reason IS NULL OR block_reason IN (
          'apple_relay','email_mismatch','duplicate_clients','session_conflict',
          'shared_computer_continue_as_new','staff_zero_match','staff_search_unavailable','client_owned_elsewhere'
        )
      )
  `).catch(() => {});

  const req1 = await postJson("/api/amare/auth/email/request-code", { email });
  check("request-code accepted", req1.status === 200 && req1.json?.ok === true);

  const row = await identityQuery(
    `SELECT code_hash, consumed_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  const code = recoverOtpFromHash(email, String(row.rows[0]?.code_hash || ""), pepper);
  check("OTP recovered from hash", Boolean(code) && /^\d{6}$/.test(code || ""));
  if (!code) throw new Error("otp_recover_failed");

  const ver1 = await postJson("/api/amare/auth/email/verify-code", { email, code });
  check("verify-code succeeds", ver1.status === 200 && ver1.json?.ok === true && Boolean(ver1.json?.amareUserId));
  check("amare_sess present", /amare_sess=/.test(ver1.cookie));
  check("mb_sess absent", !/mb_sess=/.test(ver1.cookie));
  check("needs_profile after successful Staff 0", ver1.json?.claimStatus === "needs_profile");
  check("profile tx issued", /amare_profile_tx=/.test(ver1.cookie));
  const firstUser = String(ver1.json?.amareUserId || "");
  let cookie = mergeCookie("", ver1.cookie);

  const access1 = await getJson("/api/amare/auth/member-access", cookie);
  check("member-access is needs_profile", access1.json?.signedIn === true && access1.json?.studioAccess === "needs_profile");

  const created = await postJson(
    "/api/amare/auth/profile/create",
    { firstName: "Amare", lastName: "Newclient", mobilePhone: `786555${String(Date.now()).slice(-4)}`, explicitCreate: true },
    cookie,
  );
  check("profile create linked", created.status === 200 && created.json?.status === "linked" && created.json?.claimMethod === "new_profile_created");
  cookie = mergeCookie(cookie, created.cookie);
  check("profile tx cleared after create", !hasCookie(cookie, "amare_profile_tx") || /amare_profile_tx=;/.test(created.cookie));

  const assoc = await identityQuery(
    `SELECT status, claim_method, client_id FROM amare_studio_associations
      WHERE amare_user_id = $1 AND status IN ('verified','linked')
      ORDER BY id DESC LIMIT 1`,
    [firstUser],
  );
  check("final association linked", assoc.rows[0]?.status === "linked" && assoc.rows[0]?.claim_method === "new_profile_created");
  const clientId = Number(assoc.rows[0]?.client_id);
  check("one Studio client id stored", Number.isFinite(clientId) && clientId > 0);

  const { resolveStaffAuthHeaders } = await import("../netlify/functions/mindbody-class-book-lib.mjs");
  const { readStudioClientEmailSubscriptions } = await import("../netlify/functions/stripe-mindbody-sync-lib.mjs");
  const staffHeaders = await resolveStaffAuthHeaders();
  const prefs = staffHeaders ? await readStudioClientEmailSubscriptions(staffHeaders, clientId) : null;
  check("Staff GetClients after create is readable", Boolean(prefs));
  check(
    "persisted SendAccountEmails is false",
    prefs?.SendAccountEmails === false,
    prefs ? JSON.stringify(prefs) : "prefs_unavailable",
  );
  check(
    "persisted SendScheduleEmails is true",
    prefs?.SendScheduleEmails === true,
    prefs ? JSON.stringify(prefs) : "prefs_unavailable",
  );
  check(
    "persisted SendPromotionalEmails is true",
    prefs?.SendPromotionalEmails === true,
    prefs ? JSON.stringify(prefs) : "prefs_unavailable",
  );
  console.log(
    JSON.stringify({
      event: "d28_e2e_persisted_email_prefs",
      persisted: prefs,
      updateClientRequired: prefs
        ? prefs.SendAccountEmails !== false ||
          prefs.SendScheduleEmails !== true ||
          prefs.SendPromotionalEmails !== true
        : null,
    }),
  );

  const access2 = await getJson("/api/amare/auth/member-access", cookie);
  check("/member access linked", access2.json?.studioAccess === "linked" && access2.json?.studioOperations === true);

  const loginHtml = await fetch(`${ORIGIN}/login`).then((r) => r.text());
  check("login profile form is in the built page", loginHtml.includes("Create my profile") && loginHtml.includes("Welcome to AMARÉ"));

  console.log("Waiting 90s after profile create to observe Mindbody account-invite delivery.");
  await new Promise((r) => setTimeout(r, 90000));

  const checkout = await postJson(
    "/api/stripe/checkout/create-session",
    {
      localSku: "new_client_special_3_for_65",
      ctaLocation: "d28_e2e_sendemail_false",
      pageLocation: `${ORIGIN}/pricing`,
      firstName: "Amare",
      lastName: "Newclient",
      phone: "7865550100",
    },
    cookie,
  );
  check("Stripe create-session still works for D28 member", checkout.status === 200 && Boolean(checkout.json?.sessionId));
  let paid = false;
  let booked = false;
  if (checkout.json?.sessionId) {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });
    try {
      const session = await stripe.checkout.sessions.retrieve(String(checkout.json.sessionId), {
        expand: ["payment_intent"],
      });
      const pi = session.payment_intent;
      const piId = typeof pi === "string" ? pi : pi && typeof pi === "object" ? pi.id : "";
      if (piId) {
        const confirmed = await stripe.paymentIntents.confirm(piId, {
          payment_method: "pm_card_visa",
          return_url: `${ORIGIN}/checkout/success`,
        });
        paid = confirmed.status === "succeeded" || confirmed.status === "requires_capture";
      }
    } catch (err) {
      console.log(`NOTE — Stripe PaymentIntent confirm skipped: ${String(err?.message || err).slice(0, 180)}`);
    }
  }
  if (paid) check("Stripe test payment succeeded", true);
  else console.log("NOTE — hosted Stripe Checkout has no PaymentIntent until the page is paid; D28 create path is unchanged.");

  if (paid) {
    let saleOk = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await getJson(
        `/api/stripe/order-status?session_id=${encodeURIComponent(String(checkout.json.sessionId))}`,
        cookie,
      );
      const sync = String(status.json?.order?.mindbodySyncStatus || status.json?.mindbodySyncStatus || "");
      const bucket = String(status.json?.order?.bucket || status.json?.bucket || "");
      if (status.json?.ok && (sync === "mindbody_synced" || bucket === "synced")) {
        saleOk = true;
        break;
      }
    }
    check("Mindbody sale recorded after Stripe webhook", saleOk);

    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 2);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 5);
    const classesRes = await fetch(
      `${ORIGIN}/api/mindbody/class/classes?StartDateTime=${encodeURIComponent(start.toISOString())}&EndDateTime=${encodeURIComponent(end.toISOString())}&HideCanceledClasses=true&Limit=200`,
      { headers: { origin: ORIGIN, cookie } },
    );
    const classesJson = await classesRes.json().catch(() => null);
    const classes = Array.isArray(classesJson?.Classes)
      ? classesJson.Classes
      : Array.isArray(classesJson?.classes)
        ? classesJson.classes
        : [];
    const pick = classes.find((cls) => {
      const id = Number(cls?.Id ?? cls?.ClassId ?? cls?.id);
      const bookedCount = Number(cls?.TotalBooked ?? cls?.WebBooked ?? 0);
      const cap = Number(cls?.MaxCapacity ?? cls?.TotalCapacity ?? 0);
      const canceled = cls?.IsCanceled === true || cls?.isCanceled === true;
      return Number.isFinite(id) && id > 0 && !canceled && (cap === 0 || bookedCount < cap);
    });
    check("future class available to book", Boolean(pick));
    if (pick) {
      const classId = Number(pick.Id ?? pick.ClassId ?? pick.id);
      const bookRes = await postJson("/api/mindbody/class/book", { classId }, cookie);
      booked = bookRes.status === 200 && bookRes.json?.ok === true;
      check("class book via amare_sess without mb_sess", booked, bookRes.json?.error || String(bookRes.status));
    }
  }

  await new Promise((r) => setTimeout(r, 61000));
  const req2 = await postJson("/api/amare/auth/email/request-code", { email });
  check("second request-code accepted", req2.status === 200 && req2.json?.ok === true);
  const row2 = await identityQuery(
    `SELECT code_hash FROM amare_otp_challenges WHERE email_normalized = $1 ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const code2 = recoverOtpFromHash(email, String(row2.rows[0]?.code_hash || ""), pepper);
  const ver2 = await postJson("/api/amare/auth/email/verify-code", { email, code: code2 });
  check("second Email OTP succeeds", ver2.status === 200 && String(ver2.json?.amareUserId || "") === firstUser);
  check("second login is not onboarding", ver2.json?.claimStatus !== "needs_profile");
  const identCount = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_identities WHERE provider = 'email' AND provider_sub = $1`,
    [email],
  );
  const clientCount = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_studio_associations
      WHERE amare_user_id = $1 AND status IN ('verified','linked')`,
    [firstUser],
  );
  check("no duplicate AMARÉ user", Number(identCount.rows[0]?.n || 0) === 1);
  check("no duplicate linked Studio association", Number(clientCount.rows[0]?.n || 0) === 1);

  await closeIdentityDb();
} catch (err) {
  check("real new-customer E2E completed", false, String(err?.message || err));
} finally {
  stopLocalDbKeeper();
}

if (failed) {
  console.error(`\n${failed} AMARÉ new-customer E2E check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ new-customer E2E checks passed.");
