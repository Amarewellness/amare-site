/**
 * Booking cancellation-policy kind (Unlimited $10 ack vs credit forfeit).
 * Local only. No Mindbody writes. No Stripe. No $10 charge.
 *
 * Run: node scripts/qa-booking-cancellation-policy.mjs
 */
process.env.NETLIFY = "";

const {
  resolveBookingCancellationPolicy,
  unlimitedFeeAcknowledgmentFromBody,
  UNLIMITED_FEE_POLICY_VERSION,
  publicCancellationPolicy,
} = await import("../netlify/functions/booking-cancellation-policy-lib.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function row(partial) {
  return {
    Remaining: 1,
    ExpirationDate: "2027-12-31T00:00:00",
    ...partial,
  };
}

const unlimited = row({
  Id: 1,
  ProductId: 100135,
  Name: "AMARÉ Monthly Unlimited",
  Remaining: 999999,
});
const unlimitedDesk = row({ Id: 2, ProductId: 100056, Name: "Unlimited", Remaining: 999999 });
const monthly8 = row({ Id: 3, ProductId: 100134, Name: "AMARÉ Monthly 8 Classes", Remaining: 8 });
const monthly8Zero = row({ Id: 4, ProductId: 100134, Remaining: 0 });
const topup = row({ Id: 5, ProductId: 100143, Name: "Monthly Member Top-Up — 1 Class", Remaining: 1 });
const pack10 = row({ Id: 6, ProductId: 100127, Name: "10 Class Pack", Remaining: 4 });
const dropIn = row({ Id: 7, ProductId: 100011, Name: "Drop-In — Single Class", Remaining: 1 });
const ncs = row({ Id: 8, ProductId: 100012, Name: "New Client Special — 3 Classes", Remaining: 2 });
const guest = row({ Id: 9, ProductId: 100136, Name: "Guest Pass - 1 Class", Remaining: 1 });
const expiredUnlimited = row({
  Id: 10,
  ProductId: 100135,
  Remaining: 999999,
  ExpirationDate: "2020-01-01T00:00:00",
});

const now = Date.parse("2026-08-21T12:00:00-04:00");

const u = resolveBookingCancellationPolicy([unlimited], now);
check("Unlimited 100135 → unlimited_fee", u.kind === "unlimited_fee" && u.requiresAcknowledgment === true);
check("Unlimited policy version", u.policyVersion === UNLIMITED_FEE_POLICY_VERSION);
check("Unlimited copy is $10 fee, not credit forfeit", /\$10 fee/.test(u.body || "") && !/forfeit/.test(u.body || ""));

const desk = resolveBookingCancellationPolicy([unlimitedDesk], now);
check("Front-desk 100056 → unlimited_fee", desk.kind === "unlimited_fee");

const m8 = resolveBookingCancellationPolicy([monthly8], now);
check("Monthly 8 → credit_forfeit", m8.kind === "credit_forfeit" && m8.requiresAcknowledgment === false);
check("Monthly 8 copy forfeits credit, not $10", /forfeit/.test(m8.body || "") && !/\$10/.test(m8.body || ""));

const top = resolveBookingCancellationPolicy([monthly8Zero, topup], now);
check("Monthly 8 at 0 + Top-Up 100143 → credit_forfeit", top.kind === "credit_forfeit");

check("10 Pack → credit_forfeit", resolveBookingCancellationPolicy([pack10], now).kind === "credit_forfeit");
check("Drop-In → credit_forfeit", resolveBookingCancellationPolicy([dropIn], now).kind === "credit_forfeit");
check("NCS → credit_forfeit", resolveBookingCancellationPolicy([ncs], now).kind === "credit_forfeit");

const none = resolveBookingCancellationPolicy([monthly8Zero, guest, expiredUnlimited], now);
check("No bookable class credit / expired unlimited → none", none.kind === "none");

const mixed = resolveBookingCancellationPolicy([unlimited, dropIn], now);
check(
  "Unlimited + leftover Drop-In → unlimited_fee (fail-closed for $10 disclosure)",
  mixed.kind === "unlimited_fee" && mixed.mixedBookable === true,
);

const missing = unlimitedFeeAcknowledgmentFromBody({}, u);
check("Unlimited booking without ack is rejected", missing.required === true && missing.ok === false);

const badVersion = unlimitedFeeAcknowledgmentFromBody(
  { policyAcknowledged: true, policyVersion: "wrong" },
  u,
);
check("Wrong policyVersion is rejected", badVersion.ok === false);

const good = unlimitedFeeAcknowledgmentFromBody(
  { policyAcknowledged: true, policyVersion: UNLIMITED_FEE_POLICY_VERSION },
  u,
);
check("Valid Unlimited ack is accepted", good.ok === true && good.policyVersion === UNLIMITED_FEE_POLICY_VERSION);

const creditAckIgnored = unlimitedFeeAcknowledgmentFromBody({}, m8);
check("Credit-based booking does not require ack", creditAckIgnored.required === false && creditAckIgnored.ok === true);

const pub = publicCancellationPolicy(u);
check("Public payload omits internal counts", pub.unlimitedBookable == null && pub.kind === "unlimited_fee");

if (failed) {
  console.error(`\nFAILED ${failed} check(s)`);
  process.exit(1);
}
console.log("\nAll booking cancellation-policy checks passed.");
