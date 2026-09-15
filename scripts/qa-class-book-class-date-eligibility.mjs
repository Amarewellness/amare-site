/**
 * Authoritative class-date ClientService eligibility QA.
 * Run: node scripts/qa-class-book-class-date-eligibility.mjs
 */
import fs from "node:fs/promises";
import {
  isClientServiceValidForClassDate,
  filterBookableIdsForClassDate,
  authoritativeClassStartIsoFromRow,
  NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE,
  noCreditsValidForClassDateResponse,
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

const snir5Service22378 = {
  Id: 22378,
  Remaining: 8,
  ActiveDate: "2026-08-20T00:00:00",
  ExpirationDate: "2026-09-20T00:00:00",
  Name: "AMARÉ Monthly 8 Classes",
};

const serviceB = {
  Id: 99999,
  Remaining: 5,
  ActiveDate: "2026-08-20T00:00:00",
  ExpirationDate: "2026-10-20T00:00:00",
  Name: "AMARÉ Monthly 8 Classes",
};

const futureService = {
  Id: 88888,
  Remaining: 3,
  ActiveDate: "2026-10-01T00:00:00",
  ExpirationDate: "2026-10-31T00:00:00",
};

const noExpService = {
  Id: 77777,
  Remaining: 2,
  ActiveDate: "2026-01-01T00:00:00",
  ExpirationDate: null,
};

check(
  "8. Service Aug 20–Sep 20, class Sep 18 → eligible",
  isClientServiceValidForClassDate(snir5Service22378, "2026-09-18"),
);

check(
  "9. Same service, class Sep 20 → eligible (inclusive expiration)",
  isClientServiceValidForClassDate(snir5Service22378, "2026-09-20"),
);

check(
  "10. Same service, class Sep 21 → ineligible",
  !isClientServiceValidForClassDate(snir5Service22378, "2026-09-21"),
);

check(
  "11. snir5 service 22378, class Sep 24 → ineligible",
  !isClientServiceValidForClassDate(snir5Service22378, "2026-09-24"),
);

check(
  "12. Future service, class before ActiveDate → ineligible",
  !isClientServiceValidForClassDate(futureService, "2026-09-24"),
);

check(
  "13. Null expiration → no upper date restriction",
  isClientServiceValidForClassDate(noExpService, "2027-06-01"),
);

{
  const filtered = filterBookableIdsForClassDate(
    [snir5Service22378, serviceB],
    [22378, 99999],
    "2026-09-24",
  );
  check(
    "14. Multiple services: Sep 24 excludes 22378, keeps valid service B",
    filtered.length === 1 && filtered[0] === 99999,
  );
}

check(
  "15. Authoritative class row StartDateTime used (not client hint field name)",
  authoritativeClassStartIsoFromRow({ StartDateTime: "2026-09-24T07:00:00" }) ===
    "2026-09-24T07:00:00",
);

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);

check(
  "16. Backend rejects before AddClientToClass when no class-date eligible services",
  bookSrc.includes("noCreditsValidForClassDateResponse") &&
    bookSrc.includes("classDateBookableIds.length === 0") &&
    bookSrc.includes("resolveAuthoritativeClassStartForBooking"),
);

check(
  "17. Entitlement uses authoritative class date, not raw body.classStartIso alone",
  bookSrc.includes("filterBookableIdsForClassDate(policyRows, bookableIds, authoritativeClass.classDayKey)") &&
    !bookSrc.match(/filterBookableIdsForClassDate[\s\S]{0,120}classStartIso\)/),
);

check(
  "18. Class-date rejection message is accurate",
  NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE.includes("aren't valid for this class date"),
);

{
  const body = JSON.parse(noCreditsValidForClassDateResponse().body);
  check(
    "18b. Class-date 402 includes detail for released mobile",
    body.detail === NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE &&
      body.detail === body.message,
  );
}

check(
  "19. Wallet listBookableClientServiceIds still today-based (unchanged for display path)",
  bookSrc.includes("listBookableClientServiceIds(") &&
    bookSrc.includes("bookableIds.length > 0 && classDateBookableIds.length === 0"),
);

check(
  "20. Trust boundary: authoritative lookup via fetchClassRowForCapacity path",
  bookSrc.includes("resolveAuthoritativeClassStartForBooking") &&
    bookSrc.includes("prefetchedRow: authoritativeClass.row"),
);

if (failed) {
  console.log(`\n${failed} class-date eligibility check(s) failed`);
  process.exit(1);
}
console.log("\nAll class-date eligibility QA checks passed.");
