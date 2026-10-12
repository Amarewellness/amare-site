/**
 * QA: staff-first late cancel + pre-live blockers (no live Mindbody mutations).
 * Run: npm run test:class-cancel-late-decision
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isStaffMemberLateCancelWindow,
  mindbodyClassStartToUtcMs,
  STUDIO_LATE_CANCEL_HOURS,
} from "../netlify/functions/guest-pass-lib.mjs";
import { cancelMemberVisit } from "../netlify/functions/mindbody-class-cancel.mjs";
import {
  isActiveEnrolledClassVisit,
  isVisitAlreadyCancelledForMemberClass,
  visitAlreadyCancelledInactiveReason,
} from "../netlify/functions/class-book-claim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MS_12H = STUDIO_LATE_CANCEL_HOURS * 60 * 60 * 1000;

const SCHEDULE_UNAVAILABLE_MSG =
  "Could not verify class timing. Please try again or contact the studio.";
const CLASS_ALREADY_STARTED_MSG =
  "This class has already started and can no longer be cancelled online. Please contact the studio.";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const now = Date.parse("2026-03-15T18:00:00.000Z");

// 1–4 window boundaries
check("24h before → not late", !isStaffMemberLateCancelWindow(now + MS_12H * 2, now));
check("exactly 12h before → early", !isStaffMemberLateCancelWindow(now + MS_12H, now));
check("11h 59m before → late", isStaffMemberLateCancelWindow(now + MS_12H - 1000, now));
check("1h before → late", isStaffMemberLateCancelWindow(now + 60 * 60 * 1000, now));
check("1 second before start → late", isStaffMemberLateCancelWindow(now + 1000, now));

// Post-start: not late window; handler blocks separately
check("at/after start → not late window flag", !isStaffMemberLateCancelWindow(now, now));
check("at/after start → not late (1h after)", !isStaffMemberLateCancelWindow(now - 3600000, now));

// ET / DST
const edtStart = mindbodyClassStartToUtcMs("2026-07-15T19:00:00");
check("ET naive summer start parses", Number.isFinite(edtStart));
check("6h before ET class → late", isStaffMemberLateCancelWindow(edtStart, edtStart - 6 * 3600000));

const cancelSrc = await readFile(
  path.join(root, "netlify/functions/mindbody-class-cancel.mjs"),
  "utf8",
);
const bookSrc = await readFile(
  path.join(root, "netlify/functions/mindbody-class-book-lib.mjs"),
  "utf8",
);

function staffFirstPayload(withinLate) {
  const p = { ClientId: 1, ClassId: 2, VisitId: 3, SendEmail: true };
  if (withinLate) p.LateCancel = true;
  return p;
}
check(
  "staff early payload",
  JSON.stringify(staffFirstPayload(false)) ===
    JSON.stringify({ ClientId: 1, ClassId: 2, VisitId: 3, SendEmail: true }),
);
check(
  "staff late payload",
  JSON.stringify(staffFirstPayload(true)).includes('"LateCancel":true'),
);

/** Mirrors classes-schedule cancelBookingViaApi error parsing */
function webScheduleCancelErrorMessage(j, resOk) {
  if (resOk && j.ok !== false) return null;
  let msg = "Could not cancel this booking.";
  if (typeof j.detail === "string") msg = j.detail;
  return msg;
}

/** Mirrors member-dashboard inline cancel */
function webDashboardCancelErrorMessage(j, resOk) {
  if (resOk && j.ok !== false) return null;
  let msg = "Could not cancel this booking.";
  if (typeof j.detail === "string") msg = j.detail;
  else if (typeof j.error === "string") msg = j.error;
  return msg;
}

/** Mirrors cancel-api.ts catch */
function mobileCancelErrorMessage(body) {
  let msg = "Could not cancel this booking.";
  if (body && typeof body.detail === "string") msg = body.detail;
  return msg;
}

const body503 = {
  ok: false,
  error: "class_schedule_unavailable",
  message: SCHEDULE_UNAVAILABLE_MSG,
  detail: SCHEDULE_UNAVAILABLE_MSG,
};
check(
  "11 Web schedule 503 → detail",
  webScheduleCancelErrorMessage(body503, false) === SCHEDULE_UNAVAILABLE_MSG,
);
check(
  "12 Web dashboard 503 → detail",
  webDashboardCancelErrorMessage(body503, false) === SCHEDULE_UNAVAILABLE_MSG,
);
check(
  "13 iOS 503 → detail",
  mobileCancelErrorMessage(body503) === SCHEDULE_UNAVAILABLE_MSG,
);
check(
  "14 Android 503 → detail",
  mobileCancelErrorMessage(body503) === SCHEDULE_UNAVAILABLE_MSG,
);

const body409 = {
  ok: false,
  error: "class_already_started",
  message: CLASS_ALREADY_STARTED_MSG,
  detail: CLASS_ALREADY_STARTED_MSG,
};
check(
  "15 Web schedule post-start 409 → detail",
  webScheduleCancelErrorMessage(body409, false) === CLASS_ALREADY_STARTED_MSG,
);
check(
  "16 iOS/Android post-start 409 → detail",
  mobileCancelErrorMessage(body409) === CLASS_ALREADY_STARTED_MSG,
);

check(
  "10 503 includes message + detail in source",
  cancelSrc.includes("detail: CLASS_SCHEDULE_UNAVAILABLE_MSG") &&
    cancelSrc.includes("class_schedule_unavailable"),
);

check(
  "5–7 post-start guard in classCancelHandler before cancelMemberVisit",
  cancelSrc.includes('error: "class_already_started"') &&
    cancelSrc.includes("rejectionReason: \"class_already_started\"") &&
    cancelSrc.includes("classStartRes.classStartMs <= nowMs"),
);

const handlerCancelCallIdx = cancelSrc.indexOf("await cancelMemberVisit({");
const postStartGuardIdx = cancelSrc.indexOf("classStartRes.classStartMs <= nowMs");
const guestOnlyBlockEnd = cancelSrc.indexOf("memberBookingKept: true");
check(
  "post-start guard in classCancelHandler before cancelMemberVisit call",
  postStartGuardIdx > 0 &&
    handlerCancelCallIdx > postStartGuardIdx &&
    postStartGuardIdx > guestOnlyBlockEnd,
);

check(
  "rollbackBookedVisit not guarded (book-lib only)",
  !bookSrc.includes("class_already_started") && bookSrc.includes("rollbackBookedVisit"),
);

check(
  "consumer 400 → staff LateCancel retry preserved",
  cancelSrc.includes("cancelRejectedAsOutsideWindow") &&
    cancelSrc.includes("!useStaffAuth") &&
    cancelSrc.includes("buildPayload(true)"),
);

check(
  "guest cancelGuestOnly unchanged",
  cancelSrc.includes("cancelGuestOnly") && cancelSrc.includes("cancelGuestVisit"),
);

check(
  "handler still reads classId + visitId only",
  cancelSrc.includes("body.classId") && cancelSrc.includes("body.visitId"),
);

check(
  "503 fail-closed before cancelMemberVisit call",
  cancelSrc.indexOf("class_schedule_unavailable") < handlerCancelCallIdx,
);

check("cancelMemberVisit exported", typeof cancelMemberVisit === "function");

check(
  "staff single POST firstLate",
  /let r = await fetchMb\("POST", path, opts\.authHeaders, buildPayload\(firstLate\)\)/.test(
    cancelSrc,
  ),
);

check(
  "authSource agnostic post-start (no amare-only guard)",
  !/classStartRes\.classStartMs <= nowMs[\s\S]{0,120}authSource === "amare"/.test(cancelSrc),
);

check(
  "attendance fee record only after successful cancelMemberVisit",
  cancelSrc.indexOf("await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel") > handlerCancelCallIdx,
);
check(
  "attendance fee recording does not change jsonResponse success shape",
  cancelSrc.indexOf("tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel") < cancelSrc.indexOf("return jsonResponse("),
);
check(
  "attendance fee uses tryRecord wrapper (Mindbody success preserved on ledger failure)",
  cancelSrc.includes("tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel"),
);

check(
  "already-cancelled uses isVisitAlreadyCancelledForMemberClass",
  cancelSrc.includes("isVisitAlreadyCancelledForMemberClass") &&
    cancelSrc.includes("memberVisitAlreadyCancelled"),
);

const preflightIdx = cancelSrc.indexOf("memberVisitAlreadyCancelled = isVisitAlreadyCancelledForMemberClass");
check(
  "already-cancelled preflight after guest confirm, before cancelMemberVisit",
  preflightIdx > 0 &&
    preflightIdx > cancelSrc.indexOf("confirmCancelGuest") &&
    preflightIdx < handlerCancelCallIdx,
);

check(
  "claim heal on already-cancelled idempotent path",
  cancelSrc.includes("tryHealCompletedBookClaimAfterCancel") &&
    /memberVisitAlreadyCancelled[\s\S]{0,1200}tryHealCompletedBookClaimAfterCancel/.test(cancelSrc),
);

check(
  "claim heal does not fail idempotent HTTP response",
  cancelSrc.includes("context: \"already_cancelled_heal\"") &&
    cancelSrc.includes("claimCleanupAttempted"),
);

check(
  "idempotent already-cancelled returns 200 alreadyCancelled",
  cancelSrc.includes('alreadyCancelled: true') && cancelSrc.includes('result: "already_cancelled"'),
);

check(
  "attendance fee skipped when member cancel skipped (retry)",
  /if \(r\.ok && !memberCancelSkippedAlreadyRemoved\)/.test(cancelSrc),
);

check(
  "claim heal only on fresh Mindbody success (not skipped retry)",
  /if \(r\.ok && !memberCancelSkippedAlreadyRemoved\)[\s\S]{0,400}tryHealCompletedBookClaimAfterCancel/.test(
    cancelSrc,
  ),
);

check(
  "guest follow-up when member already removed but guest pass confirmed",
  cancelSrc.includes("needsGuestFollowUp") && cancelSrc.includes("memberCancelSkippedAlreadyRemoved = true"),
);

check(
  "mindbody_cancel_attempt_result logging",
  cancelSrc.includes('event: "mindbody_cancel_attempt_result"') &&
    cancelSrc.includes('"staff_late_retry"') &&
    cancelSrc.includes('"consumer_first"') &&
    cancelSrc.includes('"staff_first"'),
);

check(
  "attempt log has no email/token fields",
  !cancelSrc.includes("mindbody_cancel_attempt_result") ||
    (!/mindbody_cancel_attempt_result[\s\S]{0,400}email/.test(cancelSrc) &&
      !/mindbody_cancel_attempt_result[\s\S]{0,400}Authorization/.test(cancelSrc)),
);

check(
  "class_cancel_final summary event",
  cancelSrc.includes('event: "class_cancel_final"') &&
    cancelSrc.includes('result: "already_cancelled"') &&
    cancelSrc.includes("finalResult"),
);

check(
  "staffLateCancelFirst logic unchanged",
  cancelSrc.includes("sendStaffLateCancel = ctx.authSource === \"amare\" && withinLateCancelWindow"),
);

// isActiveEnrolledClassVisit semantics (shared with duplicate guard)
const activeClassId = 16854;
check(
  "active visit → enrolled",
  isActiveEnrolledClassVisit({ Id: 1, ClassId: activeClassId, AppointmentStatus: "Booked" }, activeClassId),
);
check(
  "LateCancelled visit → not active",
  !isActiveEnrolledClassVisit(
    { Id: 1, ClassId: activeClassId, LateCancelled: true, AppointmentStatus: "Cancelled" },
    activeClassId,
  ),
);
check(
  "Cancelled AppointmentStatus → not active",
  !isActiveEnrolledClassVisit(
    { Id: 1, ClassId: activeClassId, AppointmentStatus: "Cancelled" },
    activeClassId,
  ),
);

check(
  "Cancelled → already-cancelled predicate",
  isVisitAlreadyCancelledForMemberClass(
    { Id: 1, ClassId: activeClassId, AppointmentStatus: "Cancelled" },
    activeClassId,
  ),
);
check(
  "LateCancelled → already-cancelled predicate",
  isVisitAlreadyCancelledForMemberClass(
    { Id: 1, ClassId: activeClassId, LateCancelled: true },
    activeClassId,
  ),
);
check(
  "waitlist → not already-cancelled (still may call Mindbody)",
  !isVisitAlreadyCancelledForMemberClass(
    { Id: 1, ClassId: activeClassId, Waitlist: true, AppointmentStatus: "Waitlist" },
    activeClassId,
  ),
);
check(
  "waitlist inactive reason not appointment_cancelled",
  visitAlreadyCancelledInactiveReason({ Waitlist: true, AppointmentStatus: "Waitlist" }) === "unknown",
);

if (failed) {
  console.error(`\n${failed} class-cancel late-decision QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll class-cancel late-decision QA checks passed.");
