import { apiFetch, ApiError } from "./client";

export type GooglePayPublicConfig = {
  environment: "TEST";
  country: "US";
  currency: "USD";
};

export type MobilePrepareResponse = {
  ok?: boolean;
  orderId?: string;
  paymentIntentClientSecret?: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  merchantDisplayName?: string;
  publishableKey?: string;
  googlePay?: GooglePayPublicConfig;
  error?: string;
  message?: string;
};

export type MobileOrderStatus = {
  ok?: boolean;
  orderId?: string;
  localSku?: string;
  paymentFlow?: string;
  purchaseAttemptId?: string | null;
  mindbodySyncStatus?: string;
  paymentStatus?: string;
  fulfilled?: boolean;
  error?: string;
};

export type MobilePendingOrders = {
  ok?: boolean;
  orders?: MobileOrderStatus[];
  error?: string;
};

export async function prepareMobilePayment(
  accessToken: string,
  body: { sku: string; purchaseAttemptId: string },
): Promise<MobilePrepareResponse> {
  const res = await apiFetch("/api/amare/commerce/mobile/prepare", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sku: body.sku,
      purchaseAttemptId: body.purchaseAttemptId,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as MobilePrepareResponse;
  if (!res.ok || !data.orderId || !data.paymentIntentClientSecret) {
    const message =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      `prepare_${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export async function fetchMobileOrderStatus(accessToken: string, orderId: string): Promise<MobileOrderStatus> {
  const path = `/api/amare/commerce/mobile/status?orderId=${encodeURIComponent(orderId)}`;
  const res = await apiFetch(path, accessToken);
  const data = (await res.json().catch(() => ({}))) as MobileOrderStatus;
  if (!res.ok) {
    const message = (typeof data.error === "string" && data.error) || `status_${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export async function fetchMobilePendingOrders(accessToken: string): Promise<MobilePendingOrders> {
  const res = await apiFetch("/api/amare/commerce/mobile/pending", accessToken);
  const data = (await res.json().catch(() => ({}))) as MobilePendingOrders;
  if (!res.ok) {
    const message = (typeof data.error === "string" && data.error) || `pending_${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}
