/**
 * GET /api/amare/commerce/catalog
 *
 * Read-only purchase catalog for the AMARÉ app. Prices and eligibility flags
 * come from stripe-catalog-lib + existing feature flags. The client must not
 * send an amount to create-session.
 *
 * Does not create Stripe sessions, Orders, or fulfill sales.
 */

import { SAFE_COMMERCE_SKUS } from "./amare-commerce-lib.mjs";
import { loadStripeMindbodyCatalog } from "./stripe-catalog-lib.mjs";
import {
  loadMbContractTermsConfig,
  resolveManualContractEntryByServiceId,
} from "./load-mb-contract-terms.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const ONE_TIME_SKUS = [
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "pack_10_classes",
  "pack_20_classes",
];

const MONTHLY_SKUS = ["monthly_5", "monthly_8", "monthly_unlimited"];

const SHORT_NAMES = {
  new_client_special_3_for_65: "New Client Special",
  drop_in_single_class: "Drop-In",
  pack_10_classes: "10 Pack",
  pack_20_classes: "20 Pack",
  monthly_5: "Monthly 5",
  monthly_8: "Monthly 8",
  monthly_unlimited: "Unlimited",
};

function oneTimeCheckoutEnabled() {
  return (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1";
}

function recurringCheckoutEnabled() {
  return (process.env.ENABLE_STRIPE_RECURRING_CHECKOUT || "").trim() === "1";
}

function publicAgreement(item) {
  if (item.kind !== "monthlyMembership") return null;
  try {
    const cfg = loadMbContractTermsConfig();
    const fromService =
      item.mindbodyServiceId != null
        ? resolveManualContractEntryByServiceId(cfg, item.mindbodyServiceId)
        : null;
    const productKey = fromService?.productKey || item.mindbodyContractProductId || "";
    const manual =
      fromService?.manual ||
      (productKey && cfg.byMindbodyProductId && typeof cfg.byMindbodyProductId === "object"
        ? /** @type {Record<string, unknown>} */ (cfg.byMindbodyProductId)[productKey]
        : null);
    if (!manual || typeof manual !== "object") return null;
    const m = /** @type {Record<string, unknown>} */ (manual);
    const summaryLines = Array.isArray(m.summaryLines)
      ? m.summaryLines.filter((x) => typeof x === "string")
      : [];
    return {
      contractVersion: typeof m.contractVersion === "string" ? m.contractVersion : "",
      title: typeof m.title === "string" ? m.title : "Membership Agreement",
      marketingPlanName: typeof m.marketingPlanName === "string" ? m.marketingPlanName : "",
      summaryLines,
      termsHtml: typeof m.termsHtml === "string" ? m.termsHtml : "",
      checkboxAgreementLabel:
        typeof m.checkboxAgreementLabel === "string"
          ? m.checkboxAgreementLabel
          : "I have read and agree to the Membership Agreement, cancellation policy, and recurring billing terms.",
      checkboxBillingAuthLabel:
        typeof m.checkboxBillingAuthLabel === "string"
          ? m.checkboxBillingAuthLabel
          : "I authorize Amaré Wellness Studio to charge my selected payment method monthly until I cancel according to the membership terms.",
    };
  } catch {
    return null;
  }
}

function publicItem(item, checkoutEnabled) {
  const available = item.enabled === true && item.mindbodyItemType === "Service";
  const expressOk =
    item.kind === "monthlyMembership" ? true : item.enabledForExpressCheckout === true;
  return {
    localSku: item.localSku,
    displayName: item.displayName,
    shortName: SHORT_NAMES[item.localSku] || item.displayName,
    description: item.description || "",
    amountCents: item.amountCents,
    currency: item.currency || "usd",
    kind: item.kind,
    stripeMode: item.stripeMode || "payment",
    available: available && expressOk,
    checkoutEnabled,
    oneTimePerClient: item.oneTimePerClient === true,
    minimumCommitmentMonths:
      typeof item.minimumCommitmentMonths === "number" ? item.minimumCommitmentMonths : null,
    agreement: publicAgreement(item),
  };
}

export function handleAmareCommerceCatalog(event) {
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }

  let catalog;
  try {
    catalog = loadStripeMindbodyCatalog();
  } catch (e) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        ok: false,
        error: "catalog_unavailable",
        message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    };
  }

  const bySku = new Map(catalog.items.map((it) => [it.localSku, it]));
  const oneTimeOn = oneTimeCheckoutEnabled();
  const monthlyOn = recurringCheckoutEnabled();

  const oneTime = ONE_TIME_SKUS.filter((sku) => SAFE_COMMERCE_SKUS.includes(sku))
    .map((sku) => bySku.get(sku))
    .filter(Boolean)
    .filter((it) => it.enabled)
    .map((it) => publicItem(it, oneTimeOn));

  const monthly = MONTHLY_SKUS.filter((sku) => SAFE_COMMERCE_SKUS.includes(sku))
    .map((sku) => bySku.get(sku))
    .filter(Boolean)
    .filter((it) => it.enabled)
    .map((it) => publicItem(it, monthlyOn));

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({
      ok: true,
      currency: catalog.currency || "usd",
      oneTimeCheckoutEnabled: oneTimeOn,
      recurringCheckoutEnabled: monthlyOn,
      groups: [
        { id: "one_time", title: "One-time", items: oneTime },
        { id: "monthly", title: "Monthly", items: monthly },
      ],
    }),
  };
}

export const handler = withMobileCorsHandler(handleAmareCommerceCatalog);
