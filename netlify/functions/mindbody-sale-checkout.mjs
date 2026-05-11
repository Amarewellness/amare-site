import { randomUUID } from "node:crypto";
import {
  MB_API_VERSION,
  fetchMindbodyConsumerStoredWalletCards,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  mindbodyCheckoutTimeoutMs,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";
import {
  checkoutAttemptBlobKey,
  checkoutIdempotencyBlobsEnabled,
  claimNewCheckoutAttempt,
  patchCheckoutAttempt,
  tryOpenCheckoutBlobStore,
} from "./mindbody-checkout-idempotency.mjs";
import {
  mindbodyHeaders,
  mindbodyHost,
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { mergeMembershipConsentRecord, validateMembershipElectronicConsent } from "./mindbody-membership-electronic-consent.mjs";
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

function liveCheckoutEnvAllowed() {
  return (process.env.MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT || "").trim() === "1";
}

/** @param {unknown} raw @returns {number | null} */
function parseUsdAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseFloat(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
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
 * @param {unknown} mb
 * @returns {{ saleId: string | null }}
 */
function mindbodyShoppingSaleFingerprint(mb) {
  if (!mb || typeof mb !== "object") return { saleId: null };
  const root = /** @type {Record<string, unknown>} */ (mb);
  for (const key of ["ShoppingCart", "Sale", "shoppingCart", "sale"]) {
    const seg = root[key];
    if (!seg || typeof seg !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (seg);
    const id = o.Id ?? o.id ?? o.SaleId ?? o.saleId ?? o.TransactionId ?? o.transactionId;
    if (typeof id === "number" && Number.isFinite(id) && id > 0) return { saleId: String(Math.trunc(id)) };
    if (typeof id === "string" && /^\d+$/.test(id.trim())) return { saleId: id.trim() };
  }
  return { saleId: null };
}

/**
 * CheckoutShoppingCart (Comp/Test) rejects when payment sum ≠ discounted cart sum — e.g. list price Comp
 * while PromotionCode zeros the cart. Mindbody echoes the totals in Error.Message (possibly nested).
 * @param {unknown} mbData
 * @returns {number | null} calculated cart total Mindbody expects (USD)
 */
function mindbodyCheckoutMismatchCalculatedTotal(mbData) {
  /** @param {string} s */
  function fromString(s) {
    const m = s.match(/calculated total\s*\(\s*([\d.]+)\s*\)/i);
    if (!m) return null;
    const n = Number.parseFloat(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** @param {unknown} x @param {number} depth */
  function walk(x, depth = 0) {
    if (depth > 14) return null;
    if (x == null) return null;
    if (typeof x === "string") return fromString(x);
    if (typeof x !== "object") return null;
    if (Array.isArray(x)) {
      for (const el of x) {
        const n = walk(el, depth + 1);
        if (n != null) return n;
      }
      return null;
    }
    const o = /** @type {Record<string, unknown>} */ (x);
    const msg = o.Message ?? o.message;
    if (typeof msg === "string") {
      const hit = fromString(msg);
      if (hit != null) return hit;
    }
    for (const v of Object.values(o)) {
      const n = walk(v, depth + 1);
      if (n != null) return n;
    }
    return null;
  }

  const hit = walk(mbData);
  if (hit != null) return hit;
  if (mbData && typeof mbData === "object") {
    const raw = /** @type {Record<string, unknown>} */ (mbData)._raw;
    if (typeof raw === "string") {
      const n = fromString(raw);
      if (n != null) return n;
    }
  }
  try {
    return fromString(JSON.stringify(mbData));
  } catch {
    return null;
  }
}

/** @param {unknown} data */
function servicesArrayFromSaleServicesPayload(data) {
  if (!data || typeof data !== "object") return [];

  /** @param {unknown} obj */
  function fromKnownKeys(obj) {
    if (!obj || typeof obj !== "object") return [];
    const o = /** @type {Record<string, unknown>} */ (obj);
    for (const key of ["Services", "services"]) {
      const v = o[key];
      if (Array.isArray(v)) {
        return v
          .filter((row) => row != null && typeof row === "object")
          .map((row) => /** @type {Record<string, unknown>} */ (row));
      }
    }
    return [];
  }

  const d = /** @type {Record<string, unknown>} */ (data);
  let rows = fromKnownKeys(d);
  if (rows.length) return rows;
  const pr = d.PaginationResponse ?? d.paginationResponse;
  return fromKnownKeys(pr);
}

/** @param {Record<string, unknown>} row */
function onlinePriceFromServiceRow(row) {
  const candidates = [
    "OnlinePrice",
    "onlinePrice",
    "Price",
    "price",
    "CurrentPrice",
    "RetailPrice",
    "retailPrice",
    "Amount",
    "amount",
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Match `/sale/services` row for `checkout` line item. Paginates large Sell Online catalogs.
 * @param {number} serviceId
 */
async function lookupServiceOnlineUsdPrice(serviceId) {
  const h = mindbodyHeaders();
  if (!h) return null;

  const limit = 200;
  try {
    for (let offset = 0; offset <= 4800; offset += limit) {
      const path = `/public/v${MB_API_VERSION}/sale/services?SellOnline=true&Limit=${limit}&Offset=${offset}`;
      const url = `https://${mindbodyHost()}${path}`;
      const res = await fetch(url, { method: "GET", headers: h });
      const data = /** @type {unknown} */ (await res.json().catch(() => null));
      if (!res.ok || !data) return null;

      const rows = servicesArrayFromSaleServicesPayload(data);
      if (!rows.length) break;

      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const sid = r.Id ?? r.ID ?? r.ServiceId ?? r.ServiceID;
        let num = NaN;
        if (typeof sid === "number" && Number.isFinite(sid)) num = sid;
        else if (typeof sid === "string" && /^\d+$/.test(sid.trim())) num = parseInt(sid.trim(), 10);
        if (num !== serviceId) continue;
        const p = onlinePriceFromServiceRow(r);
        return p ?? null;
      }

      if (rows.length < limit) break;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * POST …/sale/checkoutshoppingcart — exactly one pricing-option line item.
 *
 * Send **either** PascalCase **or** camelCase for envelope + line keys — not both. Some Mindbody deserializers
 * treat duplicated keys (`items`+`Items`, nested `item`+`Item`) as **two distinct lines**, doubling the cart
 * (e.g. one $30 drop-in → charged as $60).
 *
 * PascalCase aligns with ShoppingCart responses (`CartItems`, `GrandTotal`, …).
 * @param {number} clientId
 * @param {number} serviceId
 * @param {boolean} test
 * @param {number | null} storedCardId
 * @param {number | null} compAmountUsd
 * @param {string | null} promotionCode
 */
function buildCheckoutPayload(clientId, serviceId, test, storedCardId, compAmountUsd, promotionCode) {
  /** @type {Record<string, unknown>[]} */
  const payments = [];

  if (storedCardId != null && Number.isFinite(storedCardId)) {
    const scMeta = {
      StoredCardID: storedCardId,
      StoredCardId: storedCardId,
    };
    payments.push({
      Type: "StoredCard",
      Metadata: scMeta,
    });
  } else if (test) {
    if (compAmountUsd == null || !Number.isFinite(compAmountUsd) || compAmountUsd < 0) return null;
    const amt = Number(compAmountUsd);
    // Mindbody requires a non-empty `Payments` array. Sum must match GrandTotal ($0 carts after 100%
    // promo need a zero-amount Comp — empty `Payments` returns MissingRequiredFields).
    const compMeta = {
      Amount: amt,
      AmountPaid: amt,
    };
    payments.push({
      Type: "Comp",
      Metadata: compMeta,
    });
  } else {
    return null;
  }

  const locRaw = (process.env.MINDBODY_SALE_LOCATION_ID ?? "").trim();
  /** @type {number | undefined} */
  let locationId;
  if (/^\d+$/.test(locRaw)) {
    const n = parseInt(locRaw, 10);
    if (n > 0) locationId = n;
  }

  /** Service row references Sell Online pricing option id. */
  const itemMetadata = {
    Id: serviceId,
    ServiceId: serviceId,
  };
  /** @type {Record<string, unknown>} */
  const serviceItemWrapper = {
    Type: "Service",
    Metadata: itemMetadata,
  };

  /** Single cart row; never duplicate casing keys (`item`/`Item`, `quantity`/`Quantity`). */
  const cartLines = [{ Item: serviceItemWrapper, Quantity: 1 }];

  /** @type {Record<string, unknown>} */
  const checkout = {
    ClientId: String(clientId),
    test,
    Test: test,
    Items: cartLines,
    Payments: payments,
    InStore: false,
    SendEmail: true,
  };

  if (locationId !== undefined) {
    checkout.LocationId = locationId;
  }

  const promo = typeof promotionCode === "string" ? promotionCode.trim() : "";
  if (promo) checkout.PromotionCode = promo;

  return checkout;
}

/** @param {unknown} raw */
function parsePromotionCodeFromBody(raw) {
  if (raw == null) return null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!s) return null;
  return s.slice(0, 80);
}

/** Reject multi-line carts or client-supplied payment rows — server builds a single service line + payments. */
/** @param {Record<string, unknown>} body */
function rejectMultiLineCheckoutBody(body) {
  for (const key of ["items", "Items"]) {
    const arr = body[key];
    if (Array.isArray(arr) && arr.length !== 1) {
      return jsonResponse(400, {
        ok: false,
        error: "invalid_cart_lines",
        message:
          "Checkout supports exactly one line item. Remove extra cart rows or use Mindbody classic checkout.",
      });
    }
  }
  for (const key of ["payments", "Payments"]) {
    const arr = body[key];
    if (Array.isArray(arr) && arr.length > 0) {
      return jsonResponse(400, {
        ok: false,
        error: "client_payments_forbidden",
        message: "Do not send a `payments` array — the server builds payment rows.",
      });
    }
  }
  return null;
}

/**
 * Client-generated id for double-submit protection + optional blob idempotency (8–160 chars, [A-Za-z0-9_-]).
 * Falls back to server UUID when missing/invalid.
 *
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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const bodyObj = /** @type {Record<string, unknown>} */ (body);
  const rejected = rejectMultiLineCheckoutBody(bodyObj);
  if (rejected) return rejected;

  const attemptId = checkoutAttemptIdFromBody(bodyObj) ?? randomUUID();
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 160)
      : attemptId;

  const svcRaw = body.serviceId ?? body.ServiceId;
  const serviceId =
    typeof svcRaw === "number" ? svcRaw : typeof svcRaw === "string" ? parseInt(svcRaw, 10) : NaN;
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return jsonResponse(400, {
      ok: false,
      error: "missing_service_id",
      attemptId,
      idempotencyKey,
    });
  }

  const membershipEnvelope = validateMembershipElectronicConsent(bodyObj, serviceId, attemptId, idempotencyKey);
  if (!membershipEnvelope.ok) return membershipEnvelope.response;
  const membershipConsentData = membershipEnvelope.data;

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  /** Default: Mindbody Test=true (dry run / validation only) unless client explicitly confirms purchase. */
  /** @type {boolean} */
  let test = true;
  if (typeof body.test === "boolean") test = body.test;
  else if (typeof body.dryRun === "boolean") test = body.dryRun;
  else if (body.confirmPurchase === true) test = false;

  const wantsLive = body.confirmPurchase === true || body.live === true;

  if (!test) {
    if (!wantsLive) {
      return jsonResponse(400, {
        ok: false,
        error: "confirm_required",
        message: "Set confirmPurchase: true to charge the saved card (live mode).",
      });
    }
    if (!liveCheckoutEnvAllowed()) {
      return jsonResponse(403, {
        ok: false,
        error: "live_checkout_disabled",
        message:
          "Live checkout is blocked until MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT=1 is set on the server.",
      });
    }
  }

  const cardArg = body.storedCardId ?? body.StoredCardId;
  let storedCardId =
    typeof cardArg === "number" && Number.isFinite(cardArg)
      ? cardArg
      : typeof cardArg === "string" && /^\d+$/.test(cardArg.trim())
        ? parseInt(cardArg.trim(), 10)
        : null;

  /** Same wallet probing as `/client/stored-cards` (CCI scoped, GetClients Fields, staff) — avoids “UI says no card” while checkout briefly saw CCI-only. */
  if (storedCardId == null) {
    const w = await fetchMindbodyConsumerStoredWalletCards(ctx.clientId, ctx.authHeaders);
    const id0 = w.cards[0]?.id;
    if (id0 != null && Number.isFinite(id0)) storedCardId = id0;
  }

  if (!test && storedCardId == null) {
    return jsonResponse(400, {
      ok: false,
      error: "no_stored_card",
      message: "Add a card on file in Mindbody (Consumer) or complete purchase via the classic checkout link.",
    });
  }

  /** Dry-run without a stored card uses `Type: "Comp"` — Mindbody requires `Metadata.amount`. */
  let compAmountUsd = parseUsdAmount(body.amount ?? body.Amount ?? body.cartTotal ?? body.CartTotal);
  if (test && storedCardId == null) {
    if (compAmountUsd == null) {
      compAmountUsd = await lookupServiceOnlineUsdPrice(serviceId);
    }
    if (compAmountUsd == null || !(compAmountUsd > 0)) {
      return jsonResponse(400, {
        ok: false,
        error: "missing_comp_amount",
        message:
          "Dry-run checkout needs a positive `amount` (USD) for the Comp payment row. The UI should send the row price, or the service must appear on GET /sale/services so the server can infer it.",
      });
    }
  } else {
    compAmountUsd = null;
  }

  const promotionCode = parsePromotionCodeFromBody(
    body.promotionCode ?? body.PromotionCode ?? body.couponCode ?? body.coupon ?? body.promoCode,
  );

  /** @type {Record<string, unknown> | null} */
  let payload = buildCheckoutPayload(
    ctx.clientId,
    serviceId,
    test,
    storedCardId,
    compAmountUsd,
    promotionCode,
  );
  if (!payload) {
    return jsonResponse(500, {
      ok: false,
      error: "checkout_payload_bug",
      message: "Checkout payment row could not be built.",
      attemptId,
      idempotencyKey,
    });
  }

  /**
   * Staff auth: `MINDBODY_STAFF_USERNAME` + `MINDBODY_STAFF_PASSWORD` → `POST …/usertoken/issue`
   * with in-memory reuse until JWT nears expiry (serverless warm instance).
   * Legacy: `MINDBODY_STAFF_USER_TOKEN` (static Bearer).
   */
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
      const code = issued.error;
      const http =
        code === "missing_staff_issue_credentials"
          ? 500
          : typeof issued.status === "number" && issued.status >= 400 && issued.status < 600
            ? issued.status
            : 502;
      console.log(
        JSON.stringify({
          event: "mindbody_checkout_staff_issue_failed",
          attemptId,
          idempotencyKey,
          clientId: ctx.clientId,
          serviceId,
          error: code,
          mbHttpStatus: issued.status,
        }),
      );
      const msg =
        code === "staff_token_issue_timeout"
          ? "Staff token issuance timed out — try again; if it persists, check Mindbody status and network."
          : code === "staff_token_issue_failed"
            ? "Mindbody rejected staff User Token issuance — check MINDBODY_STAFF_USERNAME/PASSWORD, site, and API key."
            : code === "staff_token_issue_malformed"
              ? "Mindbody Issue response had no AccessToken — check API version/host."
              : "Staff Issue credentials incomplete.";
      return jsonResponse(http, {
        ok: false,
        error: code,
        attemptId,
        idempotencyKey,
        mindbody: issued.mindbody,
        message: msg,
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
        "Mindbody CheckoutShoppingCart needs a staff User Token. Set MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD (recommended — issued automatically per checkout), or legacy MINDBODY_STAFF_USER_TOKEN. Consumer sign-in only resolves clientId.",
    });
  }

  /** @type {any} */
  let blobStore = null;
  /** @type {string | null} */
  let blobKey = null;
  if (checkoutIdempotencyBlobsEnabled()) {
    const st = tryOpenCheckoutBlobStore(event);
    if (st) {
      blobStore = st;
      blobKey = checkoutAttemptBlobKey(attemptId, ctx.clientId);
      const claim = await claimNewCheckoutAttempt(blobStore, blobKey, {
        status: "pending",
        createdAt: new Date().toISOString(),
        attemptId,
        serviceId,
        test,
      });
      if (claim.kind === "exists") {
        const ex = claim.existing;
        const state =
          ex && typeof ex === "object" ? /** @type {Record<string, unknown>} */ (ex) : null;
        if (state?.status === "pending") {
          return jsonResponse(409, {
            ok: false,
            error: "checkout_attempt_in_progress",
            attemptId,
            idempotencyKey,
            message:
              "This checkout attempt is still processing. Wait for the result before submitting again.",
          });
        }
        const res = state?.result;
        if (res && typeof res === "object" && "statusCode" in res && "body" in res) {
          const rc = /** @type {{ statusCode: unknown; body: unknown }} */ (res);
          const sc = Number(rc.statusCode);
          const bod = rc.body;
          const safe =
            bod && typeof bod === "object"
              ? /** @type {Record<string, unknown>} */ (bod)
              : { ok: false, error: "idempotency_replay_malformed", attemptId, idempotencyKey };
          return jsonResponse(Number.isFinite(sc) ? sc : 500, safe);
        }
        return jsonResponse(409, {
          ok: false,
          error: "checkout_attempt_id_stale",
          attemptId,
          idempotencyKey,
          message:
            "This purchaseAttemptId is already registered with no replayable result. Start a fresh checkout or use a new attempt id.",
        });
      }
    }
  }

  /** @type {import("@netlify/blobs").Store | null} */
  let consentStore = null;
  /** @type {string | null} */
  let consentBlobKey = null;
  /** @type {string | null} */
  let consentIdPublic = null;

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
      checkoutServiceId: serviceId,
      acceptedAt: new Date().toISOString(),
      ipAddress: clientIp(event),
      userAgent: clientUserAgent(event),
      source: "amare_website",
      environment: envLabel,
      checkoutStatus: "pending_mindbody",
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
            "Configure Netlify Blobs for Functions and set MINDBODY_MEMBERSHIP_CONSENT_BLOBS=1 to store membership consent before checkout.",
        });
      }
      await consentStore.setJSON(consentBlobKey, audit);
    } else {
      console.log(
        JSON.stringify({
          event: "membership_consent_audit_log_only",
          consentId: consentIdPublic,
          mindbodyClientId: ctx.clientId,
          termsTextHash: membershipConsentData.termsTextHash,
          contractVersion: membershipConsentData.contractVersion,
          serviceId,
          attemptId,
        }),
      );
    }
  }

  const finalizeBlob = async (statusCode, respBody) => {
    if (!blobStore || !blobKey) return;
    try {
      await patchCheckoutAttempt(blobStore, blobKey, {
        status: "final",
        result: { statusCode, body: respBody },
      });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "mindbody_checkout_blob_finalize_failed",
          attemptId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
    }
  };

  const path = `/public/v${MB_API_VERSION}/sale/checkoutshoppingcart`;
  let r;
  let staffAuthRetry = false;

  /**
   * @param {Record<string, unknown>} body
   * @returns {Promise<Awaited<ReturnType<typeof fetchMb>>>}
   */
  async function checkoutPost(body) {
    let res = await fetchMb("POST", path, staffHeaders, body, { timeoutMs: checkoutTimeoutMs });
    if (!res.ok && (res.status === 401 || res.status === 403) && hasIssueCreds) {
      staffAuthRetry = true;
      const issued2 = await getMindbodyStaffAccessTokenCached({ forceRefresh: true });
      if (issued2.ok) {
        const h2 = mindbodyStaffBearerHeaders(issued2.accessToken);
        if (h2) res = await fetchMb("POST", path, h2, body, { timeoutMs: checkoutTimeoutMs });
      }
    }
    return res;
  }

  try {
    r = await checkoutPost(payload);
    if (
      !r.ok &&
      test &&
      storedCardId == null &&
      compAmountUsd != null &&
      r.data &&
      typeof r.data === "object" &&
      !(/** @type {Record<string, unknown>} */ (r.data)._mbFetchTimeout === true)
    ) {
      let corrected = mindbodyCheckoutMismatchCalculatedTotal(r.data);
      if (
        corrected == null &&
        promotionCode &&
        r.data &&
        /\bcalculated total\s*\(\s*0(?:\.0+)?\s*\)/i.test(JSON.stringify(r.data))
      ) {
        corrected = 0;
      }
      if (
        corrected != null &&
        Math.abs(corrected - compAmountUsd) > 0.009
      ) {
        const payload2 = buildCheckoutPayload(
          ctx.clientId,
          serviceId,
          test,
          storedCardId,
          corrected,
          promotionCode,
        );
        if (payload2) {
          console.log(
            JSON.stringify({
              event: "mindbody_checkout_comp_amount_realigned",
              attemptId,
              idempotencyKey,
              fromUsd: compAmountUsd,
              toUsd: corrected,
              promotionCode: promotionCode || undefined,
            }),
          );
          payload = payload2;
          r = await checkoutPost(payload2);
        }
      }
    }
  } catch (e) {
    const errBody = {
      ok: false,
      error: "checkout_upstream_throw",
      attemptId,
      idempotencyKey,
      message:
        "Mindbody request failed before a response arrived. You were likely not charged — check your account or contact the studio.",
    };
    await finalizeBlob(502, errBody);
    await mergeMembershipConsentRecord(consentStore, consentBlobKey, {
      checkoutStatus: "upstream_throw",
      mindbodyCheckoutSucceeded: false,
    });
    return jsonResponse(502, errBody);
  }

  if (
    !r.ok &&
    r.data &&
    typeof r.data === "object" &&
    /** @type {Record<string, unknown>} */ (r.data)._mbFetchTimeout === true
  ) {
    console.log(
      JSON.stringify({
        event: "mindbody_checkout_timeout",
        attemptId,
        idempotencyKey,
        clientId: ctx.clientId,
        serviceId,
        checkoutTimeoutMs,
        promotionCode: promotionCode || undefined,
      }),
    );
    const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
    const timeoutBody = {
      ok: false,
      error: "checkout_timeout",
      attemptId,
      idempotencyKey,
      message:
        "Checkout did not finish in time — Mindbody may still be processing. Do not submit again immediately; check your account or contact the studio if you are unsure whether you were charged.",
      test,
      storedCardId,
      ...(promotionCode ? { promotionCode } : {}),
    };
    await finalizeBlob(504, timeoutBody);
    await mergeMembershipConsentRecord(consentStore, consentBlobKey, {
      checkoutStatus: "checkout_timeout",
      mindbodyCheckoutSucceeded: false,
    });
    return jsonResponse(504, timeoutBody, hdr);
  }

  console.log(
    JSON.stringify({
      event: "mindbody_checkout_attempt",
      attemptId,
      idempotencyKey,
      ok: r.ok,
      httpStatus: r.status,
      clientId: ctx.clientId,
      serviceId,
      test,
      storedCardId,
      staffAuthMode: hasIssueCreds ? "issue_cached_or_fresh" : "static_env_token",
      staffTokenFromCache: hasIssueCreds ? staffTokenFromCache : undefined,
      staffAuthRetry,
      promotionCode: promotionCode || undefined,
    }),
  );

  const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  const mbFp = mindbodyShoppingSaleFingerprint(r.data);
  const snippet =
    r.data != null ? JSON.stringify(r.data).slice(0, 4000) : "";
  await mergeMembershipConsentRecord(consentStore, consentBlobKey, {
    checkoutStatus: r.ok ? "mindbody_response_received_ok" : "mindbody_response_received_error",
    mindbodyCheckoutSucceeded: r.ok === true,
    mindbodyHttpStatus: r.status,
    mindbodySaleId: mbFp.saleId,
    mindbodyResponseSnippet: snippet,
    completedAt: new Date().toISOString(),
  });
  const responseBody = {
    ok: r.ok,
    attemptId,
    idempotencyKey,
      test,
    storedCardId,
    ...(promotionCode ? { promotionCode } : {}),
    ...(consentIdPublic ? { membershipConsentId: consentIdPublic } : {}),
    mindbody: r.data,
    ...(r.ok ? {} : { error: "checkout_failed" }),
  };
  await finalizeBlob(r.ok ? 200 : r.status, responseBody);
  return jsonResponse(r.ok ? 200 : r.status, responseBody, hdr);
}
