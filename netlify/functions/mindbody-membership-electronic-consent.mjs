import { createHash } from "node:crypto";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  loadMbContractTermsConfig,
  resolveAnnualContractEntryByLocalSku,
  resolveManualContractEntryByServiceId,
} from "./load-mb-contract-terms.mjs";

export const MEMBERSHIP_API_CONTRACT_VERSION = "mindbody-api-v1";
export const MEMBERSHIP_TERMS_SNAPSHOT_MAX = 380_000;

/** @param {unknown} raw */
export function parseBoolTruthy(raw) {
  if (raw === true || raw === 1 || raw === "1") return true;
  if (typeof raw === "string" && /^(true|yes|on)$/i.test(raw.trim())) return true;
  return false;
}

export function stripScriptsConsentHtml(html) {
  return String(html).replace(
    /<\/(?:script|iframe)\b[\s\S]*?>|<(?:script|iframe)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/(?:script|iframe)>)/gi,
    "",
  );
}

export function sha256HexUtf8(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function plausibleFullLegalName(s) {
  const t = s.trim();
  if (t.length < 4 || t.length > 120) return false;
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length >= 2;
}

/**
 * @param {Record<string, unknown>} bodyObj
 * @param {number} serviceId Pricing option id (ContractItems / row.Id) for manual terms map
 * @param {string} attemptId
 * @param {string} idempotencyKey
 */
export function validateMembershipElectronicConsent(bodyObj, serviceId, attemptId, idempotencyKey) {
  const requires = parseBoolTruthy(
    bodyObj.requiresMembershipAgreement ?? bodyObj.RequiresMembershipAgreement,
  );
  if (!requires)
    return /** @type {{ ok: true; data: null }} */ ({ ok: /** @type {const} */ (true), data: null });

  const agreementAccepted = parseBoolTruthy(
    bodyObj.membershipAgreementAccepted ?? bodyObj.MembershipAgreementAccepted,
  );
  const billingAuthorized = parseBoolTruthy(
    bodyObj.membershipBillingAuthorized ?? bodyObj.MembershipBillingAuthorized,
  );
  if (!agreementAccepted || !billingAuthorized) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_consent_incomplete",
        attemptId,
        idempotencyKey,
        message:
          "Both membership agreement confirmations are required — terms acceptance and recurring billing authorization.",
      }),
    };
  }

  const nameRaw =
    typeof bodyObj.membershipFullLegalName === "string"
      ? bodyObj.membershipFullLegalName
      : typeof bodyObj.membershipFullLegalName === "number"
        ? String(bodyObj.membershipFullLegalName)
        : "";
  const fullNameTyped = nameRaw.trim();
  if (fullNameTyped && !plausibleFullLegalName(fullNameTyped)) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_legal_name_invalid",
        attemptId,
        idempotencyKey,
        message:
          "If you provide a legal name, use at least two name parts (or leave it blank and confirm with the checkboxes only).",
      }),
    };
  }

  const verRaw =
    typeof bodyObj.membershipTermsContractVersion === "string"
      ? bodyObj.membershipTermsContractVersion.trim().slice(0, 96)
      : "";
  if (!verRaw) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_contract_version_mismatch",
        attemptId,
        idempotencyKey,
        message: "Membership terms version missing — refresh checkout and try again.",
      }),
    };
  }

  const snapRaw = typeof bodyObj.membershipTermsDisplayedHtml === "string" ? bodyObj.membershipTermsDisplayedHtml : "";
  if (snapRaw.length > MEMBERSHIP_TERMS_SNAPSHOT_MAX || snapRaw.length < 80) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_terms_snapshot_invalid",
        attemptId,
        idempotencyKey,
        message: "Membership agreement text was missing from the request — refresh checkout and reopen the dialog.",
      }),
    };
  }

  let cfg;
  try {
    cfg = loadMbContractTermsConfig();
  } catch {
    cfg = {};
  }
  const localSku =
    typeof bodyObj.localSku === "string"
      ? bodyObj.localSku.trim()
      : typeof bodyObj.LocalSku === "string"
        ? bodyObj.LocalSku.trim()
        : "";
  const annualBundle = resolveAnnualContractEntryByLocalSku(cfg, localSku);
  const manualBundle = annualBundle ? null : resolveManualContractEntryByServiceId(cfg, serviceId);
  const expectedVersion = annualBundle
    ? typeof annualBundle.annual.contractVersion === "string" &&
      String(annualBundle.annual.contractVersion).trim()
      ? String(annualBundle.annual.contractVersion).trim()
      : ""
    : manualBundle?.manual &&
        typeof /** @type {Record<string, unknown>} */ (manualBundle.manual).contractVersion === "string" &&
        String(/** @type {Record<string, unknown>} */ (manualBundle.manual).contractVersion).trim()
      ? String(/** @type {Record<string, unknown>} */ (manualBundle.manual).contractVersion).trim()
      : MEMBERSHIP_API_CONTRACT_VERSION;

  if (!expectedVersion || verRaw !== expectedVersion) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_contract_version_mismatch",
        attemptId,
        idempotencyKey,
        message: "Stale or mismatched membership terms — refresh pricing/checkout and consent again.",
      }),
    };
  }

  const termsSanitized = stripScriptsConsentHtml(snapRaw).trim();
  if (termsSanitized.length < 80) {
    return {
      ok: /** @type {const} */ (false),
      response: jsonResponse(400, {
        ok: false,
        error: "membership_terms_snapshot_invalid",
        attemptId,
        idempotencyKey,
        message: "Could not sanitize membership terms snapshot.",
      }),
    };
  }

  /** @type {{
   * termsSanitized: string;
   * termsTextHash: string;
   * contractVersion: string;
   * contractProductId: string | null;
   * contractName: string | null;
   * fullNameTyped: string;
   * membershipAgreementAccepted: boolean;
   * membershipBillingAuthorized: boolean;
   * }} */
  const data = {
    termsSanitized,
    termsTextHash: sha256HexUtf8(termsSanitized),
    contractVersion: verRaw,
    contractProductId: annualBundle
      ? typeof annualBundle.annual.mindbodyContractProductId === "string"
        ? String(annualBundle.annual.mindbodyContractProductId).trim()
        : null
      : manualBundle
        ? manualBundle.productKey
        : null,
    contractName: annualBundle
      ? typeof annualBundle.annual.marketingPlanName === "string"
        ? String(annualBundle.annual.marketingPlanName).slice(0, 240)
        : typeof annualBundle.annual.title === "string"
          ? String(annualBundle.annual.title).slice(0, 240)
          : null
      : manualBundle?.manual &&
          typeof /** @type {Record<string, unknown>} */ (manualBundle.manual).title === "string"
        ? String(/** @type {Record<string, unknown>} */ (manualBundle.manual).title).slice(0, 240)
        : null,
    fullNameTyped,
    membershipAgreementAccepted: agreementAccepted,
    membershipBillingAuthorized: billingAuthorized,
  };
  return { ok: /** @type {const} */ (true), data };
}

/**
 * @param {import("@netlify/blobs").Store | null} store
 * @param {string | null} key
 * @param {Record<string, unknown>} patch
 */
export async function mergeMembershipConsentRecord(store, key, patch) {
  if (!store || !key) return;
  try {
    const cur = await store.get(key, { type: "json" });
    if (!cur || typeof cur !== "object") return;
    await store.setJSON(key, {
      .../** @type {Record<string, unknown>} */ (cur),
      ...patch,
      auditUpdatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "mindbody_membership_consent_patch_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
  }
}
