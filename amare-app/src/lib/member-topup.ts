import { ApiError, apiJson } from "../api/client";
import { prepareMobilePayment, type MobilePrepareResponse } from "../api/mobile-payments";
import { clearPurchaseAttemptId, purchaseAttemptIdForSku } from "./purchase-attempt";

export const MEMBER_TOPUP_SKU = "monthly_member_topup";

export type MemberTopUpStatus = {
  ok?: boolean;
  eligible?: boolean;
  reason?: string | null;
  cta?: "topup" | "upgrade_monthly_8" | "go_unlimited" | "none" | string;
  tier?: string | null;
  sku?: string;
  amountCents?: number;
  copy?: {
    eyebrow?: string | null;
    button?: string | null;
    support?: string | null;
    upgrade?: string | null;
  };
};

export function memberTopUpVisible(status: MemberTopUpStatus | null | undefined): boolean {
  const cta = String(status?.cta || "");
  return cta === "topup" || cta === "upgrade_monthly_8" || cta === "go_unlimited";
}

export async function releaseUnpaidMemberTopUp(
  accessToken: string,
  orderId: string | undefined,
): Promise<{ released: boolean }> {
  const id = String(orderId || "").trim();
  if (!/^ord_[A-Za-z0-9]{8,40}$/.test(id)) return { released: false };
  try {
    const data = await apiJson<{ ok?: boolean; released?: boolean }>(
      "/api/mindbody/member/top-up/release",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: id }),
      },
    );
    return { released: data.released === true };
  } catch {
    return { released: false };
  }
}

function isRetiredPurchaseAttemptError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body;
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  return String((body as { error?: unknown }).error || "") === "purchase_attempt_retired";
}

/** One retry after a retired/canceled attempt. Never loops. */
export async function prepareMemberTopUpPayment(accessToken: string): Promise<MobilePrepareResponse> {
  const firstId = purchaseAttemptIdForSku(MEMBER_TOPUP_SKU);
  try {
    return await prepareMobilePayment(accessToken, { sku: MEMBER_TOPUP_SKU, purchaseAttemptId: firstId });
  } catch (err) {
    if (!isRetiredPurchaseAttemptError(err)) throw err;
    clearPurchaseAttemptId(MEMBER_TOPUP_SKU);
    const nextId = purchaseAttemptIdForSku(MEMBER_TOPUP_SKU);
    if (!nextId || nextId === firstId) throw err;
    return await prepareMobilePayment(accessToken, { sku: MEMBER_TOPUP_SKU, purchaseAttemptId: nextId });
  }
}
