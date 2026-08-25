import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createHostedCheckoutSession, openHostedCheckoutUrl } from "../api/checkout";
import { apiJson } from "../api/client";
import { newHostedCheckoutIdempotencyKey } from "../lib/purchase-attempt";
import {
  MEMBER_TOPUP_SKU,
  memberTopUpVisible,
  type MemberTopUpStatus,
} from "../lib/member-topup";
import { HOSTED_CHECKOUT_UNAVAILABLE } from "../lib/member-profile-utils";

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

  async function refreshTopUpStatus() {
    const next = await apiJson<MemberTopUpStatus>("/api/mindbody/member/top-up/status", accessToken).catch(
      () => null,
    );
    if (next) setStatus(next);
  }

  async function onClick() {
    if (cta !== "topup") {
      navigate("/purchase");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const session = await createHostedCheckoutSession(accessToken, {
        localSku: MEMBER_TOPUP_SKU,
        ctaLocation: "app_member_topup",
        pageLocation: "/schedule",
        idempotencyKey: newHostedCheckoutIdempotencyKey(),
      });
      if (!session.url) throw new Error("missing_checkout_url");
      await openHostedCheckoutUrl(session.url, () => {
        setErr(null);
        void refreshTopUpStatus();
      });
    } catch {
      setErr(HOSTED_CHECKOUT_UNAVAILABLE);
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
