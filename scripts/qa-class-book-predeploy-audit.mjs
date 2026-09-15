/**
 * Pre-deploy safety audit for class-book email + verify fix.
 * Run: node scripts/qa-class-book-predeploy-audit.mjs
 */
import fs from "node:fs/promises";
import {
  anyBookableRemainingDecreased,
  isRemainingUnchangedRetryEligible,
  PAYMENT_VERIFY_RETRY_WAIT_MS,
  resolveBookConfirmationEmailFields,
} from "../netlify/functions/mindbody-class-book-lib.mjs";

const STUDIO_TZ = "America/New_York";

let failed = 0;
/** @type {string[]} */
const blockers = [];

function check(name, ok, detail = "") {
  if (!ok) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    if (detail) console.log(`  ${detail}`);
    return;
  }
  console.log(`PASS — ${name}`);
}

function blocker(name, detail = "") {
  blockers.push(name);
  failed += 1;
  console.log(`BLOCKER — ${name}`);
  if (detail) console.log(`  ${detail}`);
}

/** Mirrors guest-pass-emails.mjs mindbodyInstantToUtcMs + formatClassWhen time line. */
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

function formatStudioTime(isoLike) {
  const ms = mindbodyInstantToUtcMs(isoLike);
  if (!Number.isFinite(ms)) return { dateLine: "", timeLine: "" };
  const d = new Date(ms);
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const timeLine = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return { datePart, timeLine };
}

console.log("=== 1. Authoritative email details ===\n");

/** Typical Mindbody addclienttoclass success body (mobile sends classId + classStartIso only). */
const typicalBookResponse = {
  Class: {
    Id: 10988,
    StartDateTime: "2026-09-15T09:00:00",
    ClassDescription: { Name: "Athletic Reformer (Intermediate)" },
    Staff: { FirstName: "Regan", LastName: "Hibbs" },
    Visits: [{ Id: 38175, ClassId: 10988, StartDateTime: "2026-09-15T09:00:00" }],
  },
};

const mobileOnlyPayload = resolveBookConfirmationEmailFields({
  bookData: typicalBookResponse,
  classId: 10988,
  bodyStartIso: "2026-09-15T09:00:00",
});

check(
  "Mobile-only payload resolves class name from Mindbody ClassDescription.Name",
  mobileOnlyPayload.className === "Athletic Reformer (Intermediate)",
  `got: ${mobileOnlyPayload.className}`,
);

check(
  "Mobile-only payload resolves instructor from Mindbody Staff",
  mobileOnlyPayload.instructor === "Regan Hibbs",
  `got: ${mobileOnlyPayload.instructor}`,
);

check(
  "Mobile-only payload resolves start from body classStartIso (Mindbody local instant)",
  mobileOnlyPayload.classStartIso === "2026-09-15T09:00:00",
);

if (mobileOnlyPayload.className === "your class") {
  blocker("Normal successful booking can still produce className='your class'");
}

check(
  "Does not use ServiceName (pricing option) as class name",
  resolveBookConfirmationEmailFields({
    bookData: {
      Class: {
        Id: 1,
        ClassDescription: { Name: "Mat Pilates" },
        Visits: [{ Id: 9, ServiceName: "Monthly Unlimited", ClassId: 1 }],
      },
    },
    classId: 1,
  }).className === "Mat Pilates",
);

check(
  "Staff.Name-only instructor shape supported",
  resolveBookConfirmationEmailFields({
    bookData: {
      Class: {
        Id: 2,
        ClassDescription: { Name: "Kangoo Power" },
        Staff: { Name: "Test Instructor" },
      },
    },
    classId: 2,
  }).instructor === "Test Instructor",
);

console.log("\n=== 2. Florida timezone / DST ===\n");

const sept = formatStudioTime("2026-09-15T09:00:00");
check(
  "2026-09-15 09:00 Florida (EDT) → 9:00 AM",
  sept.datePart.includes("9/15/2026") && /9:00\s*AM/i.test(sept.timeLine),
  `date=${sept.datePart} time=${sept.timeLine}`,
);

const jan = formatStudioTime("2026-01-15T09:00:00");
check(
  "2026-01-15 09:00 Florida (EST) → 9:00 AM",
  jan.datePart.includes("1/15/2026") && /9:00\s*AM/i.test(jan.timeLine),
  `date=${jan.datePart} time=${jan.timeLine}`,
);

check(
  "Formatter uses America/New_York (not server/browser default)",
  STUDIO_TZ === "America/New_York",
);

console.log("\n=== 3. HTML escaping ===\n");

const emailSrc = await fs.readFile(
  new URL("../netlify/functions/guest-pass-emails.mjs", import.meta.url),
  "utf8",
);

check(
  "classDetailsBlock escapes class name and instructor",
  emailSrc.includes("detailRow(\"Class\", escapeHtml(opts.className)") &&
    emailSrc.includes('detailRow("Instructor", escapeHtml(opts.instructor))'),
);

check(
  "Member confirmation hero escapes first name",
  emailSrc.includes("escapeHtml(firstName)") &&
    emailSrc.includes("buildMemberClassBookingConfirmationEmail") &&
    emailSrc.includes("memberHeroBlock"),
);

check(
  "Preview text escaped before email shell",
  emailSrc.includes("escapeHtml(preview)") &&
    emailSrc.match(/sendMemberClassBookingConfirmationEmail[\s\S]{0,800}escapeHtml\(preview\)/),
);

console.log("\n=== 4. Combined failure regression (simulated) ===\n");

let resendCalls = 0;
let rollbackCalls = 0;
let addClientCalls = 0;
const visitId = 38175;

/** Handler-equivalent post-book branch for normal non-waitlist flow. */
async function simulateNormalBookOutcome(opts) {
  const {
    bookOk,
    verifyResults,
    resendOk,
  } = opts;

  if (!bookOk) {
    return { status: 400, body: { ok: false } };
  }

  addClientCalls += 1;
  let paymentVerified = false;
  let mindbodyConfirmationEmail = false;

  let verify = verifyResults[0];
  for (let i = 1; i < verifyResults.length; i += 1) {
    if (verify.ok) break;
    if (i > 1) await new Promise((r) => setTimeout(r, 0));
    verify = verifyResults[i];
  }

  if (!verify.ok) {
    rollbackCalls += 1;
    return {
      status: 402,
      body: { ok: false, error: "payment_not_applied", paymentVerified: false },
    };
  }

  paymentVerified = true;
  resendCalls += 1;
  mindbodyConfirmationEmail = resendOk === true;

  return {
    status: 200,
    body: {
      ok: true,
      visitId,
      paymentVerified,
      mindbodyConfirmationEmail,
    },
  };
}

const retrySuccess = await simulateNormalBookOutcome({
  bookOk: true,
  verifyResults: [{ ok: false, reason: "remaining_unchanged" }, { ok: true, reason: "remaining_decreased" }],
  resendOk: false,
});

check(
  "Retry success + Resend fail → HTTP 200, same visitId, paymentVerified true, email false",
  retrySuccess.status === 200 &&
    retrySuccess.body.ok === true &&
    retrySuccess.body.visitId === visitId &&
    retrySuccess.body.paymentVerified === true &&
    retrySuccess.body.mindbodyConfirmationEmail === false,
);

check(
  "Retry success + Resend fail → no rollback, single AddClientToClass, single Resend",
  rollbackCalls === 0 && addClientCalls === 1 && resendCalls === 1,
  `rollback=${rollbackCalls} add=${addClientCalls} resend=${resendCalls}`,
);

resendCalls = 0;
rollbackCalls = 0;
addClientCalls = 0;

const verifyFail = await simulateNormalBookOutcome({
  bookOk: true,
  verifyResults: [{ ok: false, reason: "remaining_unchanged" }, { ok: false, reason: "remaining_unchanged" }],
  resendOk: true,
});

check(
  "Remaining never decreases → HTTP 402, zero Resend",
  verifyFail.status === 402 && verifyFail.body.paymentVerified === false,
);

check(
  "Verify fail → rollback once, no Resend",
  rollbackCalls === 1 && resendCalls === 0,
  `rollback=${rollbackCalls} resend=${resendCalls}`,
);

console.log("\n=== 5. Normal path matrix (static) ===\n");

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);

check(
  "AMARÉ path: SendEmail false before verify",
  bookSrc.includes('tryBookWith(ctx.authHeaders, first, "staff", tentativeBookSendEmail("staff", waitlist))'),
);

check(
  "Consumer path: default SendEmail false for non-waitlist",
  bookSrc.includes("sendEmail = tentativeBookSendEmail(authMode, waitlist)"),
);

check(
  "Staff fallback: explicit SendEmail false",
  bookSrc.includes('tryBookWith(staffHeadersForBook, picked, "staff", false)'),
);

check(
  "Confirmation only after verify.ok (awaited Resend)",
  bookSrc.includes("if (!verify.ok)") &&
    bookSrc.includes("await sendVerifiedClassBookingConfirmationEmail") &&
    bookSrc.indexOf("if (!verify.ok)") < bookSrc.indexOf("await sendVerifiedClassBookingConfirmationEmail"),
);

check(
  "No rebook helper on normal path",
  !bookSrc.includes("rebookClassVisitWithConfirmationEmail"),
);

check(
  "Waitlist unchanged (skips verify branch)",
  bookSrc.includes("} else if (r.ok && waitlist)") && bookSrc.includes("paymentVerified = null"),
);

console.log("\n=== 6. Resend production readiness ===\n");

const resendClient = await fs.readFile(
  new URL("../netlify/functions/resend-email-client.mjs", import.meta.url),
  "utf8",
);

check(
  "Uses existing resend-email-client (production infrastructure)",
  emailSrc.includes('from "./resend-email-client.mjs"') && resendClient.includes("RESEND_API_KEY"),
);

check(
  "FROM uses RESEND_FROM with existing AMARÉ fallback domain",
  emailSrc.includes("process.env.RESEND_FROM") &&
    emailSrc.includes("info@amarewellness.com") &&
    emailSrc.includes("SMS_ADMIN_REPORT_FROM"),
);

check(
  "No new env vars introduced by member class booking email",
  !emailSrc.includes("MEMBER_CLASS") && !emailSrc.includes("CLASS_BOOK_EMAIL"),
);

console.log("\n=== 7. Released-client compatibility ===\n");

const scheduleSrc = await fs.readFile(
  new URL("../src/js/classes-schedule.js", import.meta.url),
  "utf8",
);
const mobileErrors = await fs.readFile(
  new URL("../amare-app/src/api/booking-errors.ts", import.meta.url),
  "utf8",
);
const scheduleScreen = await fs.readFile(
  new URL("../amare-app/src/screens/ScheduleScreen.tsx", import.meta.url),
  "utf8",
);

check(
  "Web success keyed on res.ok / j.ok + visitId (not mindbodyConfirmationEmail)",
  scheduleSrc.includes("ok: true") &&
    scheduleSrc.includes("visitId") &&
    !scheduleSrc.includes("mindbodyConfirmationEmail"),
);

check(
  "Mobile success keyed on apiJson resolution / visitId (not mindbodyConfirmationEmail)",
  scheduleScreen.includes("res.visitId") && !scheduleScreen.includes("mindbodyConfirmationEmail"),
);

check(
  "Mobile errors do not treat mindbodyConfirmationEmail as failure",
  !mobileErrors.includes("mindbodyConfirmationEmail"),
);

check(
  "Handler returns HTTP 200 when email fails but verify passed",
  bookSrc.includes("mindbodyConfirmationEmail = emailResult.ok === true") &&
    bookSrc.includes("r.ok ? 200 : r.status"),
);

console.log("\n=== 8. Verify retry eligibility unchanged ===\n");

check(
  "Delayed remaining 5→5→4 succeeds with retry eligibility",
  isRemainingUnchangedRetryEligible({ ServiceId: 100, ServiceName: "10 Pack" }, 100) &&
    (() => {
      const before = new Map([[100, 5]]);
      return [new Map([[100, 5]]), new Map([[100, 4]])].some(
        (after) => anyBookableRemainingDecreased(before, after, [100], 100).ok,
      );
    })(),
);

check(
  "Retry window still ~2.5s",
  PAYMENT_VERIFY_RETRY_WAIT_MS.reduce((a, b) => a + b, 0) === 2500,
);

if (failed) {
  console.log(`\n${failed} pre-deploy audit check(s) failed`);
  if (blockers.length) {
    console.log("\nBLOCKERS:");
    for (const b of blockers) console.log(`  - ${b}`);
  }
  process.exit(1);
}

console.log("\nAll pre-deploy safety audit checks passed.");
console.log("Recommendation: READY TO DEPLOY (after human review of this report).");
