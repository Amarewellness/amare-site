/**
 * AMARÉ Auth Phase 1 — association state machine + claim hierarchy.
 * Pure functions. No HTTP. No Mindbody calls. No booking.
 */

export const ASSOCIATION_STATUSES = Object.freeze([
  "unlinked",
  "candidate",
  "ambiguous",
  "verified",
  "linked",
  "conflict",
]);

export const ACTIVE_ASSOCIATION_STATUSES = Object.freeze(["verified", "linked"]);

/** Phase 1 may persist up to verified. linked is Phase 2+. */
export const PHASE1_WRITE_CEILING = "verified";

const ALLOWED_TRANSITIONS = Object.freeze({
  unlinked: ["candidate", "ambiguous", "unlinked"],
  candidate: ["verified", "ambiguous", "unlinked"],
  ambiguous: [],
  verified: ["linked", "conflict"],
  linked: ["conflict"],
  conflict: ["verified", "linked"],
});

/**
 * @param {string} email
 */
export function isApplePrivateRelayEmail(email) {
  return typeof email === "string" && /@privaterelay\.appleid\.com$/i.test(email.trim());
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{ phase?: 1 | 2 }} [opts]
 */
export function canTransitionAssociation(from, to, opts = {}) {
  const phase = opts.phase === 2 ? 2 : 1;
  if (!ASSOCIATION_STATUSES.includes(from) || !ASSOCIATION_STATUSES.includes(to)) return false;
  if (from === "verified" && to === "linked" && phase < 2) return false;
  if (from === "conflict" && to === "linked" && phase < 2) return false;
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{ phase?: 1 | 2; explicitConfirm?: boolean; appleRelay?: boolean }} [opts]
 */
export function assertAssociationTransition(from, to, opts = {}) {
  if (opts.appleRelay && (to === "candidate" || to === "verified" || to === "linked")) {
    throw new Error("apple_relay_cannot_bind");
  }
  if (to === "verified" && opts.explicitConfirm !== true) {
    throw new Error("verified_requires_explicit_confirm");
  }
  if (to === "linked" && (opts.phase ?? 1) < 2) {
    throw new Error("linked_forbidden_in_phase1");
  }
  if (!canTransitionAssociation(from, to, opts)) {
    throw new Error(`forbidden_association_transition:${from}->${to}`);
  }
}

/**
 * Claim hierarchy (design §7). Does not bind. Does not write.
 *
 * @param {{
 *   existingStatus?: string | null;
 *   existingClientId?: number | null;
 *   mbSessValid?: boolean;
 *   mbSessClientId?: number | null;
 *   verifiedEmail?: string | null;
 *   emailMatchCount?: number;
 *   phoneMatchesSameClient?: boolean;
 * }} input
 */
export function resolveClaimCandidate(input) {
  const existing = input.existingStatus || null;
  if (existing === "verified" || existing === "linked") {
    return {
      rank: 1,
      action: "use_existing",
      status: existing,
      clientId: input.existingClientId ?? null,
      autoBind: false,
    };
  }

  const email = (input.verifiedEmail || "").trim().toLowerCase();
  if (email && isApplePrivateRelayEmail(email)) {
    return {
      rank: 6,
      action: "block_relay",
      status: "unlinked",
      blockReason: "apple_relay",
      clientId: null,
      autoBind: false,
    };
  }

  if (input.mbSessValid === true && Number(input.mbSessClientId) > 0) {
    return {
      rank: 2,
      action: "confirm_required",
      status: "candidate",
      claimMethodIfConfirmed: "mb_sess_confirmed",
      clientId: Number(input.mbSessClientId),
      autoBind: false,
    };
  }

  const matches = Number(input.emailMatchCount) || 0;
  if (matches >= 2) {
    return {
      rank: 5,
      action: "ambiguous",
      status: "ambiguous",
      blockReason: "duplicate_clients",
      clientId: null,
      autoBind: false,
    };
  }

  if (matches === 1 && input.phoneMatchesSameClient === true) {
    return {
      rank: 4,
      action: "confirm_required",
      status: "candidate",
      claimMethodIfConfirmed: "email_phone_confirmed",
      clientId: null,
      autoBind: false,
    };
  }

  if (matches === 1) {
    return {
      rank: 3,
      action: "confirm_required",
      status: "candidate",
      claimMethodIfConfirmed: "email_unique_confirmed",
      clientId: null,
      autoBind: false,
    };
  }

  return {
    rank: 0,
    action: "unlinked",
    status: "unlinked",
    clientId: null,
    autoBind: false,
  };
}

export function newAmareUserId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `usr_${toCrockford(bytes)}`;
}

/** Crockford base32 without checksum — 16 bytes → 22 chars. */
export function toCrockford(bytes) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out.slice(0, 22);
}
