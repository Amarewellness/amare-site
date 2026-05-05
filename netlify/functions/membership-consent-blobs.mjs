import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "mindbody-membership-consents";

export function membershipConsentBlobsEnabled() {
  const v = (process.env.MINDBODY_MEMBERSHIP_CONSENT_BLOBS ?? "").trim();
  if (!v) return false;
  return v === "1" || /^true$/i.test(v);
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
