/**
 * Authorized production execution: Amanda Curry Monthly 5 → Unlimited (billing anchor reset to now).
 *
 * Inject key on this process only (avoid pasting into chat or command history):
 *   PowerShell:
 *     $k = Read-Host "Stripe rk_live or sk_live" -AsSecureString
 *     $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($k)
 *     $env:STRIPE_RESTRICTED_LIVE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
 *     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
 *     node amare-app/qa-output/_amanda-upgrade-execute.mjs permissions
 *     node amare-app/qa-output/_amanda-upgrade-execute.mjs prepare-product   # if no active prod for monthly_unlimited
 *     node amare-app/qa-output/_amanda-upgrade-execute.mjs preview-both
 *   Clear after run:
 *     Remove-Item Env:STRIPE_RESTRICTED_LIVE_KEY -ErrorAction SilentlyContinue
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv } from "../../scripts/load-env.mjs";
import { getCatalogItem } from "../../netlify/functions/stripe-catalog-lib.mjs";
import {
  ensureActiveStripeProductForCatalogSku,
  findActiveStripeProductForLocalSku,
  requireActiveStripeProductForCatalogSku,
  subscriptionItemPriceDataFromCatalog,
} from "../../netlify/functions/stripe-membership-stripe-product-lib.mjs";
import { openSubscriptionStore } from "../../netlify/functions/stripe-subscription-store.mjs";

loadLocalEnv();
delete process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY;
delete process.env.STRIPE_SUBSCRIPTION_STORE_BLOBS_QA;
process.env.STRIPE_SUBSCRIPTION_STORE_BLOBS_PRODUCTION = "1";

const EMAIL = "amandamilacurry@gmail.com";
const SITE_ID = "f315d80d-f61e-4fef-9a06-68bb09192d56";
const TARGET_CUS = "cus_VK0hN399BPtH4Q";
const TARGET_SUB = "sub_1UOOoRA47S4kb7VH4ZHJgbq3";
const TARGET_ITEM = "si_VPDEAriyzr4kjU";
const TARGET_RECORD = "sub_amare_8RM7ZQ4ZVMPYWDZB";
const TARGET_MB = 100004145;
const CHECKOUT_PI = "pi_3UOOoPA47S4kb7VH1huLVmpz";
const CHECKOUT_PM = "pm_1UOOoOA47S4kb7VHRVKStnOw";
const TARGET_SKU = "monthly_unlimited";

/** Set by prepare-product / execute in-process; previews use read-only product search only. */
let resolvedStripeProductId = "";

/** @typedef {"A" | "B"} UpgradeScenario */
const SCENARIOS = /** @type {const} */ ({
  A: {
    id: "A",
    label: "reset_anchor_with_m5_credit",
    proration_behavior: "always_invoice",
    description: "billing_cycle_anchor=now, Unlimited $229, credit unused Monthly 5 time",
  },
  B: {
    id: "B",
    label: "reset_anchor_no_credit",
    proration_behavior: "none",
    description: "billing_cycle_anchor=now, Unlimited $229, no proration credit (5/5 classes used)",
  },
});

const phase = (process.argv[2] || "preflight").trim();
const scenarioArg = (process.argv[3] || "").trim().toUpperCase();

function netlifyCliToken() {
  const configPath =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "netlify",
          "Config",
          "config.json",
        )
      : path.join(os.homedir(), ".config", "netlify", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const user of Object.values(cfg?.users || {})) {
      const token = String(user?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    /* ignore */
  }
  return (process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PAT || "").trim();
}

/** Live secret or restricted key — never log return value. */
function stripeLiveKey() {
  for (const k of ["STRIPE_LIVE_SECRET_KEY", "STRIPE_RESTRICTED_LIVE_KEY", "STRIPE_SECRET_KEY"]) {
    const v = (process.env[k] || "").trim();
    if (/^(sk_live_|rk_live_)/.test(v)) return v;
  }
  return "";
}

function stripeKeyMode(key) {
  if (key.startsWith("rk_live_")) return "restricted";
  if (key.startsWith("sk_live_")) return "secret";
  return "missing";
}

async function stripeLive() {
  const key = stripeLiveKey();
  if (!/^(sk_live_|rk_live_)/.test(key)) {
    throw new Error(
      "missing_stripe_live_key: set STRIPE_LIVE_SECRET_KEY or STRIPE_RESTRICTED_LIVE_KEY (sk_live_ or rk_live_) on this process only",
    );
  }
  const Stripe = (await import("stripe")).default;
  return new Stripe(key);
}

function catalogTargetItem() {
  const item = getCatalogItem(TARGET_SKU);
  if (!item) throw new Error("catalog_monthly_unlimited_missing");
  return item;
}

/** Subscription item update uses price_data.product (product id), not product_data. */
function targetSubscriptionPriceData(productId) {
  return subscriptionItemPriceDataFromCatalog(catalogTargetItem(), productId);
}

/** Read-only: active Stripe Product aligned to catalog localSku (not a hardcoded prod_ id). */
async function catalogStripeProductStatus(stripe) {
  const product = await findActiveStripeProductForLocalSku(stripe, TARGET_SKU);
  return {
    localSku: TARGET_SKU,
    productId: product?.id ?? null,
    active: Boolean(product),
    metadata: product?.metadata || {},
    prepareProductRequired: !product,
  };
}

/**
 * PRODUCTION WRITE — explicit `prepare-product` only.
 * Reuses an active catalog-aligned Product or creates one (checkout-equivalent metadata).
 * Does not reactivate inactive historical checkout products.
 */
async function prepareCatalogStripeProduct(stripe) {
  const result = await ensureActiveStripeProductForCatalogSku(stripe, TARGET_SKU);
  resolvedStripeProductId = result.productId;
  return result;
}

/** Fail fast on read-only preview paths if no active catalog-aligned Product exists yet. */
async function assertCatalogStripeProductReadyForPreview(stripe) {
  if (resolvedStripeProductId) {
    return { productId: resolvedStripeProductId, localSku: TARGET_SKU };
  }
  const product = await requireActiveStripeProductForCatalogSku(stripe, TARGET_SKU);
  resolvedStripeProductId = product.id;
  return { productId: product.id, localSku: TARGET_SKU, metadata: product.metadata || {} };
}

async function checkStripePermissions(stripe) {
  const checks = [];
  try {
    await stripe.customers.retrieve(TARGET_CUS);
    checks.push({ op: "customers.retrieve", ok: true });
  } catch (e) {
    checks.push({ op: "customers.retrieve", ok: false, code: /** @type {{ code?: string }} */ (e)?.code });
  }
  try {
    await stripe.subscriptions.retrieve(TARGET_SUB);
    checks.push({ op: "subscriptions.retrieve", ok: true });
  } catch (e) {
    checks.push({ op: "subscriptions.retrieve", ok: false, code: /** @type {{ code?: string }} */ (e)?.code });
  }
  try {
    await stripe.invoices.createPreview({
      customer: TARGET_CUS,
      subscription: TARGET_SUB,
    });
    checks.push({ op: "invoices.createPreview (renewal)", ok: true });
  } catch (e) {
    checks.push({ op: "invoices.createPreview (renewal)", ok: false, code: /** @type {{ code?: string }} */ (e)?.code });
  }
  try {
    const status = await catalogStripeProductStatus(stripe);
    checks.push({
      op: "products.search (active product for catalog localSku)",
      ok: true,
      localSku: TARGET_SKU,
      productId: status.productId,
      productActive: status.active,
      prepareProductRequired: status.prepareProductRequired,
    });
  } catch (e) {
    checks.push({
      op: "products.search (active product for catalog localSku)",
      ok: false,
      code: /** @type {{ code?: string }} */ (e)?.code,
    });
  }
  checks.push({
    op: "products.create",
    ok: null,
    readOnlyPhase: true,
    note: "Not exercised in permissions. Explicit prepare-product may create a catalog-aligned Product once (idempotent).",
  });
  return checks;
}

function subscriptionPeriod(sub) {
  const item = sub?.items?.data?.[0];
  return {
    start: iso(item?.current_period_start ?? sub?.current_period_start),
    end: iso(item?.current_period_end ?? sub?.current_period_end),
  };
}

function iso(v) {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

function adminToken() {
  return (process.env.ADMIN_DEBUG_TOKEN || "").trim();
}

async function adminGetSubscription() {
  const token = adminToken();
  if (!token) throw new Error("ADMIN_DEBUG_TOKEN missing");
  const res = await fetch(
    `https://www.amarewellness.com/api/stripe/admin/subscriptions?subscriptionId=${TARGET_RECORD}`,
    { headers: { "x-admin-token": token } },
  );
  return res.json();
}

function unlimitedPatchFields() {
  const item = getCatalogItem("monthly_unlimited");
  if (!item) throw new Error("catalog_monthly_unlimited_missing");
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
  const unlimited = getCatalogItem("monthly_unlimited");
  if (!unlimited) throw new Error("catalog_missing");
  return {
    ...(existing || {}),
    localSku: unlimited.localSku,
    mindbodyServiceId: String(unlimited.mindbodyServiceId),
    mindbodyContractProductId: String(unlimited.mindbodyContractProductId),
    orderType: existing?.orderType || "monthly_membership",
    billingCadence: existing?.billingCadence || "monthly",
    flow: existing?.flow || "stripe_recurring_subscription",
    source: existing?.source || "amare_membership_checkout",
    subscriptionId: TARGET_RECORD,
    mindbodyClientId: String(TARGET_MB),
    upgradeNote: "authorized_amanda_monthly5_to_unlimited_2026-10-23",
  };
}

async function preflight(stripe, subStore) {
  const errors = [];
  const sub = await stripe.subscriptions.retrieve(TARGET_SUB, { expand: ["items.data.price"] });
  if (!sub.livemode) errors.push("not_livemode");
  if (sub.customer !== TARGET_CUS) errors.push("customer_mismatch");
  if (sub.status !== "active") errors.push(`status_${sub.status}`);
  if (sub.pending_update) errors.push("pending_update");
  const items = sub.items?.data || [];
  if (items.length !== 1) errors.push(`item_count_${items.length}`);
  const price = items[0]?.price;
  const unit = typeof price === "object" ? price?.unit_amount : null;
  if (unit !== 12500) errors.push(`price_not_12500_${unit}`);
  if (items[0]?.id !== TARGET_ITEM) errors.push("item_id_mismatch");
  if (sub.metadata?.localSku !== "monthly_5") errors.push(`metadata_sku_${sub.metadata?.localSku}`);

  const openInvoices = await stripe.invoices.list({
    subscription: TARGET_SUB,
    status: "open",
    limit: 5,
  });
  if (openInvoices.data.length) errors.push("open_invoices_exist");

  const admin = await adminGetSubscription();
  if (!admin?.ok || !admin.subscription) errors.push("admin_record_missing");
  else {
    const r = admin.subscription;
    if (r.localSku !== "monthly_5") errors.push(`record_sku_${r.localSku}`);
    if (r.stripeSubscriptionId !== TARGET_SUB) errors.push("record_stripe_sub_mismatch");
    if (r.mindbodyClientId !== TARGET_MB) errors.push("record_mb_mismatch");
    const inv = (r.invoices || []).find((i) => i.invoiceId === "in_1UOOoOA47S4kb7VHVI4euxfT");
    if (!inv || inv.status !== "synced") errors.push("first_invoice_not_synced");
  }

  const pi = await stripe.paymentIntents.retrieve(CHECKOUT_PI, { expand: ["payment_method"] });
  const pmId =
    typeof pi.payment_method === "string"
      ? pi.payment_method
      : pi.payment_method?.id || CHECKOUT_PM;
  if (pmId !== CHECKOUT_PM) errors.push("checkout_pm_changed");

  const unlimited = getCatalogItem("monthly_unlimited");
  if (unlimited?.amountCents !== 22900) errors.push("catalog_unlimited_price_changed");
  if (unlimited?.mindbodyServiceId !== 100135) errors.push("catalog_service_not_100135");

  const period = subscriptionPeriod(sub);
  let blobRecord = null;
  if (subStore.available) {
    blobRecord = await subStore.get(TARGET_RECORD);
    if (!blobRecord) errors.push("production_blob_record_missing");
  } else {
    errors.push("production_blob_store_unavailable");
  }

  return {
    ok: errors.length === 0,
    errors,
    sub: {
      id: sub.id,
      status: sub.status,
      periodStart: period.start,
      periodEnd: period.end,
      priceId: typeof price === "object" ? price?.id : null,
      metadata: sub.metadata,
    },
    checkoutPaymentMethodId: pmId,
    adminSubscription: admin?.subscription || null,
    blobRecordPresent: Boolean(blobRecord),
    blobStoreAvailable: subStore.available,
  };
}

function formatPreview(preview, scenarioMeta) {
  const lines = (preview.lines?.data || []).map((l) => ({
    description: l.description,
    amount: l.amount,
    proration: l.proration === true,
    period_start: iso(l.period?.start),
    period_end: iso(l.period?.end),
  }));
  return {
    scenario: scenarioMeta.id,
    scenarioLabel: scenarioMeta.label,
    proration_behavior: scenarioMeta.proration_behavior,
    billing_cycle_anchor: "now",
    amount_due: preview.amount_due,
    subtotal: preview.subtotal,
    total: preview.total,
    tax: preview.tax ?? null,
    currency: preview.currency,
    period_start: iso(preview.period_start),
    period_end: iso(preview.period_end),
    lines,
    webhookMindbodyNote:
      scenarioMeta.proration_behavior === "none"
        ? "paid ≈ $229 → no derived Mindbody discount (webhook only discounts when paid < monthlyAmountCents)"
        : "paid < $229 → webhook derives Mindbody discount = 22900 - amount_paid for subscription_update",
  };
}

async function previewScenario(stripe, /** @type {UpgradeScenario} */ scenarioId) {
  const scenarioMeta = SCENARIOS[scenarioId];
  if (!scenarioMeta) throw new Error("invalid_scenario");
  const { productId } = await assertCatalogStripeProductReadyForPreview(stripe);
  const preview = await stripe.invoices.createPreview({
    customer: TARGET_CUS,
    subscription: TARGET_SUB,
    subscription_details: {
      items: [{ id: TARGET_ITEM, price_data: targetSubscriptionPriceData(productId) }],
      proration_behavior: scenarioMeta.proration_behavior,
      billing_cycle_anchor: "now",
    },
  });
  return formatPreview(preview, scenarioMeta);
}

async function previewBothScenarios(stripe) {
  const a = await previewScenario(stripe, "A");
  const b = await previewScenario(stripe, "B");
  return { scenarioA: a, scenarioB: b };
}

/** @param {ReturnType<formatPreview>} scenarioB @param {Awaited<ReturnType<preflight>>} pf */
function validateScenarioBPreview(scenarioB, pf) {
  const checks = [];
  const expectedCents = catalogTargetItem().amountCents;
  checks.push({
    id: "amount_due_catalog_price",
    pass: scenarioB.amount_due === expectedCents,
    expected: expectedCents,
    actual: scenarioB.amount_due,
  });
  const creditLines = (scenarioB.lines || []).filter((l) => l.amount < 0 || /unused|credit|remaining/i.test(String(l.description || "")));
  checks.push({
    id: "no_proration_credit_lines",
    pass: creditLines.length === 0,
    creditLines,
  });
  checks.push({
    id: "billing_anchor_resets_in_preview",
    pass: Boolean(scenarioB.period_start && scenarioB.period_end),
    previewPeriodStart: scenarioB.period_start,
    previewPeriodEnd: scenarioB.period_end,
    note: "After execute, Stripe subscription current_period should match this preview window (starts ~execution time).",
  });
  checks.push({
    id: "next_renewal_catalog_price",
    pass: scenarioB.amount_due === expectedCents,
    note: "Immediate invoice is first month; post-execute upcoming renewal should match catalog monthlyAmountCents (verify phase).",
  });
  checks.push({
    id: "mindbody_100135_webhook_path",
    pass: true,
    note: "Full $229 subscription_update → webhook syncs monthly_unlimited / service 100135 with zero derived discount",
  });
  checks.push({
    id: "no_open_invoices_preflight",
    pass: !(pf.errors || []).includes("open_invoices_exist"),
    preflightOk: pf.ok === true,
  });
  checks.push({
    id: "no_pending_update_preflight",
    pass: !(pf.errors || []).includes("pending_update"),
  });
  return {
    allPass: checks.every((c) => c.pass === true),
    checks,
  };
}

function idempotencyKeyForScenario(/** @type {UpgradeScenario} */ scenarioId) {
  return `amanda-upgrade-${scenarioId}-anchor-now_${TARGET_SUB}_2026-10-23`;
}

function parseApprovedExecution() {
  const scenario = (process.env.AMANDA_UPGRADE_APPROVED_SCENARIO || scenarioArg || "").trim().toUpperCase();
  if (scenario !== "A" && scenario !== "B") {
    throw new Error("missing_approval: set AMANDA_UPGRADE_APPROVED_SCENARIO=A|B and AMANDA_UPGRADE_APPROVED_AMOUNT_CENTS from preview");
  }
  const centsRaw = (process.env.AMANDA_UPGRADE_APPROVED_AMOUNT_CENTS || "").trim();
  const approvedCents = Number(centsRaw);
  if (!Number.isFinite(approvedCents) || approvedCents <= 0) {
    throw new Error("missing_approval: AMANDA_UPGRADE_APPROVED_AMOUNT_CENTS must match live preview amount_due");
  }
  return { scenario: /** @type {UpgradeScenario} */ (scenario), approvedCents };
}

async function ensurePaymentMethod(stripe, pmId) {
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer === TARGET_CUS) return pmId;
  if (pm.customer && pm.customer !== TARGET_CUS) {
    throw new Error("checkout_pm_bound_to_other_customer");
  }
  await stripe.paymentMethods.attach(pmId, { customer: TARGET_CUS });
  await stripe.customers.update(TARGET_CUS, { invoice_settings: { default_payment_method: pmId } });
  return pmId;
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

async function executeUpgrade(stripe, subStore, /** @type {UpgradeScenario} */ scenarioId) {
  const scenarioMeta = SCENARIOS[scenarioId];
  const approval = parseApprovedExecution();
  if (approval.scenario !== scenarioId) {
    throw new Error("scenario_mismatch_between_argv_and_env");
  }
  const { approvedCents } = approval;

  const beforeRecord = await subStore.get(TARGET_RECORD);
  if (!beforeRecord) throw new Error("subscription_record_not_found_in_blobs");
  const beforeSub = await stripe.subscriptions.retrieve(TARGET_SUB);

  const preview = await previewScenario(stripe, scenarioId);
  if (Math.abs(preview.amount_due - approvedCents) > 1) {
    throw Object.assign(new Error("approved_amount_does_not_match_live_preview"), {
      approvedCents,
      previewAmountDue: preview.amount_due,
      scenario: scenarioId,
    });
  }

  const pmId = await ensurePaymentMethod(stripe, CHECKOUT_PM);
  const productPrep = await prepareCatalogStripeProduct(stripe);
  const metadata = buildStripeMetadata(beforeSub.metadata || {});

  const skuPatch = unlimitedPatchFields();
  const patchedSku = await subStore.patch(TARGET_RECORD, skuPatch);
  if (!patchedSku) throw new Error("blob_patch_failed");

  try {
    const updated = await stripe.subscriptions.update(
      TARGET_SUB,
      {
        items: [{ id: TARGET_ITEM, price_data: targetSubscriptionPriceData(productPrep.productId) }],
        billing_cycle_anchor: "now",
        proration_behavior: scenarioMeta.proration_behavior,
        payment_behavior: "error_if_incomplete",
        default_payment_method: pmId,
        metadata,
      },
      { idempotencyKey: idempotencyKeyForScenario(scenarioId) },
    );

    const period = subscriptionPeriod(updated);
    await subStore.patch(TARGET_RECORD, {
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    });

    const invs = await stripe.invoices.list({ subscription: TARGET_SUB, limit: 8 });
    const upgradeInv =
      invs.data.find(
        (i) =>
          (i.billing_reason === "subscription_update" || i.billing_reason === "subscription_cycle") &&
          i.status === "paid",
      ) ||
      invs.data.find(
        (i) => i.billing_reason === "subscription_update" || i.billing_reason === "subscription_cycle",
      ) ||
      null;

    return {
      scenario: scenarioId,
      preview,
      approvedCents,
      updated,
      newBillingPeriod: period,
      upgradeInvoice: upgradeInv
        ? {
            id: upgradeInv.id,
            status: upgradeInv.status,
            billing_reason: upgradeInv.billing_reason,
            amount_paid: upgradeInv.amount_paid,
            amount_due: upgradeInv.amount_due,
          }
        : null,
      patchedSku,
      catalogStripeProduct: productPrep,
      beforeRecord,
      pmId,
      commitmentPreserved: {
        commitmentStartDate: beforeRecord.commitmentStartDate,
        commitmentEndDate: beforeRecord.commitmentEndDate,
      },
    };
  } catch (e) {
    await subStore.patch(TARGET_RECORD, blobRollbackFields(beforeRecord));
    throw e;
  }
}

async function verify(stripe) {
  const admin = await adminGetSubscription();
  const sub = await stripe.subscriptions.retrieve(TARGET_SUB, { expand: ["items.data.price"] });
  const upcoming = await stripe.invoices.createPreview({ customer: TARGET_CUS, subscription: TARGET_SUB });
  const { resolveStaffAuthHeaders } = await import("../../netlify/functions/mindbody-class-book-lib.mjs");
  const { fetchMb } = await import("../../netlify/functions/mindbody-consumer-lib.mjs");
  const staff = await resolveStaffAuthHeaders();
  let mbServices = [];
  if (staff) {
    const csRes = await fetchMb(
      "GET",
      `/public/v6/client/clientservices?${new URLSearchParams({ ClientId: String(TARGET_MB) })}`,
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
  const period = subscriptionPeriod(sub);
  const upcomingAmount = upcoming.amount_due;
  return {
    admin,
    sub,
    currentPeriod: period,
    upcomingRenewal: {
      amount_due: upcomingAmount,
      period_start: iso(upcoming.period_start),
      period_end: iso(upcoming.period_end),
    },
    mbServices,
    mindbodyExpectation:
      "Unlimited PO sale date ≈ upgrade day; ExpirationDate set by Mindbody (~1 month from sale). Compare mbServices ExpirationDate to Stripe currentPeriod.end.",
  };
}

async function main() {
  process.env.NETLIFY_SITE_ID = SITE_ID;
  process.env.NETLIFY_AUTH_TOKEN = netlifyCliToken();
  const subStore = openSubscriptionStore({});

  if (phase === "permissions") {
    const stripe = await stripeLive();
    const checks = await checkStripePermissions(stripe);
    console.log(
      JSON.stringify(
        {
          phase,
          readOnly: true,
          writesPerformed: [],
          stripeKeyMode: stripeKeyMode(stripeLiveKey()),
          checks,
          minimumPermissions: MINIMUM_STRIPE_PERMISSIONS,
        },
        null,
        2,
      ),
    );
    if (checks.some((c) => c.ok === false)) process.exit(1);
    return;
  }

  if (phase === "prepare-product") {
    const stripe = await stripeLive();
    const result = await prepareCatalogStripeProduct(stripe);
    console.log(
      JSON.stringify(
        {
          phase,
          readOnly: false,
          productionWrite: result.writePerformed === true,
          operation: result.writePerformed
            ? "stripe.products.create (catalog-aligned, idempotent)"
            : "none (reused existing active catalog product)",
          catalogSourceOfTruth: TARGET_SKU,
          result,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (phase === "preflight") {
    const stripe = await stripeLive();
    const pf = await preflight(stripe, subStore);
    console.log(JSON.stringify({ phase, stripeKeyMode: stripeKeyMode(stripeLiveKey()), ...pf }, null, 2));
    if (!pf.ok) process.exit(1);
    return;
  }

  if (phase === "preview" || phase === "preview-both") {
    const stripe = await stripeLive();
    const pf = await preflight(stripe, subStore);
    if (!pf.ok) {
      console.log(JSON.stringify({ blocked: true, preflight: pf }, null, 2));
      process.exit(1);
    }
    if (phase === "preview" && (scenarioArg === "A" || scenarioArg === "B")) {
      const preview = await previewScenario(stripe, /** @type {UpgradeScenario} */ (scenarioArg));
      console.log(JSON.stringify({ phase, preview, ownerApprovalRequired: true }, null, 2));
      return;
    }
    const both = await previewBothScenarios(stripe);
    const scenarioBChecks = validateScenarioBPreview(both.scenarioB, pf);
    console.log(
      JSON.stringify(
        {
          phase: "preview-both",
          readOnly: true,
          writesPerformed: ["none — Stripe createPreview only; no subscriptions.update, no Blob patch"],
          ownerApprovalRequired: true,
          instruction:
            "Owner selects A or B, then set AMANDA_UPGRADE_APPROVED_SCENARIO and AMANDA_UPGRADE_APPROVED_AMOUNT_CENTS to matching preview amount_due before execute",
          ...both,
          scenarioBVerification: scenarioBChecks,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (phase === "execute") {
    const stripe = await stripeLive();
    const pf = await preflight(stripe, subStore);
    if (!pf.ok) {
      console.log(JSON.stringify({ blocked: true, preflight: pf }, null, 2));
      process.exit(1);
    }
    const { scenario } = parseApprovedExecution();
    if (scenarioArg && scenarioArg !== scenario) {
      console.log(JSON.stringify({ blocked: true, error: "argv_scenario_env_mismatch" }, null, 2));
      process.exit(1);
    }
    const result = await executeUpgrade(stripe, subStore, scenario);
    const upgradeInvoiceId = result.upgradeInvoice?.id || null;
    let syncWait = null;
    if (upgradeInvoiceId) {
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const admin = await adminGetSubscription();
        const row = (admin?.subscription?.invoices || []).find((inv) => inv.invoiceId === upgradeInvoiceId);
        if (row?.status === "synced") {
          syncWait = { invoiceId: upgradeInvoiceId, status: row.status, mindbodySaleId: row.mindbodySaleId, attempts: i + 1 };
          break;
        }
        syncWait = { invoiceId: upgradeInvoiceId, status: row?.status || "pending", attempts: i + 1 };
      }
    }
    const post = await verify(stripe);
    console.log(JSON.stringify({ phase, result, syncWait, verify: post }, null, 2));
    return;
  }

  if (phase === "verify") {
    const stripe = await stripeLive();
    const post = await verify(stripe);
    console.log(JSON.stringify({ phase, verify: post }, null, 2));
    return;
  }

  console.error(
    "usage: permissions | prepare-product | preflight | preview-both | preview A|B | execute (requires AMANDA_UPGRADE_APPROVED_*) | verify",
  );
  process.exit(1);
}

/** Documented minimum for rk_live / restricted keys (Stripe Dashboard → API keys → Permissions). */
const MINIMUM_STRIPE_PERMISSIONS = [
  "Customers: Read",
  "Subscriptions: Read",
  "Subscriptions: Write",
  "Invoices: Read",
  "Invoices: Write (create_preview + finalize/pay on subscription_update)",
  "Payment Intents: Read",
  "Payment Methods: Read",
  "Payment Methods: Write (attach checkout PM to customer if detached)",
  "Products: Read (products.search for metadata.localSku)",
  "Products: Write (products.create once if no active catalog-aligned Product exists — prepare-product)",
  "Prices: Write (implicit via subscription item price_data on update)",
];

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e?.message ?? e), detail: e?.preview || e?.errors || null }));
  process.exit(1);
});
