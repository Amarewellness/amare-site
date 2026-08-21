/**
 * Monthly membership entitlement vs class-credit usability.
 * Local only. No Mindbody writes. No Stripe. No usage reset.
 *
 * Run: node scripts/qa-monthly-membership-entitlement.mjs
 */
process.env.NETLIFY = "";

const {
  firstMonthlyMembershipMatch,
  monthlyMembershipWindowActive,
  monthlySkuFromMembershipRow,
  __testing,
} = await import("../netlify/functions/guest-pass-lib.mjs");
const { loadGuestPassConfig } = await import("../netlify/functions/guest-pass-catalog-lib.mjs");
const { mindbodyStudioCalendarDay, computeUsableCreditBuckets } = await import(
  "../netlify/functions/member-topup-lib.mjs"
);

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const gp = loadGuestPassConfig();
const NOW = Date.parse("2026-08-21T12:00:00-04:00");

function monthlyRow(partial) {
  return {
    Name: "AMARÉ Monthly 8 Classes",
    ProductId: 100134,
    Remaining: 0,
    Current: false,
    ActiveDate: "2026-08-20T00:00:00",
    ExpirationDate: "2026-09-20T00:00:00",
    ...partial,
  };
}

function matchSku(rows) {
  return firstMonthlyMembershipMatch(rows, gp, NOW)?.sku ?? null;
}

function benefitsMonthly(rows) {
  const match = firstMonthlyMembershipMatch(rows, gp, NOW);
  return Boolean(match);
}

function bafPackEligible(rows) {
  const now = NOW;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const pid = Number(raw.ProductId);
    if (!gp.eligibleFlexiblePackMindbodyServiceIds.includes(pid)) continue;
    if (!__testing.clientServiceHasRemaining(raw)) continue;
    const expRaw = raw.ExpirationDate ?? raw.expirationDate;
    if (expRaw) {
      const d = new Date(String(expRaw));
      if (!Number.isNaN(d.getTime())) {
        const today = new Date(now);
        const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        if (expDay < todayDay) continue;
      }
    }
    return true;
  }
  return false;
}

const caseA = monthlyRow({ Remaining: 8, Current: true, Active: true });
check("CASE A monthly_8 Remaining=8 in window → entitlement", matchSku([caseA]) === "monthly_8");
check("CASE A Benefits monthly entitlement", benefitsMonthly([caseA]) === true);

const caseB = monthlyRow({ Remaining: 0, Current: false });
delete caseB.Active;
check("CASE B monthly_8 Remaining=0 Current=false Active absent → entitlement", matchSku([caseB]) === "monthly_8");
check("CASE B window active", monthlyMembershipWindowActive(caseB, NOW) === true);
check("CASE B membership display would be Active", monthlyMembershipWindowActive(caseB, NOW) === true);
check("CASE B Benefits monthly entitlement", benefitsMonthly([caseB]) === true);

const caseC = monthlyRow({
  ProductId: 100129,
  Name: "AMARÉ Monthly 5 Classes",
  Remaining: 0,
});
check("CASE C monthly_5 Remaining=0 in window → entitlement", matchSku([caseC]) === "monthly_5");

const caseD = monthlyRow({
  ProductId: 100135,
  Name: "AMARÉ Monthly Unlimited",
  Remaining: 999999,
});
check("CASE D monthly_unlimited eligible ProductId in window → entitlement", matchSku([caseD]) === "monthly_unlimited");
check("CASE D front-desk 100056 also maps", matchSku([monthlyRow({ ProductId: 100056, Name: "Unlimited" })]) === "monthly_unlimited");

const caseE = monthlyRow({ ExpirationDate: "2026-08-19T00:00:00" });
check("CASE E expired monthly → inactive", matchSku([caseE]) === null);
check("CASE E window inactive", monthlyMembershipWindowActive(caseE, NOW) === false);

const caseF = monthlyRow({
  ActiveDate: "2026-09-01T00:00:00",
  ExpirationDate: "2026-10-01T00:00:00",
});
check("CASE F future ActiveDate → inactive", matchSku([caseF]) === null);

const packZero = {
  ProductId: 100127,
  Name: "10 Class Pack",
  Remaining: 0,
  ExpirationDate: "2027-01-15T00:00:00",
};
check("CASE G 10 Pack Remaining=0 → not monthly entitlement", matchSku([packZero]) === null);
check("CASE G 10 Pack Remaining=0 → BAF pack ineligible", bafPackEligible([packZero]) === false);

const packValid = {
  ProductId: 100127,
  Name: "10 Class Pack",
  Remaining: 4,
  ExpirationDate: "2027-01-15T00:00:00",
};
check(
  "CASE H 10 Pack valid/non-expired → Benefits pack still recognized",
  __testing.hasNonExpiredFlexiblePackInClientServices([packValid], gp) === true,
);
check(
  "CASE H 10 Pack Remaining=0 still counts for Benefits (unchanged)",
  __testing.hasNonExpiredFlexiblePackInClientServices([packZero], gp) === true,
);
check("CASE H BAF pack with remaining stays eligible", bafPackEligible([packValid]) === true);

const buckets = computeUsableCreditBuckets([caseB], NOW);
check(
  "CASE I exhausted membership is not a booking credit",
  buckets.monthlyCreditsRemaining === 0 && __testing.clientServiceHasRemaining(caseB) === false,
  JSON.stringify(buckets),
);

check(
  "DATE naive 2026-08-20T00:00:00 → studio day 2026-08-20",
  mindbodyStudioCalendarDay("2026-08-20T00:00:00") === "2026-08-20",
);
check(
  "DATE naive 2026-09-20T00:00:00 → studio day 2026-09-20",
  mindbodyStudioCalendarDay("2026-09-20T00:00:00") === "2026-09-20",
);

check("SKU map front-desk 100130 → monthly_8", monthlySkuFromMembershipRow({ ProductId: 100130 }, gp) === "monthly_8");
check("SKU map Stripe 100134 → monthly_8", monthlySkuFromMembershipRow({ ProductId: 100134 }, gp) === "monthly_8");
check("SKU map Stripe 100133 → monthly_5", monthlySkuFromMembershipRow({ ProductId: 100133 }, gp) === "monthly_5");

const noWindow = monthlyRow({ ActiveDate: null, ExpirationDate: null });
delete noWindow.ActiveDate;
delete noWindow.ExpirationDate;
check("fail closed without date window", matchSku([noWindow]) === null);

const membershipShaped = {
  Id: 22378,
  Name: "8 monthly classes",
  ProductId: 100134,
  Remaining: 0,
  Current: false,
  ActiveDate: "2026-08-20T00:00:00",
  ExpirationDate: "2026-09-20T00:00:00",
};
check(
  "ActiveClientMemberships-shaped exhausted row → monthly_8",
  __testing.resolveMonthlyFromActiveMemberships([membershipShaped], gp)?.tier === "monthly_8",
);

if (failed) {
  console.error(`\nFAILED ${failed} check(s)`);
  process.exit(1);
}
console.log("\nAll monthly membership entitlement checks passed.");
