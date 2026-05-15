import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON } from "./blobs-conditional-create.mjs";

const STORE_NAME = "mindbody-checkout-attempts";

export function checkoutIdempotencyBlobsEnabled() {
  return (process.env.MINDBODY_CHECKOUT_IDEMPOTENCY_BLOBS || "").trim() === "1";
}

/**
 * `event.blobs` (opaque handle) is present on Netlify Functions with Blobs — required for `getStore` in-function.
 *
 * @param {{ blobs?: string } | unknown} event
 * @returns {any | null}
 */
export function tryOpenCheckoutBlobStore(event) {
  if (!checkoutIdempotencyBlobsEnabled()) return null;
  try {
    if (
      event &&
      typeof event === "object" &&
      typeof /** @type {{ blobs?: string }} */ (event).blobs === "string"
    ) {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return getStore({ name: STORE_NAME });
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "mindbody_checkout_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}

/**
 * @param {string} attemptId
 * @param {number} clientId
 */
export function checkoutAttemptBlobKey(attemptId, clientId) {
  return `v1/${clientId}/${attemptId}`;
}

/**
 * @param {import("@netlify/blobs").Store} store
 * @param {string} key
 * @param {Record<string, unknown>} initial
 */
export async function claimNewCheckoutAttempt(store, key, initial) {
  /**
   * MUST go through `atomicCreateJSON` — `setJSON(..., { onlyIfNew: true })`
   * is silently broken in @netlify/blobs (see `blobs-conditional-create.mjs`).
   */
  const wr = await atomicCreateJSON(store, key, initial);
  if (wr.modified) return { kind: /** @type {const} */ ("claimed") };
  const existing = await store.get(key, { type: "json" });
  return { kind: /** @type {const} */ ("exists"), existing };
}

/**
 * @param {import("@netlify/blobs").Store} store
 * @param {string} key
 * @param {Record<string, unknown>} patch
 */
export async function patchCheckoutAttempt(store, key, patch) {
  const cur = await store.get(key, { type: "json" });
  if (!cur || typeof cur !== "object") return;
  await store.setJSON(key, { .../** @type {Record<string, unknown>} */ (cur), ...patch });
}
