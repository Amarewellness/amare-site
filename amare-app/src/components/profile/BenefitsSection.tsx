import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useState } from "react";
import {
  benefitQrImageUrl,
  fetchMemberBenefits,
  issueBenefitToken,
  type MemberBenefit,
} from "../../api/benefits";
import { ApiError } from "../../api/client";

type Props = {
  accessToken: string;
};

function mapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
}

async function openExternal(url: string) {
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Browser.open({ url });
}

function issueErrorMessage(code: string, benefit: MemberBenefit): string {
  if (code === "not_eligible") return "You are not eligible for this perk.";
  if (code === "already_redeemed_this_period") {
    return benefit.redeemedMessage || "You already used this perk this month.";
  }
  return "Could not open benefit.";
}

function BenefitCard({
  benefit,
  busy,
  onUse,
}: {
  benefit: MemberBenefit;
  busy: boolean;
  onUse: () => void;
}) {
  const status = String(benefit.memberStatus || "eligible");
  const address = String(benefit.locationAddress || "").trim();
  const phone = String(benefit.partnerPhone || "").trim();
  const phoneLink = phone ? telHref(phone) : null;

  return (
    <article className="profile-benefit">
      <div className="profile-benefit__head">
        {benefit.logoUrl ? (
          <img className="profile-benefit__logo" src={benefit.logoUrl} alt="" width={40} height={40} />
        ) : null}
        <div>
          <h3>{benefit.title || "Benefit"}</h3>
          {benefit.partnerDisplayName ? (
            <p className="profile-benefit__partner">AMARÉ × {benefit.partnerDisplayName}</p>
          ) : null}
        </div>
      </div>
      {benefit.description ? <p className="card__meta">{benefit.description}</p> : null}
      {address ? (
        <div className="profile-benefit__field">
          <p className="profile-benefit__label">Redeem at</p>
          <p>{address}</p>
          <button type="button" className="profile-benefit__text-btn" onClick={() => void openExternal(mapsSearchUrl(address))}>
            Open map
          </button>
        </div>
      ) : null}
      {phone ? (
        <div className="profile-benefit__field">
          <p className="profile-benefit__label">Call to schedule</p>
          <p className="card__meta">Please call the business to schedule your visit before redeeming this perk.</p>
          {phoneLink ? (
            <a className="profile-benefit__text-btn" href={phoneLink}>
              {phone}
            </a>
          ) : (
            <p>{phone}</p>
          )}
        </div>
      ) : null}
      {status === "eligible" || status === "pending_token" ? (
        <button type="button" className="btn btn--cream" disabled={busy} onClick={onUse}>
          {busy ? "Opening…" : status === "pending_token" ? "Open my QR" : "Use benefit"}
        </button>
      ) : status === "redeemed" ? (
        <p className="card__meta">
          {benefit.availableAgain
            ? `Redeemed${benefit.redeemedAt ? ` ${benefit.redeemedAt}` : ""} · Available again ${benefit.availableAgain}`
            : `Redeemed${benefit.redeemedAt ? ` ${benefit.redeemedAt}` : ""} · ${benefit.redeemedMessage || "One-time campaign perk"}`}
        </p>
      ) : (
        <p className="card__meta">
          {benefit.message || "Monthly perks are included with active monthly memberships."}
        </p>
      )}
    </article>
  );
}

export function BenefitsSection({ accessToken }: Props) {
  const [benefits, setBenefits] = useState<MemberBenefit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [qr, setQr] = useState<{ benefit: MemberBenefit; qrUrl: string; validThrough: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMemberBenefits(accessToken);
      setBenefits(Array.isArray(data.benefits) ? data.benefits : []);
    } catch {
      setBenefits([]);
      setError("Partner benefits unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openQr(benefit: MemberBenefit) {
    setBusyId(benefit.id);
    try {
      const data = await issueBenefitToken(accessToken, benefit.id);
      if (!data.qrUrl) throw new Error("missing_qr");
      setQr({
        benefit,
        qrUrl: data.qrUrl,
        validThrough: data.validThrough || benefit.validThrough || "",
      });
      setBenefits((cur) =>
        cur.map((row) =>
          row.id === benefit.id
            ? { ...row, memberStatus: "pending_token", validThrough: data.validThrough || row.validThrough }
            : row,
        ),
      );
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "";
      setError(issueErrorMessage(code, benefit));
      if (code === "already_redeemed_this_period") void load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card profile-section">
      <h2>Benefits</h2>
      <p className="profile-section__hint">
        Exclusive local perks for monthly members and 10/20 class packs.
      </p>
      {loading ? (
        <div className="profile-benefits-loader" role="status" aria-live="polite" aria-busy="true">
          <p>Loading benefits…</p>
          <div className="profile-benefits-loader__track" role="progressbar" aria-label="Loading benefits">
            <div className="profile-benefits-loader__bar" />
          </div>
          <div className="profile-benefits-loader__cards" aria-hidden="true">
            <span className="profile-benefits-loader__card" />
            <span className="profile-benefits-loader__card" />
          </div>
        </div>
      ) : null}
      {!loading && error && benefits.length === 0 ? <p className="card__meta">{error}</p> : null}
      {!loading && !error && benefits.length === 0 ? (
        <p className="card__meta">No partner perks are active right now. Check back soon.</p>
      ) : null}
      {!loading && error && benefits.length > 0 ? <p className="amare-login__error">{error}</p> : null}
      <div className="profile-benefits">
        {benefits.map((benefit) => (
          <BenefitCard
            key={benefit.id}
            benefit={benefit}
            busy={busyId === benefit.id}
            onUse={() => void openQr(benefit)}
          />
        ))}
      </div>

      {qr ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setQr(null)}>
          <div
            className="modal card profile-benefit-qr"
            role="dialog"
            aria-labelledby="profile-benefit-qr-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="profile-benefit-qr-title">{qr.benefit.title || "Benefit"}</h2>
            <p className="card__meta">
              {qr.benefit.partnerDisplayName ? `AMARÉ × ${qr.benefit.partnerDisplayName}` : "AMARÉ"}
            </p>
            <img src={benefitQrImageUrl(qr.qrUrl)} alt="QR code for partner benefit" width={280} height={280} />
            <p className="card__meta">Valid through {qr.validThrough || "—"}</p>
            <p className="card__meta">
              Show this QR at the partner — or save a screenshot for later this month.
            </p>
            <div className="modal__actions">
              <button type="button" className="btn btn--cream" onClick={() => setQr(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
