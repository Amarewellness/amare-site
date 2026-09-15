/**
 * RequirePayment scope QA for class booking paths.
 * Run: node scripts/qa-class-book-requirepayment.mjs
 */
import fs from "node:fs/promises";

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

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);
const deferredSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-deferred-class-book.mjs", import.meta.url),
  "utf8",
);
const bafSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-member-bring-a-friend.mjs", import.meta.url),
  "utf8",
);

check(
  "1. Normal member tryBookWith sets RequirePayment when ClientServiceId present",
  bookSrc.includes("const requirePayment = cs != null && !waitlist") &&
    bookSrc.includes("if (requirePayment) payload.RequirePayment = true") &&
    bookSrc.includes("requirePayment,"),
);

check(
  "2. Consumer first attempt without ClientServiceId omits RequirePayment",
  bookSrc.includes('await tryBookWith(ctx.authHeaders, null, "consumer")') &&
    !bookSrc.match(/tryBookWith\(ctx\.authHeaders,\s*null[\s\S]{0,80}RequirePayment:\s*true/),
);

check(
  "3. Staff payment fallback uses tryBookWith with paid ClientServiceId",
  bookSrc.includes('tryBookWith(staffHeadersForBook, picked, "staff", false)') &&
    bookSrc.includes("RequirePayment = true"),
);

check(
  "4. Deferred paid booking sends RequirePayment:true",
  deferredSrc.includes("RequirePayment: true") &&
    deferredSrc.includes("ClientServiceId: picked") &&
    deferredSrc.includes("requirePayment: true"),
);

check(
  "5. Bring-a-Friend guest book unchanged (no RequirePayment added)",
  bafSrc.includes("const bookPayload = {") &&
    !bafSrc.includes("RequirePayment"),
);

check(
  "6. Waitlist path does not force RequirePayment on null ClientServiceId",
  bookSrc.includes("const requirePayment = cs != null && !waitlist"),
);

check(
  "7. rebookClassVisitWithConfirmationEmail legacy path unchanged (not normal book)",
  !bookSrc.includes("rebookClassVisitWithConfirmationEmail"),
);

if (failed) {
  console.log(`\n${failed} RequirePayment check(s) failed`);
  process.exit(1);
}
console.log("\nAll RequirePayment scope QA checks passed.");
