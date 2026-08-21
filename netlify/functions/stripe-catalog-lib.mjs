/**
 * Server-side Stripe → Mindbody catalog loader.
 *
 * Source of truth: `_embedded/stripe-mindbody-catalog.config.json`. Never trust price /
 * Mindbody ids from the browser. The catalog covers TWO checkout shapes:
 *
 *   • One-time SKUs (`kind: newClient | dropin | packs`, `stripeMode: undefined | "payment"`):
 *     flow through Stripe Checkout `payment` mode → `CheckoutShoppingCart` (Type:Service).
 *
 *   • Recurring monthly memberships (`kind: monthlyMembership`, `stripeMode: "subscription"`):
 *     flow through Stripe Checkout `subscription` mode. On every successful `invoice.paid`,
 *     `stripe-webhook.mjs` adds the matching Mindbody Pricing Option to the client via the
 *     same `CheckoutShoppingCart` endpoint. Mindbody Contracts are NOT used in this path.
 *     Gated by `ENABLE_STRIPE_RECURRING_CHECKOUT=1` and per-SKU `enabled: true`.
 *     See `docs/MEMBERSHIP-RECURRING-CHECKOUT.md`.
 *
 * Decisions: `docs/STRIPE-MINDBODY-QUESTIONS.md` Q1–Q4.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the catalog path in a way that survives Netlify's esbuild bundler.
 *
 * Why this is non-trivial:
 *  • Local dev (`npm run dev`) imports this module as native ESM. `import.meta.url`
 *    is set; `__dirname` is undeclared.
 *  • Netlify's function bundler converts `.mjs` → `.js` (CJS). In the bundled
 *    output, `import.meta.url` resolves to `undefined`, so `fileURLToPath()`
 *    throws with `TypeError ERR_INVALID_ARG_TYPE` at module load → 502.
 *  • In bundled CJS Node injects `__dirname` automatically.
 *
 * Strategy: prefer `__dirname` (works in production), fall back to
 * `import.meta.url` (works in dev), then `process.cwd()` as a last resort.
 *
 * `netlify.toml` `[functions].included_files` ensures the JSON file is actually
 * shipped with each function bundle (esbuild does not include arbitrary JSON
 * by default).
 */
const CATALOG_FILENAME = "stripe-mindbody-catalog.config.json";

function resolveCatalogPath() {
  /** Bundled CJS path (Netlify production). `typeof` keeps this safe in pure ESM. */
  if (typeof __dirname === "string" && __dirname) {
    return path.join(__dirname, "_embedded", CATALOG_FILENAME);
  }
  /** Native ESM (local dev). */
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "_embedded", CATALOG_FILENAME);
  }
  /** Last resort: cwd-relative. Netlify Functions cwd is `/var/task`. */
  return path.join(process.cwd(), "netlify", "functions", "_embedded", CATALOG_FILENAME);
}

const CATALOG_PATH = resolveCatalogPath();

const ALLOWED_DUPLICATE_POLICIES = new Set([
  "allow_additional",
  "block_before_checkout_if_known",
  "manual_review_after_payment",
  /**
   * Recurring memberships only — the create-session endpoint refuses to start a new
   * subscription if our SubscriptionRecord store already lists an active subscription
   * for the same Mindbody client + same SKU. Stripe itself does NOT prevent two active
   * subscriptions on one Customer (admin tooling can intentionally do this), so the
   * guard is in our application layer.
   */
  "block_if_active_subscription",
]);

/** Allowed `kind` values. Recurring memberships use `monthlyMembership`. */
const ALLOWED_KINDS = new Set(["newClient", "dropin", "packs", "monthlyMembership", "memberAddon"]);

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
 * @property {"allow_additional"|"block_before_checkout_if_known"|"manual_review_after_payment"|"block_if_active_subscription"} duplicatePolicy
 * @property {string} ga4SkuType
 * @property {"newClient"|"dropin"|"packs"|"monthlyMembership"|"memberAddon"} kind
 * @property {"payment"|"subscription"} stripeMode Defaults to "payment" for one-time SKUs.
 * @property {"month"|null} recurringInterval Required when `stripeMode === "subscription"`.
 * @property {number | null} minimumCommitmentMonths Studio-enforced; informational here.
 * @property {number | null} earlyCancellationFeePercent Documented in agreement; not auto-collected in V1.
 * @property {string | null} mindbodyContractProductId Links a recurring SKU to the membership-terms
 *   bundle in `mb-contract-terms.config.json` (`byMindbodyProductId[<id>]`). Same product key the
 *   legacy Mindbody-Classic flow uses, so the consent text is shared.
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
    const kind = ALLOWED_KINDS.has(kindRaw) ? /** @type {CatalogItem["kind"]} */ (kindRaw) : "packs";

    /**
     * Recurring fields (only meaningful for `kind === "monthlyMembership"`).
     *
     * `stripeMode` defaults to "payment" for backward compatibility with all existing
     * one-time SKUs. When it's "subscription" we require the supporting fields:
     * `recurringInterval`, `mindbodyContractProductId` (so the consent system maps to
     * the right terms), and a positive `minimumCommitmentMonths` (V1 informational
     * only — studio enforces it manually). Validation is fail-fast: a misconfigured
     * row throws at module load instead of failing silently at checkout time.
     */
    const stripeModeRaw = typeof r.stripeMode === "string" ? r.stripeMode.trim() : "payment";
    if (stripeModeRaw !== "payment" && stripeModeRaw !== "subscription") {
      throw new Error(
        `stripe_mindbody_catalog_row_${localSku}_invalid_stripeMode: ${stripeModeRaw}`,
      );
    }
    /** @type {CatalogItem["stripeMode"]} */
    const stripeMode = /** @type {CatalogItem["stripeMode"]} */ (stripeModeRaw);

    /** @type {CatalogItem["recurringInterval"]} */
    let recurringInterval = null;
    if (r.recurringInterval != null) {
      if (r.recurringInterval !== "month") {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_invalid_recurringInterval: only "month" is supported in V1`,
        );
      }
      recurringInterval = "month";
    }

    /** @type {number | null} */
    let minimumCommitmentMonths = null;
    if (r.minimumCommitmentMonths != null) {
      const n = Number(r.minimumCommitmentMonths);
      if (!Number.isInteger(n) || n < 0 || n > 36) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_invalid_minimumCommitmentMonths`,
        );
      }
      minimumCommitmentMonths = n;
    }

    /** @type {number | null} */
    let earlyCancellationFeePercent = null;
    if (r.earlyCancellationFeePercent != null) {
      const n = Number(r.earlyCancellationFeePercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_invalid_earlyCancellationFeePercent`,
        );
      }
      earlyCancellationFeePercent = n;
    }

    /** @type {string | null} */
    let mindbodyContractProductId = null;
    if (r.mindbodyContractProductId != null) {
      const s = String(r.mindbodyContractProductId).trim();
      if (!/^\d{1,8}$/.test(s)) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_invalid_mindbodyContractProductId`,
        );
      }
      mindbodyContractProductId = s;
    }

    /**
     * Cross-field validation: a subscription SKU MUST have the full recurring bundle so
     * that downstream code (Stripe session, webhook, consent system) can rely on every
     * field being present. Failing fast at config load is the safer posture vs. surfacing
     * the missing field as a 500 at checkout.
     */
    if (stripeMode === "subscription") {
      if (kind !== "monthlyMembership") {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_subscription_requires_kind_monthlyMembership`,
        );
      }
      if (recurringInterval == null) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_subscription_requires_recurringInterval`,
        );
      }
      if (mindbodyContractProductId == null) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_subscription_requires_mindbodyContractProductId`,
        );
      }
      if (mindbodyServiceId == null) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_subscription_requires_mindbodyServiceId`,
        );
      }
      if (enabledForExpressCheckout) {
        throw new Error(
          `stripe_mindbody_catalog_row_${localSku}_subscription_must_not_set_enabledForExpressCheckout`,
        );
      }
    }

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
      stripeMode,
      recurringInterval,
      minimumCommitmentMonths,
      earlyCancellationFeePercent,
      mindbodyContractProductId,
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
export function stripeOneTimeHostedCheckoutBlocked() {
  return (process.env.STRIPE_BLOCK_ONE_TIME_HOSTED_CHECKOUT || "").trim() === "1";
}

export function stripeOneTimeHostedCheckoutPublicEnabled() {
  return (
    (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1" &&
    !stripeOneTimeHostedCheckoutBlocked()
  );
}

export function buildPublicCatalogEmbed() {
  const { items } = loadStripeMindbodyCatalog();
  const enabled = items.filter((it) => it.enabled && it.enabledForExpressCheckout);
  const ids = enabled
    .map((it) => it.mindbodyServiceId)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  return {
    enableStripeOneTimeCheckout: stripeOneTimeHostedCheckoutPublicEnabled(),
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
