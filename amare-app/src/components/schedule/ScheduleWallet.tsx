import { Link } from "react-router-dom";
import { scheduleWalletViewModel, walletPunchSlotLayout } from "../../lib/wallet-view";

type Props = {
  summary: unknown;
  loading: boolean;
  compact?: boolean;
};

export function ScheduleWallet({ summary, loading, compact = false }: Props) {
  if (loading) {
    return (
      <div className={`mb-schedule-wallet${compact ? " mb-schedule-wallet--compact" : ""}`} aria-live="polite">
        <div
          className="mb-schedule-wallet__inner mb-schedule-wallet__inner--loading"
          role="region"
          aria-label="Your class visit credits"
          aria-busy="true"
        >
          <div className="mb-schedule-wallet__eyebrow">Class credits</div>
          <div className="mb-schedule-wallet__meta">Loading credits…</div>
          {!compact ? (
            <div className="mb-schedule-wallet__track" role="progressbar" aria-busy="true">
              <div className="mb-schedule-wallet__fill mb-schedule-wallet__fill--loading" />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const vm = scheduleWalletViewModel(summary);

  if (vm.kind === "message") {
    return (
      <div className={`mb-schedule-wallet${compact ? " mb-schedule-wallet--compact" : ""}`} aria-live="polite">
        <div className={`mb-schedule-wallet__notice${vm.variant === "warn" ? " mb-schedule-wallet__notice--warn" : ""}`}>
          {vm.text}
          {vm.variant === "info" && (
            <>
              {" "}
              <Link to="/purchase">Buy a pass</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  if (vm.kind === "membership") {
    return (
      <div className={`mb-schedule-wallet${compact ? " mb-schedule-wallet--compact" : ""}`} aria-live="polite">
        <div className="mb-schedule-wallet__inner" role="region" aria-label="Your membership">
          <div className="mb-schedule-wallet__membership-head">
            <div className="mb-schedule-wallet__eyebrow">Membership</div>
            <span className="mb-schedule-wallet__membership-badge">Active</span>
          </div>
          <div className="mb-schedule-wallet__meta">
            <strong>{vm.membershipName}</strong>
          </div>
          {vm.renewsLabel && (
            <div className="mb-schedule-wallet__expiry">Renews {vm.renewsLabel}</div>
          )}
        </div>
      </div>
    );
  }

  if (vm.kind !== "packs") return null;

  return (
    <div className={`mb-schedule-wallet${compact ? " mb-schedule-wallet--compact" : ""}`} aria-live="polite">
      {vm.packs.map((pack) => {
        const { slotCount, filled } = walletPunchSlotLayout(pack.remaining, pack.total);
        const expiryLine = pack.expiryLabel
          ? pack.isRecurringMonthly
            ? `Renews ${pack.expiryLabel}`
            : `Expires ${pack.expiryLabel}`
          : "";
        return (
          <div key={pack.name} className="mb-schedule-wallet__inner" role="region" aria-label={pack.name}>
            <div className="mb-schedule-wallet__eyebrow">Class credits</div>
            <div className="mb-schedule-wallet__meta">
              <strong>{pack.name}</strong>
              {": "}
              {pack.remaining} left
            </div>
            {!compact && expiryLine ? <div className="mb-schedule-wallet__expiry">{expiryLine}</div> : null}
            {!compact ? (
              <div
                className="mb-schedule-wallet__segments"
                style={{ ["--mb-wallet-seg-n" as string]: String(slotCount) }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={pack.total}
                aria-valuenow={pack.remaining}
                aria-valuetext={`${pack.remaining} left`}
              >
                {Array.from({ length: slotCount }, (_, i) => (
                  <div
                    key={i}
                    className={`mb-schedule-wallet__seg${i < filled ? " mb-schedule-wallet__seg--on" : " mb-schedule-wallet__seg--off"}`}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {vm.moreCount > 0 && (
        <p className="mb-schedule-wallet__more">+{vm.moreCount} more package{vm.moreCount > 1 ? "s" : ""}</p>
      )}
    </div>
  );
}
