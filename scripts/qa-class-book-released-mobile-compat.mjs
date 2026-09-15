/**
 * Released iOS/Android backward-compat gate (mocked parser + backend response shapes).
 * Run: node scripts/qa-class-book-released-mobile-compat.mjs
 */
import fs from "node:fs/promises";
import {
  noCreditsValidForClassDateResponse,
  paymentVerificationFailedResponse,
  NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE,
} from "../netlify/functions/mindbody-class-book-lib.mjs";

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

/** @param {{ statusCode: number; body: string }} res */
function parseBody(res) {
  return JSON.parse(res.body);
}

/**
 * Mirrors released Android 1.0 @496f63e `parseBookFailure` + ApiError message = body.error.
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function releasedMobileBannerText(status, body) {
  const errCode =
    body && typeof body === "object" && "error" in body ? String(body.error) : "";

  /** @param {unknown} b */
  function mindbodyMessage(b) {
    if (!b || typeof b !== "object") return "";
    const j = /** @type {Record<string, unknown>} */ (b);
    const mb = j.mindbody;
    if (mb && typeof mb === "object") {
      const d = /** @type {Record<string, unknown>} */ (mb);
      const inner =
        d.Error && typeof d.Error === "object"
          ? /** @type {{ Message?: string }} */ (d.Error)
          : null;
      if (inner?.Message) return inner.Message;
      if (typeof d.Message === "string") return d.Message;
    }
    if (typeof j.detail === "string") return j.detail;
    return "";
  }

  /** @param {string} raw */
  function interpretMessage(raw) {
    const s = raw.trim();
    if (!s) return { message: "Booking didn't complete.", suggestPackages: false, paymentMismatch: false };
    if (
      /\bno\s+available\s+payments?\b/i.test(s) ||
      /\bhas\s+no\s+available\s+payments?\b/i.test(s) ||
      /ClassRequiresPayment/i.test(s)
    ) {
      return {
        message:
          "We couldn't apply your package to this class. Your credits may not cover this class type, or the pass may not be valid for this date. Try another class or contact the studio.",
        suggestPackages: false,
        paymentMismatch: true,
      };
    }
    return { message: s, suggestPackages: false, paymentMismatch: false };
  }

  if (errCode === "unlimited_policy_ack_required") {
    return typeof body.message === "string"
      ? body.message
      : "Please confirm the Unlimited member late-cancellation and no-show fee policy before booking.";
  }
  if (errCode === "client_not_linked") {
    return "We couldn't link your sign-in to your AMARÉ studio profile. Sign in with your studio email, or buy a pass first.";
  }

  const errMessage = errCode || String(status);
  const raw = mindbodyMessage(body) || errMessage;
  const classFull = /\bfull\b|\bcapacity\b/i.test(raw);
  const noLongerAvailable =
    classFull || /\bno longer available\b/i.test(raw) || /\binvalid class\b/i.test(raw);
  if (noLongerAvailable) {
    return classFull
      ? "This class is full. You can join the waitlist or pick another time."
      : "This class is no longer available. Refresh the schedule and try another class.";
  }

  const { message, suggestPackages, paymentMismatch } = interpretMessage(raw || errCode || errMessage);
  return { text: message, suggestPackages, paymentMismatch };
}

// --- A. Class-date 402 ---
{
  const res = noCreditsValidForClassDateResponse();
  const j = parseBody(res);
  check("A1. Class-date 402 status", res.statusCode === 402);
  check("A2. Class-date error code", j.error === "payment_not_applied");
  check("A3. Class-date message", j.message === NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE);
  check("A4. Class-date detail matches message", j.detail === NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE);
  check("A5. Class-date suggestPackages false", j.suggestPackages === false);
  check("A6. Class-date rejectionReason preserved", j.rejectionReason === "service_not_valid_for_class_date");

  const mobile = releasedMobileBannerText(402, j);
  const mobileText = typeof mobile === "string" ? mobile : mobile.text;
  check(
    "A7. Released mobile shows human class-date text",
    mobileText === NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE,
    `got: ${mobileText}`,
  );
  check(
    "A8. Released mobile does NOT show payment_not_applied",
    mobileText !== "payment_not_applied",
  );
  const flags = typeof mobile === "object" ? mobile : { suggestPackages: false, paymentMismatch: false };
  check("A9. Released mobile no package CTA", flags.suggestPackages === false);
}

// --- B. Payment verify 402 ---
{
  const res = paymentVerificationFailedResponse(undefined, "payment_not_applied");
  const j = parseBody(res);
  const expected =
    "We couldn't apply your class credits to this booking. Nothing was charged — please try again or contact the studio if it keeps happening.";
  check("B1. Verify-fail detail present", j.detail === expected);
  check("B2. Verify-fail detail matches message", j.detail === j.message);
  const mobile = releasedMobileBannerText(402, j);
  const mobileText = typeof mobile === "string" ? mobile : mobile.text;
  check("B3. Released mobile verify-fail human text", mobileText === expected, `got: ${mobileText}`);
  check("B4. Released mobile verify-fail not raw code", mobileText !== "payment_not_applied");
}

// --- C. Unpaid visit 402 ---
{
  const res = paymentVerificationFailedResponse(undefined, "unpaid_visit_detected");
  const j = parseBody(res);
  const expected =
    "This booking would have been recorded as unpaid in Mindbody, so we cancelled it. Please try again or contact the studio.";
  check("C1. Unpaid visit detail present", j.detail === expected);
  check("C2. Unpaid visit detail matches message", j.detail === j.message);
  const mobile = releasedMobileBannerText(402, j);
  const mobileText = typeof mobile === "string" ? mobile : mobile.text;
  check("C3. Released mobile unpaid human text", mobileText === expected, `got: ${mobileText}`);
  check("C4. Released mobile unpaid not raw code", mobileText !== "unpaid_visit_detected");
}

// --- D. Class lookup 503 ---
{
  const bookSrc = await fs.readFile(
    new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
    "utf8",
  );
  const retryMsg =
    "We couldn't verify class availability right now. Please refresh the schedule and try again.";
  check(
    "D1. Class lookup 503 includes detail field",
    bookSrc.includes("reason: \"class_lookup_failed\"") &&
      bookSrc.includes("detail: classLookupRetryMessage"),
  );
  check(
    "D2. Class lookup detail uses approved retry message",
    bookSrc.includes(`message: classLookupRetryMessage`) && bookSrc.includes(retryMsg),
  );

  const j = {
    ok: false,
    error: "capacity_check_failed",
    reason: "class_lookup_failed",
    message: retryMsg,
    detail: retryMsg,
  };
  const mobile = releasedMobileBannerText(503, j);
  const mobileText = typeof mobile === "string" ? mobile : mobile.text;
  check("D3. Released mobile 503 shows detail text", mobileText === retryMsg, `got: ${mobileText}`);
  check(
    "D4. Released mobile 503 not raw capacity_check_failed",
    mobileText !== "capacity_check_failed",
  );
}

// --- E/F. Success contract (static — apiJson only throws on !res.ok) ---
{
  const scheduleSrc = await fs.readFile(
    new URL("../amare-app/src/screens/ScheduleScreen.tsx", import.meta.url),
    "utf8",
  );
  check(
    "E. Success uses visitId only (email true/false irrelevant)",
    scheduleSrc.includes("typeof res.visitId === \"number\"") &&
      !scheduleSrc.includes("mindbodyConfirmationEmail") &&
      !scheduleSrc.includes("paymentVerified"),
  );
  check(
    "F. Success banner unchanged",
    scheduleSrc.includes("Booked! Check your email for confirmation"),
  );
}

// --- G. Web class-date rejection ---
{
  const webSrc = await fs.readFile(new URL("../src/js/classes-schedule.js", import.meta.url), "utf8");
  check(
    "G1. Web generic 402 reads j.message for class-date path",
    webSrc.includes("typeof j.message === \"string\" && j.message.trim()") &&
      webSrc.includes("j.error === \"no_bookable_credits\""),
  );
  check(
    "G2. Web no_bookable_credits hardcode separate from payment_not_applied",
    webSrc.includes("NO_CREDITS_BOOK_MESSAGE") &&
      webSrc.includes('j.error === "no_bookable_credits"'),
  );
  check(
    "G3. Web suggestPackages gated — class-date keeps suggestPackages:false",
    webSrc.includes("j.suggestPackages === true"),
  );
}

if (failed) {
  console.log(`\n${failed} released-mobile compatibility check(s) failed`);
  process.exit(1);
}
console.log("\nAll released-mobile compatibility QA checks passed.");
