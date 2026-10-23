/**
 * Temporary production ops endpoint — Amanda Curry Scenario B upgrade only.
 * Gated: x-admin-token + AMANDA_CURRY_UPGRADE_OPS_ENABLED=1 + hardcoded allowlist in lib.
 *
 * POST/GET ?action= runtime-check | preflight | prepare-product | preview-b | execute | verify
 * Mutations are POST-only except read-only GET for runtime-check/preflight/preview-b.
 */
import { connectLambda, getStore } from "@netlify/blobs";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import {
  createMonthlyMindbodyIO,
  executeMonthlyRenewalSync,
} from "./stripe-monthly-period-sync.mjs";
import {
  AMANDA_CURRY_UPGRADE_CASE,
  amandaExecuteScenarioB,
  amandaPreflight,
  amandaPrepareCatalogProduct,
  amandaPreviewScenarioB,
  amandaVerify,
  createProductionStripe,
  productionStripeSecretPresent,
  runtimeStripeCheck,
  waitForInvoiceSynced,
} from "./stripe-amanda-upgrade-lib.mjs";

const GUARD_STORE = "stripe-ops-execution-guards";
const GUARD_KEY = `amanda_curry_upgrade_${AMANDA_CURRY_UPGRADE_CASE.subscriptionRecordId}`;

function opsEnabled() {
  return (process.env.AMANDA_CURRY_UPGRADE_OPS_ENABLED || "").trim() === "1";
}

/** @param {unknown} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  const headers =
    /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
      if (got.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < got.length; i += 1) {
        mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    }
  }
  return false;
}

/** @param {unknown} event */
function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded
    ? Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8")
    : /** @type {string} */ (e.body);
  try {
    return JSON.parse(typeof raw === "string" ? raw.trim() : String(raw));
  } catch {
    return null;
  }
}

function resolveAction(event) {
  const q = event.queryStringParameters || {};
  const body = event.httpMethod === "POST" ? parseJsonBody(event) : {};
  const action = String(q.action || body?.action || "").trim().toLowerCase();
  return { action, body };
}

function guardStore(event) {
  connectLambda(event);
  return getStore({ name: GUARD_STORE, consistency: "strong" });
}

async function readGuard(store) {
  const row = await store.get(GUARD_KEY, { type: "json" });
  return row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : null;
}

const READ_ACTIONS = new Set(["runtime-check", "preflight", "preview-b"]);
const MUTATION_ACTIONS = new Set(["prepare-product", "execute", "verify"]);

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Headers": "Content-Type, x-admin-token" },
      body: "",
    };
  }

  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const { action } = resolveAction(event);
  if (!action) {
    return jsonResponse(400, { ok: false, error: "missing_action" });
  }

  const isMutation = MUTATION_ACTIONS.has(action);
  if (isMutation && event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "mutation_requires_post", action });
  }
  if (READ_ACTIONS.has(action) && event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (isMutation && !opsEnabled()) {
    return jsonResponse(503, { ok: false, error: "ops_endpoint_disabled", action });
  }

  const subStore = openSubscriptionStore(event);
  if (!subStore.available) {
    return jsonResponse(503, { ok: false, error: "subscription_store_unavailable" });
  }

  try {
    if (action === "runtime-check") {
      const key = productionStripeSecretPresent();
      if (!key.present) {
        return jsonResponse(503, {
          ok: false,
          error: "stripe_live_secret_missing",
          stripeEnv: { mode: key.mode },
          opsEnabled: opsEnabled(),
        });
      }
      const stripe = createProductionStripe();
      const runtime = await runtimeStripeCheck(stripe);
      return jsonResponse(200, {
        ok: true,
        stripeEnv: { mode: "live", configured: true },
        runtime,
        opsEnabled: opsEnabled(),
        case: {
          subscriptionRecordId: AMANDA_CURRY_UPGRADE_CASE.subscriptionRecordId,
          approvedAmountCents: AMANDA_CURRY_UPGRADE_CASE.approvedAmountCents,
          scenario: AMANDA_CURRY_UPGRADE_CASE.approvedScenario,
        },
      });
    }

    const stripe = createProductionStripe();

    if (action === "preflight") {
      const pf = await amandaPreflight(stripe, subStore);
      return jsonResponse(pf.ok || pf.alreadyUpgraded ? 200 : 409, { ok: pf.ok, ...pf });
    }

    if (action === "prepare-product") {
      const result = await amandaPrepareCatalogProduct(stripe);
      return jsonResponse(200, {
        ok: true,
        productionWrite: result.writePerformed === true,
        operation: result.writePerformed ? "products.create" : "products.search_reuse",
        result,
      });
    }

    if (action === "preview-b") {
      const pf = await amandaPreflight(stripe, subStore);
      if (!pf.ok && !pf.alreadyUpgraded) {
        return jsonResponse(409, { ok: false, error: "preflight_failed", preflight: pf });
      }
      if (pf.alreadyUpgraded) {
        return jsonResponse(409, { ok: false, error: "already_upgraded", preflight: pf });
      }
      const preview = await amandaPreviewScenarioB(stripe);
      const approved = preview.amount_due === AMANDA_CURRY_UPGRADE_CASE.approvedAmountCents;
      return jsonResponse(approved ? 200 : 409, {
        ok: approved,
        preview,
        approvedAmountCents: AMANDA_CURRY_UPGRADE_CASE.approvedAmountCents,
      });
    }

    if (action === "execute") {
      const store = guardStore(event);
      const existing = await readGuard(store);
      if (existing?.status === "executed") {
        return jsonResponse(409, {
          ok: false,
          error: "already_executed",
          guard: { status: existing.status, executedAt: existing.executedAt, upgradeInvoiceId: existing.upgradeInvoiceId },
        });
      }

      const claim = await atomicCreateJSON(store, GUARD_KEY, {
        status: "executing",
        startedAt: new Date().toISOString(),
        subscriptionRecordId: AMANDA_CURRY_UPGRADE_CASE.subscriptionRecordId,
      });
      if (!claim.modified) {
        const again = await readGuard(store);
        if (again?.status === "executing") {
          return jsonResponse(409, { ok: false, error: "execution_in_progress", guard: again });
        }
        if (again?.status === "executed") {
          return jsonResponse(409, { ok: false, error: "already_executed", guard: again });
        }
      }

      let execResult;
      try {
        execResult = await amandaExecuteScenarioB(stripe, subStore);
      } catch (e) {
        await store.delete(GUARD_KEY).catch(() => {});
        throw e;
      }

      if (execResult.skipped) {
        await store.delete(GUARD_KEY).catch(() => {});
        return jsonResponse(200, { ok: true, skipped: true, ...execResult });
      }

      const invoiceId = execResult.upgradeInvoice?.id || null;
      let syncWait = null;
      if (invoiceId) {
        syncWait = await waitForInvoiceSynced(subStore, invoiceId);
        if (!syncWait.synced) {
          const record = await subStore.get(AMANDA_CURRY_UPGRADE_CASE.subscriptionRecordId);
          const entry = (record?.invoices || []).find((i) => i.invoiceId === invoiceId);
          const item = getCatalogItem(AMANDA_CURRY_UPGRADE_CASE.targetLocalSku);
          if (record && entry && item && entry.status !== "synced") {
            const liveInv = await stripe.invoices.retrieve(invoiceId, { expand: ["lines.data"] });
            const io = createMonthlyMindbodyIO();
            await executeMonthlyRenewalSync({
              subStore,
              record,
              invoice: liveInv,
              existingEntry: entry,
              item,
              retrieveInvoice: async () => liveInv,
              syncFn: (syncInput) => io.syncFn(syncInput),
              claimAlreadyAcquired: false,
              lostClaim: false,
              discountAmountCents: 0,
            });
            syncWait = await waitForInvoiceSynced(subStore, invoiceId, 8);
          }
        }
      }

      await store.setJSON(GUARD_KEY, {
        status: "executed",
        executedAt: new Date().toISOString(),
        upgradeInvoiceId: invoiceId,
        amountPaidCents: execResult.upgradeInvoice?.amount_paid ?? null,
        syncSynced: syncWait?.synced === true,
        subscriptionRecordId: AMANDA_CURRY_UPGRADE_CASE.subscriptionRecordId,
      });

      const verify = await amandaVerify(stripe, subStore);
      return jsonResponse(200, {
        ok: true,
        execute: execResult,
        syncWait,
        verify,
      });
    }

    if (action === "verify") {
      const verify = await amandaVerify(stripe, subStore);
      return jsonResponse(200, { ok: true, verify });
    }

    return jsonResponse(404, { ok: false, error: "unknown_action", action });
  } catch (e) {
    const code = /** @type {{ code?: string }} */ (e)?.code || "execution_error";
    return jsonResponse(500, {
      ok: false,
      error: code,
      message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
    });
  }
}
