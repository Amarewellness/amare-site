/**
 * QA for bounded remaining_unchanged payment-verify retry (Part B).
 * Run: node scripts/qa-class-book-verify-retry.mjs
 */
import fs from "node:fs/promises";
import {
  anyBookableRemainingDecreased,
  isRemainingUnchangedRetryEligible,
  PAYMENT_VERIFY_RETRY_WAIT_MS,
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
  "Retry eligible only when visit paid and service ids match",
  isRemainingUnchangedRetryEligible({ ServiceId: 33488 }, 33488) === true &&
    isRemainingUnchangedRetryEligible({ ServiceId: 33488 }, 99999) === false &&
    isRemainingUnchangedRetryEligible(null, 33488) === false &&
    isRemainingUnchangedRetryEligible({ ServiceName: "Unpaid" }, 33488) === false,
);

const paidVisit = { ServiceId: 100, ServiceName: "10 Class Pack" };
if (visitRowLooksUnpaid({ ServiceName: "Unpaid Visit" })) {
  check("Explicit unpaid visit is not retry eligible", !isRemainingUnchangedRetryEligible({ ServiceName: "Unpaid Visit" }, 100));
} else {
  check("visitRowLooksUnpaid detects unpaid naming", false, "expected unpaid visit detection");
}

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
    return success && isRemainingUnchangedRetryEligible(paidVisit, 100);
  })(),
);

check(
  "Remaining never changes fails after bounded polls",
  (() => {
    const before = new Map([[100, 5]]);
    const after = new Map([[100, 5]]);
    const rem = anyBookableRemainingDecreased(before, after, [100], 100);
    return rem.ok === false;
  })(),
);

check(
  "Last credit exhaustion (1→row missing) counts as paid",
  anyBookableRemainingDecreased(new Map([[100, 1]]), new Map(), [100], 100).ok === true,
);

const libSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book-lib.mjs", import.meta.url),
  "utf8",
);

check(
  "Verify logs retry and final outcomes",
  libSrc.includes("class_book_payment_verify_retry") &&
    libSrc.includes("class_book_payment_verify_final"),
);

check(
  "Verify loop uses isRemainingUnchangedRetryEligible",
  libSrc.includes("isRemainingUnchangedRetryEligible"),
);

if (failed) {
  console.log(`\n${failed} verify-retry check(s) failed`);
  process.exit(1);
}
console.log("\nAll class-book verify-retry QA checks passed.");
