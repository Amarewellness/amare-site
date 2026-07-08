/**
 * Phase 1.2 backend + API contract static QA for class booking credits gate.
 * Run: node scripts/qa-phase-12-book-credits.mjs
 */
import fs from "node:fs/promises";

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);

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
  "Preflight noBookableCreditsResponse with suggestPackages",
  bookSrc.includes("noBookableCreditsResponse") &&
    bookSrc.includes("suggestPackages: true") &&
    bookSrc.includes("no_bookable_credits"),
);

check(
  "Production-parity consumer-first book (no ClientServiceId on first try)",
  bookSrc.includes('await tryBookWith(ctx.authHeaders, null, "consumer")') &&
    bookSrc.includes("Production parity: consumer first without ClientServiceId"),
);

check(
  "No staff-only-visibility gate (production retries staff on payment error)",
  !bookSrc.includes("consumer_sees_no_active_client_services"),
);

check(
  "Verify treats last credit (1→0) as payment applied when CS row drops from API",
  bookSrc.includes("before === 1 && after == null") &&
    bookSrc.includes("remaining_exhausted"),
);

check(
  "Production payload: no RequirePayment on addclienttoclass",
  !bookSrc.includes("payload.RequirePayment") &&
    bookSrc.includes("Production never sent RequirePayment"),
);

check(
  "Staff fallback uses SendEmail false (tentative until verify)",
  bookSrc.includes('tryBookWith(staffHeadersForBook, picked, "staff", false)') &&
    bookSrc.includes("sendEmail = authMode === \"consumer\""),
);

check(
  "Success response includes paymentVerified",
  bookSrc.includes("paymentVerified") && bookSrc.includes("class_book_payment_verified"),
);

check(
  "Staff fallback never books without ClientServiceId",
  !bookSrc.includes("tryBookWith(staffHeaders, clientServiceId ?? undefined)") &&
    !bookSrc.includes("tryBookWith(staffHeaders, undefined)"),
  "Found staff book call without required ClientServiceId",
);

check(
  "payment_not_applied does not always suggest packages",
  bookSrc.includes("hasBookableCredits") &&
    bookSrc.includes('errorCode === "no_bookable_credits"'),
);

check(
  "ClientService Remaining accepts numeric strings",
  bookSrc.includes("clientServiceRemainingFromRow") &&
    bookSrc.includes("Number.isFinite(Number(rem))"),
);

check(
  "ClientServices query uses showActiveOnly false (member-summary parity)",
  bookSrc.includes('"request.showActiveOnly": "false"') &&
    !bookSrc.includes('"request.showActiveOnly": "true"'),
);

check(
  "Book preflight merges staff + consumer ClientService ids",
  bookSrc.includes("listBookableClientServiceIds") &&
    bookSrc.includes("staffActiveServiceCount"),
);

check(
  "tryBookWith sends ClientServiceId only when cs is set",
  bookSrc.includes("if (cs != null)") &&
    bookSrc.includes("payload.ClientServiceId = cs") &&
    !bookSrc.includes("ClientServiceId: cs,"),
);

const scheduleSrc = await fs.readFile(
  new URL("../src/js/classes-schedule.js", import.meta.url),
  "utf8",
);

check(
  "Frontend: packages only for no_bookable_credits; credits errors skip packages",
  scheduleSrc.includes('j.error === "no_bookable_credits"') &&
    scheduleSrc.includes('j.error === "payment_not_applied"') &&
    scheduleSrc.includes("suggestPackages: false, message: msg"),
);

check(
  "Frontend reads suggestPackages from API body",
  scheduleSrc.includes("j.suggestPackages === true"),
);

const syncSrc = await fs.readFile(
  new URL("../netlify/functions/stripe-mindbody-sync-lib.mjs", import.meta.url),
  "utf8",
);
const consumerSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-consumer-lib.mjs", import.meta.url),
  "utf8",
);

check(
  "OAuth ensure refuses addclient without phone",
  syncSrc.includes('reason: "missing_phone"') &&
    syncSrc.includes("normalizeUsMobilePhone(profile.mobilePhone"),
);

check(
  "OAuth link state skips ensure when missing_phone",
  consumerSrc.includes('reason: "missing_phone"') &&
    consumerSrc.includes("oauth_studio_client_ensure_skipped"),
);

check(
  "Resolved client without phone → incomplete profile",
  consumerSrc.includes("oauth_studio_client_profile_incomplete_phone") &&
    consumerSrc.includes('link_status: "no_studio_client"'),
);

check(
  "updateStudioClientMobilePhone for complete profile",
  syncSrc.includes("updateStudioClientMobilePhone") &&
    syncSrc.includes("/client/updateclient"),
);

if (failed) {
  console.log(`\n${failed} Phase 1.2 check(s) failed`);
  process.exit(1);
}
console.log("\nAll Phase 1.2 backend/API checks passed.");
