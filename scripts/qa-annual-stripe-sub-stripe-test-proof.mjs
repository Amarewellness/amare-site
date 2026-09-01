/**
 * Stripe TEST proof: real invoice payload → annual term stores sub_* (memory only).
 * Does NOT write Postgres. Does NOT mutate revoked QA terms.
 *
 * Run: node scripts/qa-annual-stripe-sub-stripe-test-proof.mjs
 */

import { loadLocalEnv } from "./load-env.mjs";
import Stripe from "stripe";

import {
  isRealStripeSubscriptionId,
  extractStripeInvoiceSubscriptionId,
} from "../netlify/functions/annual-membership-lib.mjs";
import {
  openAnnualMembershipStoreForTests,
  resetAnnualMembershipStoreMemoryForTests,
} from "../netlify/functions/annual-membership-store.mjs";
import { handleAnnualInvoicePaid } from "../netlify/functions/annual-membership-webhook-lib.mjs";

loadLocalEnv();

const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
if (!sk.startsWith("sk_test_")) {
  console.error("FAIL — STRIPE_SECRET_KEY must be sk_test_* for this proof");
  process.exit(1);
}

/** Real QA E2E invoice ids (subscriptions already canceled; read-only Stripe fetch). */
const QA_INVOICES = [
  "in_1UAuz3AjsONx3mgIhk3DleEs",
  "in_1UAwZ5AjsONx3mgIJnnQSMd4",
];

const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

for (const invoiceId of QA_INVOICES) {
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["subscription"] });
  const invoiceSub = extractStripeInvoiceSubscriptionId(invoice);
  check(
    `real Stripe invoice ${invoiceId} exposes sub_*`,
    isRealStripeSubscriptionId(invoiceSub),
    invoiceSub || "(empty)",
  );
  if (!isRealStripeSubscriptionId(invoiceSub)) continue;

  resetAnnualMembershipStoreMemoryForTests();
  const store = openAnnualMembershipStoreForTests();
  const pendingSub = "pending_sub_amare_stripe_test_proof";

  const outcome = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: {
      id: "subrec_proof",
      localSku: "annual_monthly_5",
      mindbodyClientId: 100002839,
      stripeSubscriptionId: pendingSub,
      stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : "",
      amareUserId: "usr_proof",
    },
    store,
    skipMindbodyIssue: true,
  });

  const mem = await store.getAnnualMembershipByInvoiceId(invoiceId);
  check(
    `memory term for ${invoiceId} stores real sub_* on first pass`,
    outcome.ok === true &&
      outcome.created === true &&
      isRealStripeSubscriptionId(mem?.stripe_subscription_id) &&
      mem?.stripe_subscription_id === invoiceSub,
    String(mem?.stripe_subscription_id),
  );

  const replay = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: {
      id: "subrec_proof",
      localSku: "annual_monthly_5",
      mindbodyClientId: 100002839,
      stripeSubscriptionId: invoiceSub,
      stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : "",
    },
    store,
    skipMindbodyIssue: true,
  });
  const memReplay = await store.getAnnualMembershipByInvoiceId(invoiceId);
  check(
    `replay for ${invoiceId} idempotent with same sub_*`,
    replay.created === false && memReplay?.stripe_subscription_id === invoiceSub,
    String(memReplay?.stripe_subscription_id),
  );
}

if (failed) {
  console.error(`\n${failed} Stripe TEST proof failure(s)`);
  process.exit(1);
}
console.log("\nStripe TEST annual sub_* persistence proof passed.");
