import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { apiBase, applyTunnelHeaders, appOrigin } from "../config";

export type HostedCheckoutSession = {
  ok?: boolean;
  url?: string;
  error?: string;
  message?: string;
  orderId?: string;
  sessionId?: string;
};

export type HostedCheckoutBody = {
  localSku: string;
  ctaLocation?: string;
  pageLocation?: string;
  idempotencyKey?: string;
  requiresMembershipAgreement?: boolean;
  membershipAgreementAccepted?: boolean;
  membershipBillingAuthorized?: boolean;
  membershipTermsContractVersion?: string;
  membershipTermsDisplayedHtml?: string;
  membershipFullLegalName?: string;
};

/** SKU known: App Bearer → create-session → Stripe Checkout URL. Server owns price. */
export async function createHostedCheckoutSession(
  accessToken: string,
  body: HostedCheckoutBody,
): Promise<HostedCheckoutSession> {
  const url = `${apiBase()}/api/stripe/checkout/create-session`;
  const res = await fetch(url, {
    method: "POST",
    headers: applyTunnelHeaders(
      new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      }),
      url,
    ),
    body: JSON.stringify({
      ...body,
      ctaLocation: body.ctaLocation || "app_purchase",
      pageLocation: body.pageLocation || `${appOrigin()}/purchase`.slice(0, 200),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as HostedCheckoutSession;
  if (!res.ok || !data.url) {
    const message =
      (typeof data.message === "string" && data.message.trim() && data.message) ||
      (typeof data.error === "string" && data.error) ||
      `create_session_${res.status}`;
    throw new Error(message);
  }
  return data;
}

export async function openHostedCheckoutUrl(url: string, onClosed?: () => void): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    if (onClosed) {
      const handle = await Browser.addListener("browserFinished", () => {
        void handle.remove();
        onClosed();
      });
    }
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
