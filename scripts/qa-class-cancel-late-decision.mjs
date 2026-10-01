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

if (failed) {
  console.error(`\n${failed} class-cancel late-decision QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll class-cancel late-decision QA checks passed.");
