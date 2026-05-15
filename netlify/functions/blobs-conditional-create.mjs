// @ts-check
/**
 * Atomic conditional-create helper for Netlify Blobs.
 *
 * **WHY THIS FILE EXISTS — Netlify Blobs SDK bug**
 *
 * `@netlify/blobs` (verified up to and including v10.7.4 plus the current
 * `main` branch at github.com/netlify/primitives/packages/blobs/src/store.ts on
 * 2026-05-15) has a long-standing bug in `Store.setJSON()` that silently drops
 * the `onlyIfNew` and `onlyIfMatch` conditions:
 *
 *     // src/store.ts — setJSON
 *     const res = await this.client.makeRequest({
 *       ...conditions,  // ← BUG: spreads { onlyIfNew: true } as top-level props
 *       body: payload,
 *       ...
 *     })
 *
 * `makeRequest` destructures `conditions` from a *named* property:
 *
 *     async makeRequest({ body, conditions = {}, ... }) {
 *       ...
 *       if ("onlyIfNew" in conditions && conditions.onlyIfNew) {
 *         headers["if-none-match"] = "*"
 *       }
 *       ...
 *     }
 *
 * Because `setJSON` spreads `conditions` instead of passing it under the
 * `conditions` key, `makeRequest` always sees `conditions = {}` and the
 * `if-none-match: *` header is **never sent**. Both concurrent writes succeed
 * server-side and both return `{ modified: true }`. The "atomic" claim is a
 * lie.
 *
 * `Store.set()` is correct — it passes `conditions` as a named property:
 *
 *     // src/store.ts — set
 *     const res = await this.client.makeRequest({
 *       conditions,         // ← correct
 *       body: data,
 *       ...
 *     })
 *
 * **PRODUCTION IMPACT — duplicate Mindbody Sales (2026-05-15)**
 *
 * Our `claimInvoiceSlot()` in `stripe-subscription-store.mjs` was using
 * `setJSON(..., { onlyIfNew: true })`. When the eager first-invoice sync from
 * `checkout.session.completed` raced the regular `invoice.paid` webhook, both
 * Lambda containers wrote to the same `(subscriptionId, invoiceId)` claim key,
 * both received `{ modified: true }`, both proceeded to call Mindbody, and we
 * got two identical Sales for one Stripe charge. Local tests passed because
 * our memory shim's `setJSON` correctly checks `backing.has(key)`.
 *
 * **THE FIX**
 *
 * Always route conditional creates through `Store.set()` with a JSON-encoded
 * string body. Reads via `Store.get(key, { type: "json" })` still parse the
 * body correctly because they call `res.json()` regardless of the stored
 * `Content-Type` header.
 *
 * For in-memory shims that only expose `setJSON()` (and which already handle
 * `onlyIfNew` correctly), we transparently fall back.
 *
 * Once Netlify ships an SDK fix, this helper becomes a no-op wrapper — keep
 * the indirection so the call sites stay future-proof.
 */

/**
 * @typedef {{
 *   set?: (key: string, body: string, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => Promise<{ modified: boolean; etag?: string }>;
 *   setJSON: (key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => Promise<{ modified: boolean; etag?: string }>;
 * }} BlobsLikeStore
 */

/**
 * Conditionally create a JSON value at `key` only if no entry exists yet.
 * Returns `{ modified: true }` when this caller created the entry, or
 * `{ modified: false }` when another caller raced and won.
 *
 * Always prefer this helper over `store.setJSON(key, value, { onlyIfNew: true })`
 * for cross-container mutexes (claim slots, idempotency keys, "first writer
 * wins" record creation). Race-correctness is the entire point.
 *
 * @param {BlobsLikeStore} store
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<{ modified: boolean; etag?: string }>}
 */
export async function atomicCreateJSON(store, key, value) {
  if (typeof store.set === "function") {
    /**
     * Real Netlify Blobs `Store.set()` correctly forwards `conditions` to the
     * underlying request. Encode body ourselves so the wire format mirrors
     * what `setJSON` would have produced for the persisted bytes.
     */
    return await store.set(key, JSON.stringify(value), { onlyIfNew: true });
  }
  /**
   * Memory shim path. The shim's `setJSON` handles `onlyIfNew` correctly
   * (it's a literal `Map.has(key)` check on a single-process backing map), so
   * we don't need to round-trip through `set`.
   */
  return await store.setJSON(key, value, { onlyIfNew: true });
}
