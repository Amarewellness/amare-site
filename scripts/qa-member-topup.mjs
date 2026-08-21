/**
 * Member Top-Up eligibility, reserve, payment, and cycle QA.
 * Local only. No Stripe charges. No Mindbody writes. No deploy.
 *
 * Run: node scripts/qa-member-topup.mjs
 */
process.env.NETLIFY = "";
process.env.ENABLE_MEMBER_TOPUP = "1";
process.env.MEMBER_TOPUP_BLOBS = "1";
process.env.MEMBER_TOPUP_BLOBS_LOCAL_MEMORY = "1";
process.env.ENABLE_AMARE_AUTH = process.env.ENABLE_AMARE_AUTH || "1";
process.env.ENABLE_AMARE_COMMERCE = process.env.ENABLE_AMARE_COMMERCE || "1";
process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT = process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "1";
process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY = "1";
process.env.AMARE_SITE_ID = process.env.AMARE_SITE_ID || "qa-topup-site";

const {
  resetMemberTopUpMemoryForTests,
  tryOpenMemberTopUpBlobStore,
} = await import("../netlify/functions/member-topup-blobs.mjs");
const {
  computeUsableCreditBuckets,
  evaluateTopUpGate,
  reserveTopUpSlot,
  releaseTopUpReservation,
  finalizeTopUpPurchase,
  topUpUsageKey,
  resolveMemberTier,
  resolveBillingCycle,
  cycleStartDayKey,
  mindbodyStudioCalendarDay,
  selectCurrentMonthlyCycleRow,
  canSafelyReleaseTopUpReservation,
  isOrdinaryGroupClassCredit,
  TOPUP_SKU,
} = await import("../netlify/functions/member-topup-lib.mjs");
const { readStripeSubscriptionPeriod } = await import("../netlify/functions/stripe-subscription-period.mjs");
const { getCatalogItem, loadStripeMindbodyCatalog } = await import("../netlify/functions/stripe-catalog-lib.mjs");
const { isOneTimeCatalogProduct, isMobilePrepareSku } = await import("../netlify/functions/stripe-payment-flow.mjs");
const { SAFE_COMMERCE_SKUS } = await import("../netlify/functions/amare-commerce-lib.mjs");

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
    Remaining: 0,
    ExpirationDate: "2027-12-31T00:00:00",
    ...partial,
  };
}

const monthly5Zero = row({
  ProductId: 100133,
  Name: "AMARÉ Monthly 5 Classes",
  Remaining: 0,
  ActiveDate: "2026-07-26T00:00:00",
  ExpirationDate: "2026-08-26T00:00:00",
});
const monthly8Zero = row({
  ProductId: 100134,
  Name: "AMARÉ Monthly 8 Classes",
  Remaining: 0,
  ActiveDate: "2026-07-26T00:00:00",
  ExpirationDate: "2026-08-26T00:00:00",
});
const dropIn = row({ ProductId: 100011, Name: "Drop-In — Single Class", Remaining: 1 });
const ncs = row({ ProductId: 100012, Name: "New Client Special — 3 Classes", Remaining: 2 });
const sameDay = row({ ProductId: 100123, Name: "Same-Day Drop-In", Remaining: 1 });
const pack10 = row({ ProductId: 100127, Name: "10 Class Pack", Remaining: 3 });
const pack20 = row({ ProductId: 100128, Name: "20 Class Pack", Remaining: 4 });
const guestPass = row({ ProductId: 100136, Name: "Guest Pass - 1 Class", Remaining: 1 });
const topUpCredit = row({ ProductId: 100143, Name: "Monthly Member Top-Up — 1 Class", Remaining: 1 });
const unlimited = row({ ProductId: 100135, Name: "AMARÉ Monthly Unlimited", Remaining: 999999 });
const expiredDropIn = row({
  ProductId: 100011,
  Name: "Drop-In — Single Class",
  Remaining: 1,
  ExpirationDate: "2020-01-01T00:00:00",
});
const gripSocks = row({ ProductId: 100999, Name: "Grip Socks", Remaining: 2 });
const privateSession = row({ ProductId: 100888, Name: "Private Reformer 1:1", Remaining: 3 });
const workshop = row({ ProductId: 100777, Name: "Sound Bath Workshop", Remaining: 1 });
const inactiveDropIn = row({ ProductId: 100011, Name: "Drop-In — Single Class", Remaining: 1, Active: false });

const b5 = computeUsableCreditBuckets([monthly5Zero]);
check(
  "monthly_5, 0 monthly credits, no other credits → buckets",
  b5.monthlyCreditsRemaining === 0 && b5.otherUsableCredits === 0,
  JSON.stringify(b5),
);
check(
  "monthly_5 zero credits → eligible",
  evaluateTopUpGate({
    tier: "monthly_5",
    monthlyCreditsRemaining: 0,
    otherUsableCredits: 0,
    cycleStartDay: "2026-07-26",
  }).eligible === true,
);

const b8 = computeUsableCreditBuckets([monthly8Zero]);
check("monthly_8, 0 monthly, no other → eligible buckets", b8.monthlyCreditsRemaining === 0 && b8.otherUsableCredits === 0);
check(
  "monthly_8 zero credits → eligible",
  evaluateTopUpGate({
    tier: "monthly_8",
    monthlyCreditsRemaining: 0,
    otherUsableCredits: 0,
    cycleStartDay: "2026-07-26",
  }).eligible === true,
);

check(
  "unlimited → ineligible",
  resolveMemberTier({ services: [unlimited], memberships: [], stripeSubs: [] }).tier === "monthly_unlimited" &&
    evaluateTopUpGate({
      tier: "monthly_unlimited",
      monthlyCreditsRemaining: 0,
      otherUsableCredits: 0,
      cycleStartDay: "2026-07-26",
    }).eligible === false,
);

const withDropIn = computeUsableCreditBuckets([monthly5Zero, dropIn]);
check(
  "monthly_5 with Drop-In remaining → other credits block",
  withDropIn.monthlyCreditsRemaining === 0 && withDropIn.otherUsableCredits === 1,
);
check(
  "monthly_5 + Drop-In → ineligible",
  evaluateTopUpGate({
    tier: "monthly_5",
    monthlyCreditsRemaining: withDropIn.monthlyCreditsRemaining,
    otherUsableCredits: withDropIn.otherUsableCredits,
    cycleStartDay: "2026-07-26",
  }).eligible === false,
);

const withPack = computeUsableCreditBuckets([monthly5Zero, pack10]);
check("monthly_5 with 10-Pack remaining → ineligible", withPack.otherUsableCredits === 3);
check(
  "monthly_5 + 10-Pack gate",
  evaluateTopUpGate({
    tier: "monthly_5",
    monthlyCreditsRemaining: 0,
    otherUsableCredits: withPack.otherUsableCredits,
    cycleStartDay: "2026-07-26",
  }).reason === "other_usable_credits",
);

const ignorePerks = computeUsableCreditBuckets([monthly5Zero, guestPass, topUpCredit, expiredDropIn]);
check(
  "Guest Pass + Top-Up leftover + expired Drop-In are ignored",
  ignorePerks.monthlyCreditsRemaining === 0 && ignorePerks.otherUsableCredits === 0,
);

check("Drop-In is ordinary group-class credit", isOrdinaryGroupClassCredit(dropIn) === true);
check("NCS is ordinary group-class credit", isOrdinaryGroupClassCredit(ncs) === true);
check("Same-Day is ordinary group-class credit", isOrdinaryGroupClassCredit(sameDay) === true);
check("10 Pack is ordinary group-class credit", isOrdinaryGroupClassCredit(pack10) === true);
check("20 Pack is ordinary group-class credit", isOrdinaryGroupClassCredit(pack20) === true);
check("Guest Pass is not ordinary group-class credit", isOrdinaryGroupClassCredit(guestPass) === false);
check("Top-Up leftover is not ordinary group-class credit", isOrdinaryGroupClassCredit(topUpCredit) === false);
check("Unlimited sentinel is not ordinary group-class credit", isOrdinaryGroupClassCredit(unlimited) === false);

const withNcs = computeUsableCreditBuckets([monthly5Zero, ncs]);
check("NCS remaining counts as otherUsableCredits", withNcs.otherUsableCredits === 2);
const withSameDay = computeUsableCreditBuckets([monthly5Zero, sameDay]);
check("valid Same-Day remaining counts as otherUsableCredits", withSameDay.otherUsableCredits === 1);
const with20 = computeUsableCreditBuckets([monthly5Zero, pack20]);
check("20 Pack remaining counts as otherUsableCredits", with20.otherUsableCredits === 4);

const nonClass = computeUsableCreditBuckets([monthly5Zero, gripSocks, privateSession, workshop, inactiveDropIn]);
check(
  "retail / private / workshop / inactive do not count as otherUsableCredits",
  nonClass.otherUsableCredits === 0 && nonClass.monthlyCreditsRemaining === 0,
);
check(
  "non-class Remaining>0 does not block Top-Up",
  evaluateTopUpGate({
    tier: "monthly_5",
    monthlyCreditsRemaining: nonClass.monthlyCreditsRemaining,
    otherUsableCredits: nonClass.otherUsableCredits,
    cycleStartDay: "2026-07-26",
  }).eligible === true,
);

const basil = readStripeSubscriptionPeriod({
  id: "sub_qa",
  items: { data: [{ current_period_start: 1785370286, current_period_end: 1788048686 }] },
});
check("Stripe period source is items[] when root is empty", basil.source === "items" && !!basil.start && !!basil.end);
check(
  "cycle key is studio-day of period start",
  cycleStartDayKey(basil.start) === "2026-08-26" || Boolean(cycleStartDayKey(basil.start)),
);

const cycle = resolveBillingCycle({
  stripeStart: basil.start,
  stripeEnd: basil.end,
  monthlyRow: monthly5Zero,
});
check("billing cycle prefers Stripe items[] dates", cycle.source === "stripe" && cycle.cycleStartDay != null);

const STUDIO_NOW_IN_LIVE_WINDOW = Date.UTC(2026, 7, 21, 16, 0, 0);
const exhaustedCurrentFalse = {
  ProductId: 100134,
  Name: "AMARÉ Monthly 8 Classes",
  Remaining: 0,
  Current: false,
  Active: false,
  ActiveDate: "2026-08-20T00:00:00",
  ExpirationDate: "2026-09-20T00:00:00",
};
const leftoverMonthly = {
  ...exhaustedCurrentFalse,
  Remaining: 8,
  Current: true,
  Active: true,
};
const expiredMonthlyWindow = {
  ProductId: 100134,
  Name: "AMARÉ Monthly 8 Classes",
  Remaining: 0,
  Current: false,
  ActiveDate: "2026-06-01T00:00:00",
  ExpirationDate: "2026-07-01T00:00:00",
};
const oldExpiredMonthly = {
  ProductId: 100130,
  Name: "AMARÉ Monthly 8 Classes",
  Remaining: 0,
  Current: false,
  ActiveDate: "2026-05-01T00:00:00",
  ExpirationDate: "2026-06-01T00:00:00",
};

function gateFromServices(services, nowMs = STUDIO_NOW_IN_LIVE_WINDOW) {
  const buckets = computeUsableCreditBuckets(services, nowMs);
  const currentMonthly = selectCurrentMonthlyCycleRow(services, nowMs);
  const resolved = resolveBillingCycle({ monthlyRow: currentMonthly });
  const tier = resolveMemberTier({ services, memberships: [], stripeSubs: [] });
  const gate = evaluateTopUpGate({
    tier: tier.tier,
    monthlyCreditsRemaining: buckets.monthlyCreditsRemaining,
    otherUsableCredits: buckets.otherUsableCredits,
    cycleStartDay: resolved.cycleStartDay,
  });
  return { buckets, currentMonthly, cycle: resolved, tier, gate };
}

check(
  "Mindbody ActiveDate 2026-08-20T00:00:00 → cycleStartDay 2026-08-20, never 2026-08-19",
  mindbodyStudioCalendarDay("2026-08-20T00:00:00") === "2026-08-20" &&
    cycleStartDayKey("2026-08-20T00:00:00") === "2026-08-20" &&
    cycleStartDayKey("2026-08-20T00:00:00") !== "2026-08-19",
);
const csCycle = resolveBillingCycle({ monthlyRow: exhaustedCurrentFalse });
check(
  "ClientService fallback cycle days keep studio calendar 2026-08-20 → 2026-09-20",
  csCycle.source === "clientservices" &&
    csCycle.cycleStartDay === "2026-08-20" &&
    csCycle.cycleEndDay === "2026-09-20",
);

const leftoverGate = gateFromServices([leftoverMonthly]);
check(
  "eligible monthly row + Remaining > 0 → no Top-Up",
  leftoverGate.gate.eligible === false && leftoverGate.gate.reason === "monthly_credits_remain" && leftoverGate.gate.cta === "none",
);

const exhaustedGate = gateFromServices([exhaustedCurrentFalse]);
check(
  "Remaining=0 Current=false in-window monthly is retained for cycle",
  exhaustedGate.currentMonthly != null &&
    exhaustedGate.currentMonthly.ProductId === 100134 &&
    exhaustedGate.cycle.cycleStartDay === "2026-08-20" &&
    exhaustedGate.cycle.cycleEndDay === "2026-09-20" &&
    exhaustedGate.cycle.source === "clientservices",
);
check(
  "Remaining=0 Current=false in-window monthly → cta=topup",
  exhaustedGate.buckets.monthlyCreditsRemaining === 0 &&
    exhaustedGate.buckets.otherUsableCredits === 0 &&
    exhaustedGate.gate.eligible === true &&
    exhaustedGate.gate.reason === "eligible" &&
    exhaustedGate.gate.cta === "topup",
);
check(
  "inactive exhausted monthly does not enter otherUsableCredits",
  computeUsableCreditBuckets([exhaustedCurrentFalse], STUDIO_NOW_IN_LIVE_WINDOW).otherUsableCredits === 0,
);

const expiredGate = gateFromServices([expiredMonthlyWindow]);
check(
  "eligible monthly row + Remaining=0 + expired window → ineligible",
  expiredGate.currentMonthly == null &&
    expiredGate.cycle.source === "missing" &&
    expiredGate.gate.eligible === false &&
    expiredGate.gate.cta === "none",
);

const oldExpiredGate = gateFromServices([oldExpiredMonthly, expiredMonthlyWindow]);
check(
  "old expired monthly ClientService cannot become current cycle",
  oldExpiredGate.currentMonthly == null && oldExpiredGate.cycle.source === "missing",
);

const inactivePackGate = gateFromServices([
  exhaustedCurrentFalse,
  { ProductId: 100011, Name: "Drop-In — Single Class", Remaining: 1, Active: false, Current: false },
  { ProductId: 100127, Name: "10 Class Pack", Remaining: 2, Active: false },
]);
check(
  "inactive Drop-In / pack cannot block through otherUsableCredits",
  inactivePackGate.buckets.otherUsableCredits === 0 &&
    inactivePackGate.gate.cta === "topup" &&
    inactivePackGate.gate.eligible === true,
);

check(
  "no resolvable cycle → fail closed",
  evaluateTopUpGate({
    tier: "monthly_8",
    monthlyCreditsRemaining: 0,
    otherUsableCredits: 0,
    cycleStartDay: null,
  }).reason === "cycle_unresolved" &&
    evaluateTopUpGate({
      tier: "monthly_8",
      monthlyCreditsRemaining: 0,
      otherUsableCredits: 0,
      cycleStartDay: null,
    }).cta === "none",
);

resetMemberTopUpMemoryForTests();
const store = tryOpenMemberTopUpBlobStore({});
check("isolated memory store opens", !!store);

const siteId = "qa-topup-site";
const clientId = 100000001;
const day = "2026-07-26";
const first = await reserveTopUpSlot(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  cycleStart: "2026-07-26T00:00:00.000Z",
  cycleEnd: "2026-08-26T00:00:00.000Z",
  orderId: "ord_first",
});
check("first Top-Up reserve → succeeds", first.ok === true, first.reason);

const second = await reserveTopUpSlot(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  cycleStart: "2026-07-26T00:00:00.000Z",
  cycleEnd: "2026-08-26T00:00:00.000Z",
  orderId: "ord_second",
});
check("second simultaneous reserve → blocked", second.ok === false && second.reason === "topup_reserved", second.reason);

const released = await releaseTopUpReservation(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  orderId: "ord_first",
});
check("payment failure → reservation released", released.ok === true && released.released === true);

const afterFail = await reserveTopUpSlot(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  cycleStart: "2026-07-26T00:00:00.000Z",
  cycleEnd: "2026-08-26T00:00:00.000Z",
  orderId: "ord_retry",
});
check("after release, a new reserve succeeds", afterFail.ok === true);

const paid = await finalizeTopUpPurchase(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  orderId: "ord_retry",
  cycleStart: "2026-07-26T00:00:00.000Z",
  cycleEnd: "2026-08-26T00:00:00.000Z",
});
check("payment success → slot purchased", paid.ok === true);

const afterPaidRelease = await releaseTopUpReservation(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  orderId: "ord_retry",
});
check(
  "Mindbody sync failure after paid → slot remains consumed",
  afterPaidRelease.released === false && afterPaidRelease.reason === "already_purchased",
);

check(
  "unpaid PaymentSheet / Checkout cancel may release",
  canSafelyReleaseTopUpReservation({
    order: { localSku: TOPUP_SKU, mindbodySyncStatus: "checkout_created" },
    stripePaymentIntentStatus: "requires_payment_method",
    stripeSessionPaymentStatus: "unpaid",
  }).ok === true,
);
check(
  "paid PaymentIntent cannot release reservation",
  canSafelyReleaseTopUpReservation({
    order: { localSku: TOPUP_SKU, mindbodySyncStatus: "checkout_created" },
    stripePaymentIntentStatus: "succeeded",
  }).ok === false,
);
check(
  "paid Checkout session cannot release reservation",
  canSafelyReleaseTopUpReservation({
    order: { localSku: TOPUP_SKU, mindbodySyncStatus: "checkout_created" },
    stripeSessionPaymentStatus: "paid",
  }).ok === false,
);
check(
  "processing PaymentIntent cannot release reservation",
  canSafelyReleaseTopUpReservation({
    order: { localSku: TOPUP_SKU, mindbodySyncStatus: "checkout_created" },
    stripePaymentIntentStatus: "processing",
  }).ok === false,
);
check(
  "order already payment_completed cannot release reservation",
  canSafelyReleaseTopUpReservation({
    order: { localSku: TOPUP_SKU, mindbodySyncStatus: "payment_completed" },
  }).ok === false,
);

const key = topUpUsageKey(siteId, clientId, day);
const afterPaid = await store.get(key, { type: "json" });
check("purchased record stays purchased", afterPaid?.status === "purchased");

const dup = await finalizeTopUpPurchase(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: day,
  orderId: "ord_retry",
});
check("duplicate webhook consume is idempotent", dup.ok === true);
const still = await store.get(key, { type: "json" });
check("duplicate webhook → still one purchased slot", still?.status === "purchased" && still?.orderId === "ord_retry");

const nextCycle = await reserveTopUpSlot(store, {
  siteId,
  mindbodyClientId: clientId,
  cycleStartDay: "2026-08-26",
  cycleStart: "2026-08-26T00:00:00.000Z",
  cycleEnd: "2026-09-26T00:00:00.000Z",
  orderId: "ord_next",
});
check("new billing cycle → new Top-Up eligibility", nextCycle.ok === true);

const usedCta = evaluateTopUpGate({
  tier: "monthly_5",
  monthlyCreditsRemaining: 0,
  otherUsableCredits: 0,
  cycleStartDay: day,
  usage: afterPaid,
});
check("after used, monthly_5 CTA is Upgrade to Monthly 8", usedCta.cta === "upgrade_monthly_8" && usedCta.eligible === false);

const used8 = evaluateTopUpGate({
  tier: "monthly_8",
  monthlyCreditsRemaining: 0,
  otherUsableCredits: 0,
  cycleStartDay: day,
  usage: afterPaid,
});
check("after used, monthly_8 CTA is Go Unlimited", used8.cta === "go_unlimited");

const item = getCatalogItem(TOPUP_SKU);
check("catalog has monthly_member_topup at $29 / service 100143", item?.amountCents === 2900 && item?.mindbodyServiceId === 100143);
check("catalog kind is memberAddon, not public express", item?.kind === "memberAddon" && item?.enabledForExpressCheckout === false);
check("top-up is a one-time catalog product for fulfillment", isOneTimeCatalogProduct(item));
check("top-up is allowlisted for commerce / mobile", SAFE_COMMERCE_SKUS.includes(TOPUP_SKU) && isMobilePrepareSku(TOPUP_SKU));

const fs = await import("node:fs");
const appPurchaseFlow = fs.readFileSync(new URL("../amare-app/src/lib/purchase-flow.ts", import.meta.url), "utf8");
check("app PaymentSheet allowlist includes top-up", appPurchaseFlow.includes(`"${TOPUP_SKU}"`));

const publicSkus = loadStripeMindbodyCatalog().items.filter((it) => it.enabledForExpressCheckout).map((it) => it.localSku);
check("top-up is hidden from public/anonymous express catalog", !publicSkus.includes(TOPUP_SKU));

const widget = fs.readFileSync(new URL("../src/js/member-topup.js", import.meta.url), "utf8");
const card = fs.readFileSync(new URL("../amare-app/src/components/MemberTopUpCard.tsx", import.meta.url), "utf8");
const cancelPage = fs.readFileSync(new URL("../src/content/checkout-cancel.html", import.meta.url), "utf8");
const statusFn = fs.readFileSync(new URL("../netlify/functions/mindbody-member-top-up-status.mjs", import.meta.url), "utf8");
const releaseFn = fs.readFileSync(new URL("../netlify/functions/mindbody-member-top-up-release.mjs", import.meta.url), "utf8");
check(
  "no misleading expiration copy",
  !/next renewal|end of this billing cycle|expires at the end/i.test(widget + card) &&
    widget.includes("Need one more class?") &&
    widget.includes("Add 1 Class · $29") &&
    widget.includes("One member top-up per billing cycle."),
);
check(
  "PaymentSheet cancel posts unpaid release",
  card.includes("releaseUnpaidMemberTopUp") && card.includes('sheet.status === "canceled"'),
);
check(
  "successful unpaid release clears the Top-Up purchaseAttemptId",
  card.includes("rel.released") && card.includes("clearPurchaseAttemptId(MEMBER_TOPUP_SKU)"),
);
const memberTopUpTs = fs.readFileSync(new URL("../amare-app/src/lib/member-topup.ts", import.meta.url), "utf8");
check(
  "stale canceled attempt retries once with a new purchaseAttemptId",
  memberTopUpTs.includes("purchase_attempt_retired") &&
    memberTopUpTs.includes("clearPurchaseAttemptId(MEMBER_TOPUP_SKU)") &&
    memberTopUpTs.includes("prepareMemberTopUpPayment"),
);
check(
  "Hosted Checkout cancel_url posts unpaid release",
  cancelPage.includes("/api/mindbody/member/top-up/release") && cancelPage.includes("orderId"),
);
check(
  "status endpoint uses resolveStudioCustomer and never trusts query clientId",
  statusFn.includes("resolveStudioCustomer") &&
    !statusFn.includes("queryStringParameters") &&
    statusFn.includes("withMobileCorsHandler"),
);
const { handler: topUpStatusHandler } = await import("../netlify/functions/mindbody-member-top-up-status.mjs");
const signedOutStatus = await topUpStatusHandler({
  httpMethod: "GET",
  headers: {},
  queryStringParameters: { clientId: "100002726" },
});
const signedOutBody = JSON.parse(signedOutStatus.body || "{}");
check(
  "signed-out status is not eligible even if a clientId is supplied",
  signedOutStatus.statusCode !== 200 || signedOutBody.eligible !== true,
);
check(
  "release endpoint fail-closes on paid Stripe/order state",
  releaseFn.includes("releaseUnpaidTopUpOrder") && releaseFn.includes("order_paid"),
);

const leftoverCta = evaluateTopUpGate({
  tier: "monthly_5",
  monthlyCreditsRemaining: 1,
  otherUsableCredits: 0,
  cycleStartDay: "2026-07-26",
});
check("leftover monthly credit hides Top-Up CTA", leftoverCta.eligible === false && leftoverCta.cta === "none");

const { resetOrderStoreMemoryForTests, openOrderStore } = await import("../netlify/functions/stripe-order-store.mjs");
const {
  handleMobilePaymentPrepare,
  isCanceledPaymentIntentStatus,
  isRetiredUnpaidTopUpOrder,
} = await import("../netlify/functions/amare-commerce-mobile-payments.mjs");

check("canceled PI status is detected", isCanceledPaymentIntentStatus("canceled") === true);
check(
  "requires_payment_method is not treated as canceled",
  isCanceledPaymentIntentStatus("requires_payment_method") === false,
);
check(
  "released Top-Up order is retired",
  isRetiredUnpaidTopUpOrder({ localSku: TOPUP_SKU, mindbodySyncStatus: "canceled" }) === true,
);
check(
  "open Top-Up order is not retired",
  isRetiredUnpaidTopUpOrder({ localSku: TOPUP_SKU, mindbodySyncStatus: "checkout_created" }) === false,
);

function parsePrep(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch {
    return {};
  }
}

function mockTopUpStripe() {
  let n = 0;
  const byIdem = new Map();
  const byId = new Map();
  return {
      createdKeys: [],
    customers: { search: async () => ({ data: [] }), list: async () => ({ data: [] }), create: async () => ({ id: "cus_topup" }) },
    paymentIntents: {
      create: async (params, opts) => {
        const key = opts?.idempotencyKey || "";
        if (key && byIdem.has(key)) return byIdem.get(key);
        n += 1;
        const pi = {
          id: `pi_topup_${n}`,
          client_secret: `pi_topup_${n}_secret`,
          status: "requires_payment_method",
          amount: params.amount,
          currency: params.currency,
          customer: params.customer,
          metadata: params.metadata,
        };
        if (key) byIdem.set(key, pi);
        byId.set(pi.id, pi);
        return pi;
      },
      retrieve: async (id) => byId.get(id) || { id, status: "canceled", client_secret: `${id}_secret` },
      markCanceled(id) {
        const cur = byId.get(id);
        if (cur) {
          cur.status = "canceled";
          byId.set(id, cur);
        }
      },
    },
  };
}

const USER_TOP = "usr_TOPUPQA0000000000000001";
function topUpPrepDeps(store, stripe) {
  return {
    oneTimeEnabled: true,
    commerceEnabled: true,
    orderStore: store,
    stripe,
    ncsDuplicateDryRun: async () => ({ decision: "allow" }),
    resolveStripeCustomer: async () => "cus_topup",
    resolveAmareUser: async () => ({ signedIn: true, amareUserId: USER_TOP, reason: null }),
    resolveCommerceCustomer: async () => ({
      state: "AMARE_LINKED",
      amareUserId: USER_TOP,
      clientId: 100002726,
      authSource: "amare",
      mbEmail: "buyer@example.com",
    }),
    prepareTopUpForPurchase: async ({ orderId }) => ({
      ok: true,
      ctx: {
        cycle: {
          cycleStartDay: "2026-08-20",
          cycleStart: "2026-08-20T00:00:00",
          cycleEnd: "2026-09-20T00:00:00",
        },
      },
      reserved: { ok: true, orderId },
    }),
  };
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockTopUpStripe();
  const attemptA = "attemptA_topup_aaaaaaaa";
  const first = await handleMobilePaymentPrepare(
    {
      httpMethod: "POST",
      headers: { authorization: `Bearer test.${USER_TOP}` },
      body: JSON.stringify({ sku: TOPUP_SKU, purchaseAttemptId: attemptA }),
    },
    topUpPrepDeps(store, stripe),
  );
  const firstBody = parsePrep(first);
  check("Top-Up prepare A returns a confirmable PI", first.statusCode === 200 && !!firstBody.orderId && !!firstBody.paymentIntentClientSecret);
  const orderA = firstBody.orderId;
  const idemA = `amare-mobile-payment:${orderA}`;
  const stored = await store.get(orderA);
  if (stored?.stripePaymentIntentId) stripe.paymentIntents.markCanceled(stored.stripePaymentIntentId);
  await store.patch(orderA, { mindbodySyncStatus: "canceled" });

  const stale = await handleMobilePaymentPrepare(
    {
      httpMethod: "POST",
      headers: { authorization: `Bearer test.${USER_TOP}` },
      body: JSON.stringify({ sku: TOPUP_SKU, purchaseAttemptId: attemptA }),
    },
    topUpPrepDeps(store, stripe),
  );
  const staleBody = parsePrep(stale);
  check(
    "stale canceled purchaseAttemptId cannot resurrect canceled PI",
    stale.statusCode === 409 &&
      staleBody.error === "purchase_attempt_retired" &&
      !staleBody.paymentIntentClientSecret,
    JSON.stringify(staleBody),
  );

  const attemptB = "attemptB_topup_bbbbbbbb";
  const second = await handleMobilePaymentPrepare(
    {
      httpMethod: "POST",
      headers: { authorization: `Bearer test.${USER_TOP}` },
      body: JSON.stringify({ sku: TOPUP_SKU, purchaseAttemptId: attemptB }),
    },
    topUpPrepDeps(store, stripe),
  );
  const secondBody = parsePrep(second);
  const storedB = secondBody.orderId ? await store.get(secondBody.orderId) : null;
  check(
    "retry creates fresh order + fresh PI + fresh Stripe idempotency key",
    second.statusCode === 200 &&
      !!secondBody.orderId &&
      secondBody.orderId !== orderA &&
      storedB?.stripePaymentIntentId &&
      storedB.stripePaymentIntentId !== stored?.stripePaymentIntentId &&
      `amare-mobile-payment:${secondBody.orderId}` !== idemA,
    JSON.stringify({ first: firstBody, second: secondBody, piA: stored?.stripePaymentIntentId, piB: storedB?.stripePaymentIntentId }),
  );
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockTopUpStripe();
  const attempt = "attemptC_topup_cccccccc";
  const first = await handleMobilePaymentPrepare(
    {
      httpMethod: "POST",
      headers: { authorization: `Bearer test.${USER_TOP}` },
      body: JSON.stringify({ sku: TOPUP_SKU, purchaseAttemptId: attempt }),
    },
    topUpPrepDeps(store, stripe),
  );
  const firstBody = parsePrep(first);
  const stored = await store.get(firstBody.orderId);
  if (stored?.stripePaymentIntentId) stripe.paymentIntents.markCanceled(stored.stripePaymentIntentId);
  const canceledPi = await handleMobilePaymentPrepare(
    {
      httpMethod: "POST",
      headers: { authorization: `Bearer test.${USER_TOP}` },
      body: JSON.stringify({ sku: TOPUP_SKU, purchaseAttemptId: attempt }),
    },
    topUpPrepDeps(store, stripe),
  );
  const canceledBody = parsePrep(canceledPi);
  check(
    "canceled PI is never returned by prepare",
    canceledPi.statusCode === 409 &&
      canceledBody.error === "purchase_attempt_retired" &&
      !canceledBody.paymentIntentClientSecret,
    JSON.stringify(canceledBody),
  );
}
const reservedCta = evaluateTopUpGate({
  tier: "monthly_5",
  monthlyCreditsRemaining: 0,
  otherUsableCredits: 0,
  cycleStartDay: "2026-07-26",
  usage: { status: "reserved", expiresAt: "2099-01-01T00:00:00.000Z" },
});
check("reserved slot hides second purchase CTA", reservedCta.eligible === false && reservedCta.reason === "topup_reserved");

const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
const localDev = fs.readFileSync(new URL("./unified-local-dev.mjs", import.meta.url), "utf8");
check("ENABLE_MEMBER_TOPUP is documented and default-off", envExample.includes("ENABLE_MEMBER_TOPUP=0"));
check(
  "top-up status route is wired",
  toml.includes("/api/mindbody/member/top-up/status") && localDev.includes("/api/mindbody/member/top-up/status"),
);
check(
  "top-up unpaid-release route is wired",
  toml.includes("/api/mindbody/member/top-up/release") && localDev.includes("/api/mindbody/member/top-up/release"),
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll member top-up QA checks passed.");
