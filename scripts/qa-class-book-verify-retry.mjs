/**
 * QA for bounded remaining_unchanged payment-verify retry (Part B + near-start linkage).
 * Run: node scripts/qa-class-book-verify-retry.mjs
 */
import fs from "node:fs/promises";
import {
  anyBookableRemainingDecreased,
  isIncompleteServiceLinkageRetryEligible,
  isRemainingUnchangedRetryEligible,
  PAYMENT_VERIFY_RETRY_WAIT_MS,
  resolvePaymentVerifyRetryEligibility,
  visitClassIdFromRow,
  visitClientIdFromRow,
  visitRowLooksUnpaid,
  visitServiceIdFromRow,
} from "../netlify/functions/mindbody-class-book-lib.mjs";

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

const baseEligibility = {
  visitId: 49755,
  clientId: 100002726,
  classId: 8939,
  usedServiceId: 34497,
  requirePayment: true,
  addClientClientServiceId: 34497,
  remainingAlreadyDecreased: false,
};

check(
  "Retry waits are 600/900/1000ms (~2.5s total after attempt 1)",
  PAYMENT_VERIFY_RETRY_WAIT_MS.length === 3 &&
    PAYMENT_VERIFY_RETRY_WAIT_MS[0] === 600 &&
    PAYMENT_VERIFY_RETRY_WAIT_MS[1] === 900 &&
    PAYMENT_VERIFY_RETRY_WAIT_MS[2] === 1000,
);

check(
  "visitServiceIdFromRow reads Service.Id and ClientServiceId",
  visitServiceIdFromRow({ Service: { Id: 33488 } }) === 33488 &&
    visitServiceIdFromRow({ ClientServiceId: 22039 }) === 22039,
);

check(
  "visitClientIdFromRow reads ClientId",
  visitClientIdFromRow({ ClientId: 100002726 }) === 100002726,
);

check(
  "Existing retry-eligible visitServiceId match → maxAttempts 4",
  resolvePaymentVerifyRetryEligibility({
    ...baseEligibility,
    visitRow: { ServiceId: 34497, ClassId: 8939, ClientId: 100002726 },
  }).maxAttempts === 4 &&
    resolvePaymentVerifyRetryEligibility({
      ...baseEligibility,
      visitRow: { ServiceId: 34497, ClassId: 8939, ClientId: 100002726 },
    }).retryEligibleReason === "service_id_match",
);

check(
  "Incomplete linkage: missing serviceId + RequirePayment → maxAttempts 4",
  resolvePaymentVerifyRetryEligibility({
    ...baseEligibility,
    visitRow: { ClassId: 8939, ClientId: 100002726, Name: "Reformer Booty Burner" },
  }).maxAttempts === 4 &&
    resolvePaymentVerifyRetryEligibility({
      ...baseEligibility,
      visitRow: { ClassId: 8939, ClientId: 100002726 },
    }).retryEligibleReason === "linkage_incomplete",
);

check(
  "Incomplete linkage: wrong serviceId on visit → linkage_incomplete eligible",
  isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    visitRow: { ServiceId: 99999, ClassId: 8939, ClientId: 100002726 },
  }) === true,
);

check(
  "Delayed remaining update succeeds on third poll (5→5→4)",
  (() => {
    const before = new Map([[100, 5]]);
    const attemptMaps = [new Map([[100, 5]]), new Map([[100, 5]]), new Map([[100, 4]])];
    let success = false;
    for (const after of attemptMaps) {
      const rem = anyBookableRemainingDecreased(before, after, [100], 100);
      if (rem.ok) {
        success = true;
        break;
      }
    }
    return success && isRemainingUnchangedRetryEligible({ ServiceId: 100 }, 100);
  })(),
);

check(
  "Incomplete linkage: Unlimited 99997→99997→99996 succeeds on retry poll",
  (() => {
    const before = new Map([[34497, 99997]]);
    const maps = [new Map([[34497, 99997]]), new Map([[34497, 99997]]), new Map([[34497, 99996]])];
    const visitRow = { ClassId: 8939, ClientId: 100002726 };
    let ok = false;
    for (const after of maps) {
      if (anyBookableRemainingDecreased(before, after, [34497], 34497).ok) {
        ok = true;
        break;
      }
    }
    return (
      ok &&
      resolvePaymentVerifyRetryEligibility({ ...baseEligibility, visitRow }).retryEligibleReason ===
        "linkage_incomplete"
    );
  })(),
);

check(
  "Remaining never changes fails after bounded polls",
  (() => {
    const before = new Map([[100, 5]]);
    const after = new Map([[100, 5]]);
    return anyBookableRemainingDecreased(before, after, [100], 100).ok === false;
  })(),
);

check(
  "Explicit unpaid visit → no extended retry (service id match path)",
  !isRemainingUnchangedRetryEligible({ ServiceName: "Unpaid Visit", ServiceId: 100 }, 100),
);

check(
  "Explicit unpaid visit → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    visitRow: { ServiceName: "Unpaid Visit", ClassId: 8939, ClientId: 100002726 },
  }),
);

check(
  "Wrong class on visit → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    visitRow: { ClassId: 12885, ClientId: 100002726 },
  }),
);

check(
  "Wrong client on visit → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    visitRow: { ClassId: 8939, ClientId: 999999 },
  }),
);

check(
  "Invalid usedServiceId → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    usedServiceId: null,
    visitRow: { ClassId: 8939, ClientId: 100002726 },
  }),
);

check(
  "RequirePayment false → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    requirePayment: false,
    visitRow: { ClassId: 8939, ClientId: 100002726 },
  }),
);

check(
  "AddClient ClientServiceId mismatch → no incomplete linkage retry",
  !isIncompleteServiceLinkageRetryEligible({
    ...baseEligibility,
    addClientClientServiceId: 11111,
    visitRow: { ClassId: 8939, ClientId: 100002726 },
  }),
);

check(
  "Mixed wallet: unrelated service decrease does NOT verify usedServiceId booking",
  (() => {
    const before = new Map([
      [34497, 99997],
      [22039, 5],
    ]);
    const after = new Map([
      [34497, 99997],
      [22039, 4],
    ]);
    const rem = anyBookableRemainingDecreased(before, after, [34497, 22039], 34497);
    return rem.ok === false;
  })(),
);

check(
  "Last credit exhaustion (1→row missing) counts as paid",
  anyBookableRemainingDecreased(new Map([[100, 1]]), new Map(), [100], 100).ok === true,
);

check(
  "Remaining already decreased → maxAttempts 1 even with incomplete visit row",
  resolvePaymentVerifyRetryEligibility({
    ...baseEligibility,
    remainingAlreadyDecreased: true,
    visitRow: { ClassId: 8939, ClientId: 100002726 },
  }).maxAttempts === 1,
);

check(
  "visitClassIdFromRow reads nested Class.Id",
  visitClassIdFromRow({ Class: { Id: 8939 } }) === 8939,
);

const libSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book-lib.mjs", import.meta.url),
  "utf8",
);

check(
  "Verify logs retry, poll, and final outcomes",
  libSrc.includes("class_book_payment_verify_retry") &&
    libSrc.includes("class_book_payment_verify_final") &&
    libSrc.includes("class_book_payment_verify_poll"),
);

check(
  "Verify uses resolvePaymentVerifyRetryEligibility and incomplete linkage helper",
  libSrc.includes("resolvePaymentVerifyRetryEligibility") &&
    libSrc.includes("isIncompleteServiceLinkageRetryEligible"),
);

check(
  "Rollback helper unchanged (failed payment still rolls back visit)",
  libSrc.includes("rollbackFailedPaymentBooking") && libSrc.includes("rollbackBookedVisit"),
);

if (failed) {
  console.log(`\n${failed} verify-retry check(s) failed`);
  process.exit(1);
}
console.log("\nAll class-book verify-retry QA checks passed.");
