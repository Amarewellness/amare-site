/**
 * Static QA + optional live Resend smoke for member class booking confirmation email.
 * Run: node scripts/qa-class-book-email-smoke.mjs
 * Live send (optional): node scripts/qa-class-book-email-smoke.mjs --send
 *
 * Default is rendering/static QA only — no Resend call.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const envPath = new URL("../.env", import.meta.url);
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

const SEND_LIVE = process.argv.includes("--send");
const STUDIO_TZ = "America/New_York";
const STUDIO_SITE = "https://www.amarewellness.com";
const STUDIO_NAME = "AMARÉ Wellness Studio";

function firstValidEmail(raw) {
  const parts = String(raw || "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const m = part.match(/<?([^\s<>]+@[^\s>,]+)>?/);
    if (m?.[1]?.includes("@")) return m[1].trim();
  }
  return "";
}

function resolveSmokeRecipient() {
  for (const key of [
    "CLASS_BOOK_EMAIL_SMOKE_TO",
    "AMARE_OTP_E2E_EMAIL",
    "QA_EMAIL_TO",
  ]) {
    const email = firstValidEmail(process.env[key]);
    if (email) return { email, source: key };
  }
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (email.includes("@")) return { email, source: "git config user.email" };
  } catch {
    /* ignore */
  }
  const adminTo = firstValidEmail(process.env.SMS_ADMIN_REPORT_TO);
  if (adminTo) return { email: adminTo, source: "SMS_ADMIN_REPORT_TO (first address)" };
  return { email: "", source: null };
}

/** Same algorithm as guest-pass-emails.mjs */
function mindbodyInstantToUtcMs(isoLike) {
  if (isoLike == null || typeof isoLike !== "string") return NaN;
  const raw = isoLike.trim();
  if (!raw) return NaN;
  if (/[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
  if (!mm) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const y = +mm[1],
    mo = +mm[2],
    d = +mm[3],
    h = +mm[4],
    mi = +mm[5];
  const se = mm[6] != null ? +mm[6] : 0;
  let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 48; i++) {
    const parts = fmt.formatToParts(new Date(t));
    const num = (typ) => parseInt(parts.find((p) => p.type === typ)?.value || "0", 10);
    const yy = num("year"),
      MM = num("month"),
      dd = num("day"),
      HH = num("hour"),
      mmm = num("minute"),
      ss = num("second");
    if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
    t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
    if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
  }
  return NaN;
}

function formatPlainWhen(isoLike) {
  const ms = mindbodyInstantToUtcMs(isoLike);
  if (!Number.isFinite(ms)) return { dateLine: "", timeLine: "" };
  const d = new Date(ms);
  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    weekday: "long",
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const timeLine = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return { dateLine, timeLine };
}

const fixture = {
  memberFirstName: "Nadejda",
  className: "Athletic Reformer (Intermediate)",
  classStartDateTime: "2026-09-15T09:00:00",
  instructor: "Regan Hibbs",
};

let failed = 0;

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = "") {
  if (!ok) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    if (detail) console.log(`  ${detail}`);
    return;
  }
  console.log(`PASS — ${name}`);
}

console.log("=== Member class booking confirmation — static template QA ===\n");

const { buildMemberClassBookingConfirmationEmail } = await import(
  "../netlify/functions/guest-pass-emails.mjs"
);

const built = buildMemberClassBookingConfirmationEmail(fixture);
const html = built.html;
const subject = built.subject;
const preview = built.preview;

const when = formatPlainWhen(fixture.classStartDateTime);

console.log(`Subject: ${subject}`);
console.log(`Preview: ${preview}`);
console.log(`Class: ${fixture.className}`);
console.log(`Instructor: ${fixture.instructor}`);
console.log(`When: ${when.dateLine} / ${when.timeLine}\n`);

check("Subject includes class name and date/time", subject.includes(fixture.className) && /9\/15\/2026/.test(subject));
check("Preview includes instructor", preview.includes("Regan Hibbs"));
check("Contains label: You're confirmed", html.includes("You&rsquo;re confirmed"));
check("Contains headline: You're booked, Nadejda.", html.includes("You&rsquo;re booked, Nadejda."));
check("Contains class name", html.includes("Athletic Reformer (Intermediate)"));
check("Contains instructor", html.includes("Regan Hibbs"));
check("Contains Tuesday, 9/15/2026", html.includes("Tuesday, 9/15/2026"));
check("Contains 9:00 AM", /9:00\s*AM/.test(html));
check("Contains fifteen minutes early", html.includes("fifteen minutes early"));
check(
  "Contains cancellation instruction",
  html.includes("cancel from your account") &&
    html.includes("released to a standby student"),
);
check("CTA: View my schedule", html.includes("View my schedule"));
check("Fallback URL visible", html.includes("Button not working? Open this link instead:") && html.includes(`${STUDIO_SITE}/classes`));
check("Signoff preserved", html.includes("See you soon,") && html.includes(`The ${STUDIO_NAME} Team`));

check("Does NOT contain ten minutes early", !html.includes("ten minutes early"));
check("Does NOT contain What to bring", !html.includes("What to bring"));
check("Does NOT contain Reformer grip socks packing copy", !html.includes("Grip socks"));
check("Does NOT contain Mat towel packing copy", !html.includes("long towel"));
check("Does NOT contain Kangoo boots packing copy", !html.includes("Kangoo classes"));
check('Does NOT use "your class" fallback', !html.includes("your class"));
check('Does NOT use "You\'re booked, there." headline', !html.includes("You&rsquo;re booked, there."));

console.log("\n=== Desktop structure / typography ===\n");

check("Desktop container max-width 600px", html.includes("max-width:600px"));
check("Desktop headline baseline 30px", html.includes("font-size:30px"));
check("Member shell uses responsive viewport meta", html.includes('name="viewport" content="width=device-width, initial-scale=1.0"'));

console.log("\n=== Mobile @media (max-width: 480px) ===\n");

check("Mobile media query present", html.includes("@media only screen and (max-width: 480px)"));
check("Mobile .outer-pad 8px horizontal", /\.outer-pad[\s\S]{0,120}padding-left:\s*8px/.test(html));
check("Mobile .mobile-pad 20px horizontal", /\.mobile-pad[\s\S]{0,120}padding-left:\s*20px/.test(html));
check("Mobile .mobile-card-inner 18px horizontal", /\.mobile-card-inner[\s\S]{0,120}padding-left:\s*18px/.test(html));
check("Mobile .mobile-h1 20px", /\.mobile-h1[\s\S]{0,120}font-size:\s*20px/.test(html));
check("Mobile .mobile-body 12px", /\.mobile-body[\s\S]{0,120}font-size:\s*12px/.test(html));
check("Mobile .mobile-detail 12px", /\.mobile-detail[\s\S]{0,120}font-size:\s*12px/.test(html));
check("Mobile .mobile-label 8px", /\.mobile-label[\s\S]{0,120}font-size:\s*8px/.test(html));
check("Mobile .mobile-cta 11px + compact padding", /\.mobile-cta[\s\S]{0,160}font-size:\s*11px/.test(html) && /\.mobile-cta[\s\S]{0,200}padding:\s*12px 24px/.test(html));
check("Mobile .mobile-footer 10px", /\.mobile-footer[\s\S]{0,120}font-size:\s*10px/.test(html));
check("Mobile .mobile-sig 13px", /\.mobile-sig[\s\S]{0,120}font-size:\s*13px/.test(html));

console.log("\n=== Headline fallback ===\n");

const noName = buildMemberClassBookingConfirmationEmail({
  ...fixture,
  memberFirstName: "",
}).html;
check("Missing firstName → You're booked.", noName.includes("You&rsquo;re booked.</h1>") || noName.includes(">You&rsquo;re booked.</h1>"));
check("Missing firstName does not include comma headline", !noName.includes("You&rsquo;re booked, "));

console.log("\n=== Guest / BAF isolation ===\n");

const emailSrc = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../netlify/functions/guest-pass-emails.mjs", import.meta.url), "utf8"),
);
check(
  "Guest booking still uses wrapReservationEmail (not member shell)",
  emailSrc.includes("sendGuestBookingConfirmationEmail") &&
    emailSrc.match(/sendGuestBookingConfirmationEmail[\s\S]{0,900}wrapReservationEmail/) &&
    !emailSrc.match(/sendGuestBookingConfirmationEmail[\s\S]{0,900}wrapMemberReservationEmail/),
);
check(
  "Guest booking still includes What to bring",
  emailSrc.match(/sendGuestBookingConfirmationEmail[\s\S]{0,900}whatToBringBlock/),
);
check(
  "Member builder uses wrapMemberReservationEmail only",
  emailSrc.match(/buildMemberClassBookingConfirmationEmail[\s\S]{0,900}wrapMemberReservationEmail/),
);

if (failed) {
  console.log(`\n${failed} static template check(s) failed`);
  process.exit(1);
}

console.log("\nAll static template checks passed.");

if (!SEND_LIVE) {
  console.log("\nLive Resend send skipped (use --send to deliver one test email).");
  process.exit(0);
}

const recipient = resolveSmokeRecipient();
if (!recipient.email) {
  console.error("\nFAIL — --send requires CLASS_BOOK_EMAIL_SMOKE_TO or similar");
  process.exit(1);
}
if (!(process.env.RESEND_API_KEY || "").trim()) {
  console.error("\nFAIL — --send requires RESEND_API_KEY");
  process.exit(1);
}

console.log(`\n=== Live Resend send to ${recipient.source} ===\n`);

const { sendMemberClassBookingConfirmationEmail } = await import(
  "../netlify/functions/guest-pass-emails.mjs"
);

const result = await sendMemberClassBookingConfirmationEmail({
  ...fixture,
  memberEmail: recipient.email,
});

if (!result.ok) {
  console.error(`FAIL — Resend error: ${result.error || "unknown"}`);
  process.exit(1);
}

console.log(`Resend accepted — message id: ${result.messageId || "(none)"}`);
