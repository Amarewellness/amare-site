/**
 * Server-side Stripe → Mindbody catalog loader.
 *
 * Source of truth: `_embedded/stripe-mindbody-catalog.config.json`. Never trust price /
 * Mindbody ids from the browser. Recurring memberships are NOT in this catalog (they stay on
 * Mindbody classic / `mindbody-sale-purchase-contract.mjs`).
 *
 * Decisions: `docs/STRIPE-MINDBODY-QUESTIONS.md` Q1–Q4.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, "_embedded", "stripe-mindbody-catalog.config.json");

const ALLOWED_DUPLICATE_POLICIES = new Set([
  "allow_additional",
  "block_before_checkout_if_known",
  "manual_review_after_payment",
]);

/**
 * @typedef {Object} CatalogItem
 * @property {string} localSku
 * @property {string} displayName
 * @property {string} description
 * @property {number} amountCents
 * @property {string} currency
 * @property {"Service"} mindbodyItemType
 * @property {number | null} mindbodyServiceId
 * @property {string[]} mindbodyServiceNameMatchAny
 * @property {string[]} mindbodyServiceNameMatchExclude
 * @property {boolean} enabled
 * @property {boolean} enabledForExpressCheckout
 * @property {boolean} newClientsAllowed
 * @property {boolean} oneTimePerClient
 * @property {"allow_additional"|"block_before_checkout_if_known"|"manual_review_after_payment"} duplicatePolicy
 * @property {string} ga4SkuType
 * @property {"newClient"|"dropin"|"packs"} kind
 */

/** Hot-instance cache (warm Netlify Functions reuse). */
let catalogCache = /** @type {{ loadedAt: number; items: CatalogItem[]; currency: string } | null} */ (null);

/** @returns {{ items: CatalogItem[]; currency: string }} */
export function loadStripeMindbodyCatalog() {
  if (catalogCache) return { items: catalogCache.items, currency: catalogCache.currency };

  let raw;
  try {
    raw = fs.readFileSync(CATALOG_PATH, "utf8");
  } catch (e) {
    throw new Error(
      `stripe_mindbody_catalog_unreadable: ${String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200)} (path: ${CATALOG_PATH})`,
    );
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `stripe_mindbody_catalog_invalid_json: ${String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("stripe_mindbody_catalog_root_not_object");
  }
  const root = /** @type {Record<string, unknown>} */ (parsed);
  const currency = String(root.currency ?? "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error(`stripe_mindbody_catalog_invalid_currency: ${currency}`);
  }
  const list = Array.isArray(root.items) ? root.items : [];
  if (!list.length) throw new Error("stripe_mindbody_catalog_empty_items");

  /** @type {CatalogItem[]} */
  const items = [];
  /** @type {Set<string>} */
  const seenSkus = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const rawRow = list[i];
    if (!rawRow || typeof rawRow !== "object") {
      throw new Error(`stripe_mindbody_catalog_row_${i}_not_object`);
    }
    const r = /** @type {Record<string, unknown>} */ (rawRow);

    const localSku = typeof r.localSku === "string" ? r.localSku.trim() : "";
    if (!/^[a-z0-9_]{3,64}$/.test(localSku)) {
      throw new Error(`stripe_mindbody_catalog_row_${i}_invalid_localSku: ${localSku}`);
    }
    if (seenSkus.has(localSku)) {
      throw new Error(`stripe_mindbody_catalog_duplicate_localSku: ${localSku}`);
    }
    seenSkus.add(localSku);

    const displayName = typeof r.displayName === "string" ? r.displayName.trim() : "";
    if (!displayName) throw new Error(`stripe_mindbody_catalog_row_${localSku}_missing_displayName`);
    const description = typeof r.description === "string" ? r.description.trim() : "";

    const amountCents = Number(r.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 1_000_000) {
      throw new Error(`stripe_mindbody_catalog_row_${localSku}_invalid_amountCents`);
    }

    const mbType = typeof r.mindbodyItemType === "string" ? r.mindbodyItemType : "";
    if (mbType !== "Service") {
      throw new Error(
        `stripe_mindbody_catalog_row_${localSku}_invalid_mindbodyItemType: must be "Service" — recurring memberships do not belong in this catalog (use Mindbody classic / purchase-contract).`,
      );
    }

    /** @type {number | null} */
    let mindbodyServiceId = null;
    if (r.mindbodyServiceId != null) {
      const n = Number(r.mindbodyServiceId);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) mindbodyServiceId = n;
      else throw new Error(`stripe_mindbody_catalog_row_${localSku}_invalid_mindbodyServiceId`);
    }

    const matchAny = Array.isArray(r.mindbodyServiceNameMatchAny)
      ? r.mindbodyServiceNameMatchAny.filter((s) => typeof s === "string" && s.trim()).map((s) => /** @type {string} */ (s).trim().toLowerCase())
      : [];
    const matchExclude = Array.isArray(r.mindbodyServiceNameMatchExclude)
      ? r.mindbodyServiceNameMatchExclude.filter((s) => typeof s === "string" && s.trim()).map((s) => /** @type {string} */ (s).trim().toLowerCase())
      : [];
    if (mindbodyServiceId == null && matchAny.length === 0) {
      throw new Error(
        `stripe_mindbody_catalog_row_${localSku}_no_resolution_strategy: set mindbodyServiceId or at least one mindbodyServiceNameMatchAny entry.`,
      );
    }

    const enabled = r.enabled !== false;
    const enabledForExpressCheckout = r.enabledForExpressCheckout === true;
    const newClientsAllowed = r.newClientsAllowed !== false;
    const oneTimePerClient = r.oneTimePerClient === true;

    const duplicatePolicyRaw = typeof r.duplicatePolicy === "string" ? r.duplicatePolicy : "allow_additional";
    if (!ALLOWED_DUPLICATE_POLICIES.has(duplicatePolicyRaw)) {
      throw new Error(
        `stripe_mindbody_catalog_row_${localSku}_invalid_duplicatePolicy: ${duplicatePolicyRaw}`,
      );
    }
    /** @type {CatalogItem["duplicatePolicy"]} */
    const duplicatePolicy = /** @type {CatalogItem["duplicatePolicy"]} */ (duplicatePolicyRaw);

    const ga4SkuType = typeof r.ga4SkuType === "string" && r.ga4SkuType.trim() ? r.ga4SkuType.trim() : "package";
    const kindRaw = typeof r.kind === "string" ? r.kind.trim() : "packs";
    /** @type {CatalogItem["kind"]} */
    const kind =
      kindRaw === "newClient" || kindRaw === "dropin" || kindRaw === "packs"
        ? kindRaw
        : "packs";

    items.push({
      localSku,
      displayName,
      description,
      amountCents,
      currency,
      mindbodyItemType: "Service",
      mindbodyServiceId,
      mindbodyServiceNameMatchAny: matchAny,
      mindbodyServiceNameMatchExclude: matchExclude,
      enabled,
      enabledForExpressCheckout,
      newClientsAllowed,
      oneTimePerClient,
      duplicatePolicy,
      ga4SkuType,
      kind,
    });
  }

  catalogCache = { loadedAt: Date.now(), items, currency };
  return { items, currency };
}

/**
 * @param {string} localSku
 * @returns {CatalogItem | null}
 */
export function getCatalogItem(localSku) {
  if (typeof localSku !== "string") return null;
  const sku = localSku.trim();
  if (!sku) return null;
  const { items } = loadStripeMindbodyCatalog();
  return items.find((it) => it.localSku === sku) ?? null;
}

/**
 * Public-safe summary for the build-time embed in pricing.html — no internal flags or
 * resolution hints, just enough for the UI to know which Mindbody service ids are eligible
 * for express checkout (so the CTA can render).
 *
 * @returns {{ enableStripeOneTimeCheckout: boolean; expressEnabledServiceIds: number[]; expressEnabledSkus: { localSku: string; displayName: string; mindbodyServiceId: number | null; nameMatch: string[]; kind: string }[] }}
 */
export function buildPublicCatalogEmbed() {
  const { items } = loadStripeMindbodyCatalog();
  const enabled = items.filter((it) => it.enabled && it.enabledForExpressCheckout);
  const ids = enabled
    .map((it) => it.mindbodyServiceId)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  return {
    enableStripeOneTimeCheckout:
      (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1",
    expressEnabledServiceIds: /** @type {number[]} */ (ids),
    expressEnabledSkus: enabled.map((it) => ({
      localSku: it.localSku,
      displayName: it.displayName,
      mindbodyServiceId: it.mindbodyServiceId,
      nameMatch: it.mindbodyServiceNameMatchAny,
      kind: it.kind,
    })),
  };
}

export const __testing = { CATALOG_PATH };
