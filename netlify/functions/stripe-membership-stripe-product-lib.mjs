/**
 * Resolve or create Stripe Product ids for recurring membership subscription updates.
 *
 * Checkout (`stripe-create-checkout-session.mjs`) uses Checkout `price_data.product_data`
 * so Stripe creates Products inline per session. Subscription `items[].price_data` requires
 * a Product id (no `product_data`). This module bridges that gap using the embedded catalog
 * as source of truth — same names/metadata as checkout `product_data`, never Dashboard catalog.
 */
import { getCatalogItem, isAnnualMembershipCatalogItem } from "./stripe-catalog-lib.mjs";

/** @param {import("./stripe-catalog-lib.mjs").CatalogItem} item */
export function membershipStripeProductMetadataFromCatalog(item) {
  const isAnnual = isAnnualMembershipCatalogItem(item);
  /** @type {Record<string, string>} */
  const metadata = {
    localSku: item.localSku,
    mindbodyServiceId: String(item.mindbodyServiceId ?? ""),
    kind: item.kind,
    billingCadence: isAnnual ? "annual" : "monthly",
  };
  return metadata;
}

/** @param {import("./stripe-catalog-lib.mjs").CatalogItem} item */
export function membershipStripeProductCreateParamsFromCatalog(item) {
  return {
    name: item.displayName,
    description: item.description || undefined,
    active: true,
    metadata: membershipStripeProductMetadataFromCatalog(item),
  };
}

/**
 * Subscription item `price_data` for an existing Product id (Talya / Amanda upgrade pattern).
 * @param {import("./stripe-catalog-lib.mjs").CatalogItem} item
 * @param {string} productId
 */
export function subscriptionItemPriceDataFromCatalog(item, productId) {
  if (!/^prod_[A-Za-z0-9]+$/.test(productId)) {
    throw new Error("invalid_stripe_product_id");
  }
  const interval = item.recurringInterval === "year" ? "year" : "month";
  return {
    currency: item.currency,
    unit_amount: item.amountCents,
    product: productId,
    recurring: { interval },
  };
}

/**
 * Read-only: newest active live Product whose metadata.localSku matches.
 * @param {import("stripe").Stripe} stripe
 * @param {string} localSku
 */
export async function findActiveStripeProductForLocalSku(stripe, localSku) {
  if (!/^[a-z0-9_]{3,64}$/.test(localSku)) throw new Error("invalid_localSku");
  const res = await stripe.products.search({
    query: `active:'true' AND metadata['localSku']:'${localSku}'`,
    limit: 20,
  });
  const rows = (res.data || []).filter((p) => p.livemode === true && p.metadata?.localSku === localSku);
  rows.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return rows[0] ?? null;
}

/**
 * Idempotent preparation: reuse active catalog-aligned Product or create one (explicit write).
 * Does not reactivate inactive historical checkout products.
 *
 * @param {import("stripe").Stripe} stripe
 * @param {string} localSku
 */
export async function ensureActiveStripeProductForCatalogSku(stripe, localSku) {
  const item = getCatalogItem(localSku);
  if (!item) throw new Error(`catalog_missing:${localSku}`);
  if (item.stripeMode !== "subscription") {
    throw new Error(`catalog_not_recurring:${localSku}`);
  }

  const existing = await findActiveStripeProductForLocalSku(stripe, localSku);
  if (existing) {
    return {
      localSku,
      productId: existing.id,
      action: "reused_active",
      writePerformed: false,
      catalogAmountCents: item.amountCents,
      productMetadata: existing.metadata || {},
    };
  }

  const created = await stripe.products.create(membershipStripeProductCreateParamsFromCatalog(item), {
    idempotencyKey: `amare_membership_stripe_product_${localSku}`,
  });

  return {
    localSku,
    productId: created.id,
    action: "created",
    writePerformed: true,
    catalogAmountCents: item.amountCents,
    productMetadata: created.metadata || {},
  };
}

/**
 * Read-only resolve for previews. Fails if no active Product exists yet.
 * @param {import("stripe").Stripe} stripe
 * @param {string} localSku
 */
export async function requireActiveStripeProductForCatalogSku(stripe, localSku) {
  const product = await findActiveStripeProductForLocalSku(stripe, localSku);
  if (!product) {
    throw Object.assign(new Error("no_active_stripe_product_for_catalog_sku"), {
      localSku,
      hint: "Run explicit prepare-product phase (ensureActiveStripeProductForCatalogSku) before preview",
    });
  }
  return product;
}
