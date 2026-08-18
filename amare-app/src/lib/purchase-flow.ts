export const MOBILE_PAYMENT_SHEET_SKUS = [
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "drop_in_same_day",
  "pack_10_classes",
  "pack_20_classes",
] as const;

export type MobilePaymentSheetSku = (typeof MOBILE_PAYMENT_SHEET_SKUS)[number];

export const PURCHASE_UI_STATES = [
  "idle",
  "preparing",
  "payment_sheet_open",
  "payment_completed_processing",
  "success",
  "canceled",
  "failed",
  "sync_unknown",
] as const;

export type PurchaseUiState = (typeof PURCHASE_UI_STATES)[number];

export function isPaymentSheetSku(sku: string): boolean {
  return (MOBILE_PAYMENT_SHEET_SKUS as readonly string[]).includes(sku);
}

export function isMonthlyHostedSku(sku: string, kind?: string, stripeMode?: string): boolean {
  if (kind === "monthlyMembership" || stripeMode === "subscription") return true;
  return sku === "monthly_5" || sku === "monthly_8" || sku === "monthly_unlimited";
}

/**
 * PaymentSheet `completed` is not fulfillment. Only mindbody_synced is success.
 */
export function nextStateAfterStatusPoll(status: {
  paymentStatus?: string;
  mindbodySyncStatus?: string;
  fulfilled?: boolean;
}): Exclude<PurchaseUiState, "idle" | "preparing" | "payment_sheet_open" | "canceled"> {
  if (status.fulfilled === true || status.mindbodySyncStatus === "mindbody_synced" || status.paymentStatus === "mindbody_synced") {
    return "success";
  }
  if (status.mindbodySyncStatus === "mindbody_sync_unknown" || status.paymentStatus === "mindbody_sync_unknown") {
    return "sync_unknown";
  }
  if (status.paymentStatus === "failed" || status.mindbodySyncStatus === "canceled" || status.mindbodySyncStatus === "paid_but_not_synced") {
    return "failed";
  }
  return "payment_completed_processing";
}

export function sheetCompletedIsFulfilled(): false {
  return false;
}
