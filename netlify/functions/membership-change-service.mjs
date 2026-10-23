/**
 * Admin membership plan change service (monthly Stripe-managed memberships).
 *
 * Generalizes the completed Amanda Curry upgrade:
 *   • Plan data from the catalog (`membership-change-lib.mjs` → `getCatalogItem`).
 *   • Stripe Product resolved by catalog `localSku` (`stripe-membership-stripe-product-lib.mjs`).
 *   • Existing subscription updated in place (`items[].price_data` + product id).
 *   • Blob `localSku` switched before the paid update so the existing `invoice.paid` webhook
 *     issues the new Mindbody service; scheduled changes switch at the renewal invoice instead.
 *   • Durable ledger + per-subscription lock in Postgres (`membership-change-store.mjs`).
 *
 * All Stripe/customer identifiers come from the trusted SubscriptionRecord, never the caller.
 */
import {
  findActiveStripeProductForLocalSku,
  ensureActiveStripeProductForCatalogSku,
  subscriptionItemPriceDataFromCatalog,
} from "./stripe-membership-stripe-product-lib.mjs";
import {
  BILLING_POLICIES,
  catalogPlan,
  changeDirection,
  evaluateChange,
  listCatalogPlans,
  allowedPoliciesForDirection,
  missingAcknowledgements,
  planFieldsForSku,
  policyTiming,
  readSubscriptionShape,
  signPreviewToken,
  snapshotPlanFields,
  subscriptionBlockers,
  subscriptionFingerprint,
  subscriptionMetadataForSku,
  summarizePreviewInvoice,
  verifyPreviewToken,
  PREVIEW_TOKEN_TTL_MS,
  RENEWAL_GUARD_MS,
} from "./membership-change-lib.mjs";

const SUBSCRIPTION_RECORD_ID_RE = /^sub_amare_[A-Z0-9]{8,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
/** An `executing` row older than this is treated as an interrupted invocation and reconciled. */
const STALE_EXECUTING_MS = 3 * 60 * 1000;
/** A paid change invoice with no webhook sync entry after this long needs attention. */
const WEBHOOK_SYNC_GRACE_MS = 15 * 60 * 1000;

export class MembershipChangeError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.httpStatus = status;
    this.extra = extra;
  }
}

/** @param {unknown} e */
function errMessage(e) {
  return String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 400);
}

/**
 * @param {any} err Stripe SDK error
 * @returns {"authentication_required" | "declined" | "invalid_request" | "uncertain"}
 */
export function classifyStripeUpdateError(err) {
  const type = String(err?.type || err?.rawType || "");
  const code = String(err?.code || err?.raw?.code || "");
  const decline = String(err?.decline_code || err?.raw?.decline_code || "");
  const msg = String(err?.message || "").toLowerCase();
  if (
    code === "authentication_required" ||
    decline === "authentication_required" ||
    code === "subscription_payment_intent_requires_action" ||
    msg.includes("requires_action") ||
    msg.includes("authentication")
  ) {
    return "authentication_required";
  }
  if (type === "StripeCardError" || type === "card_error" || code === "card_declined" || decline) return "declined";
  if (type === "StripeInvalidRequestError" || type === "invalid_request_error") return "invalid_request";
  return "uncertain";
}

/**
 * @param {{
 *   stripe: any,
 *   subStore: ReturnType<import("./stripe-subscription-store.mjs").openSubscriptionStore>,
 *   ledger: any,
 *   io: {
 *     clientServices: (clientId: number) => Promise<any[] | null>,
 *     futureVisits: (clientId: number) => Promise<Array<{ startDateTime: string, name?: string }> | null>,
 *     consentContractProductId: (record: Record<string, any>) => Promise<string | null>,
 *     retryInvoiceSync?: (record: Record<string, any>, invoiceId: string) => Promise<{ status: string }>,
 *   },
 *   previewSecret: string,
 *   flags: { deferredEnabled: boolean },
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   syncWaitMs?: number,
 *   log?: (event: Record<string, unknown>) => void,
 * }} deps
 */
export function createMembershipChangeService(deps) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const syncWaitMs = deps.syncWaitMs ?? 15000;
  const log = deps.log || ((e) => console.log(JSON.stringify(e)));
  const { stripe, subStore, ledger, io } = deps;

  /** @param {string} id */
  async function loadRecord(id) {
    if (!SUBSCRIPTION_RECORD_ID_RE.test(String(id || ""))) {
      throw new MembershipChangeError("invalid_subscription_id", 400, "Invalid membership id.");
    }
    const record = await subStore.get(id);
    if (!record) throw new MembershipChangeError("subscription_not_found", 404, "Membership not found.");
    return /** @type {Record<string, any>} */ (record);
  }

  /** @param {Record<string, any>} record */
  async function loadStripe(record) {
    if (!/^sub_[A-Za-z0-9]+$/.test(String(record.stripeSubscriptionId || ""))) {
      return { sub: null, shape: readSubscriptionShape(null), openInvoiceCount: 0 };
    }
    const sub = await stripe.subscriptions.retrieve(record.stripeSubscriptionId, {
      expand: ["items.data.price"],
    });
    const [open, draft] = await Promise.all([
      stripe.invoices.list({ subscription: sub.id, status: "open", limit: 3 }),
      stripe.invoices.list({ subscription: sub.id, status: "draft", limit: 3 }),
    ]);
    return {
      sub,
      shape: readSubscriptionShape(sub),
      openInvoiceCount: (open?.data?.length || 0) + (draft?.data?.length || 0),
    };
  }

  /**
   * Payment method the immediate update will charge. Returns `{ id: null }` when the
   * subscription already has one (no override needed).
   * @param {any} sub
   */
  async function resolvePaymentMethod(sub) {
    const subPm = typeof sub?.default_payment_method === "string" ? sub.default_payment_method : sub?.default_payment_method?.id;
    if (subPm) return { source: "subscription_default", overrideId: null };
    const customerId = typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id;
    const customer = await stripe.customers.retrieve(customerId);
    const custPm =
      typeof customer?.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : customer?.invoice_settings?.default_payment_method?.id;
    if (custPm) return { source: "customer_default", overrideId: null };
    const cards = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 5 });
    if (cards?.data?.length) return { source: "customer_saved_card", overrideId: cards.data[0].id };
    return { source: "none", overrideId: null };
  }

  /** @param {Record<string, any>} record */
  async function currentPackage(record) {
    const rows = await io.clientServices(Number(record.mindbodyClientId)).catch(() => null);
    if (!rows) return null;
    const serviceId = Number(record.mindbodyServiceId);
    const match = rows
      .filter((r) => Number(r?.ProductId) === serviceId && r?.Current !== false)
      .sort((a, b) => String(b?.PaymentDate || "").localeCompare(String(a?.PaymentDate || "")))[0];
    if (!match) return { remaining: null, unlimited: record.localSku === "monthly_unlimited", expiresAt: null, found: false };
    const remaining = typeof match.Remaining === "number" ? match.Remaining : null;
    return {
      remaining,
      unlimited: record.localSku === "monthly_unlimited" || (remaining != null && remaining >= 9999),
      expiresAt: match.ExpirationDate ?? null,
      found: true,
    };
  }

  /**
   * Reconcile the active operation (if any) before reading or starting a new change.
   * @param {string} subscriptionRecordId
   */
  async function activeOperationReconciled(subscriptionRecordId) {
    const active = await ledger.getActiveOperation(subscriptionRecordId);
    if (!active) return null;
    const after = await reconcileOperation(active).catch((e) => {
      log({ event: "membership_change_reconcile_failed", operationId: active.id, detail: errMessage(e) });
      return active;
    });
    return after && ["executing", "scheduled", "syncing", "needs_reconciliation"].includes(after.status) ? after : null;
  }

  /** @param {string} subscriptionRecordId */
  async function loadContext(subscriptionRecordId) {
    const activeOperation = await activeOperationReconciled(subscriptionRecordId);
    const record = await loadRecord(subscriptionRecordId);
    const { sub, shape, openInvoiceCount } = await loadStripe(record);
    return { record, sub, shape, openInvoiceCount, activeOperation };
  }

  /**
   * @param {Awaited<ReturnType<typeof loadContext>>} ctx
   * @param {string} toSku
   * @param {string} policy
   * @param {{ mindbody?: { pkg: any, visits: any, agreement: any }, productCache?: Map<string, any> }} [pre]
   */
  async function evaluate(ctx, toSku, policy, pre = {}) {
    const mb =
      pre.mindbody ||
      (await (async () => {
        const [pkg, visits, agreementContract] = await Promise.all([
          currentPackage(ctx.record),
          io.futureVisits(Number(ctx.record.mindbodyClientId)).catch(() => null),
          io.consentContractProductId(ctx.record).catch(() => null),
        ]);
        return { pkg, visits, agreement: agreementContract };
      })());
    const target = catalogPlan(toSku);
    let product = null;
    if (target && pre.productCache?.has(toSku)) product = pre.productCache.get(toSku);
    else if (target) {
      product = await findActiveStripeProductForLocalSku(stripe, toSku);
      pre.productCache?.set(toSku, product);
    }
    const subBlockers = subscriptionBlockers({
      record: ctx.record,
      shape: ctx.shape,
      openInvoiceCount: ctx.openInvoiceCount,
      activeOperation: ctx.activeOperation,
    });
    const change = evaluateChange({
      record: ctx.record,
      shape: ctx.shape,
      toSku,
      policy,
      nowMs: now(),
      deferredEnabled: deps.flags.deferredEnabled,
      catalogProductReady: Boolean(product),
      currentPackage: mb.pkg,
      futureVisits: mb.visits,
      targetAgreementOnFile: target ? mb.agreement === String(target.mindbodyContractProductId) : null,
    });
    return {
      ...change,
      blockers: [...subBlockers, ...change.blockers],
      product,
      mindbody: mb,
    };
  }

  /** @param {string} subscriptionRecordId */
  async function getDetails(subscriptionRecordId) {
    const ctx = await loadContext(subscriptionRecordId);
    const { record, shape } = ctx;
    const [pkg, visits, agreement] = await Promise.all([
      currentPackage(record),
      io.futureVisits(Number(record.mindbodyClientId)).catch(() => null),
      io.consentContractProductId(record).catch(() => null),
    ]);
    const mindbody = { pkg, visits, agreement };
    const productCache = new Map();
    const fromSku = String(record.localSku || "");
    const options = [];
    for (const plan of listCatalogPlans()) {
      if (plan.sku === fromSku) continue;
      const direction = changeDirection(fromSku, plan.sku);
      const policies = [];
      for (const policy of direction ? allowedPoliciesForDirection(direction) : []) {
        const ev = await evaluate(ctx, plan.sku, policy, { mindbody, productCache });
        policies.push({
          policy,
          timing: policyTiming(policy),
          label: BILLING_POLICIES[/** @type {keyof typeof BILLING_POLICIES} */ (policy)].label,
          blockers: ev.blockers,
          warnings: ev.warnings,
          available: ev.blockers.length === 0,
        });
      }
      options.push({ ...plan, direction, policies, default: direction === "downgrade" ? "scheduled_no_charge" : "new_cycle_no_credit" });
    }
    const current = catalogPlan(fromSku);
    return {
      membership: {
        subscriptionRecordId: record.id,
        customerName: record.customerName ?? null,
        customerEmail: record.customerEmail ?? null,
        mindbodyClientId: record.mindbodyClientId ?? null,
        localSku: fromSku,
        planName: current?.displayName ?? record.displayName ?? fromSku,
        supported: Boolean(current),
        catalogAmountCents: current?.amountCents ?? null,
        stripeUnitAmountCents: shape.unitAmount,
        recordStatus: record.status,
        stripeStatus: shape.status,
        nextBillingDate: shape.periodEnd,
        currentPeriodStart: shape.periodStart,
        commitmentStartDate: record.commitmentStartDate ?? null,
        commitmentEndDate: record.commitmentEndDate ?? null,
        cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
        paused: Boolean(shape.pauseCollection),
        hasStripeSchedule: Boolean(shape.scheduleId),
        mindbodyPackage: pkg,
        futureBookingCount: Array.isArray(visits) ? visits.length : null,
        pendingPlanChange: record.pendingPlanChange ?? null,
        planChangeHistory: Array.isArray(record.planChangeHistory) ? record.planChangeHistory.slice(-5) : [],
      },
      subscriptionBlockers: subscriptionBlockers({
        record,
        shape,
        openInvoiceCount: ctx.openInvoiceCount,
        activeOperation: ctx.activeOperation,
      }),
      options,
      activeOperation: ctx.activeOperation ? publicOperation(ctx.activeOperation) : null,
      recentOperations: (await ledger.listOperations(record.id, 10)).map(publicOperation),
    };
  }

  /**
   * @param {Awaited<ReturnType<typeof loadContext>>} ctx
   * @param {string} toSku
   * @param {string} policy
   * @param {string} productId
   */
  async function stripePreview(ctx, toSku, policy, productId) {
    const target = catalogPlan(toSku);
    const p = BILLING_POLICIES[/** @type {keyof typeof BILLING_POLICIES} */ (policy)];
    const preview = await stripe.invoices.createPreview({
      customer: ctx.shape.customerId,
      subscription: ctx.shape.id,
      subscription_details: {
        items: [{ id: ctx.shape.itemId, price_data: subscriptionItemPriceDataFromCatalog(target, productId) }],
        proration_behavior: p.stripe.proration_behavior,
        billing_cycle_anchor: p.stripe.billing_cycle_anchor,
      },
    });
    return summarizePreviewInvoice(preview, {
      targetProductId: productId,
      currentProductId: ctx.shape.productId,
      currentPriceId: ctx.shape.priceId,
      policy,
    });
  }

  /**
   * @param {{ subscriptionRecordId: string, toSku: string, policy: string }} input
   */
  async function preview(input) {
    const ctx = await loadContext(input.subscriptionRecordId);
    const ev = await evaluate(ctx, input.toSku, input.policy);
    const target = catalogPlan(input.toSku);
    const current = catalogPlan(String(ctx.record.localSku || ""));
    const base = {
      subscriptionRecordId: ctx.record.id,
      fromSku: ctx.record.localSku,
      fromPlanName: current?.displayName ?? ctx.record.localSku,
      toSku: input.toSku,
      toPlanName: target?.displayName ?? input.toSku,
      policy: input.policy,
      timing: ev.timing,
      direction: ev.direction,
      warnings: ev.warnings,
      blockers: [...ev.blockers],
    };
    if (ev.blockers.length || !target || !ev.product) return { ok: false, ...base };

    let pm = { source: "subscription_default", overrideId: null };
    /** @type {Record<string, unknown>} */
    let billing;
    if (ev.timing === "immediate") {
      pm = await resolvePaymentMethod(ctx.sub);
      if (pm.source === "none") {
        base.blockers.push({ code: "no_payment_method", message: "No saved card on the Stripe customer." });
      }
      const summary = await stripePreview(ctx, input.toSku, input.policy, ev.product.id);
      if (!summary.hasTargetLine) {
        base.blockers.push({ code: "preview_missing_target_line", message: "Stripe preview has no line for the new plan." });
      }
      if (summary.unexpectedLines.length) {
        base.blockers.push({
          code: "unexpected_invoice_lines",
          message: `Stripe preview contains unexpected charges: ${summary.unexpectedLines.join("; ")}. Clear pending invoice items first.`,
        });
      }
      if (summary.amountDueCents <= 0) {
        base.blockers.push({ code: "non_positive_charge", message: "This change would not collect a payment; use a scheduled change." });
      }
      if (summary.startingBalanceCents !== 0) {
        base.warnings.push({
          code: "customer_balance_applied",
          message: `Customer Stripe balance of $${(summary.startingBalanceCents / 100).toFixed(2)} is applied to this invoice.`,
        });
      }
      billing = {
        chargeTodayCents: summary.amountDueCents,
        subtotalCents: summary.subtotalCents,
        creditCents: summary.creditCents,
        discountCents: summary.discountCents,
        taxCents: summary.taxCents,
        lines: summary.lines,
        effectiveAt: summary.targetLinePeriodStart || new Date(now()).toISOString(),
        newPeriodStart: summary.targetLinePeriodStart,
        newPeriodEnd: summary.targetLinePeriodEnd,
        nextRenewalAmountCents: target.amountCents,
        nextRenewalDate: summary.targetLinePeriodEnd,
        paymentMethodSource: pm.source,
      };
    } else {
      billing = {
        chargeTodayCents: 0,
        subtotalCents: 0,
        creditCents: 0,
        discountCents: 0,
        taxCents: 0,
        lines: [],
        effectiveAt: ctx.shape.periodEnd,
        newPeriodStart: ctx.shape.periodEnd,
        newPeriodEnd: null,
        nextRenewalAmountCents: target.amountCents,
        nextRenewalDate: ctx.shape.periodEnd,
        paymentMethodSource: "renewal_default",
      };
    }
    const commitmentImpact = ctx.record.commitmentEndDate
      ? `Commitment end date ${String(ctx.record.commitmentEndDate).slice(0, 10)} stays the same.`
      : "No commitment date on record; nothing changes.";
    const mindbodyImpact =
      ev.timing === "immediate"
        ? `After the payment is confirmed, Mindbody gets one ${target.displayName} package (service ${target.mindbodyServiceId}) starting today. The current ${current?.displayName ?? "package"} stays until it expires.`
        : `${current?.displayName ?? "Current package"} stays active until ${String(ctx.shape.periodEnd).slice(0, 10)}. At that renewal Mindbody gets ${target.displayName} (service ${target.mindbodyServiceId}) instead.`;

    if (base.blockers.length) return { ok: false, ...base, billing, commitmentImpact, mindbodyImpact };

    const issuedAt = now();
    const fingerprint = subscriptionFingerprint(ctx.shape, ctx.record);
    const ackRequired = ev.warnings.filter((w) => w.ackRequired).map((w) => w.code);
    const token = signPreviewToken(
      {
        sid: ctx.record.id,
        toSku: input.toSku,
        policy: input.policy,
        timing: ev.timing,
        amountDueCents: billing.chargeTodayCents,
        fingerprint,
        productId: ev.product.id,
        ackRequired,
        iat: issuedAt,
        exp: issuedAt + PREVIEW_TOKEN_TTL_MS,
      },
      deps.previewSecret,
    );
    return {
      ok: true,
      ...base,
      billing,
      commitmentImpact,
      mindbodyImpact,
      ackRequired,
      previewToken: token,
      previewExpiresAt: new Date(issuedAt + PREVIEW_TOKEN_TTL_MS).toISOString(),
    };
  }

  /**
   * @param {{
   *   previewToken: string,
   *   confirmAmountCents: number,
   *   requestId: string,
   *   actor: { id: string, role: string },
   *   acknowledgements?: Record<string, unknown>,
   * }} input
   */
  async function execute(input) {
    const verified = verifyPreviewToken(input.previewToken, deps.previewSecret, now());
    if (!verified.ok) {
      throw new MembershipChangeError(
        verified.reason === "expired" ? "preview_expired" : "invalid_preview",
        409,
        verified.reason === "expired" ? "The preview expired. Preview again." : "Invalid preview. Preview again.",
      );
    }
    if (!REQUEST_ID_RE.test(String(input.requestId || ""))) {
      throw new MembershipChangeError("invalid_request_id", 400, "Missing request id.");
    }
    const prior = await ledger.getOperationByRequestId(input.requestId);
    if (prior) return { duplicate: true, operation: publicOperation(prior) };

    const tok = verified.payload;
    if (!Number.isInteger(input.confirmAmountCents) || input.confirmAmountCents !== tok.amountDueCents) {
      throw new MembershipChangeError("amount_not_confirmed", 409, "Confirmed amount does not match the preview.");
    }
    const ctx = await loadContext(tok.sid);
    const fingerprint = subscriptionFingerprint(ctx.shape, ctx.record);
    if (fingerprint !== tok.fingerprint) {
      throw new MembershipChangeError("stale_preview", 409, "The membership changed since the preview. Preview again.");
    }
    const ev = await evaluate(ctx, tok.toSku, tok.policy);
    if (ev.blockers.length) {
      throw new MembershipChangeError("change_blocked", 409, ev.blockers[0].message, { blockers: ev.blockers });
    }
    if (!ev.product || ev.product.id !== tok.productId) {
      throw new MembershipChangeError("stale_preview", 409, "Stripe product changed since the preview. Preview again.");
    }
    const acknowledgements = input.acknowledgements && typeof input.acknowledgements === "object" ? input.acknowledgements : {};
    const missing = missingAcknowledgements(ev.warnings, acknowledgements);
    if (missing.length) {
      throw new MembershipChangeError("acknowledgement_required", 409, "Confirm every highlighted warning first.", { missing });
    }

    let pm = { source: "renewal_default", overrideId: null };
    if (ev.timing === "immediate") {
      pm = await resolvePaymentMethod(ctx.sub);
      if (pm.source === "none") throw new MembershipChangeError("no_payment_method", 409, "No saved card on the Stripe customer.");
      const fresh = await stripePreview(ctx, tok.toSku, tok.policy, ev.product.id);
      if (fresh.amountDueCents !== tok.amountDueCents || fresh.unexpectedLines.length) {
        throw new MembershipChangeError("stale_preview", 409, "Stripe now quotes a different amount. Preview again.", {
          previewAmountCents: tok.amountDueCents,
          currentAmountCents: fresh.amountDueCents,
        });
      }
    }

    const target = catalogPlan(tok.toSku);
    const inserted = await ledger.insertOperation({
      requestId: input.requestId,
      subscriptionRecordId: ctx.record.id,
      stripeSubscriptionId: ctx.shape.id,
      stripeCustomerId: ctx.shape.customerId,
      mindbodyClientId: Number(ctx.record.mindbodyClientId) || null,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      fromSku: ctx.record.localSku,
      toSku: tok.toSku,
      direction: ev.direction,
      timing: ev.timing,
      billingPolicy: tok.policy,
      previewAmountCents: tok.amountDueCents,
      previewFingerprint: tok.fingerprint,
      previewCreatedAt: new Date(tok.iat).toISOString(),
      targetAmountCents: target.amountCents,
      effectiveAt: ev.effectiveAt,
      status: "executing",
      warnings: ev.warnings.map((w) => w.code),
      acknowledgements,
    });
    if (!inserted.created) {
      if (inserted.reason === "request_id_exists") return { duplicate: true, operation: publicOperation(inserted.operation) };
      throw new MembershipChangeError("operation_in_progress", 409, "Another plan change is already in progress for this membership.", {
        operation: inserted.operation ? publicOperation(inserted.operation) : null,
      });
    }
    const op = inserted.operation;
    log({
      event: "membership_change_started",
      operationId: op.id,
      subscriptionRecordId: op.subscriptionRecordId,
      actorId: op.actorId,
      fromSku: op.fromSku,
      toSku: op.toSku,
      policy: op.billingPolicy,
      previewAmountCents: op.previewAmountCents,
    });
    const result =
      ev.timing === "immediate"
        ? await executeImmediate(op, ctx, ev.product.id, pm.overrideId)
        : await executeScheduled(op, ctx, ev.product.id);
    return { duplicate: false, operation: publicOperation(result || (await ledger.getOperation(op.id))) };
  }

  /**
   * @param {any} op
   * @param {Awaited<ReturnType<typeof loadContext>>} ctx
   * @param {string} productId
   * @param {string | null} paymentMethodOverride
   */
  async function executeImmediate(op, ctx, productId, paymentMethodOverride) {
    const record = ctx.record;
    const target = catalogPlan(op.toSku);
    const policy = BILLING_POLICIES[/** @type {keyof typeof BILLING_POLICIES} */ (op.billingPolicy)];
    const previous = snapshotPlanFields(record);
    const startedAt = new Date(now()).toISOString();

    const patched = await subStore.patch(record.id, {
      ...planFieldsForSku(op.toSku),
      planChangeInFlight: { operationId: op.id, fromSku: op.fromSku, toSku: op.toSku, startedAt, previous },
    });
    if (!patched) {
      return ledger.updateOperation(
        op.id,
        { status: "failed", errorCode: "blob_patch_failed", errorMessage: "Could not update the membership record. Nothing was charged." },
        { expectStatuses: ["executing"] },
      );
    }

    const idempotencyKey = `amare-mc-${op.id}`;
    await ledger.updateOperation(op.id, { stripeProductId: productId, stripeIdempotencyKey: idempotencyKey });

    let updated;
    try {
      updated = await stripe.subscriptions.update(
        ctx.shape.id,
        {
          items: [{ id: ctx.shape.itemId, price_data: subscriptionItemPriceDataFromCatalog(target, productId) }],
          proration_behavior: policy.stripe.proration_behavior,
          billing_cycle_anchor: "now",
          payment_behavior: "error_if_incomplete",
          metadata: subscriptionMetadataForSku(ctx.shape.metadata, op.toSku, { operationId: op.id }),
          ...(paymentMethodOverride ? { default_payment_method: paymentMethodOverride } : {}),
          expand: ["latest_invoice", "items.data.price"],
        },
        { idempotencyKey },
      );
    } catch (err) {
      return handleImmediateError(op, err, productId);
    }
    return finalizeImmediate(op, updated);
  }

  /**
   * @param {any} op
   * @param {any} err
   * @param {string} productId
   */
  async function handleImmediateError(op, err, productId) {
    const kind = classifyStripeUpdateError(err);
    log({ event: "membership_change_stripe_error", operationId: op.id, kind, detail: errMessage(err) });
    const inspected = await inspectApplied(op, productId);
    if (inspected.state === "applied") return finalizeImmediate(op, inspected.sub);
    if (inspected.state === "unknown" || kind === "uncertain") {
      return ledger.updateOperation(
        op.id,
        {
          status: "needs_reconciliation",
          errorCode: `stripe_${kind}`,
          errorMessage: errMessage(err),
          recoveryNote: "Stripe outcome uncertain. Status checks re-read Stripe; nothing is retried automatically.",
        },
        { expectStatuses: ["executing"] },
      );
    }
    const rolledBack = await rollbackRecord(op);
    if (!rolledBack.ok) {
      return ledger.updateOperation(
        op.id,
        {
          status: "needs_reconciliation",
          errorCode: "record_rollback_blocked",
          errorMessage: `${errMessage(err)} | ${rolledBack.reason}`,
          recoveryNote: "Stripe did not apply the change but the AMARÉ record could not be restored safely.",
        },
        { expectStatuses: ["executing"] },
      );
    }
    const paymentProblem = kind === "authentication_required" || kind === "declined";
    return ledger.updateOperation(
      op.id,
      {
        status: paymentProblem ? "payment_required" : "failed",
        errorCode: kind === "authentication_required" ? "payment_requires_authentication" : kind === "declined" ? "payment_declined" : "stripe_rejected",
        errorMessage:
          kind === "authentication_required"
            ? "The card requires customer authentication (3D Secure). No change was applied and nothing was charged. Ask the customer to update their card or pay in person."
            : kind === "declined"
              ? `The card was declined (${errMessage(err)}). No change was applied and nothing was charged.`
              : `Stripe rejected the change: ${errMessage(err)}. Nothing was charged.`,
        completedAt: new Date(now()).toISOString(),
      },
      { expectStatuses: ["executing", "needs_reconciliation"] },
    );
  }

  /**
   * Read Stripe to decide whether the plan change landed.
   * @param {any} op
   * @param {string | null} productId
   * @returns {Promise<{ state: "applied" | "not_applied" | "unknown", sub?: any }>}
   */
  async function inspectApplied(op, productId) {
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(op.stripeSubscriptionId, { expand: ["latest_invoice", "items.data.price"] });
    } catch {
      return { state: "unknown" };
    }
    const shape = readSubscriptionShape(sub);
    const target = catalogPlan(op.toSku);
    const productOk = productId ? shape.productId === productId : true;
    const applied =
      productOk &&
      shape.unitAmount === target.amountCents &&
      shape.metadata?.lastPlanChangeOperationId === op.id;
    return { state: applied ? "applied" : "not_applied", sub };
  }

  /**
   * Restore the pre-change plan fields, only while this operation still owns the in-flight marker
   * and no invoice has synced against the new plan.
   * @param {any} op
   */
  async function rollbackRecord(op) {
    const record = await subStore.get(op.subscriptionRecordId);
    if (!record) return { ok: false, reason: "record_missing" };
    const inflight = record.planChangeInFlight;
    if (!inflight || inflight.operationId !== op.id) {
      return { ok: record.localSku === op.fromSku, reason: "no_inflight_marker" };
    }
    const startedMs = Date.parse(String(inflight.startedAt || ""));
    const syncedSince = (record.invoices || []).some(
      (e) =>
        e &&
        (e.status === "synced" || e.checkoutRequestSentAt) &&
        Date.parse(String(e.firstAttemptAt || e.paidAt || "")) >= startedMs,
    );
    if (syncedSince) return { ok: false, reason: "invoice_synced_after_change_started" };
    const prev = inflight.previous || {};
    const restored = await subStore.patch(op.subscriptionRecordId, {
      localSku: prev.localSku,
      displayName: prev.displayName,
      monthlyAmountCents: prev.monthlyAmountCents,
      mindbodyServiceId: prev.mindbodyServiceId,
      mindbodyContractProductId: prev.mindbodyContractProductId,
      earlyCancellationFeeCents: prev.earlyCancellationFeeCents,
      planChangeInFlight: null,
    });
    return restored ? { ok: true, reason: null } : { ok: false, reason: "patch_failed" };
  }

  /**
   * @param {any} op
   * @param {any} sub Stripe subscription after the update (latest_invoice expanded)
   */
  async function finalizeImmediate(op, sub) {
    const shape = readSubscriptionShape(sub);
    let invoice = sub?.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    if (!invoice && shape.latestInvoiceId) {
      invoice = await stripe.invoices.retrieve(shape.latestInvoiceId).catch(() => null);
    }
    const paid = invoice?.status === "paid" && Number(invoice?.amount_paid) > 0;
    const record = await subStore.get(op.subscriptionRecordId);
    const history = Array.isArray(record?.planChangeHistory) ? record.planChangeHistory : [];
    const alreadyLogged = history.some((h) => h?.operationId === op.id);
    await subStore.patch(op.subscriptionRecordId, {
      ...planFieldsForSku(op.toSku),
      currentPeriodStart: shape.periodStart,
      currentPeriodEnd: shape.periodEnd,
      planChangeInFlight: null,
      ...(alreadyLogged
        ? {}
        : {
            planChangeHistory: [
              ...history,
              {
                operationId: op.id,
                fromSku: op.fromSku,
                toSku: op.toSku,
                timing: "immediate",
                billingPolicy: op.billingPolicy,
                appliedAt: new Date(now()).toISOString(),
                invoiceId: invoice?.id ?? null,
                amountPaidCents: invoice?.amount_paid ?? null,
                actorId: op.actorId,
              },
            ].slice(-20),
          }),
    });
    const next = await ledger.updateOperation(
      op.id,
      {
        status: paid ? "syncing" : "needs_reconciliation",
        stripeInvoiceId: invoice?.id ?? null,
        stripePriceId: shape.priceId,
        stripePaymentIntentId: typeof invoice?.payment_intent === "string" ? invoice.payment_intent : null,
        amountChargedCents: paid ? Number(invoice.amount_paid) : null,
        effectiveAt: shape.periodStart,
        ...(paid
          ? {}
          : {
              errorCode: "change_applied_invoice_not_paid",
              errorMessage: `Stripe applied the change but invoice ${invoice?.id ?? "?"} is ${invoice?.status ?? "unknown"}.`,
            }),
      },
      { expectStatuses: ["executing", "needs_reconciliation"] },
    );
    log({
      event: "membership_change_stripe_applied",
      operationId: op.id,
      invoiceId: invoice?.id ?? null,
      amountPaidCents: invoice?.amount_paid ?? null,
      paid,
    });
    if (!next || next.status !== "syncing") return next || (await ledger.getOperation(op.id));
    return waitForSync(next);
  }

  /** @param {any} op */
  async function waitForSync(op) {
    const deadline = now() + syncWaitMs;
    let cur = op;
    for (;;) {
      cur = (await verifySync(cur)) || (await ledger.getOperation(op.id)) || cur;
      if (cur.status !== "syncing" || now() >= deadline) return cur;
      await sleep(2500);
    }
  }

  /**
   * Payment is confirmed; completion requires the webhook's Mindbody sale for this invoice and
   * the new service visible on the client.
   * @param {any} op
   * @param {{ retryMindbodySync?: boolean }} [opts]
   */
  async function verifySync(op, opts = {}) {
    if (!op.stripeInvoiceId) return op;
    const record = await subStore.get(op.subscriptionRecordId);
    const entry = (record?.invoices || []).find((e) => e && e.invoiceId === op.stripeInvoiceId) || null;
    const target = catalogPlan(op.toSku);
    if (!entry) {
      const since = Date.parse(String(op.effectiveAt || op.updatedAt || ""));
      if (Number.isFinite(since) && now() - since > WEBHOOK_SYNC_GRACE_MS && op.status === "syncing") {
        return ledger.updateOperation(
          op.id,
          {
            status: "needs_reconciliation",
            errorCode: "webhook_not_received",
            errorMessage: `No Mindbody sync recorded for invoice ${op.stripeInvoiceId} yet. Payment is confirmed.`,
          },
          { expectStatuses: ["syncing"] },
        );
      }
      return op;
    }
    if (entry.status === "test_mode_no_sync") {
      return ledger.updateOperation(
        op.id,
        { status: "completed", recoveryNote: "Stripe test mode: Mindbody sync intentionally skipped.", completedAt: new Date(now()).toISOString() },
        { expectStatuses: ["syncing", "needs_reconciliation"] },
      );
    }
    if (entry.status === "paid_but_not_synced") {
      if (opts.retryMindbodySync && io.retryInvoiceSync) {
        const outcome = await io.retryInvoiceSync(record, op.stripeInvoiceId);
        log({ event: "membership_change_retry_sync", operationId: op.id, status: outcome.status });
        const again = await ledger.getOperation(op.id);
        return verifySync(again || op);
      }
      return ledger.updateOperation(
        op.id,
        {
          status: "needs_reconciliation",
          errorCode: "mindbody_sync_failed",
          errorMessage: entry.lastErrorMessage || entry.lastError || "Mindbody sync failed after payment.",
          recoveryNote: "Payment is confirmed. Use “Retry Mindbody sync” — it never charges again.",
        },
        { expectStatuses: ["syncing", "needs_reconciliation"] },
      );
    }
    if (entry.status !== "synced" || !entry.mindbodySaleId) return op;

    const rows = await io.clientServices(Number(record.mindbodyClientId)).catch(() => null);
    if (!rows) return op;
    const effectiveDay = String(op.effectiveAt || "").slice(0, 10);
    const svc = rows.find(
      (r) =>
        Number(r?.ProductId) === Number(target.mindbodyServiceId) &&
        (!effectiveDay || String(r?.PaymentDate || "").slice(0, 10) >= shiftDay(effectiveDay, -1)),
    );
    if (!svc) {
      return ledger.updateOperation(
        op.id,
        {
          status: "needs_reconciliation",
          mindbodySaleId: String(entry.mindbodySaleId),
          errorCode: "mindbody_service_not_visible",
          errorMessage: `Mindbody sale ${entry.mindbodySaleId} is recorded but service ${target.mindbodyServiceId} is not visible on the client.`,
        },
        { expectStatuses: ["syncing", "needs_reconciliation"] },
      );
    }
    return ledger.updateOperation(
      op.id,
      {
        status: "completed",
        mindbodySaleId: String(entry.mindbodySaleId),
        mindbodyClientServiceId: svc.Id != null ? String(svc.Id) : null,
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(now()).toISOString(),
      },
      { expectStatuses: ["syncing", "needs_reconciliation"] },
    );
  }

  /**
   * @param {any} op
   * @param {Awaited<ReturnType<typeof loadContext>>} ctx
   * @param {string} productId
   */
  async function executeScheduled(op, ctx, productId) {
    const target = catalogPlan(op.toSku);
    const keyBase = `amare-mc-${op.id}`;
    await ledger.updateOperation(op.id, { stripeProductId: productId, stripeIdempotencyKey: keyBase });
    let schedule;
    try {
      schedule = await stripe.subscriptionSchedules.create(
        { from_subscription: ctx.shape.id },
        { idempotencyKey: `${keyBase}-create` },
      );
    } catch (err) {
      return ledger.updateOperation(
        op.id,
        { status: "failed", errorCode: "stripe_schedule_create_failed", errorMessage: errMessage(err), completedAt: new Date(now()).toISOString() },
        { expectStatuses: ["executing"] },
      );
    }
    await ledger.updateOperation(op.id, { stripeScheduleId: schedule.id });
    const phase0 = schedule.phases?.[0];
    try {
      if (!phase0) throw new Error("schedule_has_no_current_phase");
      const currentItems = (phase0.items || []).map((it) => ({
        price: typeof it.price === "string" ? it.price : it.price?.id,
        quantity: it.quantity ?? 1,
      }));
      await stripe.subscriptionSchedules.update(
        schedule.id,
        {
          end_behavior: "release",
          phases: [
            {
              items: currentItems,
              start_date: phase0.start_date,
              end_date: phase0.end_date,
              proration_behavior: "none",
              metadata: ctx.shape.metadata,
            },
            {
              items: [{ price_data: subscriptionItemPriceDataFromCatalog(target, productId), quantity: 1 }],
              duration: { interval: "month", interval_count: 1 },
              proration_behavior: "none",
              metadata: subscriptionMetadataForSku(ctx.shape.metadata, op.toSku, { operationId: op.id }),
            },
          ],
        },
        { idempotencyKey: `${keyBase}-phases` },
      );
    } catch (err) {
      const released = await stripe.subscriptionSchedules.release(schedule.id).then(
        () => true,
        () => false,
      );
      return ledger.updateOperation(
        op.id,
        {
          status: released ? "failed" : "needs_reconciliation",
          errorCode: "stripe_schedule_update_failed",
          errorMessage: errMessage(err),
          recoveryNote: released ? "Schedule released; subscription unchanged." : "Schedule could not be released — release it in Stripe.",
          ...(released ? { completedAt: new Date(now()).toISOString() } : {}),
        },
        { expectStatuses: ["executing"] },
      );
    }
    const effectiveAt = phase0.end_date ? new Date(phase0.end_date * 1000).toISOString() : ctx.shape.periodEnd;
    const patched = await subStore.patch(op.subscriptionRecordId, {
      pendingPlanChange: {
        operationId: op.id,
        fromSku: op.fromSku,
        toSku: op.toSku,
        effectiveAt,
        scheduleId: schedule.id,
        actorId: op.actorId,
        createdAt: new Date(now()).toISOString(),
      },
    });
    if (!patched) {
      await stripe.subscriptionSchedules.release(schedule.id).catch(() => null);
      return ledger.updateOperation(
        op.id,
        { status: "needs_reconciliation", errorCode: "blob_patch_failed", errorMessage: "Schedule created but the record could not be marked; schedule release attempted." },
        { expectStatuses: ["executing"] },
      );
    }
    log({ event: "membership_change_scheduled", operationId: op.id, scheduleId: schedule.id, effectiveAt });
    return ledger.updateOperation(
      op.id,
      { status: "scheduled", effectiveAt, stripeScheduleId: schedule.id },
      { expectStatuses: ["executing"] },
    );
  }

  /**
   * @param {{ operationId: string, actor: { id: string } }} input
   */
  async function cancelScheduled(input) {
    const op = await ledger.getOperation(input.operationId);
    if (!op) throw new MembershipChangeError("operation_not_found", 404, "Operation not found.");
    if (op.status !== "scheduled") {
      throw new MembershipChangeError("not_cancelable", 409, `Only scheduled changes can be canceled (status: ${op.status}).`);
    }
    const effMs = Date.parse(String(op.effectiveAt || ""));
    if (Number.isFinite(effMs) && effMs - now() < RENEWAL_GUARD_MS) {
      throw new MembershipChangeError("too_close_to_renewal", 409, "The renewal is less than 2 hours away; the change can no longer be canceled here.");
    }
    const record = await subStore.get(op.subscriptionRecordId);
    if (!record?.pendingPlanChange || record.pendingPlanChange.operationId !== op.id) {
      throw new MembershipChangeError("pending_marker_missing", 409, "The record no longer carries this pending change. Reconcile first.");
    }
    if (op.stripeScheduleId) {
      const schedule = await stripe.subscriptionSchedules.retrieve(op.stripeScheduleId);
      if (schedule.status === "active" || schedule.status === "not_started") {
        await stripe.subscriptionSchedules.release(op.stripeScheduleId, {}, { idempotencyKey: `amare-mc-${op.id}-release` });
      }
    }
    const sub = await stripe.subscriptions.retrieve(op.stripeSubscriptionId, { expand: ["items.data.price"] });
    const shape = readSubscriptionShape(sub);
    if (shape.unitAmount === catalogPlan(op.toSku).amountCents && shape.metadata?.lastPlanChangeOperationId === op.id) {
      throw new MembershipChangeError("already_transitioned", 409, "Stripe already switched the plan; it can no longer be canceled.");
    }
    await subStore.patch(op.subscriptionRecordId, { pendingPlanChange: null });
    log({ event: "membership_change_canceled", operationId: op.id, actorId: input.actor.id });
    return publicOperation(
      await ledger.updateOperation(
        op.id,
        { status: "canceled", recoveryNote: `Canceled by ${input.actor.id}`, completedAt: new Date(now()).toISOString() },
        { expectStatuses: ["scheduled"] },
      ),
    );
  }

  /**
   * Bring an active operation forward to its true state. Never creates a charge.
   * @param {any} op
   * @param {{ retryMindbodySync?: boolean }} [opts]
   */
  async function reconcileOperation(op, opts = {}) {
    if (op.status === "syncing") return verifySync(op, opts);
    if (op.status === "executing" || op.status === "needs_reconciliation") {
      if (op.stripeInvoiceId) return verifySync(op, opts);
      const ageMs = now() - Date.parse(String(op.updatedAt || op.createdAt || ""));
      if (op.status === "executing" && !(ageMs > STALE_EXECUTING_MS)) return op;
      if (op.timing === "next_cycle") return op;
      const inspected = await inspectApplied(op, op.stripeProductId);
      if (inspected.state === "applied") return finalizeImmediate(op, inspected.sub);
      if (inspected.state === "unknown") return op;
      if (!(ageMs > STALE_EXECUTING_MS)) return op;
      const rolledBack = await rollbackRecord(op);
      if (!rolledBack.ok) {
        return ledger.updateOperation(
          op.id,
          { status: "needs_reconciliation", errorCode: "record_rollback_blocked", errorMessage: rolledBack.reason },
          { expectStatuses: ["executing", "needs_reconciliation"] },
        );
      }
      return ledger.updateOperation(
        op.id,
        {
          status: "failed",
          errorCode: op.errorCode || "not_applied",
          recoveryNote: "Stripe shows the change was never applied; the record was restored. Nothing was charged.",
          completedAt: new Date(now()).toISOString(),
        },
        { expectStatuses: ["executing", "needs_reconciliation"] },
      );
    }
    if (op.status === "scheduled") {
      const record = await subStore.get(op.subscriptionRecordId);
      const appliedEntry = (record?.planChangeHistory || []).find((h) => h?.operationId === op.id);
      if (appliedEntry && record.localSku === op.toSku) {
        const syncing = await ledger.updateOperation(
          op.id,
          { status: "syncing", stripeInvoiceId: appliedEntry.transitionInvoiceId ?? null },
          { expectStatuses: ["scheduled"] },
        );
        return syncing ? verifySync(syncing, opts) : op;
      }
      const effMs = Date.parse(String(op.effectiveAt || ""));
      if (Number.isFinite(effMs) && now() > effMs + 24 * 60 * 60 * 1000) {
        return ledger.updateOperation(
          op.id,
          {
            status: "needs_reconciliation",
            errorCode: "scheduled_change_not_applied",
            errorMessage: "The renewal date passed without a matching paid renewal invoice. Check the Stripe schedule and renewal payment.",
          },
          { expectStatuses: ["scheduled"] },
        );
      }
      return op;
    }
    return op;
  }

  /**
   * @param {string} operationId
   * @param {{ retryMindbodySync?: boolean }} [opts]
   */
  async function getOperationStatus(operationId, opts = {}) {
    const op = await ledger.getOperation(operationId);
    if (!op) throw new MembershipChangeError("operation_not_found", 404, "Operation not found.");
    const after = ["executing", "syncing", "needs_reconciliation", "scheduled"].includes(op.status)
      ? await reconcileOperation(op, opts)
      : op;
    return publicOperation(after || (await ledger.getOperation(operationId)) || op);
  }

  /** @param {{ toSku: string, actor: { id: string } }} input */
  async function prepareCatalogProduct(input) {
    if (!catalogPlan(input.toSku)) throw new MembershipChangeError("unknown_target_plan", 400, "Unknown plan.");
    const result = await ensureActiveStripeProductForCatalogSku(stripe, input.toSku);
    log({ event: "membership_change_catalog_product", actorId: input.actor.id, ...result });
    return result;
  }

  return {
    getDetails,
    preview,
    execute,
    cancelScheduled,
    getOperationStatus,
    prepareCatalogProduct,
    reconcileOperation,
  };
}

/** @param {string} day YYYY-MM-DD @param {number} delta */
function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Admin-facing operation shape with a plain-language stage. */
export function publicOperation(op) {
  if (!op) return null;
  const stage = {
    executing: "Processing the change…",
    scheduled: `Scheduled for ${String(op.effectiveAt || "").slice(0, 10)}`,
    syncing: "Payment confirmed. Waiting for Mindbody to issue the new package…",
    needs_reconciliation: "Needs attention",
    completed: "Completed — payment and Mindbody package verified",
    payment_required: "Payment required — nothing was changed or charged",
    failed: "Failed — nothing was changed",
    canceled: "Scheduled change canceled",
  }[op.status] || op.status;
  return {
    id: op.id,
    status: op.status,
    stage,
    subscriptionRecordId: op.subscriptionRecordId,
    actorId: op.actorId,
    fromSku: op.fromSku,
    toSku: op.toSku,
    direction: op.direction,
    timing: op.timing,
    billingPolicy: op.billingPolicy,
    previewAmountCents: op.previewAmountCents,
    amountChargedCents: op.amountChargedCents,
    effectiveAt: op.effectiveAt,
    stripeInvoiceId: op.stripeInvoiceId,
    stripeScheduleId: op.stripeScheduleId,
    mindbodySaleId: op.mindbodySaleId,
    mindbodyClientServiceId: op.mindbodyClientServiceId,
    errorCode: op.errorCode,
    errorMessage: op.errorMessage,
    recoveryNote: op.recoveryNote,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    completedAt: op.completedAt,
  };
}
