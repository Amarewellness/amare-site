import type { PurchaseUiState } from "./purchase-flow";

export type PendingMobilePurchase = {
  orderId: string;
  purchaseAttemptId: string;
  sku: string;
  createdAt: string;
};

export type MobileOrderStatusLike = {
  orderId?: string;
  localSku?: string;
  purchaseAttemptId?: string | null;
  mindbodySyncStatus?: string;
  paymentStatus?: string;
  fulfilled?: boolean;
  createdAt?: string | null;
};

export type PurchaseRecoveryDecision = {
  ui: PurchaseUiState;
  clearPending: boolean;
  buyLocked: boolean;
  restoreAttempt: boolean;
  pollStatus: boolean;
};

const NEW_ATTEMPT_SAFE = new Set(["canceled", "refunded"]);
const PAID_IN_FLIGHT = new Set([
  "payment_completed",
  "client_resolving",
  "client_created",
  "client_found",
  "mindbody_sync_claimed",
  "mindbody_checkout_started",
  "paid_but_not_synced",
  "sync_failed_retryable",
  "sync_failed_manual_review",
]);

export function isSafePendingMobilePurchase(raw: unknown): raw is PendingMobilePurchase {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  if (typeof row.orderId !== "string" || !row.orderId.startsWith("ord_")) return false;
  if (typeof row.purchaseAttemptId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(row.purchaseAttemptId)) {
    return false;
  }
  if (typeof row.sku !== "string" || !row.sku) return false;
  if (typeof row.createdAt !== "string" || !row.createdAt) return false;
  const forbidden = [
    "paymentIntentClientSecret",
    "clientSecret",
    "stripeSecret",
    "clientId",
    "email",
  ];
  return forbidden.every((key) => !(key in row));
}

export function sanitizePendingMobilePurchase(raw: unknown): PendingMobilePurchase | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const next: PendingMobilePurchase = {
    orderId: String(row.orderId || ""),
    purchaseAttemptId: String(row.purchaseAttemptId || ""),
    sku: String(row.sku || row.localSku || ""),
    createdAt: String(row.createdAt || new Date().toISOString()),
  };
  return isSafePendingMobilePurchase(next) ? next : null;
}

/** Device pointers never authorize a second charge. Backend OrderRecord does. */
export function shouldCreateNewChargeAfterRestart(): false {
  return false;
}

export function recoveryFromMobileStatus(status: MobileOrderStatusLike): PurchaseRecoveryDecision {
  const sync = String(status.mindbodySyncStatus || "");
  const paidAlias = String(status.paymentStatus || "");
  if (status.fulfilled === true || sync === "mindbody_synced" || paidAlias === "mindbody_synced") {
    return { ui: "success", clearPending: true, buyLocked: false, restoreAttempt: false, pollStatus: false };
  }
  if (sync === "mindbody_sync_unknown" || paidAlias === "mindbody_sync_unknown") {
    return { ui: "sync_unknown", clearPending: false, buyLocked: true, restoreAttempt: true, pollStatus: false };
  }
  if (NEW_ATTEMPT_SAFE.has(sync)) {
    return { ui: "idle", clearPending: true, buyLocked: false, restoreAttempt: false, pollStatus: false };
  }
  if (sync === "paid_but_not_synced") {
    return { ui: "failed", clearPending: false, buyLocked: true, restoreAttempt: true, pollStatus: false };
  }
  if (PAID_IN_FLIGHT.has(sync) || (paidAlias === "processing" && sync !== "checkout_created")) {
    return {
      ui: "payment_completed_processing",
      clearPending: false,
      buyLocked: true,
      restoreAttempt: true,
      pollStatus: true,
    };
  }
  return { ui: "idle", clearPending: false, buyLocked: false, restoreAttempt: true, pollStatus: false };
}

export function pickUnresolvedMobileOrder(
  orders: MobileOrderStatusLike[],
): MobileOrderStatusLike | null {
  if (!orders.length) return null;
  const unknown = orders.find((o) => o.mindbodySyncStatus === "mindbody_sync_unknown");
  if (unknown) return unknown;
  const processing = orders.find((o) => {
    const sync = String(o.mindbodySyncStatus || "");
    return PAID_IN_FLIGHT.has(sync) || (sync !== "checkout_created" && o.paymentStatus === "processing");
  });
  if (processing) return processing;
  return [...orders].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}
