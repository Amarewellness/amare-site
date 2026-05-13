/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook → fulfill one-time Mindbody Service purchases.
 *
 * Source of truth for fulfillment (the success page never fulfills). Handles:
 *  • checkout.session.completed
 *  • checkout.session.async_payment_succeeded
 *  • checkout.session.async_payment_failed
 *  • checkout.session.expired
 *
 * Idempotency: the order store transitions are gated by status, so even if Stripe redelivers
 * the same event many times, only one Mindbody sync ever fires. Once an order reaches
 * `mindbody_synced`, additional webhook deliveries return 200 with `noop: true`.
 *
 * Failures:
 *  • Mindbody sync failed (timeout / transient): order → `sync_failed_retryable`.
 *  • Mindbody sync rejected (business error): order → `paid_but_not_synced` (manual review).
 *  • Multiple email matches → `paid_but_not_synced` with reason `multiple_client_matches`.
 *  • NCS for known existing client (anonymous flow) → `paid_but_not_synced` with reason
 *    `ncs_for_existing_client`.
 *
 * For all paid_but_not_synced cases we still return 200 to Stripe so it stops retrying — the
 * money is captured and the studio reconciles by hand via the admin endpoint. We DO return a
 * non-2xx for transient errors so Stripe retries (with idempotency guarantees protecting us).
 */

import Stripe from "stripe";

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { newOrderId, openOrderStore } from "./stripe-order-store.mjs";
import {
  fetchClientNcsHistory,
  resolveOrCreateMindbodyClient,
  sendNewClientPasswordSetupEmail,
  splitFullName,
  syncOneTimePurchaseToMindbody,
} from "./stripe-mindbody-sync-lib.mjs";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** @param {unknown} event */
function rawBodyAndSignature(event) {
  if (!event || typeof event !== "object") return { raw: "", sig: "" };
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean; headers?: Record<string, unknown> }} */ (event);
  const headers = e.headers || {};
  let sig = "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "stripe-signature") {
      sig = String(headers[k] || "").trim();
      break;
    }
  }
  if (e.body == null) return { raw: "", sig };
  if (e.isBase64Encoded) {
    return { raw: Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8"), sig };
  }
  return { raw: typeof e.body === "string" ? e.body : String(e.body), sig };
}

function stripeSecret() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_")) return null;
  return k;
}

function webhookSecret() {
  const w = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!w.startsWith("whsec_")) return null;
  return w;
}

/**
 * Read `session.custom_fields[]` for the `first_name` + `last_name` text fields we register
 * in `stripe-create-checkout-session.mjs` for anonymous buyers (Option A — only when we
 * don't already have a clean Mindbody profile name). Returns trimmed values bounded at 80
 * chars (matches Mindbody's `addclient` field length we already enforce).
 *
 * @param {Stripe.Checkout.Session} session
 * @returns {{ firstName: string; lastName: string }}
 */
function extractCustomFieldNames(session) {
  /** @type {unknown} */
  const raw = /** @type {{ custom_fields?: unknown }} */ (session).custom_fields;
  if (!Array.isArray(raw)) return { firstName: "", lastName: "" };
  let firstName = "";
  let lastName = "";
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (f);
    const key = typeof o.key === "string" ? o.key : "";
    const t = /** @type {Record<string, unknown> | null} */ (
      o.text && typeof o.text === "object" ? o.text : null
    );
    const value = t && typeof t.value === "string" ? t.value.trim().slice(0, 80) : "";
    if (key === "first_name") firstName = value;
    else if (key === "last_name") lastName = value;
  }
  return { firstName, lastName };
}

/**
 * Resolve the buyer's email + display name + phone for downstream Mindbody calls.
 *
 * Name precedence (highest → lowest):
 *   1. `custom_fields[first_name]` + `custom_fields[last_name]` — collected when the buyer
 *      was anonymous (no Mindbody profile to pre-fill from). These are the cleanest
 *      because we asked explicitly with separate inputs, so Mindbody Identity can match
 *      first+last+email reliably on first sign-in.
 *   2. `customer_details.name` — single string from cardholder / Apple Pay / Link / wallet.
 *      Used for logged-in members (we already have first+last from Mindbody on the order
 *      record, so this name is informational) and as a fallback if custom_fields are
 *      absent for any reason.
 *
 * `firstName` / `lastName` are returned **only** when sourced from custom_fields; the
 * downstream caller decides whether to pass them as authoritative to
 * `resolveOrCreateMindbodyClient` or fall back to `splitFullName(name)`.
 *
 * @param {Stripe.Checkout.Session} session
 */
function safeCustomerDetails(session) {
  const cd = session.customer_details ?? null;
  const { firstName, lastName } = extractCustomFieldNames(session);
  const composedName = `${firstName} ${lastName}`.trim();
  const fallbackName = (cd?.name || "").trim();
  return {
    email: (cd?.email || session.customer_email || "").trim().toLowerCase(),
    name: composedName || fallbackName,
    phone: (cd?.phone || "").trim(),
    firstName,
    lastName,
  };
}

/**
 * Decide what the webhook should do with a Stripe event based on Stripe's `livemode` flag and
 * the operator's `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` env preference.
 *
 * Default behavior is **the safest one**: a Stripe test-mode payment never touches Mindbody.
 * Operators can opt into pipeline rehearsal with `mindbody_test` (Mindbody's own dry-run mode),
 * or full live syncs for staging that uses Stripe test cards but a real Mindbody site (`live`).
 *
 * Defense-in-depth: we treat the event as live ONLY when both the event-level and
 * session-level `livemode` flags say true. Mismatched (Stripe should never produce these but
 * better safe) → treated as test.
 *
 * @param {Stripe.Event} evt
 * @param {Stripe.Checkout.Session | null} session
 * @returns {{ stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean }}
 */
function decideTestModeBehavior(evt, session) {
  const evtLive = evt.livemode === true;
  const sessLive = session && typeof session.livemode === "boolean" ? session.livemode : evtLive;
  const stripeLivemode = evtLive === true && sessLive === true;

  /** Pure live → always real sync. No env override here. */
  if (stripeLivemode) {
    return { stripeLivemode: true, behavior: "live", mindbodyTest: false };
  }

  /** Stripe test-mode event. Apply the operator preference. */
  const raw = (process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR || "skip").trim().toLowerCase();
  if (raw === "live") {
    return { stripeLivemode: false, behavior: "live", mindbodyTest: false };
  }
  if (raw === "mindbody_test" || raw === "mb_test" || raw === "test") {
    return { stripeLivemode: false, behavior: "mindbody_test", mindbodyTest: true };
  }
  return { stripeLivemode: false, behavior: "skip", mindbodyTest: false };
}

/* -------------------------------------------------------------------------- */
/* Fulfillment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Idempotently fulfill one Stripe Checkout Session.
 *
 * @param {Stripe.Checkout.Session} session
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 * @param {{ stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean }} testModeDecision
 * @returns {Promise<{ ok: true; status: string; noop?: boolean } | { ok: false; status: string; reason: string; retryable?: boolean }>}
 */
async function fulfillSession(session, store, testModeDecision) {
  const sessionId = session.id;
  const metadataOrderId = (session.metadata && typeof session.metadata === "object"
    ? /** @type {Record<string, string>} */ (session.metadata).orderId
    : "") || (typeof session.client_reference_id === "string" ? session.client_reference_id : "");

  /** Resolve the order: by metadata first, then by session-index. */
  let order = null;
  if (metadataOrderId) {
    try {
      order = await store.get(metadataOrderId);
    } catch {
      order = null;
    }
  }
  if (!order) {
    order = await store.getByCheckoutSessionId(sessionId);
  }

  /**
   * Recovery path: webhook arrived but order record is missing (e.g., the create-session
   * function returned an error after the Stripe call succeeded, or somebody is replaying old
   * events). We can still try to fulfill from the session metadata — but only if metadata
   * carries enough to identify the SKU.
   */
  if (!order) {
    const sku = session.metadata && session.metadata.localSku;
    if (typeof sku !== "string" || !sku) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_no_order_no_metadata_sku",
          sessionId,
          paymentStatus: session.payment_status,
        }),
      );
      return { ok: false, status: "no_order", reason: "order_missing_and_no_sku_metadata" };
    }
    const item = getCatalogItem(sku);
    if (!item) {
      return { ok: false, status: "no_order", reason: "order_missing_unknown_sku" };
    }
    const recoveredId = metadataOrderId || newOrderId();
    /** @type {import("./stripe-order-store.mjs").OrderRecord} */
    const recovered = {
      orderId: recoveredId,
      localSku: item.localSku,
      amountCents: item.amountCents,
      currency: item.currency,
      stripeCheckoutSessionId: sessionId,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
      mindbodySyncStatus: "checkout_created",
      mindbodyServiceId: item.mindbodyServiceId,
      flow: "stripe_to_mindbody_one_time",
      source: "amare_site_recovered_in_webhook",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.put(recovered, { onlyIfNew: true });
    await store.bindSession(sessionId, recoveredId);
    order = recovered;
  }

  /** Already done — Stripe is just redelivering. */
  if (
    order.mindbodySyncStatus === "mindbody_synced" ||
    order.mindbodySyncStatus === "refunded" ||
    order.mindbodySyncStatus === "test_mode_no_sync"
  ) {
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }

  /** Stripe says paid only if `payment_status === "paid"`. */
  if (session.payment_status !== "paid") {
    await store.patch(order.orderId, {
      stripePaymentStatus: session.payment_status,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : order.stripePaymentIntentId,
    });
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }

  const customer = safeCustomerDetails(session);

  await store.patch(order.orderId, {
    mindbodySyncStatus: "payment_completed",
    stripePaymentStatus: session.payment_status,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : order.stripePaymentIntentId,
    stripeCustomerId: typeof session.customer === "string" ? session.customer : undefined,
    customerEmail: customer.email || order.customerEmail,
    customerName: customer.name || order.customerName,
    /**
     * Persist the explicit first/last from `custom_fields` so the admin retry path
     * (`stripe-admin-orders.mjs`) gets the same clean signal we used here. Without this,
     * a retry would have to fall back to `splitFullName(customerName)`, which mis-splits
     * multi-word first names like "Mary Jane".
     */
    customerFirstName: customer.firstName || order.customerFirstName,
    customerLastName: customer.lastName || order.customerLastName,
    customerPhone: customer.phone || order.customerPhone,
    stripeLivemode: testModeDecision.stripeLivemode,
    mindbodyTestModeBehavior: testModeDecision.behavior,
    syncAttempts: (order.syncAttempts || 0),
  });

  /**
   * SAFETY GATE: Stripe test-mode payment + behavior=skip → never touch Mindbody.
   *
   * This prevents a Stripe test card from creating a real client + service sale on the
   * production Mindbody site. The order is recorded for accounting but no API call is
   * issued. Stripe gets 200 so it stops retrying. Default for `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR`
   * is `skip` precisely so the safe path is opt-out, not opt-in.
   */
  if (!testModeDecision.stripeLivemode && testModeDecision.behavior === "skip") {
    await store.patch(order.orderId, {
      mindbodySyncStatus: "test_mode_no_sync",
      errorCode: "stripe_test_mode_skipped",
      errorMessageSafe:
        "Stripe test-mode payment received. Mindbody sync intentionally skipped (STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip).",
      lastSyncAttemptAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        event: "stripe_order_test_mode_skipped",
        orderId: order.orderId,
        sessionId,
        sku: order.localSku,
        amountCents: order.amountCents,
      }),
    );
    return { ok: true, status: "test_mode_no_sync", noop: false };
  }

  /** Status `paid_but_not_synced` means money in / no Mindbody sync. We still return 200. */
  /** @param {string} reason @param {string=} message */
  async function markPaidButNotSynced(reason, message) {
    /**
     * The Mindbody-supplied message is critical for diagnosing why a sync failed (e.g.
     * "MobilePhone is already in use", "ServiceId not sellable online"). Truncate to keep
     * logs bounded but never drop the field — without it the operator is flying blind.
     */
    const safeMessage = (message || "").slice(0, 480);
    await store.patch(order.orderId, {
      mindbodySyncStatus: "paid_but_not_synced",
      errorCode: reason,
      errorMessageSafe: safeMessage,
      lastSyncAttemptAt: new Date().toISOString(),
      syncAttempts: (order.syncAttempts || 0) + 1,
    });
    console.error(
      JSON.stringify({
        event: "stripe_order_paid_but_not_synced",
        orderId: order.orderId,
        sessionId,
        reason,
        mindbodyMessage: safeMessage || null,
        sku: order.localSku,
        amountCents: order.amountCents,
        mindbodyTestModeBehavior: testModeDecision.behavior,
      }),
    );
  }

  const item = getCatalogItem(order.localSku);
  if (!item) {
    await markPaidButNotSynced("catalog_sku_missing", "Order points at a SKU not in the catalog.");
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  /* ---------------- Resolve Mindbody client ------------------------------- */
  await store.patch(order.orderId, { mindbodySyncStatus: "client_resolving" });

  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  /** @type {Record<string, string> | null} */
  let staffHeaders = null;
  if (staffUser && typeof staffPass === "string" && staffPass !== "") {
    const issued = await getMindbodyStaffAccessTokenCached();
    if (issued.ok) staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
  } else {
    staffHeaders = mindbodyStaffApiHeaders();
  }
  if (!staffHeaders) {
    await markPaidButNotSynced(
      "staff_credentials_unavailable",
      "Mindbody staff token is not configured on the server.",
    );
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  /**
   * Pass `firstName` / `lastName` separately when sourced from Stripe `custom_fields`
   * (anonymous buyer flow). `resolveOrCreateMindbodyClient` will prefer them over
   * splitting `fullName`, which is critical: a clean exact first+last+email match is
   * what allows Mindbody Identity to auto-link the API-created Studio Client on the
   * buyer's first OAuth sign-in (the OAuth callback's auto-merge is the safety net
   * when this still fails).
   */
  const resolved = await resolveOrCreateMindbodyClient(
    {
      knownMindbodyClientId: order.knownMindbodyClientId ?? null,
      email: customer.email || order.customerEmail || "",
      fullName: customer.name || order.customerName || "",
      firstName: customer.firstName || undefined,
      lastName: customer.lastName || undefined,
      phone: customer.phone || order.customerPhone || "",
      mindbodyTest: testModeDecision.mindbodyTest,
    },
    staffHeaders,
  );
  if (!resolved.ok) {
    if (resolved.reason === "multiple_client_matches") {
      await markPaidButNotSynced(
        "multiple_client_matches",
        `Multiple Mindbody clients match this email; staff must reconcile manually (${resolved.candidateCount} matches).`,
      );
      return { ok: true, status: "paid_but_not_synced", noop: false };
    }
    if (resolved.retryable) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "sync_failed_retryable",
        errorCode: resolved.reason,
        errorMessageSafe: resolved.message || "",
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_client_resolve_retryable",
          orderId: order.orderId,
          sessionId,
          reason: resolved.reason,
        }),
      );
      return { ok: false, status: "sync_failed_retryable", reason: resolved.reason, retryable: true };
    }
    /**
     * Mindbody quirk: `client/addclient` does NOT accept `Test: true` — it returns
     * "Test mode is not allowed for this endpoint." This means the `mindbody_test` behavior
     * only validates payloads end-to-end when the buyer is already a known Mindbody client
     * (knownMindbodyClientId path) and addclient is bypassed. For anonymous buyers in
     * `mindbody_test`, we treat this specific failure as `test_mode_no_sync` (same terminal
     * status as `skip` mode) so it does NOT pollute `paid_but_not_synced` dashboards. The
     * order is fully recoverable: re-running the test as a logged-in member, switching to
     * `live` behavior, or simply going to live Stripe keys will succeed.
     */
    const mbMsg = String(resolved.message || "").toLowerCase();
    const isMindbodyTestAddclientUnsupported =
      testModeDecision.mindbodyTest === true &&
      resolved.reason === "addclient_failed" &&
      /test\s+mode\s+is\s+not\s+allowed/.test(mbMsg);
    if (isMindbodyTestAddclientUnsupported) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "test_mode_no_sync",
        errorCode: "mindbody_test_addclient_unsupported",
        errorMessageSafe:
          "Mindbody does not support Test:true on /client/addclient. Use a logged-in buyer for mindbody_test mode, or switch to live Stripe + live Mindbody.",
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_mindbody_test_addclient_unsupported",
          orderId: order.orderId,
          sessionId,
          mindbodyMessage: resolved.message || null,
          hint: "Mindbody refuses Test:true on /client/addclient. Anonymous-buyer flows cannot be dry-run validated end-to-end. Switch buyer to logged-in member, or test with live Stripe keys.",
        }),
      );
      return { ok: true, status: "test_mode_no_sync", noop: false };
    }
    await markPaidButNotSynced(`client_resolve_failed:${resolved.reason}`, resolved.message);
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  await store.patch(order.orderId, {
    mindbodySyncStatus: resolved.clientCreated ? "client_created" : "client_found",
    resolvedMindbodyClientId: resolved.clientId,
    customerEmail: resolved.email || order.customerEmail,
    clientWasNewlyCreated: Boolean(resolved.clientCreated),
  });

  /* ---------------- NCS duplicate check (anonymous flow) ------------------ */
  if (
    item.duplicatePolicy === "block_before_checkout_if_known" &&
    item.oneTimePerClient &&
    !resolved.clientCreated &&
    !order.knownMindbodyClientId
  ) {
    const history = await fetchClientNcsHistory(staffHeaders, resolved.clientId);
    if (history.ok && history.hadNcs) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "paid_but_not_synced",
        errorCode: "ncs_for_existing_client",
        errorMessageSafe:
          "Existing Mindbody client appears to have prior NCS history. Holding for manual review.",
        ncsEligibilityReason: history.evidence.join(" | ").slice(0, 240),
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_ncs_for_existing_client",
          orderId: order.orderId,
          sessionId,
          clientId: resolved.clientId,
        }),
      );
      return { ok: true, status: "paid_but_not_synced", noop: false };
    }
  }

  /* ---------------- Sync the package to Mindbody -------------------------- */
  await store.patch(order.orderId, { mindbodySyncStatus: "mindbody_checkout_started" });

  const sync = await syncOneTimePurchaseToMindbody({
    orderId: order.orderId,
    stripeCheckoutSessionId: sessionId,
    localSku: order.localSku,
    clientId: resolved.clientId,
    amountCents: order.amountCents,
    currency: order.currency,
    mindbodyTest: testModeDecision.mindbodyTest,
    item,
  });

  if (sync.ok) {
    await store.patch(order.orderId, {
      mindbodySyncStatus: "mindbody_synced",
      mindbodySaleId: sync.mindbodySaleId,
      mindbodyTransactionId: sync.mindbodyTransactionId,
      mindbodyResponseSummary: sync.responseSummary,
      mindbodyPaymentMode: sync.mode,
      lastSyncAttemptAt: new Date().toISOString(),
      syncAttempts: (order.syncAttempts || 0) + 1,
      errorCode: undefined,
      errorMessageSafe: undefined,
    });
    console.log(
      JSON.stringify({
        event: "stripe_order_synced_to_mindbody",
        orderId: order.orderId,
        sessionId,
        clientId: resolved.clientId,
        sku: order.localSku,
        mode: sync.mode,
        mbSaleId: sync.mindbodySaleId,
      }),
    );

    /**
     * Anonymous-buyer onboarding — only fires when ALL of these are true:
     *   • A brand-new Mindbody client was created during this checkout (resolved.clientCreated)
     *   • Mindbody package sync just succeeded (we are inside `if (sync.ok)`)
     *   • This is NOT a Stripe-test → Mindbody-Test dry run (would email a real customer for nothing)
     *
     * We trigger Mindbody's own password-setup email so the customer can sign in to book classes.
     * Best-effort: a failure here MUST NOT roll the order back. We patch a structured flag so the
     * success page can fall back to "Use 'Forgot password?' on the sign-in screen" guidance.
     */
    if (resolved.clientCreated && !testModeDecision.mindbodyTest) {
      const split = splitFullName(order.customerName || resolved.email || "");
      const emailRes = await sendNewClientPasswordSetupEmail(staffHeaders, {
        email: resolved.email || order.customerEmail || "",
        firstName: split.first || (order.customerEmail || "").split("@")[0] || "Member",
        lastName: split.last || "",
      });
      if (emailRes.ok) {
        await store.patch(order.orderId, {
          welcomeEmailSent: true,
          welcomeEmailError: null,
        });
        console.log(
          JSON.stringify({
            event: "stripe_order_welcome_email_sent",
            orderId: order.orderId,
            clientId: resolved.clientId,
          }),
        );
      } else {
        await store.patch(order.orderId, {
          welcomeEmailSent: false,
          welcomeEmailError: String(emailRes.error || "unknown").slice(0, 240),
        });
        console.warn(
          JSON.stringify({
            event: "stripe_order_welcome_email_failed",
            orderId: order.orderId,
            clientId: resolved.clientId,
            error: emailRes.error,
            status: "status" in emailRes ? emailRes.status : undefined,
          }),
        );
      }
    }

    return { ok: true, status: "mindbody_synced", noop: false };
  }

  if (sync.retryable) {
    await store.patch(order.orderId, {
      mindbodySyncStatus: "sync_failed_retryable",
      errorCode: sync.reason,
      errorMessageSafe: sync.message || "",
      lastSyncAttemptAt: new Date().toISOString(),
      syncAttempts: (order.syncAttempts || 0) + 1,
    });
    console.error(
      JSON.stringify({
        event: "stripe_order_sync_retryable",
        orderId: order.orderId,
        sessionId,
        reason: sync.reason,
      }),
    );
    return { ok: false, status: "sync_failed_retryable", reason: sync.reason, retryable: true };
  }

  await markPaidButNotSynced(`mindbody_sync_rejected:${sync.reason}`, sync.message);
  return { ok: true, status: "paid_but_not_synced", noop: false };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const sk = stripeSecret();
  const whSecret = webhookSecret();
  if (!sk || !whSecret) {
    console.error(
      JSON.stringify({
        event: "stripe_webhook_misconfigured",
        hasSk: !!sk,
        hasWhSecret: !!whSecret,
      }),
    );
    return jsonResponse(503, { ok: false, error: "stripe_webhook_misconfigured" });
  }

  const { raw, sig } = rawBodyAndSignature(event);
  if (!raw || !sig) {
    return jsonResponse(400, { ok: false, error: "missing_body_or_signature" });
  }

  const stripe = new Stripe(sk, {
    apiVersion: "2025-08-27.basil",
    appInfo: { name: "amare-stripe-mindbody-onetime", version: "0.1.0" },
  });

  /** @type {Stripe.Event} */
  let evt;
  try {
    evt = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_signature_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return jsonResponse(400, { ok: false, error: "signature_verification_failed" });
  }

  const store = openOrderStore(event);
  if (!store.available) {
    /**
     * Without persistence we cannot fulfill safely. Return non-2xx so Stripe retries; if you
     * see this consistently the function is missing Blobs and you must enable it.
     */
    console.error(
      JSON.stringify({
        event: "stripe_webhook_order_store_unavailable",
        eventId: evt.id,
        type: evt.type,
      }),
    );
    return jsonResponse(503, { ok: false, error: "order_store_unavailable" });
  }

  /** Most events are about Checkout Sessions. */
  if (
    evt.type === "checkout.session.completed" ||
    evt.type === "checkout.session.async_payment_succeeded"
  ) {
    /** Re-fetch with expansions — the live session may have more details than the event payload. */
    const sessionFromEvt = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    /** @type {Stripe.Checkout.Session} */
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionFromEvt.id, {
        expand: ["payment_intent", "customer_details"],
      });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_session_retrieve_failed",
          eventId: evt.id,
          sessionId: sessionFromEvt.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
      session = sessionFromEvt;
    }

    const testModeDecision = decideTestModeBehavior(evt, session);
    /** Always log the decision so it shows up next to the event in your function logs. */
    console.log(
      JSON.stringify({
        event: "stripe_webhook_test_mode_decision",
        eventId: evt.id,
        sessionId: session.id,
        eventLivemode: evt.livemode === true,
        sessionLivemode: typeof session.livemode === "boolean" ? session.livemode : null,
        stripeLivemode: testModeDecision.stripeLivemode,
        behavior: testModeDecision.behavior,
        mindbodyTest: testModeDecision.mindbodyTest,
      }),
    );

    /**
     * Informational notice when `mindbody_test` is active. Mindbody's Test:true on
     * checkoutshoppingcart validates the payload without persisting (no Sale row, no Service
     * grant), but it does emit a receipt email at request time. We mitigate that with
     * `SendEmail: false` in the cart payload — but for any history before that fix landed,
     * customers may have received a real-looking receipt for a test-card payment.
     */
    if (testModeDecision.behavior === "mindbody_test") {
      console.log(
        JSON.stringify({
          event: "stripe_webhook_mindbody_test_active",
          eventId: evt.id,
          sessionId: session.id,
          note:
            "STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test. Mindbody validates the cart payload but does NOT persist a Sale or grant Services. SendEmail is set to false on the cart, so no receipt email will be sent in this mode. Returns mock Sale ID; mbSaleId on the order record will be null.",
        }),
      );
    }

    let outcome;
    try {
      outcome = await fulfillSession(session, store, testModeDecision);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_fulfill_threw",
          eventId: evt.id,
          sessionId: session.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return jsonResponse(500, { ok: false, error: "fulfill_exception" });
    }

    if (!outcome.ok && outcome.retryable) {
      return jsonResponse(503, {
        ok: false,
        error: outcome.status,
        reason: outcome.reason,
        retryable: true,
      });
    }
    return jsonResponse(200, {
      received: true,
      type: evt.type,
      orderStatus: outcome.status,
      noop: outcome.ok ? !!outcome.noop : false,
      stripeLivemode: testModeDecision.stripeLivemode,
      mindbodyBehavior: testModeDecision.behavior,
    });
  }

  if (evt.type === "checkout.session.async_payment_failed") {
    const session = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    const order = await store.getByCheckoutSessionId(session.id);
    if (order) {
      await store.patch(order.orderId, {
        stripePaymentStatus: session.payment_status || "failed",
        mindbodySyncStatus: "canceled",
        errorCode: "stripe_async_payment_failed",
      });
    }
    return jsonResponse(200, { received: true, type: evt.type });
  }

  if (evt.type === "checkout.session.expired") {
    const session = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    const order = await store.getByCheckoutSessionId(session.id);
    if (order && order.mindbodySyncStatus === "checkout_created") {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "canceled",
        errorCode: "stripe_session_expired",
      });
    }
    return jsonResponse(200, { received: true, type: evt.type });
  }

  /** Unhandled types — ignore but acknowledge. */
  return jsonResponse(200, { received: true, ignored: true, type: evt.type });
}
