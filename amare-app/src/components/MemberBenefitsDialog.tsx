import { useEffect, useState } from "react";
import {
  FALLBACK_PARTNER_BENEFITS,
  STUDIO_MEMBER_BENEFITS,
  fetchPublicPartnerBenefits,
  type MemberBenefit,
} from "../lib/member-benefits";

type Props = {
  open: boolean;
  onClose: () => void;
};

function BenefitList({ items }: { items: MemberBenefit[] }) {
  return (
    <ul className="purchase-benefits__list">
      {items.map((item) => (
        <li key={item.id}>
          {item.badge ? <span className="purchase-benefits__badge">{item.badge}</span> : null}
          <strong>{item.title}</strong>
          {item.partner ? <span className="purchase-benefits__partner">AMARÉ × {item.partner}</span> : null}
          <p>{item.description}</p>
        </li>
      ))}
    </ul>
  );
}

export function MemberBenefitsDialog({ open, onClose }: Props) {
  const [partners, setPartners] = useState<MemberBenefit[]>(FALLBACK_PARTNER_BENEFITS);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchPublicPartnerBenefits()
      .then((next) => {
        if (!cancelled) setPartners(next);
      })
      .catch(() => {
        if (!cancelled) setPartners(FALLBACK_PARTNER_BENEFITS);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card purchase-benefits"
        role="dialog"
        aria-labelledby="purchase-benefits-title"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="purchase-benefits__label">Member benefits</p>
        <h2 id="purchase-benefits-title">Every monthly plan includes</h2>
        <BenefitList items={STUDIO_MEMBER_BENEFITS} />
        {partners.length > 0 ? (
          <>
            <h3 className="purchase-benefits__sub">Partner perks</h3>
            <BenefitList items={partners} />
          </>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="btn btn--cream" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
