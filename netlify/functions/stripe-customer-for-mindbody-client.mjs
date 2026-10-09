/**
 * Resolve an existing Stripe Customer for a Mindbody client — never creates a Customer.
 */

import { pickStripeCustomerFromCandidates } from "./amare-commerce-lib.mjs";

/**
 * @param {import("stripe").default} stripe
 * @param {number} mindbodyClientId
 * @param {{
 *   subscriptionStore?: {
 *     available?: boolean;
 *     listActiveByMindbodyClientId?: (id: number, opts?: { limit?: number }) => Promise<Array<{ stripeCustomerId?: string }>>;
 *   } | null;
 *   email?: string | null;
 * }} [deps]
 */
export async function resolveStripeCustomerForMindbodyClient(stripe, mindbodyClientId, deps = {}) {
  const clientId = Math.trunc(Number(mindbodyClientId));
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return { ok: false, reason: "invalid_client_id", stripeCustomerId: null };
  }
  const clientIdStr = String(clientId);

  const subStore = deps.subscriptionStore;
  if (subStore?.available && typeof subStore.listActiveByMindbodyClientId === "function") {
    try {
      const subs = await subStore.listActiveByMindbodyClientId(clientId, { limit: 10 });
      for (const rec of subs) {
        const cid = String(rec?.stripeCustomerId || "").trim();
        if (cid.startsWith("cus_")) {
          return { ok: true, stripeCustomerId: cid, source: "subscription_store" };
        }
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "attendance_fee_sub_store_lookup_failed",
          mindbodyClientId: clientId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  try {
    const found = await stripe.customers.search({
      query: `metadata['mindbodyClientId']:'${clientIdStr}'`,
      limit: 20,
    });
    /** @type {Array<{ id?: string; metadata?: Record<string, string>; deleted?: boolean; hasActiveSubscription?: boolean }>} */
    const hits = (found.data || []).filter((c) => c && c.id && !c.deleted);
    if (hits.length > 1) {
      for (const c of hits) {
        try {
          const subs = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 1 });
          c.hasActiveSubscription = (subs.data || []).length > 0;
        } catch {
          c.hasActiveSubscription = false;
        }
      }
    }
    const picked = pickStripeCustomerFromCandidates(hits, clientIdStr);
    if (picked.customer?.id) {
      return {
        ok: true,
        stripeCustomerId: picked.customer.id,
        source: "stripe_metadata_search",
      };
    }
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "attendance_fee_stripe_customer_search_failed",
        mindbodyClientId: clientId,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  const email = String(deps.email || "")
    .trim()
    .toLowerCase();
  if (email) {
    try {
      const list = await stripe.customers.list({ email, limit: 20 });
      const hits = (list.data || []).filter((c) => c && c.id && !c.deleted);
      const picked = pickStripeCustomerFromCandidates(hits, clientIdStr);
      if (picked.customer?.id) {
        return { ok: true, stripeCustomerId: picked.customer.id, source: "stripe_email_metadata" };
      }
    } catch {
      /* fail closed below */
    }
  }

  return { ok: false, reason: "missing_stripe_customer", stripeCustomerId: null };
}

/**
 * @param {import("stripe").default} stripe
 * @param {string} stripeCustomerId
 */
export async function assertStripeCustomerChargeable(stripe, stripeCustomerId) {
  const customerId = String(stripeCustomerId || "").trim();
  if (!customerId.startsWith("cus_")) {
    return { ok: false, code: "missing_stripe_customer", message: "Invalid Stripe customer id." };
  }
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer || customer.deleted) {
      return { ok: false, code: "missing_stripe_customer", message: "Stripe customer not found." };
    }
    const invDefault =
      customer.invoice_settings?.default_payment_method ||
      (typeof customer.default_source === "string" ? customer.default_source : null);
    if (invDefault) return { ok: true };

    const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    if ((pms.data || []).length > 0) return { ok: true };

    return {
      ok: false,
      code: "missing_payment_method",
      message: "No saved payment method on Stripe customer.",
    };
  } catch (e) {
    const err = /** @type {{ message?: string; code?: string }} */ (e);
    return {
      ok: false,
      code: "customer_not_chargeable",
      message: String(err?.message || "Could not verify Stripe customer.").slice(0, 240),
    };
  }
}
