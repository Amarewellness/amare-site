/**
 * QA for post-verify AMARÉ/Resend confirmation (Part A).
 * Run: node scripts/qa-class-book-email-after-verify.mjs
 */
import fs from "node:fs/promises";

let failed = 0;

function check(name, ok, detail = "") {
  if (!ok) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    if (detail) console.log(`  ${detail}`);
    return;
  }
  console.log(`PASS — ${name}`);
}

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);
const emailSrc = await fs.readFile(
  new URL("../netlify/functions/guest-pass-emails.mjs", import.meta.url),
  "utf8",
);
const scheduleSrc = await fs.readFile(
  new URL("../src/js/classes-schedule.js", import.meta.url),
  "utf8",
);
const mobileBookErrors = await fs.readFile(
  new URL("../amare-app/src/api/booking-errors.ts", import.meta.url),
  "utf8",
);
const mobileCancelPolicy = await fs.readFile(
  new URL("../amare-app/src/lib/cancellation-policy.ts", import.meta.url),
  "utf8",
);

check(
  "AMARÉ normal book uses SendEmail:false before verify",
  bookSrc.includes("tentativeBookSendEmail") &&
    bookSrc.includes('tryBookWith(ctx.authHeaders, first, "staff", tentativeBookSendEmail("staff", waitlist))') &&
    bookSrc.includes("if (waitlistBooking) return authMode === \"consumer\";") &&
    bookSrc.includes("return false;"),
);

check(
  "Consumer normal book default is SendEmail:false (non-waitlist)",
  bookSrc.includes("sendEmail = tentativeBookSendEmail(authMode, waitlist)"),
);

check(
  "Staff payment fallback stays SendEmail:false",
  bookSrc.includes('tryBookWith(staffHeadersForBook, picked, "staff", false)'),
);

check(
  "Post-verify Resend sender exists and is awaited",
  bookSrc.includes("sendVerifiedClassBookingConfirmationEmail") &&
    bookSrc.includes("await sendMemberClassBookingConfirmationEmail") &&
    bookSrc.includes("await sendVerifiedClassBookingConfirmationEmail"),
);

check(
  "Post-verify recipient resolved server-side (not raw ctx.email)",
  bookSrc.includes("resolveBookingConfirmationRecipient") &&
    bookSrc.includes("memberEmail: recipient.email") &&
    bookSrc.includes("recipientSource: recipient.source"),
);

check(
  "Normal direct book does not use destructive rebook for email",
  !bookSrc.includes("rebookClassVisitWithConfirmationEmail"),
);

check(
  "Confirmation email result observability (no PII in log payload)",
  bookSrc.includes("class_book_confirmation_email_result") &&
    bookSrc.includes('provider: "resend"') &&
    bookSrc.includes("elapsedMs") &&
    /class_book_confirmation_email_result[\s\S]{0,420}errorCode:/.test(bookSrc) &&
    !/class_book_confirmation_email_result[\s\S]{0,420}memberEmail/.test(bookSrc),
);

check(
  "Legacy mindbodyConfirmationEmail field retained with compatibility comment",
  bookSrc.includes("mindbodyConfirmationEmail") &&
    bookSrc.includes("Legacy response field name retained") &&
    bookSrc.includes("mindbodyConfirmationEmail = emailResult.ok === true"),
);

check(
  "Verify failure path rolls back without confirmation email sender",
  (() => {
    const block = bookSrc.slice(
      bookSrc.indexOf("if (r.ok && !waitlist)"),
      bookSrc.indexOf("} else if (r.ok && waitlist)"),
    );
    const verifyFailIdx = block.indexOf("if (!verify.ok)");
    const emailFnIdx = block.indexOf("sendVerifiedClassBookingConfirmationEmail");
    return verifyFailIdx >= 0 && emailFnIdx > verifyFailIdx && block.indexOf("rollbackFailedPaymentBooking") < emailFnIdx;
  })(),
);

check(
  "Resend email template matches Mindbody reservation copy + mobile density",
  emailSrc.includes("export async function sendMemberClassBookingConfirmationEmail") &&
    emailSrc.includes("buildMemberClassBookingConfirmationEmail") &&
    emailSrc.includes("memberClassDetailsBlock") &&
    emailSrc.includes("wrapMemberReservationEmail") &&
    emailSrc.includes("MEMBER_BOOKING_MOBILE_CSS") &&
    emailSrc.includes("memberViewScheduleCta") &&
    emailSrc.includes("fifteen minutes early") &&
    emailSrc.includes("View my schedule") &&
    emailSrc.includes("member_class_booking") &&
    !emailSrc.match(/export function buildMemberClassBookingConfirmationEmail[\s\S]{0,900}whatToBringBlock/),
);

check(
  "Waitlist path unchanged (skips verify/email expansion)",
  bookSrc.includes("paymentVerified = null") &&
    bookSrc.includes("} else if (r.ok && waitlist)"),
);

check(
  "Web schedule parser still surfaces 402 verify failures via API message",
  scheduleSrc.includes("res.status === 402") &&
    scheduleSrc.includes("typeof j.message === \"string\"") &&
    scheduleSrc.includes("NO_CREDITS_BOOK_MESSAGE"),
);

check(
  "Mobile booking error parser unchanged contract",
  mobileBookErrors.includes("parseBookFailure") &&
    mobileBookErrors.includes("Booking didn't complete") &&
    mobileBookErrors.includes("paymentMismatch"),
);

check(
  "Mobile book payload contract unchanged (classId + optional classStartIso)",
  mobileCancelPolicy.includes("bookPayloadForPolicy") &&
    mobileCancelPolicy.includes("classStartIso"),
);

check(
  "Duplicate/already-enrolled: failed Mindbody book returns before verify/email",
  bookSrc.includes("if (r.ok && !waitlist)") &&
    !bookSrc.match(/sendVerifiedClassBookingConfirmationEmail[\s\S]{0,200}if \(!r\.ok\)/),
  "If Mindbody rejects duplicate enrollments with ok:false, no Resend is sent. If Mindbody returns ok:true for an existing visit, verify+one Resend may run (same as prior Mindbody-email behavior).",
);

if (failed) {
  console.log(`\n${failed} email-after-verify check(s) failed`);
  process.exit(1);
}
console.log("\nAll class-book email-after-verify QA checks passed.");
