/**
 * Server-side Amanda Curry Monthly 5 → Unlimited upgrade (Scenario B).
 * Uses production STRIPE_SECRET_KEY + catalog product resolver. Hardcoded allowlist only.
 */
import Stripe from "stripe";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import {
  ensureActiveStripeProductForCatalogSku,
  requireActiveStripeProductForCatalogSku,
  subscriptionItemPriceDataFromCatalog,
} from "./stripe-membership-stripe-product-lib.mjs";

export const AMANDA_CURRY_UPGRADE_CASE = Object.freeze({
  email: "amandamilacurry@gmail.com",
  stripeCustomerId: "cus_VK0hN399BPtH4Q",
  stripeSubscriptionId: "sub_1UOOoRA47S4kb7VH4ZHJgbq3",
  stripeSubscriptionItemId: "si_VPDEAriyzr4kjU",
  subscriptionRecordId: "sub_amare_8RM7ZQ4ZVMPYWDZB",
  mindbodyClientId: 100004145,
  checkoutPaymentIntentId: "pi_3UOOoPA47S4kb7VH1huLVmpz",
  checkoutPaymentMethodId: "pm_1UOOoOA47S4kb7VHRVKStnOw",
  sourceLocalSku: "monthly_5",
  targetLocalSku: "monthly_unlimited",
  approvedScenario: "B",
  approvedAmountCents: 22900,
  firstInvoiceId: "in_1UOOoOA47S4kb7VHVI4euxfT",
  upgradeNote: "authorized_amanda_monthly5_to_unlimited_2026-10-23",
  idempotencyKey: "amanda-upgrade-B-anchor-now_sub_1UOOoRA47S4kb7VH4ZHJgbq3_2026-10-23",
});

const C = AMANDA_CURRY_UPGRADE_CASE;

const SCENARIO_B = Object.freeze({
  id: "B",
  proration_behavior: "none",
  billing_cycle_anchor: "now",
});

function iso(v) {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

export function productionStripeSecretPresent() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  return {
    present: k.startsWith("sk_live_"),
    mode: k.startsWith("sk_live_") ? "live" : k.startsWith("sk_test_") ? "test" : "missing",
  };
}

export function createProductionStripe() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_live_")) {
    throw Object.assign(new Error("stripe_live_secret_missing"), { code: "stripe_live_secret_missing" });
  }
  return new Stripe(k, { apiVersion: "2025-08-27.basil" });
}

export async function runtimeStripeCheck(stripe) {
  const acct = await stripe.accounts.retrieve();
  const sub = await stripe.subscriptions.retrieve(C.stripeSubscriptionId);
  return {
    stripeLivemode: acct.livemode === true && sub.livemode === true,
    accountId: acct.id,
    subscriptionStatus: sub.status,
    subscriptionMetadataLocalSku: sub.metadata?.localSku || null,
  };
}

function subscriptionPeriod(sub) {
  const item = sub?.items?.data?.[0];
  return {
    start: iso(item?.current_period_start ?? sub?.current_period_start),
    end: iso(item?.current_period_end ?? sub?.current_period_end),
  };
}

function catalogTargetItem() {
  const item = getCatalogItem(C.targetLocalSku);
  if (!item) throw new Error("catalog_monthly_unlimited_missing");
  return item;
}

function targetPriceData(productId) {
  return subscriptionItemPriceDataFromCatalog(catalogTargetItem(), productId);
}

function unlimitedPatchFields() {
  const item = catalogTargetItem();
  const earlyCancellationFeeCents =
    typeof item.earlyCancellationFeePercent === "number" && item.earlyCancellationFeePercent > 0
      ? Math.round((item.amountCents * item.earlyCancellationFeePercent) / 100)
      : undefined;
  return {
    localSku: item.localSku,
    displayName: "AMARÉ Monthly Unlimited",
    monthlyAmountCents: item.amountCents,
    mindbodyServiceId: item.mindbodyServiceId,
    mindbodyContractProductId: item.mindbodyContractProductId,
    ...(earlyCancellationFeeCents != null ? { earlyCancellationFeeCents } : {}),
  };
}

function buildStripeMetadata(existing) {
  const unlimited = catalogTargetItem();
  return {
    ...(existing || {}),
    localSku: unlimited.localSku,
    mindbodyServiceId: String(unlimited.mindbodyServiceId),
    mindbodyContractProductId: String(unlimited.mindbodyContractProductId),
    orderType: existing?.orderType || "monthly_membership",
    billingCadence: existing?.billingCadence || "monthly",
    flow: existing?.flow || "stripe_recurring_subscription",
    source: existing?.source || "amare_membership_checkout",
    subscriptionId: C.subscriptionRecordId,
    mindbodyClientId: String(C.mindbodyClientId),
    upgradeNote: C.upgradeNote,
  };
}

function blobRollbackFields(beforeRecord) {
  return {
    localSku: beforeRecord.localSku,
    displayName: beforeRecord.displayName,
    monthlyAmountCents: beforeRecord.monthlyAmountCents,
    mindbodyServiceId: beforeRecord.mindbodyServiceId,
    mindbodyContractProductId: beforeRecord.mindbodyContractProductId,
    earlyCancellationFeeCents: beforeRecord.earlyCancellationFeeCents,
    currentPeriodStart: beforeRecord.currentPeriodStart ?? null,
    currentPeriodEnd: beforeRecord.currentPeriodEnd ?? null,
  };
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {import("./stripe-subscription-store.mjs").SubscriptionStore} subStore
 */
export async function amandaPreflight(stripe, subStore) {
  const errors = [];
  const sub = await stripe.subscriptions.retrieve(C.stripeSubscriptionId, { expand: ["items.data.price"] });
  if (!sub.livemode) errors.push("not_livemode");
  if (sub.customer !== C.stripeCustomerId) errors.push("customer_mismatch");
  if (sub.pending_update) errors.push("pending_update");

  const alreadyUpgraded =
    sub.metadata?.localSku === C.targetLocalSku ||
    (await subStore.get(C.subscriptionRecordId))?.localSku === C.targetLocalSku;

  if (alreadyUpgraded) {
    return { ok: true, alreadyUpgraded: true, sub: { id: sub.id, status: sub.status }, errors: [] };
  }

  if (sub.status !== "active") errors.push(`status_${sub.status}`);
  const items = sub.items?.data || [];
  if (items.length !== 1) errors.push(`item_count_${items.length}`);
  const price = items[0]?.price;
  const unit = typeof price === "object" ? price?.unit_amount : null;
  if (unit !== 12500) errors.push(`price_not_12500_${unit}`);
  if (items[0]?.id !== C.stripeSubscriptionItemId) errors.push("item_id_mismatch");
  if (sub.metadata?.localSku !== C.sourceLocalSku) errors.push(`metadata_sku_${sub.metadata?.localSku}`);

  const openInvoices = await stripe.invoices.list({
    subscription: C.stripeSubscriptionId,
    status: "open",
    limit: 5,
  });
  if (openInvoices.data.length) errors.push("open_invoices_exist");

  const record = await subStore.get(C.subscriptionRecordId);
  if (!record) errors.push("production_blob_record_missing");
  else {
    if (record.localSku !== C.sourceLocalSku) errors.push(`record_sku_${record.localSku}`);
    if (record.stripeSubscriptionId !== C.stripeSubscriptionId) errors.push("record_stripe_sub_mismatch");
    if (record.mindbodyClientId !== C.mindbodyClientId) errors.push("record_mb_mismatch");
    const inv = (record.invoices || []).find((i) => i.invoiceId === C.firstInvoiceId);
    if (!inv || inv.status !== "synced") errors.push("first_invoice_not_synced");
  }

  const pi = await stripe.paymentIntents.retrieve(C.checkoutPaymentIntentId, { expand: ["payment_method"] });
  const pmId =
    typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id || C.checkoutPaymentMethodId;
  if (pmId !== C.checkoutPaymentMethodId) errors.push("checkout_pm_changed");

  const unlimited = catalogTargetItem();
  if (unlimited.amountCents !== C.approvedAmountCents) errors.push("catalog_unlimited_price_changed");
  if (unlimited.mindbodyServiceId !== 100135) errors.push("catalog_service_not_100135");

  return {
    ok: errors.length === 0,
    alreadyUpgraded: false,
    errors,
    sub: {
      id: sub.id,
      status: sub.status,
      period: subscriptionPeriod(sub),
      metadata: sub.metadata,
    },
    checkoutPaymentMethodId: pmId,
    commitmentEndDate: record?.commitmentEndDate ?? null,
  };
}

/** @param {import("stripe").Stripe} stripe */
export async function amandaPrepareCatalogProduct(stripe) {
  return ensureActiveStripeProductForCatalogSku(stripe, C.targetLocalSku);
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {string} [productId]
 */
export async function amandaPreviewScenarioB(stripe, productId) {
  const prodId = productId || (await requireActiveStripeProductForCatalogSku(stripe, C.targetLocalSku)).id;
  const preview = await stripe.invoices.createPreview({
    customer: C.stripeCustomerId,
    subscription: C.stripeSubscriptionId,
    subscription_details: {
      items: [{ id: C.stripeSubscriptionItemId, price_data: targetPriceData(prodId) }],
      proration_behavior: SCENARIO_B.proration_behavior,
      billing_cycle_anchor: SCENARIO_B.billing_cycle_anchor,
    },
  });
  const lines = (preview.lines?.data || []).map((l) => ({
    description: l.description,
    amount: l.amount,
    proration: l.proration === true,
  }));
  const creditLines = lines.filter(
    (l) => l.amount < 0 || /unused|credit|remaining/i.test(String(l.description || "")),
  );
  return {
    scenario: "B",
    amount_due: preview.amount_due,
    subtotal: preview.subtotal,
    total: preview.total,
    currency: preview.currency,
    period_start: iso(preview.period_start),
    period_end: iso(preview.period_end),
    lines,
    checks: {
      amountExact: preview.amount_due === C.approvedAmountCents,
      noCreditLines: creditLines.length === 0,
      creditLines,
    },
    productIdUsed: prodId,
  };
}

async function ensurePaymentMethod(stripe, pmId) {
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer === C.stripeCustomerId) return pmId;
  if (pm.customer && pm.customer !== C.stripeCustomerId) {
    throw new Error("checkout_pm_bound_to_other_customer");
  }
  await stripe.paymentMethods.attach(pmId, { customer: C.stripeCustomerId });
  await stripe.customers.update(C.stripeCustomerId, {
    invoice_settings: { default_payment_method: pmId },
  });
  return pmId;
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {import("./stripe-subscription-store.mjs").SubscriptionStore} subStore
 */
export async function amandaExecuteScenarioB(stripe, subStore) {
  const pf = await amandaPreflight(stripe, subStore);
  if (pf.alreadyUpgraded) {
    return { skipped: true, reason: "already_upgraded", preflight: pf };
  }
  if (!pf.ok) {
    throw Object.assign(new Error("preflight_failed"), { errors: pf.errors });
  }

  const productPrep = await amandaPrepareCatalogProduct(stripe);
  const preview = await amandaPreviewScenarioB(stripe, productPrep.productId);
  if (preview.amount_due !== C.approvedAmountCents || !preview.checks.amountExact) {
    throw Object.assign(new Error("preview_amount_mismatch"), {
      expected: C.approvedAmountCents,
      actual: preview.amount_due,
      preview,
    });
  }
  if (!preview.checks.noCreditLines) {
    throw Object.assign(new Error("preview_has_credit_lines"), { preview });
  }

  const beforeRecord = await subStore.get(C.subscriptionRecordId);
  if (!beforeRecord) throw new Error("subscription_record_not_found");
  const beforeSub = await stripe.subscriptions.retrieve(C.stripeSubscriptionId);
  const commitmentEndDate = beforeRecord.commitmentEndDate;

  const pmId = await ensurePaymentMethod(stripe, C.checkoutPaymentMethodId);
  const metadata = buildStripeMetadata(beforeSub.metadata || {});
  const skuPatch = unlimitedPatchFields();
  const patchedSku = await subStore.patch(C.subscriptionRecordId, skuPatch);
  if (!patchedSku) throw new Error("blob_patch_failed");

  try {
    const updated = await stripe.subscriptions.update(
      C.stripeSubscriptionId,
      {
        items: [{ id: C.stripeSubscriptionItemId, price_data: targetPriceData(productPrep.productId) }],
        billing_cycle_anchor: "now",
        proration_behavior: "none",
        payment_behavior: "error_if_incomplete",
        default_payment_method: pmId,
        metadata,
      },
      { idempotencyKey: C.idempotencyKey },
    );

    const period = subscriptionPeriod(updated);
    await subStore.patch(C.subscriptionRecordId, {
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    });

    const invs = await stripe.invoices.list({ subscription: C.stripeSubscriptionId, limit: 12 });
    const upgradeInv =
      invs.data.find((i) => i.billing_reason === "subscription_update" && i.status === "paid") ||
      invs.data.find((i) => i.billing_reason === "subscription_update") ||
      null;

    return {
      skipped: false,
      preview,
      productPrep,
      updated: {
        id: updated.id,
        status: updated.status,
        metadata: updated.metadata,
        period,
        priceId: updated.items?.data?.[0]?.price?.id ?? null,
        unitAmount: updated.items?.data?.[0]?.price?.unit_amount ?? null,
      },
      upgradeInvoice: upgradeInv
        ? {
            id: upgradeInv.id,
            status: upgradeInv.status,
            amount_paid: upgradeInv.amount_paid,
            amount_due: upgradeInv.amount_due,
            billing_reason: upgradeInv.billing_reason,
          }
        : null,
      commitmentPreserved: { commitmentEndDate },
      patchedSku: {
        localSku: patchedSku.localSku,
        monthlyAmountCents: patchedSku.monthlyAmountCents,
        mindbodyServiceId: patchedSku.mindbodyServiceId,
      },
    };
  } catch (e) {
    await subStore.patch(C.subscriptionRecordId, blobRollbackFields(beforeRecord));
    throw e;
  }
}

/**
 * @param {import("./stripe-subscription-store.mjs").SubscriptionStore} subStore
 * @param {string} invoiceId
 * @param {number} [maxAttempts]
 */
export async function waitForInvoiceSynced(subStore, invoiceId, maxAttempts = 24) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const record = await subStore.get(C.subscriptionRecordId);
    const row = (record?.invoices || []).find((inv) => inv.invoiceId === invoiceId);
    if (row?.status === "synced") {
      return { synced: true, attempts: i + 1, row };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  const record = await subStore.get(C.subscriptionRecordId);
  const row = (record?.invoices || []).find((inv) => inv.invoiceId === invoiceId);
  return { synced: false, attempts: maxAttempts, row: row || null };
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {import("./stripe-subscription-store.mjs").SubscriptionStore} subStore
 */
export async function amandaVerify(stripe, subStore) {
  const record = await subStore.get(C.subscriptionRecordId);
  const sub = await stripe.subscriptions.retrieve(C.stripeSubscriptionId, { expand: ["items.data.price"] });
  const upcoming = await stripe.invoices.createPreview({
    customer: C.stripeCustomerId,
    subscription: C.stripeSubscriptionId,
  });
  const period = subscriptionPeriod(sub);
  const price = sub.items?.data?.[0]?.price;
  const unit = typeof price === "object" ? price?.unit_amount : null;

  const { resolveStaffAuthHeaders } = await import("./mindbody-class-book-lib.mjs");
  const { fetchMb } = await import("./mindbody-consumer-lib.mjs");
  const staff = await resolveStaffAuthHeaders();
  let mbServices = [];
  if (staff) {
    const csRes = await fetchMb(
      "GET",
      `/public/v6/client/clientservices?${new URLSearchParams({ ClientId: String(C.mindbodyClientId) })}`,
      staff,
      null,
    );
    mbServices = (csRes?.data?.ClientServices || [])
      .filter((s) => Number(s.ProductId) === 100135 || Number(s.ProductId) === 100133)
      .map((s) => ({
        Id: s.Id,
        ProductId: s.ProductId,
        Name: s.Name,
        Remaining: s.Remaining,
        ExpirationDate: s.ExpirationDate,
        PaymentDate: s.PaymentDate,
        Current: s.Current,
      }));
  }

  const upgradeInvoices = (record?.invoices || []).filter(
    (i) => i.invoiceId !== C.firstInvoiceId && i.amountPaidCents === C.approvedAmountCents,
  );
  const paidUpgradeCount = upgradeInvoices.filter((i) => i.status === "synced" || i.status === "paid_but_not_synced").length;

  return {
    record: record
      ? {
          localSku: record.localSku,
          monthlyAmountCents: record.monthlyAmountCents,
          mindbodyServiceId: record.mindbodyServiceId,
          commitmentEndDate: record.commitmentEndDate,
          currentPeriodStart: record.currentPeriodStart,
          currentPeriodEnd: record.currentPeriodEnd,
          invoiceCount: (record.invoices || []).length,
          upgradeInvoiceRows: upgradeInvoices,
        }
      : null,
    stripe: {
      subscriptionId: sub.id,
      status: sub.status,
      metadataLocalSku: sub.metadata?.localSku,
      unitAmount: unit,
      period,
      upcomingRenewal: {
        amount_due: upcoming.amount_due,
        period_start: iso(upcoming.period_start),
        period_end: iso(upcoming.period_end),
      },
    },
    mbServices,
    duplicateChargeGuard: {
      upgradeInvoiceRowsAt22900: upgradeInvoices.length,
      paidOrSyncedUpgradeCount: paidUpgradeCount,
    },
  };
}
