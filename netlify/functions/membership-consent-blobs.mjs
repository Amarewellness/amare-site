import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "mindbody-membership-consents";

export function membershipConsentBlobsEnabled() {
  const v = (process.env.MINDBODY_MEMBERSHIP_CONSENT_BLOBS ?? "").trim();
  if (!v) return false;
  return v === "1" || /^true$/i.test(v);
}

/**
 * In-memory fallback for `npm run dev` (no Netlify Blobs context). Activated ONLY when
 * `MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY=1` AND we are not running on Netlify (no
 * `NETLIFY` env var). Lives at module scope so checkout-session and the webhook (in the
 * same Node process) share state. NEVER activates in production: the explicit env flag
 * plus the Netlify-context guard make it impossible to enable accidentally on a deploy.
 *
 * The shim exposes the subset of the `@netlify/blobs` Store API that the membership
 * consent code actually uses: `setJSON(key, value)` and `get(key, { type:"json" })`.
 *
 * @type {Map<string, unknown> | null}
 */
let memoryStoreSingleton = null;

function shouldUseLocalMemoryFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY || "").trim() === "1";
}

/**
 * @param {Map<string, unknown>} backing
 * @returns {import("@netlify/blobs").Store}
 */
function makeMemoryStoreShim(backing) {
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key) {
        const v = backing.get(key);
        return v == null ? null : JSON.parse(JSON.stringify(v));
      },
      /** @param {string} key @param {unknown} value */
      async setJSON(key, value) {
        backing.set(key, JSON.parse(JSON.stringify(value)));
        return /** @type {{ modified: boolean }} */ ({ modified: true });
      },
    })
  );
}

/** @returns {import("@netlify/blobs").Store | null} */
function openMemoryStore() {
  if (!shouldUseLocalMemoryFallback()) return null;
  if (!memoryStoreSingleton) {
    memoryStoreSingleton = new Map();
    console.warn(
      JSON.stringify({
        event: "mindbody_membership_consent_memory_fallback_active",
        detail:
          "Using in-memory consent store for local dev. NEVER use this in production. Disable by unsetting MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY.",
      }),
    );
  }
  return makeMemoryStoreShim(memoryStoreSingleton);
}

/**
 * Netlify Blob store for downloadable membership-consent audits (paired with Checkout logs).
 *
 * @param {{ blobs?: string } | unknown} event
 * @returns {import("@netlify/blobs").Store | null}
 */
export function tryOpenMembershipConsentBlobStore(event) {
  if (!membershipConsentBlobsEnabled()) return null;
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
    /**
     * Local dev: opt into an in-memory shim so testers can exercise the recurring
     * membership flow without provisioning Netlify Blobs. Production paths never reach
     * here because the Netlify runtime always provides a working Blobs context.
     */
    const memShim = openMemoryStore();
    if (memShim) return memShim;
    console.warn(
      JSON.stringify({
        event: "mindbody_membership_consent_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}

/**
 * @param {string} consentId
 */
export function membershipConsentBlobKey(consentId) {
  return `v1/${consentId}`;
}
