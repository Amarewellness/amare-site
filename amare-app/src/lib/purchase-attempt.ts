/**
 * Stable purchaseAttemptId for one checkout attempt.
 * Survives rerender, resume, prepare retry, and PaymentSheet presentation retry.
 */
const attempts = new Map<string, string>();

export function createPurchaseAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
  return `app${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function purchaseAttemptIdForSku(sku: string): string {
  const existing = attempts.get(sku);
  if (existing) return existing;
  const created = createPurchaseAttemptId();
  attempts.set(sku, created);
  return created;
}

export function peekPurchaseAttemptId(sku: string): string | null {
  return attempts.get(sku) || null;
}

/** Restore the backend-owned attempt after process death. Never mints a new id. */
export function restorePurchaseAttemptId(sku: string, purchaseAttemptId: string): void {
  const id = String(purchaseAttemptId || "").trim();
  if (!sku || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) return;
  attempts.set(sku, id);
}

/** Call only after mindbody_synced success. Cancel / fail / resume keep the same id. */
export function clearPurchaseAttemptId(sku: string): void {
  attempts.delete(sku);
}

/**
 * Fresh idempotency key for each hosted Checkout open.
 * Reusing a key after cancel/abandon makes Stripe replay an expired session with no URL.
 */
export function newHostedCheckoutIdempotencyKey(): string {
  return createPurchaseAttemptId();
}

export function clearAllPurchaseAttemptIds(): void {
  attempts.clear();
}
