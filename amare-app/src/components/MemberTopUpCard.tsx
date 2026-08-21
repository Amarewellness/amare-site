import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createHostedCheckoutSession, openHostedCheckoutUrl } from "../api/checkout";
import { apiJson } from "../api/client";
import { clearPurchaseAttemptId } from "../lib/purchase-attempt";
import {
  MEMBER_TOPUP_SKU,
  memberTopUpVisible,
  prepareMemberTopUpPayment,
  releaseUnpaidMemberTopUp,
  type MemberTopUpStatus,
} from "../lib/member-topup";
import { nativePaymentSheetAvailable, presentNativePaymentSheet } from "../plugins/amare-stripe-payment";

type Props = {
  accessToken: string;
  compact?: boolean;
  refreshKey?: number;
};

export function MemberTopUpCard({ accessToken, compact = false, refreshKey = 0 }: Props) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<MemberTopUpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiJson<MemberTopUpStatus>("/api/mindbody/member/top-up/status", accessToken)
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, refreshKey]);

  if (!memberTopUpVisible(status)) return null;
  const copy = status?.copy || {};
  const cta = String(status?.cta || "");

  async function onClick() {
    if (cta !== "topup") {
      navigate("/purchase");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (nativePaymentSheetAvailable()) {
        const prepared = await prepareMemberTopUpPayment(accessToken);
        if (!prepared.paymentIntentClientSecret || !prepared.publishableKey) {
          throw new Error("checkout_unavailable");
        }
        const sheet = await presentNativePaymentSheet({
          publishableKey: prepared.publishableKey,
          clientSecret: prepared.paymentIntentClientSecret,
          merchantDisplayName: prepared.merchantDisplayName || "AMARÉ",
        });
        if (sheet.status === "canceled" || sheet.status === "failed") {
          const rel = await releaseUnpaidMemberTopUp(accessToken, prepared.orderId);
          if (rel.released) clearPurchaseAttemptId(MEMBER_TOPUP_SKU);
          const next = await apiJson<MemberTopUpStatus>("/api/mindbody/member/top-up/status", accessToken).catch(
            () => null,
          );
          if (next) setStatus(next);
        }
        return;
      }
      const session = await createHostedCheckoutSession(accessToken, {
        localSku: MEMBER_TOPUP_SKU,
        ctaLocation: "app_member_topup",
        pageLocation: "/schedule",
      });
      if (session.url) await openHostedCheckoutUrl(session.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mb-schedule-guest-pass mb-schedule-topup${compact ? " mb-schedule-topup--compact" : ""}`}>
      <div className="mb-schedule-guest-pass__inner" role="region" aria-label={copy.eyebrow || "Member top-up"}>
        <p className="mb-schedule-guest-pass__eyebrow">{copy.eyebrow || "Need one more class?"}</p>
        <p className="mb-schedule-guest-pass__hint">{copy.support || "One member top-up per billing cycle."}</p>
        <button type="button" className="btn" disabled={busy} onClick={() => void onClick()}>
          {busy ? "Opening…" : copy.button || "Add 1 Class · $29"}
        </button>
        {err ? <p className="mb-schedule-guest-pass__hint">{err}</p> : null}
      </div>
    </div>
  );
}
