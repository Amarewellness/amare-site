/**
 * QA: subscription duplicate-block responses (active / past_due / pending_first_invoice).
 * Run: npm run test:subscription-duplicate-block-responses
 *
 * No Stripe/Mindbody/Blobs mutations. No live checkout sessions.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findActiveSubscriptionForClient } from "../netlify/functions/stripe-create-checkout-session.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNFINISHED =
  "You have an unfinished membership checkout. Please wait a few minutes and try again.";
const ACTIVE_MONTHLY =
  "You already have an active Amaré monthly membership. Please contact us to change plans.";
const HOSTED_UNAVAILABLE =
  "Checkout is temporarily unavailable. Please try again or contact the studio.";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

/** Mirrors create-session duplicate block for active / past_due / pending (source contract). */
function duplicateBlockResponse(existing, isAnnualMembership = false) {
  if (existing.status === "pending_first_invoice") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "subscription_checkout_pending",
        message: UNFINISHED,
        existingSku: existing.localSku,
        existingStatus: existing.status,
        existingSubscriptionId: existing.id,
      },
    };
  }
  return {
    status: 409,
    body: {
      ok: false,
      error: "subscription_already_active",
      message: isAnnualMembership
        ? "You already have an active Amaré membership. Please contact us to change plans."
        : ACTIVE_MONTHLY,
      existingSku: existing.localSku,
      existingStatus: existing.status,
    },
  };
}

/** Mirrors src/js/pricing-api.js friendly mapping for subscription errors. */
function webFriendlyForStripeError(stripeErr, stripeJson) {
  const serverMessage =
    stripeJson && typeof stripeJson.message === "string" ? String(stripeJson.message).trim() : "";
  if (stripeErr === "subscription_checkout_pending") {
    return serverMessage || UNFINISHED;
  }
  if (stripeErr === "subscription_already_active") {
    return ACTIVE_MONTHLY;
  }
  return serverMessage || stripeErr;
}

/** Mirrors amare-app hostedCheckoutFailureMessage (released mobile). */
function mobileHostedCheckoutFailureMessage(data) {
  const error = typeof data?.error === "string" ? data.error : "";
  const message = typeof data?.message === "string" ? data.message.trim() : "";
  const ACTIVE_COPY =
    "You already have an active Amaré monthly membership. Please contact us to change plans.";
  if (error === "subscription_already_active" || /already have an active .* monthly membership/i.test(message)) {
    return ACTIVE_COPY;
  }
  if (message) return message;
  if (error) return error;
  return HOSTED_UNAVAILABLE;
}

/** Mirrors PurchaseScreen.hostedCheckoutErrorMessage (released mobile). */
function mobilePurchaseScreenMessage(errMessage) {
  const ACTIVE_COPY =
    "You already have an active Amaré monthly membership. Please contact us to change plans.";
  if (errMessage === ACTIVE_COPY) return ACTIVE_COPY;
  return HOSTED_UNAVAILABLE;
}

function mockStore(recordsByStatus) {
  return {
    available: true,
    async listByStatus(status) {
      return recordsByStatus[status] || [];
    },
  };
}

const checkoutSrc = await readFile(
  path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"),
  "utf8",
);
const pricingSrc = await readFile(path.join(root, "src/js/pricing-api.js"), "utf8");

// 1–3 Backend response contract (logic mirror + source guards)
const active = duplicateBlockResponse({ id: "sub_a", status: "active", localSku: "monthly_8" });
check("active → 409 subscription_already_active", active.status === 409 && active.body.error === "subscription_already_active");
check("active message is active-membership copy", active.body.message === ACTIVE_MONTHLY);

const pastDue = duplicateBlockResponse({ id: "sub_p", status: "past_due", localSku: "monthly_8" });
check("past_due → 409 subscription_already_active", pastDue.body.error === "subscription_already_active");

const pending = duplicateBlockResponse({
  id: "sub_amare_X",
  status: "pending_first_invoice",
  localSku: "monthly_8",
});
check(
  "pending_first_invoice → subscription_checkout_pending",
  pending.body.error === "subscription_checkout_pending",
);
check("pending message is unfinished checkout", pending.body.message === UNFINISHED);
check(
  "pending MUST NOT contain active membership",
  !/active membership/i.test(String(pending.body.message)),
);
check("pending includes existingSubscriptionId", pending.body.existingSubscriptionId === "sub_amare_X");

check(
  "source: pending branch before subscription_already_active return",
  checkoutSrc.includes('existing.status === "pending_first_invoice"') &&
    checkoutSrc.includes('"subscription_checkout_pending"') &&
    checkoutSrc.includes(UNFINISHED),
);

// 4–5 Canceled statuses do not appear in duplicate scan
check(
  "findActiveSubscriptionForClient only scans active/pending/past_due",
  checkoutSrc.includes('"active", "pending_first_invoice", "past_due"'),
);
const noBlock = await findActiveSubscriptionForClient(
  mockStore({
    canceled_admin: [{ mindbodyClientId: 1, status: "canceled_admin", id: "x" }],
    canceled_payment_failure: [{ mindbodyClientId: 1, status: "canceled_payment_failure", id: "y" }],
  }),
  1,
);
check("canceled_admin / canceled_payment_failure do not block", noBlock === null);

// 6 TTL: stale pending orphan skipped
const staleCreated = new Date(Date.now() - 31 * 60 * 1000).toISOString();
const staleSkipped = await findActiveSubscriptionForClient(
  mockStore({
    pending_first_invoice: [
      {
        mindbodyClientId: 42,
        status: "pending_first_invoice",
        stripeSubscriptionId: "pending_placeholder",
        createdAt: staleCreated,
        id: "sub_old",
      },
    ],
  }),
  42,
);
check("pending orphan older than 30m does not block", staleSkipped === null);

const freshCreated = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const freshMatch = await findActiveSubscriptionForClient(
  mockStore({
    pending_first_invoice: [
      {
        mindbodyClientId: 42,
        status: "pending_first_invoice",
        stripeSubscriptionId: "pending_placeholder",
        createdAt: freshCreated,
        id: "sub_fresh",
        localSku: "monthly_8",
      },
    ],
  }),
  42,
);
check("fresh pending_first_invoice still blocks", freshMatch?.id === "sub_fresh");

// 7–8 Web friendly messages
const webPending = webFriendlyForStripeError("subscription_checkout_pending", {
  message: UNFINISHED,
});
check("web subscription_checkout_pending shows unfinished message", webPending === UNFINISHED);
check(
  "web pending does not route to active copy",
  webPending !== ACTIVE_MONTHLY && !/membership_consent/i.test(webPending),
);

const webActive = webFriendlyForStripeError("subscription_already_active", {});
check("web subscription_already_active unchanged", webActive === ACTIVE_MONTHLY);

check(
  "pricing-api handles subscription_checkout_pending explicitly",
  pricingSrc.includes('stripeErr === "subscription_checkout_pending"'),
);
check(
  "pricing-api does not use membership_checkout_pending",
  !pricingSrc.includes("membership_checkout_pending"),
);

// 9 Released mobile compatibility mock
const mobileRaw = mobileHostedCheckoutFailureMessage({
  error: "subscription_checkout_pending",
  message: UNFINISHED,
});
const mobileShown = mobilePurchaseScreenMessage(mobileRaw);
check(
  "mobile PurchaseScreen shows generic unavailable (not active copy)",
  mobileShown === HOSTED_UNAVAILABLE && mobileShown !== ACTIVE_MONTHLY,
);
check(
  "mobile path does not falsely claim active membership",
  !/already have an active/i.test(mobileShown),
);

// 10 Existing checkout QA hook — CORS script still expects subscription_already_active path
check(
  "create-session still has block_if_active_subscription + subscription_already_active",
  checkoutSrc.includes("block_if_active_subscription") && checkoutSrc.includes("subscription_already_active"),
);

if (failed) {
  console.error(`\n${failed} subscription duplicate-block QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll subscription duplicate-block QA checks passed.");
