/**
 * AMARÉ attendance fees — source-controlled operational config.
 *
 * Do NOT add attendance-fee-specific Netlify environment variables.
 * Rollout (enabled / dry-run / tuning) is intentional code change + deploy.
 *
 * Global project secrets/config (STRIPE_SECRET_KEY, DATABASE_URL, MINDBODY_*, etc.)
 * remain env-based elsewhere; this module is only for attendance-fee product settings.
 *
 * Future examples (code constants, not env):
 * - no-show buffer / lookback minutes
 * - processing stale timeout, retry backoff
 * - fee amount (currently fixed $10)
 * - Stripe Price ID for the $10 fee (prefer here or an existing Stripe catalog file — not a new Netlify env var)
 */

/** Master switch — when false, no ledger writes from runtime paths. */
export const ATTENDANCE_FEES_ENABLED = true;

/** When enabled, eligible visits record terminal dry-run rows instead of pending billable rows. */
export const ATTENDANCE_FEES_DRY_RUN = true;

export const ATTENDANCE_FEE_AMOUNT_CENTS = 1000;
export const ATTENDANCE_FEE_CURRENCY = "usd";

/** Stale `processing` rows may be reclaimed after this interval. */
export const ATTENDANCE_FEE_STALE_PROCESSING_MS = 10 * 60 * 1000;

/** Set when Phase 3 wires Stripe catalog (not a secret). Live charging fails closed while null. */
export const STRIPE_ATTENDANCE_FEE_PRICE_ID = null;

/** Scheduled reconciler batch size (code constant). */
export const ATTENDANCE_FEE_RECONCILE_BATCH_SIZE = 25;

/** Max parallel Stripe collections per reconciler run. */
export const ATTENDANCE_FEE_RECONCILE_MAX_CONCURRENCY = 3;

/** After this many lock attempts, automatic retries stop (permanent). */
export const ATTENDANCE_FEE_MAX_CHARGE_ATTEMPTS = 4;

/** Minutes to wait before retry after failed attempt (index = attemptCount - 1). */
export const ATTENDANCE_FEE_RETRY_DELAY_MINUTES = Object.freeze([5, 15, 60]);

/**
 * @typedef {{ enabled: boolean; dryRun: boolean }} AttendanceFeeRuntimeConfig
 */

/**
 * @typedef {{
 *   enabled?: boolean;
 *   dryRun?: boolean;
 *   stripePriceId?: string | null;
 * }} AttendanceFeeCollectionConfig
 */

/**
 * @param {Partial<AttendanceFeeCollectionConfig> | null | undefined} override
 */
export function resolveAttendanceFeeCollectionConfig(override) {
  const runtime = resolveAttendanceFeeRuntimeConfig(override);
  const stripePriceId =
    override && "stripePriceId" in override
      ? override.stripePriceId ?? null
      : STRIPE_ATTENDANCE_FEE_PRICE_ID;
  return { ...runtime, stripePriceId };
}

/**
 * @param {Partial<AttendanceFeeRuntimeConfig> | null | undefined} override
 * @returns {AttendanceFeeRuntimeConfig}
 */
export function resolveAttendanceFeeRuntimeConfig(override) {
  const enabled =
    override && typeof override.enabled === "boolean" ? override.enabled : ATTENDANCE_FEES_ENABLED;
  const dryRun =
    override && typeof override.dryRun === "boolean" ? override.dryRun : ATTENDANCE_FEES_DRY_RUN;
  return { enabled, dryRun };
}
