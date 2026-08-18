/**
 * D28 — brand-new Email OTP Studio profile creation.
 * Existing-client claim rules are unchanged. No Consumer OAuth.
 */

import { normalizeUsMobilePhone } from "./oauth-lib.mjs";
import {
  amareSiteId,
  buildNewProfileTx,
  normalizeAmareEmail,
  normalizeStudioEmailSearchResult,
  randomTxId,
  searchStudioClientsByEmail,
} from "./amare-auth-lib.mjs";

export const PROFILE_PENDING_PROOF_PREFIX = "new_profile_pending:";

export function normalizeProfileName(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!value) return "";
  return value.slice(0, 80);
}

export function rejectedProfileBodyFields(body) {
  if (!body || typeof body !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(body, "email")) return "email";
  if (Object.prototype.hasOwnProperty.call(body, "clientId") || Object.prototype.hasOwnProperty.call(body, "client_id")) {
    return "clientId";
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "amare_user_id") ||
    Object.prototype.hasOwnProperty.call(body, "amareUserId")
  ) {
    return "amare_user_id";
  }
  return null;
}

function pendingProofForEmail(email) {
  return `${PROFILE_PENDING_PROOF_PREFIX}${email}`;
}

function isOurPendingProof(row, email) {
  const ref = String(row?.claim_proof_ref || "");
  return ref === pendingProofForEmail(email) || ref === "new_profile_pending";
}

async function defaultIdentity() {
  return import("./amare-identity-store.mjs");
}

async function runStaffEmailSearch(email, deps) {
  const search = deps.searchStudioClientsByEmail || searchStudioClientsByEmail;
  return normalizeStudioEmailSearchResult(await search(email));
}

function claimTxForCandidate(amareUserId, clientId, siteId) {
  return {
    kind: "verify_candidate",
    amare_user_id: amareUserId,
    client_id: clientId,
    siteId,
    jti: randomTxId(),
    exp: Date.now() + 15 * 60 * 1000,
  };
}

/**
 * Re-issue a profile transaction from persisted successful-zero provenance.
 * Does not read an arbitrary identity email list.
 */
export async function beginAmareProfileTx(input, deps = {}) {
  const amareUserId = String(input.amareUserId || "");
  const siteId = input.siteId || amareSiteId();
  if (!amareUserId) return { ok: false, statusCode: 401, error: "signed_out" };

  const identity = deps.identity || (await defaultIdentity());
  const active =
    typeof identity.getActiveAssociation === "function"
      ? await identity.getActiveAssociation(amareUserId, siteId)
      : null;
  if (active && (active.status === "verified" || active.status === "linked")) {
    return { ok: false, statusCode: 409, error: "already_associated", claimStatus: active.status };
  }

  const latest =
    typeof identity.getLatestAssociation === "function"
      ? await identity.getLatestAssociation(amareUserId, siteId)
      : null;
  if (latest?.status === "candidate" && Number(latest.client_id) > 0) {
    return {
      ok: false,
      statusCode: 409,
      error: "existing_client",
      claimStatus: "candidate",
      claimTx: claimTxForCandidate(amareUserId, Number(latest.client_id), siteId),
    };
  }
  if (latest?.status === "ambiguous") {
    return { ok: false, statusCode: 409, error: "ambiguous", claimStatus: "ambiguous" };
  }
  if (latest?.status === "conflict") {
    return { ok: false, statusCode: 409, error: "conflict", claimStatus: "conflict" };
  }
  if (latest?.status !== "unlinked" || latest?.block_reason !== "staff_zero_match") {
    return { ok: false, statusCode: 409, error: "not_needs_profile", claimStatus: "none" };
  }

  const email = normalizeAmareEmail(latest.claim_proof_ref);
  if (!email) return { ok: false, statusCode: 409, error: "missing_verified_email" };

  const search = await runStaffEmailSearch(email, deps);
  if (!search.ok) {
    return { ok: false, statusCode: 503, error: "staff_search_unavailable", claimStatus: "search_unavailable" };
  }
  if (search.exactMatches.length >= 2) {
    if (typeof identity.proposeAssociation === "function") {
      await identity.proposeAssociation({
        amare_user_id: amareUserId,
        site_id: siteId,
        status: "ambiguous",
        candidate_client_ids: search.exactMatches,
        block_reason: "duplicate_clients",
      });
    }
    return { ok: false, statusCode: 409, error: "ambiguous", claimStatus: "ambiguous" };
  }
  if (search.exactMatches.length === 1) {
    const clientId = search.exactMatches[0];
    const owner =
      typeof identity.findActiveAssociationByClientId === "function"
        ? await identity.findActiveAssociationByClientId(siteId, clientId)
        : null;
    if (owner?.amare_user_id && String(owner.amare_user_id) !== amareUserId) {
      return { ok: false, statusCode: 409, error: "conflict", claimStatus: "conflict" };
    }
    if (typeof identity.proposeAssociation === "function") {
      await identity.proposeAssociation({
        amare_user_id: amareUserId,
        site_id: siteId,
        status: "candidate",
        client_id: clientId,
      });
    }
    return {
      ok: false,
      statusCode: 409,
      error: "existing_client",
      claimStatus: "candidate",
      claimTx: claimTxForCandidate(amareUserId, clientId, siteId),
    };
  }

  const profileTx = buildNewProfileTx({ amareUserId, email });
  return { ok: true, claimStatus: "needs_profile", profileTx };
}

/**
 * Explicit Create my profile. Email comes only from amare_profile_tx.
 */
export async function createAmareStudioProfile(input, deps = {}) {
  if (input.explicitCreate !== true) {
    return { ok: false, statusCode: 400, error: "explicit_create_required" };
  }
  const rejected = rejectedProfileBodyFields(input.body || {});
  if (rejected) return { ok: false, statusCode: 400, error: "field_not_allowed", field: rejected };

  const amareUserId = String(input.amareUserId || "");
  const tx = input.profileTx;
  if (!amareUserId) return { ok: false, statusCode: 401, error: "signed_out" };
  if (!tx || tx.kind !== "new_profile" || tx.provider !== "email") {
    return { ok: false, statusCode: 403, error: "profile_tx_required" };
  }
  if (String(tx.amare_user_id) !== amareUserId) {
    return { ok: false, statusCode: 403, error: "profile_tx_user_mismatch" };
  }
  const email = normalizeAmareEmail(tx.provider_sub);
  if (!email) return { ok: false, statusCode: 403, error: "profile_tx_email_missing" };

  const firstName = normalizeProfileName(input.firstName);
  const lastName = normalizeProfileName(input.lastName);
  const mobilePhone = normalizeUsMobilePhone(input.mobilePhone);
  if (!firstName) return { ok: false, statusCode: 400, error: "first_name_required" };
  if (!lastName) return { ok: false, statusCode: 400, error: "last_name_required" };
  if (!mobilePhone) return { ok: false, statusCode: 400, error: "mobile_phone_required" };

  const siteId = input.siteId || amareSiteId();
  const identity = deps.identity || (await defaultIdentity());
  const lockKey = `email:${email}`;
  const withLock = deps.withLock || (await defaultIdentity()).withAmareOnboardingLock;

  return withLock(lockKey, async () => {
    const active =
      typeof identity.getActiveAssociation === "function"
        ? await identity.getActiveAssociation(amareUserId, siteId)
        : null;
    if (active?.status === "linked") {
      return { ok: true, already: true, status: "linked", claimMethod: active.claim_method || "new_profile_created" };
    }
    if (active?.status === "verified") {
      if (typeof identity.promoteAssociationToLinked === "function") {
        const promoted = await identity.promoteAssociationToLinked({
          amare_user_id: amareUserId,
          site_id: siteId,
          explicitPromote: true,
        });
        return { ok: true, status: promoted?.status || "linked", claimMethod: "new_profile_created" };
      }
      return { ok: false, statusCode: 409, error: "already_associated", claimStatus: "verified" };
    }

    const latest =
      typeof identity.getLatestAssociation === "function"
        ? await identity.getLatestAssociation(amareUserId, siteId)
        : null;
    if (latest?.status === "ambiguous") {
      return { ok: false, statusCode: 409, error: "ambiguous", claimStatus: "ambiguous" };
    }
    if (latest?.status === "conflict") {
      return { ok: false, statusCode: 409, error: "conflict", claimStatus: "conflict" };
    }
    if (latest?.status === "candidate" && Number(latest.client_id) > 0 && !isOurPendingProof(latest, email)) {
      return {
        ok: false,
        statusCode: 409,
        error: "existing_client",
        claimStatus: "candidate",
        claimTx: claimTxForCandidate(amareUserId, Number(latest.client_id), siteId),
      };
    }

    const search = await runStaffEmailSearch(email, deps);
    if (!search.ok) {
      return { ok: false, statusCode: 503, error: "staff_search_unavailable", claimStatus: "search_unavailable" };
    }
    if (search.exactMatches.length >= 2) {
      if (typeof identity.proposeAssociation === "function") {
        await identity.proposeAssociation({
          amare_user_id: amareUserId,
          site_id: siteId,
          status: "ambiguous",
          candidate_client_ids: search.exactMatches,
          block_reason: "duplicate_clients",
        });
      }
      return { ok: false, statusCode: 409, error: "ambiguous", claimStatus: "ambiguous" };
    }

    if (search.exactMatches.length === 1) {
      const clientId = search.exactMatches[0];
      const owner =
        typeof identity.findActiveAssociationByClientId === "function"
          ? await identity.findActiveAssociationByClientId(siteId, clientId)
          : null;
      if (owner?.amare_user_id && String(owner.amare_user_id) !== amareUserId) {
        if (typeof identity.proposeAssociation === "function") {
          await identity.proposeAssociation({
            amare_user_id: amareUserId,
            site_id: siteId,
            status: "conflict",
            client_id: clientId,
            block_reason: "client_owned_elsewhere",
          });
        }
        return { ok: false, statusCode: 409, error: "conflict", claimStatus: "conflict" };
      }
      if (latest?.status === "candidate" && Number(latest.client_id) === clientId && isOurPendingProof(latest, email)) {
        await identity.confirmAssociation({
          amare_user_id: amareUserId,
          site_id: siteId,
          fromStatus: "candidate",
          client_id: clientId,
          claim_method: "new_profile_created",
          claim_proof_ref: email,
          explicitConfirm: true,
        });
        const promoted = await identity.promoteAssociationToLinked({
          amare_user_id: amareUserId,
          site_id: siteId,
          explicitPromote: true,
        });
        return {
          ok: true,
          status: promoted?.status || "linked",
          reconciled: true,
          claimMethod: "new_profile_created",
        };
      }
      if (typeof identity.proposeAssociation === "function") {
        await identity.proposeAssociation({
          amare_user_id: amareUserId,
          site_id: siteId,
          status: "candidate",
          client_id: clientId,
        });
      }
      return {
        ok: false,
        statusCode: 409,
        error: "existing_client",
        claimStatus: "candidate",
        claimTx: claimTxForCandidate(amareUserId, clientId, siteId),
      };
    }

    const staffHeaders = deps.staffHeaders || (await (deps.resolveStaffAuthHeaders ||
      (await import("./mindbody-class-book-lib.mjs")).resolveStaffAuthHeaders)());
    if (!staffHeaders) {
      return { ok: false, statusCode: 503, error: "staff_search_unavailable", claimStatus: "search_unavailable" };
    }

    const create =
      deps.createStudioClient ||
      (await import("./stripe-mindbody-sync-lib.mjs")).createStudioClientForAmareOnboarding;
    const created = await create(staffHeaders, {
      firstName,
      lastName,
      email,
      mobilePhone,
    });

    if (!created?.ok) {
      if (created?.conflict) {
        const again = await runStaffEmailSearch(email, deps);
        if (!again.ok) {
          return { ok: false, statusCode: 503, error: "staff_search_unavailable", claimStatus: "search_unavailable" };
        }
        if (again.exactMatches.length === 1) {
          const clientId = again.exactMatches[0];
          const owner =
            typeof identity.findActiveAssociationByClientId === "function"
              ? await identity.findActiveAssociationByClientId(siteId, clientId)
              : null;
          if (owner?.amare_user_id && String(owner.amare_user_id) !== amareUserId) {
            return { ok: false, statusCode: 409, error: "conflict", claimStatus: "conflict" };
          }
          if (typeof identity.proposeAssociation === "function") {
            await identity.proposeAssociation({
              amare_user_id: amareUserId,
              site_id: siteId,
              status: "candidate",
              client_id: clientId,
            });
          }
          return {
            ok: false,
            statusCode: 409,
            error: "existing_client",
            claimStatus: "candidate",
            claimTx: claimTxForCandidate(amareUserId, clientId, siteId),
          };
        }
        if (again.exactMatches.length >= 2) {
          return { ok: false, statusCode: 409, error: "ambiguous", claimStatus: "ambiguous" };
        }
        return { ok: false, statusCode: 409, error: "duplicate_unresolved" };
      }
      return { ok: false, statusCode: 502, error: created?.error || "addclient_failed" };
    }

    const clientId = Number(created.clientId);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      return { ok: false, statusCode: 502, error: "addclient_response_missing_id" };
    }

    const complete =
      typeof identity.completeNewProfileCreatedAssociation === "function"
        ? identity.completeNewProfileCreatedAssociation
        : (await defaultIdentity()).completeNewProfileCreatedAssociation;
    const linked = await complete({
      amare_user_id: amareUserId,
      site_id: siteId,
      client_id: clientId,
      verifiedEmail: email,
      explicitCreate: true,
    });
    console.log(
      JSON.stringify({
        event: "amare_new_profile_created",
        amare_user_id: amareUserId,
        status: linked?.status || "linked",
        claim_method: "new_profile_created",
        emailPreferences: created.emailPreferences || created.returnedSubscriptions || null,
      }),
    );
    return {
      ok: true,
      status: linked?.status || "linked",
      clientCreated: true,
      claimMethod: "new_profile_created",
    };
  });
}
