/**
 * Stripe billing-period reader.
 *
 * Production (API 2025-08-27.basil / webhook Dahlia) puts current_period_* on
 * subscription items, not the subscription root. SubscriptionRecord fields were
 * written only from the root, so they are often null.
 */

/**
 * @param {unknown} subscription
 * @returns {{
 *   start: string | null;
 *   end: string | null;
 *   source: "subscription_root" | "items" | "missing";
 * }}
 */
export function readStripeSubscriptionPeriod(subscription) {
  if (!subscription || typeof subscription !== "object") {
    return { start: null, end: null, source: "missing" };
  }
  const sub = /** @type {Record<string, unknown>} */ (subscription);
  const rootStart = unixToIso(sub.current_period_start);
  const rootEnd = unixToIso(sub.current_period_end);
  if (rootStart && rootEnd) return { start: rootStart, end: rootEnd, source: "subscription_root" };

  const items = sub.items;
  const data =
    items && typeof items === "object" && Array.isArray(/** @type {{ data?: unknown }} */ (items).data)
      ? /** @type {{ data: unknown[] }} */ (items).data
      : [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const it = /** @type {Record<string, unknown>} */ (raw);
    const start = unixToIso(it.current_period_start);
    const end = unixToIso(it.current_period_end);
    if (start && end) return { start, end, source: "items" };
  }
  return { start: null, end: null, source: "missing" };
}

/** @param {unknown} value */
function unixToIso(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
