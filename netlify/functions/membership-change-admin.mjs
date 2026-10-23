/**
 * Admin membership plan changes — /api/admin/monthly-memberships
 *
 * Reads (x-admin-token):
 *   GET ?q=<sub_amare_… | sub_… | email | Mindbody client id | name>   lookup
 *   GET ?subscriptionId=sub_amare_…                                    details + allowed changes
 *   GET ?operationId=<uuid>                                            operation status
 * Billing (x-admin-token + x-billing-actor + x-billing-key, POST only):
 *   POST { action: "whoami" }
 *   POST { action: "preview", subscriptionId, toSku, policy }
 *   POST { action: "execute", previewToken, confirmAmountCents, requestId, acknowledgements }
 *   POST { action: "cancel-scheduled", operationId }
 *   POST { action: "reconcile", operationId, retryMindbodySync }
 *   POST { action: "prepare-catalog", toSku }
 *
 * Gated by MEMBERSHIP_CHANGE_ADMIN_ENABLED=1. Scheduled (next billing date) changes additionally
 * need MEMBERSHIP_CHANGE_DEFERRED_ENABLED=1. Same-origin only (no CORS headers).
 */
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { openMembershipChangeStore } from "./membership-change-store.mjs";
import { adminTokenAuthorized, billingActorFromEvent } from "./membership-change-auth.mjs";
import { isMembershipChangeSku, BILLING_POLICIES } from "./membership-change-lib.mjs";
import { createMembershipChangeService, MembershipChangeError } from "./membership-change-service.mjs";

function flagOn(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** @param {unknown} event */
function parseJsonBody(event) {
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event || {});
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded ? Buffer.from(String(e.body), "base64").toString("utf8") : String(e.body);
  try {
    const parsed = JSON.parse(raw.trim() || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key.startsWith("sk_")) {
    throw new MembershipChangeError("stripe_unconfigured", 503, "Stripe is not configured on the server.");
  }
  return new Stripe(key, { apiVersion: "2025-08-27.basil" });
}

function previewSecret() {
  const base = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  return createHmac("sha256", base).update("membership-change-preview-secret").digest("hex");
}

/**
 * Live Mindbody / consent / retry adapters. Imported lazily so the read paths stay light.
 * @param {any} event
 * @param {any} stripe
 * @param {any} subStore
 */
export function createLiveMembershipChangeIO(event, stripe, subStore) {
  /** @type {Promise<Record<string, string> | null> | null} */
  let staffPromise = null;
  async function staff() {
    if (!staffPromise) {
      staffPromise = import("./mindbody-class-book-lib.mjs").then((m) => m.resolveStaffAuthHeaders());
    }
    return staffPromise;
  }
  return {
    async clientServices(clientId) {
      if (!Number.isFinite(clientId) || clientId <= 0) return null;
      const headers = await staff();
      if (!headers) return null;
      const { fetchMb } = await import("./mindbody-consumer-lib.mjs");
      const r = await fetchMb(
        "GET",
        `/public/v6/client/clientservices?${new URLSearchParams({ ClientId: String(clientId) })}`,
        headers,
        null,
      );
      if (!r?.ok) return null;
      return Array.isArray(r.data?.ClientServices) ? r.data.ClientServices : [];
    },
    async futureVisits(clientId) {
      if (!Number.isFinite(clientId) || clientId <= 0) return null;
      const headers = await staff();
      if (!headers) return null;
      const { fetchMb, visitsList } = await import("./mindbody-consumer-lib.mjs");
      const start = new Date();
      const end = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
      const q = new URLSearchParams({
        "request.clientId": String(clientId),
        "request.startDate": start.toISOString(),
        "request.endDate": end.toISOString(),
        "request.limit": "200",
        "request.offset": "0",
      });
      const r = await fetchMb("GET", `/public/v6/client/clientvisits?${q}`, headers, null);
      if (!r?.ok) return null;
      const nowMs = Date.now();
      return visitsList(r.data)
        .filter((v) => v && typeof v === "object" && Date.parse(String(v.StartDateTime || "")) >= nowMs)
        .map((v) => ({
          startDateTime: String(v.StartDateTime),
          name: String(v.Name || ""),
          classId: v.ClassId ?? null,
          clientServiceId: v.ProductId ?? v.ClientServiceId ?? null,
        }));
    },
    async consentContractProductId(record) {
      const consentId = String(record?.membershipConsentId || "").trim();
      if (!consentId) return null;
      const { tryOpenMembershipConsentBlobStore } = await import("./membership-consent-blobs.mjs");
      const { getConsentBlobRecord } = await import("./membership-consent-admin-lib.mjs");
      const store = tryOpenMembershipConsentBlobStore(event);
      if (!store) return null;
      const rec = await getConsentBlobRecord(store, consentId);
      if (!rec) return null;
      if (rec.mindbodyContractProductId != null) return String(rec.mindbodyContractProductId);
      const item = typeof rec.localSku === "string" ? getCatalogItem(rec.localSku) : null;
      return item?.mindbodyContractProductId != null ? String(item.mindbodyContractProductId) : null;
    },
    async retryInvoiceSync(record, invoiceId) {
      const { createMonthlyMindbodyIO, executeMonthlyRenewalSync } = await import("./stripe-monthly-period-sync.mjs");
      const entry = (record.invoices || []).find((e) => e && e.invoiceId === invoiceId);
      const item = getCatalogItem(record.localSku);
      if (!entry || !item) return { status: "not_retryable" };
      const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["lines.data"] });
      const io = createMonthlyMindbodyIO();
      const outcome = await executeMonthlyRenewalSync({
        subStore,
        record,
        invoice,
        existingEntry: entry,
        item,
        retrieveInvoice: async () => invoice,
        syncFn: (syncInput) => io.syncFn(syncInput),
        claimAlreadyAcquired: false,
        lostClaim: false,
        discountAmountCents: typeof entry.discountAmountCents === "number" ? entry.discountAmountCents : 0,
        promotionCode: entry.promotionCode || undefined,
        couponId: entry.couponId || undefined,
      });
      return { status: outcome.status };
    },
  };
}

/** @param {Record<string, any>} r */
function lookupRow(r) {
  return {
    subscriptionRecordId: r.id,
    customerName: r.customerName ?? null,
    customerEmail: r.customerEmail ?? null,
    mindbodyClientId: r.mindbodyClientId ?? null,
    localSku: r.localSku,
    planName: getCatalogItem(r.localSku)?.displayName ?? r.displayName ?? r.localSku,
    supported: isMembershipChangeSku(r.localSku),
    status: r.status,
    currentPeriodEnd: r.currentPeriodEnd ?? null,
    pendingPlanChange: r.pendingPlanChange ?? null,
  };
}

/**
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {string} q
 */
async function lookup(subStore, q) {
  const term = q.trim();
  if (/^sub_amare_[A-Z0-9]{8,40}$/.test(term)) {
    const r = await subStore.get(term);
    return r ? [r] : [];
  }
  if (/^sub_[A-Za-z0-9]+$/.test(term)) {
    const r = await subStore.getByStripeSubscriptionId(term);
    return r ? [r] : [];
  }
  if (/^\d{3,12}$/.test(term)) {
    return subStore.listActiveByMindbodyClientId(Number(term), { limit: 20 });
  }
  if (term.length < 3) return [];
  const needle = term.toLowerCase();
  const out = [];
  for (const status of ["active", "past_due"]) {
    const rows = await subStore.listByStatus(status, { limit: 500 });
    for (const r of rows) {
      const email = String(r.customerEmail || "").toLowerCase();
      const name = String(r.customerName || "").toLowerCase();
      if (email === needle || (needle.length >= 3 && (name.includes(needle) || email.includes(needle)))) out.push(r);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** @param {unknown} e */
function errorResponse(e) {
  if (e instanceof MembershipChangeError) {
    return jsonResponse(e.httpStatus, { ok: false, error: e.code, message: e.message, ...e.extra });
  }
  const code = String(/** @type {{ code?: string }} */ (e)?.code || "");
  if (code === "membership_change_db_unconfigured") {
    return jsonResponse(503, { ok: false, error: code, message: "Operation ledger database is not configured." });
  }
  console.error(
    JSON.stringify({
      event: "membership_change_admin_error",
      detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
    }),
  );
  return jsonResponse(500, { ok: false, error: "internal_error", message: "Unexpected server error. Nothing was retried." });
}

/**
 * @param {{ service?: ReturnType<typeof createMembershipChangeService> }} [overrides] tests only
 */
export function createMembershipChangeAdminHandler(overrides = {}) {
  /** @param {any} event */
  return (event) => handle(event, overrides);
}

export const handler = createMembershipChangeAdminHandler();

/**
 * @param {any} event
 * @param {{ service?: ReturnType<typeof createMembershipChangeService> }} overrides
 */
async function handle(event, overrides) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  if (!flagOn("MEMBERSHIP_CHANGE_ADMIN_ENABLED")) {
    return jsonResponse(404, { ok: false, error: "feature_disabled" });
  }
  if (!adminTokenAuthorized(event)) return jsonResponse(401, { ok: false, error: "unauthorized" });
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const subStore = openSubscriptionStore(event);
  if (!subStore.available) return jsonResponse(503, { ok: false, error: "subscription_store_unavailable" });

  try {
    const q = event.queryStringParameters || {};
    if (event.httpMethod === "GET" && typeof q.q === "string") {
      const rows = await lookup(subStore, q.q);
      return jsonResponse(200, { ok: true, count: rows.length, results: rows.map(lookupRow) });
    }

    const lazyService = () => {
      if (overrides.service) return overrides.service;
      const stripe = stripeClient();
      return createMembershipChangeService({
        stripe,
        subStore,
        ledger: openMembershipChangeStore(),
        io: createLiveMembershipChangeIO(event, stripe, subStore),
        previewSecret: previewSecret(),
        flags: { deferredEnabled: flagOn("MEMBERSHIP_CHANGE_DEFERRED_ENABLED") },
      });
    };

    if (event.httpMethod === "GET") {
      const subscriptionId = typeof q.subscriptionId === "string" ? q.subscriptionId.trim() : "";
      const operationId = typeof q.operationId === "string" ? q.operationId.trim() : "";
      if (operationId) {
        return jsonResponse(200, { ok: true, operation: await lazyService().getOperationStatus(operationId) });
      }
      if (subscriptionId) {
        const details = await lazyService().getDetails(subscriptionId);
        return jsonResponse(200, {
          ok: true,
          ...details,
          policies: BILLING_POLICIES,
          features: { deferredEnabled: flagOn("MEMBERSHIP_CHANGE_DEFERRED_ENABLED") },
        });
      }
      return jsonResponse(400, { ok: false, error: "missing_query" });
    }

    const body = parseJsonBody(event);
    if (!body) return jsonResponse(400, { ok: false, error: "invalid_json" });
    const billing = billingActorFromEvent(event);
    if (!billing.ok) {
      return jsonResponse(403, {
        ok: false,
        error: billing.reason,
        message:
          billing.reason === "billing_admins_not_configured"
            ? "No billing administrators are enrolled yet."
            : "Billing permission required (owner / superadmin credential).",
      });
    }
    const actor = billing.actor;
    const action = String(body.action || "").trim();
    const service = lazyService();

    if (action === "whoami") return jsonResponse(200, { ok: true, actor });

    if (action === "preview") {
      const subscriptionId = String(body.subscriptionId || "").trim();
      const toSku = String(body.toSku || "").trim();
      const policy = String(body.policy || "").trim();
      if (!isMembershipChangeSku(toSku)) return jsonResponse(400, { ok: false, error: "invalid_target_plan" });
      if (!Object.prototype.hasOwnProperty.call(BILLING_POLICIES, policy)) {
        return jsonResponse(400, { ok: false, error: "invalid_policy" });
      }
      const preview = await service.preview({ subscriptionRecordId: subscriptionId, toSku, policy });
      return jsonResponse(200, { ...preview, actor });
    }

    if (action === "execute") {
      const result = await service.execute({
        previewToken: String(body.previewToken || ""),
        confirmAmountCents: Number(body.confirmAmountCents),
        requestId: String(body.requestId || ""),
        actor,
        acknowledgements:
          body.acknowledgements && typeof body.acknowledgements === "object" ? body.acknowledgements : {},
      });
      return jsonResponse(200, { ok: true, ...result });
    }

    if (action === "cancel-scheduled") {
      const operation = await service.cancelScheduled({ operationId: String(body.operationId || ""), actor });
      return jsonResponse(200, { ok: true, operation });
    }

    if (action === "reconcile") {
      const operation = await service.getOperationStatus(String(body.operationId || ""), {
        retryMindbodySync: body.retryMindbodySync === true,
      });
      return jsonResponse(200, { ok: true, operation });
    }

    if (action === "prepare-catalog") {
      const toSku = String(body.toSku || "").trim();
      const result = await service.prepareCatalogProduct({ toSku, actor });
      return jsonResponse(200, { ok: true, result });
    }

    return jsonResponse(400, { ok: false, error: "unknown_action" });
  } catch (e) {
    return errorResponse(e);
  }
}
