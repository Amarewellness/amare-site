/**
 * Static QA for /classes Book-block decision order (Phase 1.2).
 * Run: node scripts/qa-book-block-logic.mjs
 *
 * Mirrors resolveBookBlockVariantAsync — not a browser test.
 */

function walletSummaryHasBookableCredits(sumPayload) {
  if (!sumPayload || typeof sumPayload !== "object") return false;
  const passes = sumPayload.passes;
  if (!Array.isArray(passes)) return false;
  const active = passes.filter(
    (p) => p && typeof p === "object" && p.active === true && Number(p.remaining) > 0,
  );
  if (active.length > 0) return true;
  const memberships = sumPayload.memberships;
  if (!Array.isArray(memberships)) return false;
  return memberships.some((m) => m && typeof m === "object" && m.active === true);
}

function resolveBookBlockVariant(state) {
  const {
    oauthLinkStatus,
    oauthClientExists,
    oauthConsumerAssociated,
    oauthBookingAllowed,
    walletLoadState,
    lastMemberSummaryPayload,
  } = state;

  if (oauthLinkStatus === "ambiguous_studio_client" || oauthLinkStatus === "apple_relay_email") {
    return "ambiguous";
  }
  if (oauthLinkStatus === "no_studio_client" || !oauthClientExists) {
    return "complete_profile";
  }
  if (walletLoadState === "loading" || walletLoadState === "idle") {
    return "wallet_checking";
  }
  if (walletLoadState === "error") {
    return "wallet_unknown";
  }

  const hasActiveCredits =
    walletLoadState === "ok" && lastMemberSummaryPayload
      ? walletSummaryHasBookableCredits(lastMemberSummaryPayload)
      : false;

  if (!hasActiveCredits) return "purchase_first";

  if (
    oauthConsumerAssociated === false ||
    oauthLinkStatus === "not_associated" ||
    oauthBookingAllowed === false
  ) {
    return "link_mindbody";
  }

  if (oauthBookingAllowed === true) {
    return null;
  }

  return "ambiguous";
}

function openLoggedInBookFlowOutcome(state) {
  const variant = resolveBookBlockVariant(state);
  return variant === null ? "confirm_booking" : variant;
}

/** @type {Array<{ name: string, state: Record<string, unknown>, expect: string }>} */
const cases = [
  {
    name: "1. Ayden-like: client + not_associated + 0 credits",
    state: {
      oauthLinkStatus: "not_associated",
      oauthClientExists: true,
      oauthConsumerAssociated: false,
      oauthBookingAllowed: false,
      walletLoadState: "ok",
      lastMemberSummaryPayload: { passes: [], memberships: [] },
    },
    expect: "purchase_first",
  },
  {
    name: "2. New global user: no_studio_client",
    state: {
      oauthLinkStatus: "no_studio_client",
      oauthClientExists: false,
      oauthConsumerAssociated: false,
      oauthBookingAllowed: false,
      walletLoadState: "idle",
      lastMemberSummaryPayload: null,
    },
    expect: "complete_profile",
  },
  {
    name: "3. Credits + not_associated",
    state: {
      oauthLinkStatus: "not_associated",
      oauthClientExists: true,
      oauthConsumerAssociated: false,
      oauthBookingAllowed: false,
      walletLoadState: "ok",
      lastMemberSummaryPayload: {
        passes: [{ active: true, remaining: 5 }],
        memberships: [],
      },
    },
    expect: "link_mindbody",
  },
  {
    name: "4a. snir30-like: bookingAllowed=true + empty wallet → Purchase first",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: true,
      walletLoadState: "ok",
      lastMemberSummaryPayload: { passes: [], memberships: [] },
    },
    expect: "purchase_first",
  },
  {
    name: "4b. bookingAllowed=true + wallet error → wallet_unknown",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: true,
      walletLoadState: "error",
      lastMemberSummaryPayload: null,
    },
    expect: "wallet_unknown",
  },
  {
    name: "4c. bookingAllowed=true + active credits → Confirm booking",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: true,
      walletLoadState: "ok",
      lastMemberSummaryPayload: {
        passes: [{ active: true, remaining: 1 }],
        memberships: [],
      },
    },
    expect: "confirm_booking",
  },
  {
    name: "5. Wallet loading → checking (before wait)",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: false,
      walletLoadState: "loading",
      lastMemberSummaryPayload: null,
    },
    expect: "wallet_checking",
  },
  {
    name: "6. Wallet error (bookingAllowed=false)",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: false,
      walletLoadState: "error",
      lastMemberSummaryPayload: null,
    },
    expect: "wallet_unknown",
  },
  {
    name: "7. Ambiguous studio client",
    state: {
      oauthLinkStatus: "ambiguous_studio_client",
      oauthClientExists: true,
      oauthConsumerAssociated: false,
      oauthBookingAllowed: false,
      walletLoadState: "ok",
      lastMemberSummaryPayload: { passes: [], memberships: [] },
    },
    expect: "ambiguous",
  },
  {
    name: "8. snir26-like: 0 credits after first book → Purchase first",
    state: {
      oauthLinkStatus: "ready",
      oauthClientExists: true,
      oauthConsumerAssociated: true,
      oauthBookingAllowed: true,
      walletLoadState: "ok",
      lastMemberSummaryPayload: { passes: [], memberships: [] },
    },
    expect: "purchase_first",
  },
];

let failed = 0;
for (const c of cases) {
  const got = openLoggedInBookFlowOutcome(c.state);
  const ok = got === c.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}`);
  if (!ok) console.log(`  expected: ${c.expect}\n  got:      ${got}`);
}

const logFields = [
  "book_block_variant",
  "linkStatus",
  "clientExists",
  "hasPhone",
  "walletLoadState",
  "hasActiveCredits",
  "consumerAssociated",
  "selectedCTA",
];
const fs = await import("node:fs/promises");
const src = await fs.readFile(new URL("../src/js/classes-schedule.js", import.meta.url), "utf8");
const missingLogFields = logFields.filter((f) => !src.includes(f));
if (missingLogFields.length) {
  failed += 1;
  console.log(`FAIL — log fields missing in classes-schedule.js: ${missingLogFields.join(", ")}`);
} else {
  console.log("PASS — console log fields present in classes-schedule.js");
}

if (src.includes("bookingAllowedBypass")) {
  failed += 1;
  console.log("FAIL — bookingAllowedBypass bypass still present in classes-schedule.js");
} else {
  console.log("PASS — no bookingAllowedBypass in classes-schedule.js");
}

if (!src.includes("resolveHasPhoneForLog")) {
  failed += 1;
  console.log("FAIL — resolveHasPhoneForLog not found in classes-schedule.js");
} else {
  console.log("PASS — resolveHasPhoneForLog present in classes-schedule.js");
}

const walletSrc = await fs.readFile(new URL("../src/js/mindbody-wallet-widget.js", import.meta.url), "utf8");
if (!walletSrc.includes("mbWalletSummaryHasBookableCredits")) {
  failed += 1;
  console.log("FAIL — mbWalletSummaryHasBookableCredits not exported");
} else {
  console.log("PASS — shared wallet helper exported");
}

if (!walletSrc.includes("walletDedupeMonthlyClientServices")) {
  failed += 1;
  console.log("FAIL — wallet dedupes stale monthly ClientService rows");
} else {
  console.log("PASS — wallet dedupes stale monthly ClientService rows");
}

if (!walletSrc.includes("walletClientServiceInactive")) {
  failed += 1;
  console.log("FAIL — wallet hides inactive ClientService rows");
} else {
  console.log("PASS — wallet hides inactive ClientService rows");
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll QA checks passed.");
