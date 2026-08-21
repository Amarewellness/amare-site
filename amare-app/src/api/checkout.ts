import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { apiBase, applyTunnelHeaders, appOrigin } from "../config";
import type { GuestCheckoutIdentity } from "../lib/guest-checkout";

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
  guest?: GuestCheckoutIdentity;
};

/**
 * POST /api/stripe/checkout/create-session.
 * Signed-in: send Bearer, never guest fields.
 * Guest: no Bearer, firstName/lastName/email/phone only. App never supplies a Studio id.
 */
export async function createHostedCheckoutSession(
  accessToken: string | null,
  body: HostedCheckoutBody,
): Promise<HostedCheckoutSession> {
  const url = `${apiBase()}/api/stripe/checkout/create-session`;
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const payload: Record<string, unknown> = {
    localSku: body.localSku,
    ctaLocation: body.ctaLocation || "app_purchase",
    pageLocation: body.pageLocation || `${appOrigin()}/purchase`.slice(0, 200),
  };
  if (body.idempotencyKey) payload.idempotencyKey = body.idempotencyKey;
  if (body.requiresMembershipAgreement) {
    payload.requiresMembershipAgreement = true;
    payload.membershipAgreementAccepted = body.membershipAgreementAccepted;
    payload.membershipBillingAuthorized = body.membershipBillingAuthorized;
    payload.membershipTermsContractVersion = body.membershipTermsContractVersion;
    payload.membershipTermsDisplayedHtml = body.membershipTermsDisplayedHtml;
    if (body.membershipFullLegalName) payload.membershipFullLegalName = body.membershipFullLegalName;
  }
  if (!accessToken && body.guest) {
    payload.firstName = body.guest.firstName;
    payload.lastName = body.guest.lastName;
    payload.email = body.guest.email;
    payload.phone = body.guest.phone;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: applyTunnelHeaders(headers, url),
    body: JSON.stringify(payload),
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
