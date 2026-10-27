/**
 * Admin membership plan changes — /api/admin/monthly-memberships
 *
 * Reads (x-admin-token):
 *   GET ?q=<sub_amare_… | sub_… | email | Mindbody client id | name>   lookup
 *   GET ?subscriptionId=sub_amare_…                                    details + allowed changes
 *   GET ?operationId=<uuid>                                            operation status
 * Billing writes: an owner/superadmin HttpOnly session (cookie + x-csrf-token), or the
 * existing per-admin billing key when no session cookie is present. The shared
 * admin token never authorizes a charge.
 *   POST { action: "whoami" }
 *   POST { action: "preview", subscriptionId, toSku, policy }
 *   POST { action: "execute", previewToken, confirmAmountCents, requestId, acknowledgements }
 *   POST { action: "cancel-scheduled", operationId }
 *   POST { action: "reconcile", operationId, retryMindbodySync }
 *   POST { action: "prepare-catalog", toSku }
 *   POST { action: "billing-key-rotate", newKey }                       own key
 *   POST { action: "billing-admins-list" }
 *   POST { action: "billing-admin-enroll", actorId, role, displayName, key }   owner (superadmin: superadmins only)
 *   POST { action: "billing-admin-revoke", actorId }                    owner; never the last owner
 *
 * Always on. Same-origin only (no CORS headers). The first owner is enrolled out-of-band
 * (scripts/membership-billing-admin-enroll.mjs); there is no bootstrap route.
 */
import { createHmac } from "node:crypto";
import { withLambda } from "@netlify/aws-lambda-compat";
import Stripe from "stripe";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { openMembershipChangeStore } from "./membership-change-store.mjs";
import { openBillingAuthStore, publicBillingAdmin } from "./membership-billing-auth-store.mjs";
import {
  ACTOR_ID_RE,
  BILLING_ROLES,
  adminTokenAuthorized,
  clientIpHash,
  hashBillingKey,
  validateBillingKey,
  verifyBillingActor,
} from "./membership-change-auth.mjs";
import {
  csrfMatches,
  hasSessionCookie,
  resolveAdminSession,
} from "./membership-admin-session.mjs";
import { isMembershipChangeSku, BILLING_POLICIES } from "./membership-change-lib.mjs";
import { createMembershipChangeService, MembershipChangeError } from "./membership-change-service.mjs";

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
        adminRetry: true,
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
 * @param {{ service?: ReturnType<typeof createMembershipChangeService>, billingStore?: any }} [overrides] tests only
 */
export function createMembershipChangeAdminHandler(overrides = {}) {
  /** @param {any} event */
  return (event) => handle(event, overrides);
}

/** Modern runtime (default export) — required for the Netlify Database binding. */
export const lambdaHandler = createMembershipChangeAdminHandler();
export default withLambda(lambdaHandler);

const BILLING_DENIED_MESSAGES = Object.freeze({
  billing_credentials_missing: "Access denied. Owner or superadmin access is required to change memberships.",
  billing_credentials_invalid: "Billing credential not accepted.",
  billing_auth_rate_limited: "Too many failed billing sign-ins. Try again in 15 minutes.",
  access_denied: "Access denied. Owner or superadmin access is required to change memberships.",
  csrf_invalid: "Reload this page before changing a membership.",
  session_invalid: "Your admin session has ended. Sign in again.",
  session_revoked: "Your admin session has ended. Sign in again.",
  session_missing: "Your admin session has ended. Sign in again.",
});

/**
 * Billing-admin management actions. Enrollment is controlled by existing owners/superadmins.
 * @param {string} action
 * @param {Record<string, any>} body
 * @param {{ id: string, role: string }} actor
 * @param {any} store
 */
async function billingAdminAction(action, body, actor, store) {
  if (action === "billing-admins-list") {
    return { status: 200, body: { ok: true, admins: (await store.listAdmins()).map(publicBillingAdmin) } };
  }
  if (action === "billing-key-rotate") {
    const problem = validateBillingKey(body.newKey);
    if (problem) return { status: 400, body: { ok: false, error: problem } };
    const { keySalt, keyHash } = hashBillingKey(String(body.newKey));
    const r = await store.rotateKey(actor.id, keySalt, keyHash);
    return r.ok ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, error: r.reason } };
  }
  if (action === "billing-admin-enroll") {
    const actorId = String(body.actorId || "").trim().toLowerCase();
    const role = String(body.role || "").trim();
    if (!ACTOR_ID_RE.test(actorId)) return { status: 400, body: { ok: false, error: "invalid_actor_id" } };
    if (!BILLING_ROLES.includes(role)) return { status: 400, body: { ok: false, error: "invalid_role" } };
    if (actor.role !== "owner" && role !== "superadmin") {
      return { status: 403, body: { ok: false, error: "owner_required", message: "Only an owner can enroll owners." } };
    }
    const problem = validateBillingKey(body.key);
    if (problem) return { status: 400, body: { ok: false, error: problem } };
    const { keySalt, keyHash } = hashBillingKey(String(body.key));
    const r = await store.enrollAdmin({
      actorId,
      role,
      displayName: String(body.displayName || "").trim().slice(0, 80) || null,
      keySalt,
      keyHash,
      createdBy: actor.id,
      mustRotate: true,
    });
    return r.ok
      ? { status: 200, body: { ok: true, admin: publicBillingAdmin(r.admin) }, detail: { enrolled: actorId, role } }
      : { status: 409, body: { ok: false, error: r.reason } };
  }
  if (action === "billing-admin-revoke") {
    if (actor.role !== "owner") return { status: 403, body: { ok: false, error: "owner_required" } };
    const actorId = String(body.actorId || "").trim().toLowerCase();
    const r = await store.revokeAdmin(actorId, actor.id);
    return r.ok
      ? { status: 200, body: { ok: true }, detail: { revoked: actorId } }
      : { status: 409, body: { ok: false, error: r.reason } };
  }
  return null;
}

/**
 * Cookie session wins when present, so a shared admin token cannot be mixed in to gain billing.
 * With no session cookie, the per-admin billing key is still accepted.
 * @param {any} event
 * @param {any} store
 */
async function authorizeBillingWrite(event, store) {
  if (hasSessionCookie(event)) {
    const session = await resolveAdminSession(event, store);
    if (!session.ok) return { ok: false, status: session.status, reason: session.reason };
    if (!csrfMatches(event, session.csrfToken)) return { ok: false, status: 403, reason: "csrf_invalid" };
    if (session.actor.role !== "owner" && session.actor.role !== "superadmin") {
      return { ok: false, status: 403, reason: "access_denied" };
    }
    return { ok: true, actor: session.actor, ipHash: clientIpHash(event) };
  }
  const billing = await verifyBillingActor(event, store);
  if (!billing.ok) return { ok: false, status: billing.status, reason: billing.reason };
  return { ok: true, actor: billing.actor, ipHash: billing.ipHash };
}

/**
 * @param {any} event
 * @param {{ service?: ReturnType<typeof createMembershipChangeService>, billingStore?: any }} overrides
 */
async function handle(event, overrides) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const tokenOk = adminTokenAuthorized(event);
  if (!tokenOk && !hasSessionCookie(event)) return jsonResponse(401, { ok: false, error: "unauthorized" });

  const subStore = openSubscriptionStore(event);
  if (!subStore.available) return jsonResponse(503, { ok: false, error: "subscription_store_unavailable" });

  try {
    if (!tokenOk) {
      const readStore = overrides.billingStore || openBillingAuthStore();
      const session = await resolveAdminSession(event, readStore);
      if (!session.ok) {
        return jsonResponse(session.status, { ok: false, error: session.reason, message: BILLING_DENIED_MESSAGES[session.reason] });
      }
    }

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
        return jsonResponse(200, { ok: true, ...details, policies: BILLING_POLICIES });
      }
      return jsonResponse(400, { ok: false, error: "missing_query" });
    }

    const body = parseJsonBody(event);
    if (!body) return jsonResponse(400, { ok: false, error: "invalid_json" });
    const billingStore = overrides.billingStore || openBillingAuthStore();
    const gate = await authorizeBillingWrite(event, billingStore);
    if (!gate.ok) {
      return jsonResponse(gate.status, {
        ok: false,
        error: gate.reason,
        message: BILLING_DENIED_MESSAGES[/** @type {keyof typeof BILLING_DENIED_MESSAGES} */ (gate.reason)] || "Access denied.",
      });
    }
    const action = String(body.action || "").trim();
    return await billingAction(action, body, gate.actor, billingStore, gate.ipHash, lazyService);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Runs one authorized billing action and records it in the audit log with the real admin id.
 * @param {string} action
 * @param {Record<string, any>} body
 * @param {{ id: string, role: string, displayName: string | null }} actor
 * @param {any} billingStore
 * @param {string | null} ipHash
 * @param {() => ReturnType<typeof createMembershipChangeService>} lazyService
 */
async function billingAction(action, body, actor, billingStore, ipHash, lazyService) {
  const subscriptionRecordId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : null;
  /** @param {string} outcome @param {Record<string, unknown>} [detail] @param {string | null} [operationId] */
  const audit = (outcome, detail = {}, operationId = null) =>
    billingStore
      .appendAudit({ actorId: actor.id, action, subscriptionRecordId, operationId, outcome, detail, ipHash })
      .catch((e) => console.error(JSON.stringify({ event: "billing_audit_write_failed", action, detail: String(e?.message || e) })));

  try {
    if (action === "whoami") return jsonResponse(200, { ok: true, actor });
    if (actor.mustRotate && action !== "billing-key-rotate") {
      return jsonResponse(403, {
        ok: false,
        error: "key_rotation_required",
        message: "Set a new password before changing memberships.",
      });
    }

    const adminResult = await billingAdminAction(action, body, actor, billingStore);
    if (adminResult) {
      if (action !== "billing-admins-list") await audit(adminResult.body.ok ? "ok" : String(adminResult.body.error), adminResult.detail);
      return jsonResponse(adminResult.status, adminResult.body);
    }

    const service = lazyService();

    if (action === "preview") {
      const toSku = String(body.toSku || "").trim();
      const policy = String(body.policy || "").trim();
      if (!isMembershipChangeSku(toSku)) return jsonResponse(400, { ok: false, error: "invalid_target_plan" });
      if (!Object.prototype.hasOwnProperty.call(BILLING_POLICIES, policy)) {
        return jsonResponse(400, { ok: false, error: "invalid_policy" });
      }
      const preview = await service.preview({ subscriptionRecordId: String(subscriptionRecordId || ""), toSku, policy });
      await audit(preview.ok ? "ok" : "blocked", {
        toSku,
        policy,
        chargeTodayCents: preview.billing?.chargeTodayCents ?? null,
        blockers: (preview.blockers || []).map((b) => b.code),
      });
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
      await audit(
        result.operation?.status || "unknown",
        { duplicate: result.duplicate === true, confirmAmountCents: Number(body.confirmAmountCents) },
        result.operation?.id ?? null,
      );
      return jsonResponse(200, { ok: true, ...result });
    }

    if (action === "cancel-scheduled") {
      const operation = await service.cancelScheduled({ operationId: String(body.operationId || ""), actor });
      await audit(operation?.status || "unknown", {}, operation?.id ?? null);
      return jsonResponse(200, { ok: true, operation });
    }

    if (action === "reconcile") {
      const operation = await service.getOperationStatus(String(body.operationId || ""), {
        retryMindbodySync: body.retryMindbodySync === true,
      });
      await audit(operation?.status || "unknown", { retryMindbodySync: body.retryMindbodySync === true }, operation?.id ?? null);
      return jsonResponse(200, { ok: true, operation });
    }

    if (action === "prepare-catalog") {
      const toSku = String(body.toSku || "").trim();
      const result = await service.prepareCatalogProduct({ toSku, actor });
      await audit("ok", { toSku, productId: result.productId, created: result.writePerformed === true });
      return jsonResponse(200, { ok: true, result });
    }

    return jsonResponse(400, { ok: false, error: "unknown_action" });
  } catch (e) {
    await audit(e instanceof MembershipChangeError ? e.code : "error", {
      message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
    });
    return errorResponse(e);
  }
}
