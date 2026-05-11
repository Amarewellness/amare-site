import { randomUUID } from "node:crypto";
import {
  MB_API_VERSION,
  fetchMindbodyConsumerStoredWalletCards,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  mindbodyCheckoutTimeoutMs,
  reliableLastFourFromWalletCards,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";
import {
  mergeMembershipConsentRecord,
  validateMembershipElectronicConsent,
} from "./mindbody-membership-electronic-consent.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import {
  membershipConsentBlobKey,
  membershipConsentBlobsEnabled,
  tryOpenMembershipConsentBlobStore,
} from "./membership-consent-blobs.mjs";

function parseJsonBody(event) {
  if (event.body == null || event.body === "") return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (typeof raw === "string" && !raw.trim()) return {};
  try {
    return JSON.parse(typeof raw === "string" ? raw.trim() : raw);
  } catch {
    return null;
  }
}

function livePricingContractEnvAllowed() {
  return (process.env.MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT || "").trim() === "1";
}

/** @param {unknown} raw */
function parsePromotionCodeFromBody(raw) {
  if (raw == null) return null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!s) return null;
  return s.slice(0, 80);
}

/**
 * @param {Record<string, unknown>} body
 */
function checkoutAttemptIdFromBody(body) {
  const raw =
    (typeof body.purchaseAttemptId === "string" && body.purchaseAttemptId) ||
    (typeof body.attemptId === "string" && body.attemptId) ||
    (typeof body.idempotencyKey === "string" && body.idempotencyKey) ||
    "";
  const s = raw.trim().slice(0, 160);
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{8,160}$/.test(s)) return s;
  return null;
}

/** @param {unknown} event */
function clientIp(event) {
  const h =
    event && typeof event === "object" && "headers" in event
      ? /** @type {Record<string, string | undefined>} */ (
          /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers ?? {}
        )
      : {};
  const raw = String(h["x-forwarded-for"] ?? h["X-Forwarded-For"] ?? "").split(",")[0].trim();
  if (raw) return raw.slice(0, 120);
  const nf = String(h["x-nf-client-connection-ip"] ?? "").trim();
  return (nf || "unknown").slice(0, 120);
}

/** @param {unknown} event */
function clientUserAgent(event) {
  const h =
    event && typeof event === "object" && "headers" in event
      ? /** @type {Record<string, string | undefined>} */ (
          /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers ?? {}
        )
      : {};
  return String(h["user-agent"] ?? h["User-Agent"] ?? "").slice(0, 800);
}

/**
 * POST `/public/v6/sale/purchasecontract` — memberships sold as contracts (vs CheckoutShoppingCart service line).
 * `StoredCardInfo` matches published Public API model: `{ LastFour }` only (no StoredCardId until verified with Mindbody).
 *
 * @param {number} clientId
 * @param {number} contractId Mindbody `GET …/sale/contracts` row `Id`
 * @param {boolean} test Dry-run when true
 * @param {string | null} lastFour four digits from `fetchMindbodyConsumerStoredWalletCards` (live only)
 * @param {string | null} promotionCode
 * @param {string} yyyyMmDd
 * @param {number | null} locationId
 */
function buildPurchaseContractPayload(clientId, contractId, test, lastFour, promotionCode, yyyyMmDd, locationId) {
  const cid = String(clientId);
  /** @type {Record<string, unknown>} */
  const req = {
    ClientId: cid,
    clientId: cid,
    ContractId: contractId,
    contractId: contractId,
    StartDate: yyyyMmDd,
    startDate: yyyyMmDd,
    FirstPaymentOccurs: yyyyMmDd,
    firstPaymentOccurs: yyyyMmDd,
    Test: test,
    test,
    SendNotifications: true,
    sendNotifications: true,
  };
  if (locationId != null && Number.isFinite(locationId)) {
    req.LocationId = locationId;
    req.locationId = locationId;
  }
  const promo = typeof promotionCode === "string" ? promotionCode.trim() : "";
  if (promo) {
    req.PromotionCode = promo;
    req.promotionCode = promo;
  }

  if (!test) {
    if (!lastFour || !/^[0-9]{4}$/.test(lastFour)) return null;
    req.StoredCardInfo = { LastFour: lastFour };
  }

  return req;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) return jsonResponse(400, { ok: false, error: "invalid_json" });

  const bodyObj = /** @type {Record<string, unknown>} */ (body);

  const attemptId = checkoutAttemptIdFromBody(bodyObj) ?? randomUUID();
  const idempotencyKey =
    typeof bodyObj.idempotencyKey === "string" && bodyObj.idempotencyKey.trim()
      ? bodyObj.idempotencyKey.trim().slice(0, 160)
      : attemptId;

  const contractRaw = bodyObj.contractId ?? bodyObj.ContractId;
  const contractId =
    typeof contractRaw === "number"
      ? contractRaw
      : typeof contractRaw === "string"
        ? parseInt(contractRaw.trim(), 10)
        : NaN;
  if (!Number.isFinite(contractId) || contractId <= 0) {
    return jsonResponse(400, {
      ok: false,
      error: "missing_contract_id",
      attemptId,
      idempotencyKey,
      message: "Provide contractId from Mindbody GET …/sale/contracts (`Id` on the contract row — Classic prodid).",
    });
  }

  const svcRaw = bodyObj.serviceId ?? bodyObj.ServiceId ?? bodyObj.pricingOptionServiceId;
  const serviceId =
    typeof svcRaw === "number"
      ? svcRaw
      : typeof svcRaw === "string" && /^\d+$/.test(svcRaw.trim())
        ? parseInt(svcRaw.trim(), 10)
        : NaN;
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return jsonResponse(400, {
      ok: false,
      error: "missing_service_id",
      attemptId,
      idempotencyKey,
      message:
        "Membership consent is keyed by pricing-option service id (ContractItems[].Id). Send serviceId with contractId.",
    });
  }

  const membershipEnvelope = validateMembershipElectronicConsent(bodyObj, serviceId, attemptId, idempotencyKey);
  if (!membershipEnvelope.ok) return membershipEnvelope.response;
  const membershipConsentData = membershipEnvelope.data;

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  let test = true;
  if (typeof bodyObj.test === "boolean") test = bodyObj.test;
  else if (typeof bodyObj.dryRun === "boolean") test = bodyObj.dryRun;
  else if (bodyObj.confirmPurchase === true) test = false;

  const wantsLive = bodyObj.confirmPurchase === true || bodyObj.live === true;

  if (!test) {
    if (!wantsLive) {
      return jsonResponse(400, {
        ok: false,
        error: "confirm_required",
        message: "Set confirmPurchase: true for a live contract charge.",
        attemptId,
        idempotencyKey,
      });
    }
    if (!livePricingContractEnvAllowed()) {
      return jsonResponse(403, {
        ok: false,
        error: "live_checkout_disabled",
        attemptId,
        idempotencyKey,
        message:
          "Live purchases are blocked until MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT=1 is set on the server.",
      });
    }
  }

  /** Live contract charge requires Same wallet probe as `/client/stored-cards` — must yield a non-placeholder LastFour. */
  let lastFourReliable = null;
  if (!test) {
    const w = await fetchMindbodyConsumerStoredWalletCards(ctx.clientId, ctx.authHeaders);
    lastFourReliable = reliableLastFourFromWalletCards(w.cards);
  }

  if (!test && lastFourReliable == null) {
    return jsonResponse(400, {
      ok: false,
      error: "no_stored_card",
      attemptId,
      idempotencyKey,
      message:
        "Mindbody did not return a usable saved-card last-four for this login on the Public API. Use hosted or classic Mindbody checkout to purchase this membership.",
    });
  }

  const locRaw = (process.env.MINDBODY_SALE_LOCATION_ID ?? "").trim();
  let locationId = null;
  if (/^\d+$/.test(locRaw)) {
    const n = parseInt(locRaw, 10);
    if (n > 0) locationId = n;
  }

  const promotionCode = parsePromotionCodeFromBody(
    bodyObj.promotionCode ??
      bodyObj.PromotionCode ??
      bodyObj.couponCode ??
      bodyObj.promoCode,
  );

  const today = new Date();
  const yyyyMmDd = today.toISOString().slice(0, 10);

  const payload = buildPurchaseContractPayload(
    ctx.clientId,
    contractId,
    test,
    lastFourReliable,
    promotionCode,
    yyyyMmDd,
    locationId,
  );
  if (!payload) {
    return jsonResponse(500, {
      ok: false,
      error: "purchase_contract_payload_bug",
      attemptId,
      idempotencyKey,
      message: "Could not build PurchaseContract request (live mode requires a validated LastFour from Mindbody wallet API).",
    });
  }

  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  const hasIssueCreds = Boolean(staffUser && typeof staffPass === "string" && staffPass !== "");

  /** @type {Record<string, string> | null} */
  let staffHeaders = null;
  let staffTokenFromCache = false;

  const checkoutTimeoutMs = mindbodyCheckoutTimeoutMs();

  if (hasIssueCreds) {
    const issued = await getMindbodyStaffAccessTokenCached();
    if (!issued.ok) {
      const http =
        typeof issued.status === "number" && issued.status >= 400 && issued.status < 600
          ? issued.status
          : 502;
      return jsonResponse(http, {
        ok: false,
        error: issued.error,
        attemptId,
        idempotencyKey,
        mindbody: issued.mindbody,
        message: "Staff User Token issuance failed — same requirements as CheckoutShoppingCart.",
      });
    }
    staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
    staffTokenFromCache = issued.fromCache === true;
  } else {
    staffHeaders = mindbodyStaffApiHeaders();
  }

  if (!staffHeaders) {
    return jsonResponse(400, {
      ok: false,
      error: "checkout_staff_credentials_not_configured",
      attemptId,
      idempotencyKey,
      message:
        "POST …/sale/purchasecontract requires a staff Bearer token — set MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD or MINDBODY_STAFF_USER_TOKEN.",
    });
  }

  /** @type {string | undefined} */
  let consentIdPublic;
  /** @type {string | undefined} */
  let consentBlobKey;
  /** @type {Awaited<ReturnType<typeof tryOpenMembershipConsentBlobStore>> | null} */
  let consentStore = null;

  if (membershipConsentData) {
    consentIdPublic = randomUUID();
    consentBlobKey = membershipConsentBlobKey(consentIdPublic);
    const envLabel =
      ((process.env.CONTEXT || "").trim() ||
        (String(process.env.NETLIFY_DEV || "").trim() === "true" ? "netlify-dev" : "") ||
        (process.env.NODE_ENV || "").trim() ||
        "unknown"
      ).slice(0, 64);

    /** @type {Record<string, unknown>} */
    const audit = {
      consentId: consentIdPublic,
      flow: "purchase_contract",
      mindbodyContractId: contractId,
      mindbodyClientId: ctx.clientId,
      contractProductId: membershipConsentData.contractProductId,
      contractName: membershipConsentData.contractName,
      contractVersion: membershipConsentData.contractVersion,
      termsTextHash: membershipConsentData.termsTextHash,
      termsHtmlSnapshot: membershipConsentData.termsSanitized,
      membershipAgreementAccepted: membershipConsentData.membershipAgreementAccepted,
      membershipBillingAuthorized: membershipConsentData.membershipBillingAuthorized,
      fullNameTyped: membershipConsentData.fullNameTyped,
      purchaseAttemptId: attemptId,
      pricingOptionServiceId: serviceId,
      acceptedAt: new Date().toISOString(),
      ipAddress: clientIp(event),
      userAgent: clientUserAgent(event),
      source: "amare_website",
      environment: envLabel,
      checkoutStatus: "pending_mindbody_purchase_contract",
    };

    if (membershipConsentBlobsEnabled()) {
      consentStore = tryOpenMembershipConsentBlobStore(event);
      if (!consentStore) {
        return jsonResponse(503, {
          ok: false,
          error: "membership_consent_storage_unavailable",
          consentId: consentIdPublic,
          attemptId,
          idempotencyKey,
          message:
            "Configure Netlify Blobs and set MINDBODY_MEMBERSHIP_CONSENT_BLOBS=1 to store membership consent.",
        });
      }
      await consentStore.setJSON(consentBlobKey, audit);
    } else {
      console.log(
        JSON.stringify({
          event: "mindbody_purchase_contract_consent_log_only",
          consentId: consentIdPublic,
          contractId,
          serviceId,
          attemptId,
        }),
      );
    }
  }

  const path = `/public/v${MB_API_VERSION}/sale/purchasecontract`;
  let r;
  let staffAuthRetry = false;
  try {
    r = await fetchMb("POST", path, staffHeaders, payload, { timeoutMs: checkoutTimeoutMs });
    if (!r.ok && (r.status === 401 || r.status === 403) && hasIssueCreds) {
      staffAuthRetry = true;
      const issued2 = await getMindbodyStaffAccessTokenCached({ forceRefresh: true });
      if (issued2.ok) {
        const h2 = mindbodyStaffBearerHeaders(issued2.accessToken);
        if (h2) r = await fetchMb("POST", path, h2, payload, { timeoutMs: checkoutTimeoutMs });
      }
    }
  } catch (e) {
    const errBody = {
      ok: false,
      error: "purchase_contract_upstream_throw",
      attemptId,
      idempotencyKey,
      message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
    };
    await mergeMembershipConsentRecord(consentStore, consentBlobKey ?? null, {
      checkoutStatus: "upstream_throw",
      mindbodyPurchaseContractSucceeded: false,
    });
    return jsonResponse(502, errBody);
  }

  if (
    !r.ok &&
    r.data &&
    typeof r.data === "object" &&
    /** @type {Record<string, unknown>} */ (r.data)._mbFetchTimeout === true
  ) {
    await mergeMembershipConsentRecord(consentStore, consentBlobKey ?? null, {
      checkoutStatus: "purchase_contract_timeout",
      mindbodyPurchaseContractSucceeded: false,
    });
    return jsonResponse(504, {
      ok: false,
      error: "checkout_timeout",
      attemptId,
      idempotencyKey,
      message: "PurchaseContract did not finish in time — check Mindbody before retrying.",
      test,
      contractId,
      ...(promotionCode ? { promotionCode } : {}),
    });
  }

  console.log(
    JSON.stringify({
      event: "mindbody_purchase_contract_attempt",
      attemptId,
      idempotencyKey,
      ok: r.ok,
      httpStatus: r.status,
      clientId: ctx.clientId,
      contractId,
      serviceId,
      test,
      purchaseContractStoredCardMode: test ? undefined : "last_four_public_api_only",
      staffAuthMode: hasIssueCreds ? "issue_cached_or_fresh" : "static_env_token",
      staffTokenFromCache: hasIssueCreds ? staffTokenFromCache : undefined,
      staffAuthRetry,
      promotionCode: promotionCode || undefined,
    }),
  );

  const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  const snippet = r.data != null ? JSON.stringify(r.data).slice(0, 4000) : "";
  await mergeMembershipConsentRecord(consentStore, consentBlobKey ?? null, {
    checkoutStatus: r.ok ? "mindbody_response_ok" : "mindbody_response_error",
    mindbodyPurchaseContractSucceeded: r.ok === true,
    mindbodyHttpStatus: r.status,
    mindbodyResponseSnippet: snippet,
    completedAt: new Date().toISOString(),
  });

  const responseBody = {
    ok: r.ok,
    attemptId,
    idempotencyKey,
    flow: "purchase_contract",
    test,
    contractId,
    pricingOptionServiceId: serviceId,
    ...(promotionCode ? { promotionCode } : {}),
    ...(consentIdPublic ? { membershipConsentId: consentIdPublic } : {}),
    mindbody: r.data,
    ...(r.ok ? {} : { error: "checkout_failed" }),
  };

  return jsonResponse(r.ok ? 200 : r.status, responseBody, hdr);
}
