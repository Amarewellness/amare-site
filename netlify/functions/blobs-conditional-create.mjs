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
 *   get?: (key: string, opts?: { type?: "json" | "text" | "stream" }) => Promise<unknown>;
 *   getWithMetadata?: (
    key: string,
    opts?: { type?: "json" | "text" | "stream"; consistency?: "eventual" | "strong" },
  ) => Promise<{ data: unknown; etag: string } | null>;
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

/**
 * @template T
 * @typedef {(current: T) => Promise<T | null> | T | null} Mutator
 */

/**
 * @template T
 * @typedef {{ ok: true; modified: true; record: T; attempts: number; etag?: string }
 *   | { ok: true; modified: false; record: T; attempts: number; reason: "no_op"; etag?: string }
 *   | { ok: false; reason: "not_found"; attempts: number }
 *   | { ok: false; reason: "max_retries_exhausted"; attempts: number }
 *   | { ok: false; reason: "store_unsupported"; attempts: 0 }
 *   | { ok: false; reason: "mutator_threw"; attempts: number; error: unknown }
 * } AtomicUpdateResult<T>
 */

/**
 * Compare-And-Swap (CAS) update for an existing JSON value at `key`.
 *
 * **WHY THIS HELPER EXISTS — § 9.17 success-page amount flicker**
 *
 * `patch()`, `appendInvoiceSync()`, and `updateInvoiceSync()` in
 * `stripe-subscription-store.mjs` historically used a non-atomic
 * read-modify-write pattern:
 *
 *     const before = await store.get(key, { type: "json" });
 *     const next = { ...before, ...partial };
 *     await store.setJSON(key, next);  // ← UNCONDITIONAL — last-writer-wins
 *
 * When `checkout.session.completed`'s eager first-invoice sync raced
 * `customer.subscription.created`, both handlers read the same baseline,
 * each computed its own `next`, and the later writer silently overwrote
 * the earlier writer's mutations. For the eager sync this caused the
 * `invoices[]` array (with the discounted `amountPaidCents`) to be lost,
 * which made the success page fall back to the catalog `monthlyAmountCents`
 * (the pre-discount price) — the "$1.25 → $125" flicker the owner observed
 * on 2026-05-15.
 *
 * The fix is conditional writes via etag-based CAS:
 *
 *     // mutator gets the *current* state and returns the next state
 *     await atomicUpdateJSON(store, key, async (current) => {
 *       return { ...current, ...mutation };
 *     });
 *
 * On conflict (`onlyIfMatch` mismatch), we re-read the latest etag,
 * re-run the mutator, and retry. This is safe because the mutator must
 * be idempotent over its own input — it never reads outside `current`.
 *
 * **WHY THIS USES `Store.set()` (not `setJSON`)**
 *
 * Same SDK bug as § 9.16: `setJSON()` silently drops conditions. `set()`
 * correctly forwards `conditions` (including `onlyIfMatch`). Once Netlify
 * ships the SDK fix, this helper still works — `set()` will continue to
 * be correct.
 *
 * **MUTATOR RULES**
 *
 * - Mutator must be a pure function over `current` (no external state).
 * - Mutator may return `null` to signal "no change required" (no-op write
 *   path); the helper returns `{ modified: false, record: current }`
 *   without making a network call.
 * - Mutator must NOT throw for validation failures — return `null` (no-op)
 *   or `current` (unchanged). Throwing aborts the retry loop.
 * - Mutator MAY be `async`. Each retry calls it again with the latest
 *   read; expensive work inside the mutator is paid per attempt.
 *
 * @template T
 * @param {BlobsLikeStore} store
 * @param {string} key
 * @param {Mutator<T>} mutator
 * @param {{
 *   maxRetries?: number;
 *   baseBackoffMs?: number;
 *   expected?: { record: T; etag: string };
 *   readConsistency?: "eventual" | "strong";
 * }} [opts]
 * @returns {Promise<AtomicUpdateResult<T>>}
 */
export async function atomicUpdateJSON(store, key, mutator, opts) {
  const maxRetries = Number.isFinite(opts?.maxRetries) ? Number(opts?.maxRetries) : 5;
  const baseBackoffMs = Number.isFinite(opts?.baseBackoffMs)
    ? Number(opts?.baseBackoffMs)
    : 25;
  /**
   * Implicit Function Blobs have no uncachedEdgeURL. Strong reads throw there.
   * Conditional writes (onlyIfMatch) stay authoritative. Callers with an
   * explicit API transport may still request strong.
   */
  const readConsistency = opts?.readConsistency === "strong" ? "strong" : "eventual";

  if (typeof store.getWithMetadata !== "function" || typeof store.set !== "function") {
    return { ok: false, reason: "store_unsupported", attempts: 0 };
  }

  /** @type {{ record: T; etag: string } | null} */
  let seeded = opts?.expected && typeof opts.expected.etag === "string" && opts.expected.etag
    ? opts.expected
    : null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    /** @type {T} */
    let current;
    /** @type {string} */
    let etag;
    if (seeded) {
      current = seeded.record;
      etag = seeded.etag;
      seeded = null;
    } else {
      /** @type {{ data: unknown; etag: string } | null} */
      const head = await store.getWithMetadata(key, { type: "json", consistency: readConsistency });
      if (!head || head.data == null || typeof head.etag !== "string" || !head.etag) {
        return { ok: false, reason: "not_found", attempts: attempt + 1 };
      }
      current = /** @type {T} */ (head.data);
      etag = head.etag;
    }

    /** @type {T | null} */
    let mutated;
    try {
      const m = mutator(current);
      mutated = m && typeof (/** @type {{ then?: unknown }} */ (m).then) === "function"
        ? await /** @type {Promise<T | null>} */ (m)
        : /** @type {T | null} */ (m);
    } catch (error) {
      return { ok: false, reason: "mutator_threw", attempts: attempt + 1, error };
    }

    if (mutated == null) {
      return {
        ok: true,
        modified: false,
        record: current,
        attempts: attempt + 1,
        reason: "no_op",
        etag,
      };
    }

    const writeResult = await store.set(key, JSON.stringify(mutated), {
      onlyIfMatch: etag,
    });

    if (writeResult && writeResult.modified) {
      return {
        ok: true,
        modified: true,
        record: mutated,
        attempts: attempt + 1,
        etag: typeof writeResult.etag === "string" ? writeResult.etag : undefined,
      };
    }

    /**
     * `modified: false` here means an `onlyIfMatch` etag mismatch — another
     * writer landed since our read. Re-read and retry. Exponential backoff
     * with jitter avoids thundering herd between the eager-sync handler and
     * the regular `invoice.paid` handler racing the same record.
     */
    if (attempt < maxRetries) {
      const backoff = Math.min(baseBackoffMs * Math.pow(2, attempt), 500);
      const jitter = Math.random() * baseBackoffMs;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }

  return { ok: false, reason: "max_retries_exhausted", attempts: maxRetries + 1 };
}
