export const MOBILE_PAYMENT_SHEET_SKUS = [
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "drop_in_same_day",
  "pack_10_classes",
  "pack_20_classes",
  "monthly_member_topup",
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

export const PURCHASE_UI_GROUPS = [
  { id: "first_visit", title: "First time visit", skus: ["new_client_special_3_for_65"] },
  { id: "membership", title: "Membership", skus: ["monthly_5", "monthly_8", "monthly_unlimited"] },
  { id: "flexible", title: "Flexible packs", skus: ["pack_10_classes", "pack_20_classes"] },
  { id: "one_time", title: "One time", skus: ["drop_in_single_class"] },
] as const;

export function groupPurchaseItems<T extends { localSku: string }>(items: T[]) {
  const bySku = new Map(items.map((item) => [item.localSku, item]));
  return PURCHASE_UI_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    items: group.skus.map((sku) => bySku.get(sku)).filter((item): item is T => item != null),
  })).filter((group) => group.items.length > 0);
}

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
