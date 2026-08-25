import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPurchaseCatalog, formatCatalogPrice, type PurchaseCatalogItem } from "../api/catalog";
import { createHostedCheckoutSession, openHostedCheckoutUrl } from "../api/checkout";
import { useAuth } from "../auth/AuthContext";
import { AppHero } from "../components/AppHero";
import { MemberBenefitsDialog } from "../components/MemberBenefitsDialog";
import { useMemberSummary } from "../hooks/useMemberSummary";
import {
  ACTIVE_MONTHLY_MEMBERSHIP_COPY,
  hasActiveMonthlyMembership,
  HOSTED_CHECKOUT_UNAVAILABLE,
} from "../lib/member-profile-utils";
import {
  parseGuestCheckoutIdentity,
  type GuestCheckoutIdentity,
} from "../lib/guest-checkout";
import { newHostedCheckoutIdempotencyKey } from "../lib/purchase-attempt";
import { groupPurchaseItems, isMonthlyHostedSku } from "../lib/purchase-flow";

export function PurchaseScreen() {
  const { accessToken, isLoggedIn, signIn, profile } = useAuth();
  const { reload, summary } = useMemberSummary();
  const activeMonthlyMembership = useMemo(() => hasActiveMonthlyMembership(summary), [summary]);
  const [items, setItems] = useState<PurchaseCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [pendingMonthly, setPendingMonthly] = useState<PurchaseCatalogItem | null>(null);
  const [choiceItem, setChoiceItem] = useState<PurchaseCatalogItem | null>(null);
  const [guestItem, setGuestItem] = useState<PurchaseCatalogItem | null>(null);
  const [guestForm, setGuestForm] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [guestIdentity, setGuestIdentity] = useState<GuestCheckoutIdentity | null>(null);
  const [guestFormError, setGuestFormError] = useState<string | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeBilling, setAgreeBilling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [benefitsOpen, setBenefitsOpen] = useState(false);

  const incompleteAccess =
    profile?.studioAccess === "candidate" ||
    profile?.studioAccess === "needs_profile" ||
    profile?.studioAccess === "ambiguous" ||
    profile?.studioAccess === "conflict";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchPurchaseCatalog(accessToken)
      .then((data) => {
        if (cancelled) return;
        const next: PurchaseCatalogItem[] = [];
        for (const group of data.groups || []) {
          for (const item of group.items || []) next.push(item);
        }
        setItems(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load packages.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const purchaseGroups = useMemo(() => groupPurchaseItems(items), [items]);

  function clearGuestCheckout() {
    setChoiceItem(null);
    setGuestItem(null);
    setGuestIdentity(null);
    setGuestFormError(null);
    setGuestForm({ firstName: "", lastName: "", email: "", phone: "" });
  }

  function membershipConsentExtras(item: PurchaseCatalogItem): Record<string, unknown> | null {
    const agreement = item.agreement;
    if (!agreement?.contractVersion || !agreement.termsHtml) return null;
    return {
      requiresMembershipAgreement: true,
      membershipAgreementAccepted: true,
      membershipBillingAuthorized: true,
      membershipTermsContractVersion: agreement.contractVersion,
      membershipTermsDisplayedHtml: agreement.termsHtml,
    };
  }

  function hostedCheckoutErrorMessage(e: unknown): string {
    const msg = e instanceof Error ? e.message : "";
    if (msg === ACTIVE_MONTHLY_MEMBERSHIP_COPY) return msg;
    return HOSTED_CHECKOUT_UNAVAILABLE;
  }

  async function startHostedPurchase(
    item: PurchaseCatalogItem,
    options: { extras?: Record<string, unknown>; guest?: GuestCheckoutIdentity } = {},
  ) {
    const { extras = {}, guest } = options;
    const token = guest ? null : accessToken;
    if (!guest && !accessToken) {
      signIn();
      return;
    }
    setBusySku(item.localSku);
    setError(null);
    setNote(null);
    try {
      const idempotencyKey = newHostedCheckoutIdempotencyKey();
      const session = await createHostedCheckoutSession(token, {
        localSku: item.localSku,
        ctaLocation: "app_purchase",
        idempotencyKey,
        guest,
        ...extras,
      });
      if (!session.url) throw new Error("missing_checkout_url");
      if (guest) clearGuestCheckout();
      await openHostedCheckoutUrl(session.url, () => {
        setError(null);
        void reload();
      });
      setNote(
        guest
          ? "Complete checkout in the browser. After payment, confirmation is emailed to you."
          : "If you finished payment, credits usually appear within a minute. Pull to refresh Profile if needed.",
      );
      void reload();
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("hosted_checkout_start_failed", e instanceof Error ? e.message : e);
      }
      setError(hostedCheckoutErrorMessage(e));
    } finally {
      setBusySku(null);
    }
  }

  async function startHostedMonthly(item: PurchaseCatalogItem, extras: Record<string, unknown> = {}) {
    if (!accessToken) {
      signIn();
      return;
    }
    if (activeMonthlyMembership) {
      setError(ACTIVE_MONTHLY_MEMBERSHIP_COPY);
      return;
    }
    await startHostedPurchase(item, { extras });
  }

  async function startGuestHostedCheckout(
    item: PurchaseCatalogItem,
    identity: GuestCheckoutIdentity,
    extras: Record<string, unknown> = {},
  ) {
    if (isLoggedIn || accessToken) {
      clearGuestCheckout();
      return;
    }
    await startHostedPurchase(item, { extras, guest: identity });
  }

  function onSelect(item: PurchaseCatalogItem) {
    if (!item.available || !item.checkoutEnabled) {
      setError("This package is not available for checkout right now.");
      return;
    }
    if (busySku != null) return;

    if (!isLoggedIn && !accessToken) {
      setError(null);
      setGuestIdentity(null);
      setChoiceItem(item);
      return;
    }

    if (!isLoggedIn) {
      signIn();
      return;
    }
    if (incompleteAccess) {
      setError("Finish connecting your studio profile before purchasing.");
      return;
    }
    if (
      activeMonthlyMembership &&
      (item.kind === "monthlyMembership" || isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode))
    ) {
      setPendingMonthly(null);
      setError(ACTIVE_MONTHLY_MEMBERSHIP_COPY);
      return;
    }
    if (item.kind === "monthlyMembership" || isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode)) {
      setAgreeTerms(false);
      setAgreeBilling(false);
      setPendingMonthly(item);
      return;
    }
    void startHostedPurchase(item);
  }

  function continueAsGuest() {
    if (!choiceItem || isLoggedIn || accessToken) {
      clearGuestCheckout();
      return;
    }
    setError(null);
    setGuestFormError(null);
    setGuestForm({ firstName: "", lastName: "", email: "", phone: "" });
    setGuestItem(choiceItem);
    setChoiceItem(null);
  }

  function submitGuestForm() {
    if (!guestItem || isLoggedIn || accessToken) {
      clearGuestCheckout();
      return;
    }
    const parsed = parseGuestCheckoutIdentity(guestForm);
    if (!parsed.ok) {
      setGuestFormError(parsed.error);
      return;
    }
    const item = guestItem;
    setGuestIdentity(parsed.identity);
    setGuestItem(null);
    setGuestFormError(null);
    setError(null);
    if (item.kind === "monthlyMembership" || isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode)) {
      setAgreeTerms(false);
      setAgreeBilling(false);
      setPendingMonthly(item);
      return;
    }
    void startGuestHostedCheckout(item, parsed.identity);
  }

  function submitMonthly() {
    if (!pendingMonthly) return;
    if (
      activeMonthlyMembership &&
      (isLoggedIn || accessToken) &&
      (pendingMonthly.kind === "monthlyMembership" ||
        isMonthlyHostedSku(pendingMonthly.localSku, pendingMonthly.kind, pendingMonthly.stripeMode))
    ) {
      setPendingMonthly(null);
      setError(ACTIVE_MONTHLY_MEMBERSHIP_COPY);
      return;
    }
    if (!agreeTerms || !agreeBilling) {
      setError("Please confirm the membership agreement and monthly billing.");
      return;
    }
    const extras = membershipConsentExtras(pendingMonthly);
    if (!extras) {
      setError("Membership terms are unavailable. Please try again later.");
      return;
    }
    const item = pendingMonthly;
    setPendingMonthly(null);
    if (!isLoggedIn && !accessToken && guestIdentity) {
      void startGuestHostedCheckout(item, guestIdentity, extras);
      return;
    }
    void startHostedMonthly(item, extras);
  }

  return (
    <div className="purchase-page">
      <AppHero />
      <p className="purchase-page__back">
        <Link to="/">Home</Link>
      </p>
      <header className="purchase-page__intro">
        <h2 className="purchase-page__title">Buy a pass</h2>
        <p className="purchase-page__lede">Memberships, flexible packs, and drop-ins.</p>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {note && <div className="wallet-banner">{note}</div>}
      {incompleteAccess && isLoggedIn && (
        <div className="wallet-banner wallet-banner--warn">
          Connect your studio profile before purchasing.{" "}
          <button type="button" className="amare-login__text-btn" onClick={signIn}>
            Continue
          </button>
        </div>
      )}
      {!isLoggedIn && (
        <div className="wallet-banner">
          Buy as a guest, or sign in to your AMARÉ account to use a linked membership.
        </div>
      )}
      {isLoggedIn && activeMonthlyMembership ? (
        <div className="wallet-banner">{ACTIVE_MONTHLY_MEMBERSHIP_COPY}</div>
      ) : null}

      {loading ? (
        <div className="spinner">Loading packages…</div>
      ) : (
        <>
          {purchaseGroups.length === 0 ? (
            <p className="card__meta">No packages are available.</p>
          ) : (
            purchaseGroups.map((group) => (
              <section key={group.id} className="purchase-group">
                <div className="purchase-group__head">
                  <h2>{group.title}</h2>
                  {group.id === "membership" ? (
                    <button
                      type="button"
                      className="purchase-benefits-btn"
                      onClick={() => setBenefitsOpen(true)}
                    >
                      See benefits
                    </button>
                  ) : null}
                </div>
                <ul className="purchase-list">
                  {group.items.map((item) => (
                    <PurchaseRow
                      key={item.localSku}
                      item={item}
                      busy={busySku === item.localSku}
                      signedIn={isLoggedIn}
                      blocked={
                        incompleteAccess ||
                        (activeMonthlyMembership &&
                          (item.kind === "monthlyMembership" ||
                            isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode)))
                      }
                      lockLabel={
                        activeMonthlyMembership &&
                        (item.kind === "monthlyMembership" ||
                          isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode))
                          ? "Contact studio"
                          : busySku === item.localSku
                            ? "Opening…"
                            : undefined
                      }
                      onSelect={() => onSelect(item)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}

      <MemberBenefitsDialog open={benefitsOpen} onClose={() => setBenefitsOpen(false)} />

      {choiceItem && (
        <div className="modal-backdrop" role="presentation" onClick={clearGuestCheckout}>
          <div
            className="modal card purchase-guest"
            role="dialog"
            aria-labelledby="purchase-choice-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="purchase-choice-title">How would you like to buy?</h2>
            <p className="card__meta">
              {choiceItem.shortName} · {formatCatalogPrice(choiceItem.amountCents, choiceItem.currency)}
              {choiceItem.kind === "monthlyMembership" ? " / month" : ""}
            </p>
            <p className="purchase-guest__lede">
              Purchase as a guest, or sign in to your AMARÉ account.
            </p>
            <div className="purchase-guest__actions">
              <button type="button" className="btn btn--cream" onClick={continueAsGuest}>
                Continue as guest
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  clearGuestCheckout();
                  signIn();
                }}
              >
                Sign in to your AMARÉ account
              </button>
            </div>
          </div>
        </div>
      )}

      {guestItem && (
        <div className="modal-backdrop" role="presentation" onClick={clearGuestCheckout}>
          <div
            className="modal card purchase-guest"
            role="dialog"
            aria-labelledby="purchase-guest-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="purchase-guest-title">Continue as guest</h2>
            <p className="card__meta">
              {guestItem.shortName} · {formatCatalogPrice(guestItem.amountCents, guestItem.currency)}
              {guestItem.kind === "monthlyMembership" ? " / month" : ""}
            </p>
            <form
              className="purchase-guest__form"
              onSubmit={(e) => {
                e.preventDefault();
                submitGuestForm();
              }}
            >
              <label htmlFor="guest-first-name">
                First name
                <input
                  id="guest-first-name"
                  type="text"
                  autoComplete="given-name"
                  maxLength={80}
                  value={guestForm.firstName}
                  onChange={(e) => setGuestForm((cur) => ({ ...cur, firstName: e.target.value }))}
                  required
                />
              </label>
              <label htmlFor="guest-last-name">
                Last name
                <input
                  id="guest-last-name"
                  type="text"
                  autoComplete="family-name"
                  maxLength={80}
                  value={guestForm.lastName}
                  onChange={(e) => setGuestForm((cur) => ({ ...cur, lastName: e.target.value }))}
                  required
                />
              </label>
              <label htmlFor="guest-email">
                Email
                <input
                  id="guest-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  maxLength={254}
                  value={guestForm.email}
                  onChange={(e) => setGuestForm((cur) => ({ ...cur, email: e.target.value }))}
                  required
                />
              </label>
              <label htmlFor="guest-phone">
                Phone
                <input
                  id="guest-phone"
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={32}
                  value={guestForm.phone}
                  onChange={(e) => setGuestForm((cur) => ({ ...cur, phone: e.target.value }))}
                  required
                />
              </label>
              {guestFormError ? <p className="amare-login__error">{guestFormError}</p> : null}
              <div className="modal__actions">
                <button type="button" className="btn btn--ghost" onClick={clearGuestCheckout}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--cream" disabled={busySku != null}>
                  Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingMonthly && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            setPendingMonthly(null);
            if (!isLoggedIn) clearGuestCheckout();
          }}
        >
          <div
            className="modal card purchase-consent"
            role="dialog"
            aria-labelledby="purchase-consent-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="purchase-consent__close"
              aria-label="Close"
              onClick={() => {
                setPendingMonthly(null);
                if (!isLoggedIn) clearGuestCheckout();
              }}
            >
              ×
            </button>
            <h2 id="purchase-consent-title">Membership contract</h2>
            <p className="purchase-consent__plan">
              {pendingMonthly.agreement?.marketingPlanName || pendingMonthly.displayName}
            </p>
            <p className="purchase-consent__price">
              {formatCatalogPrice(pendingMonthly.amountCents, pendingMonthly.currency)}/month
            </p>
            <p className="purchase-consent__lede">
              Everything you agree to is in the full agreement below.
            </p>
            {pendingMonthly.agreement?.termsHtml ? (
              <details className="purchase-consent__details">
                <summary>
                  Full membership agreement
                  <span>Click and scroll to read</span>
                </summary>
                <div
                  className="purchase-consent__terms"
                  dangerouslySetInnerHTML={{ __html: pendingMonthly.agreement.termsHtml }}
                />
              </details>
            ) : (
              <p className="card__meta">Membership terms could not be loaded.</p>
            )}
            <label className="purchase-consent__check">
              <input
                type="checkbox"
                checked={agreeTerms}
                onChange={(e) => setAgreeTerms(e.target.checked)}
              />
              <span>
                {pendingMonthly.agreement?.checkboxAgreementLabel ||
                  "I have read and agree to the Membership Agreement, cancellation policy, and recurring billing terms."}
              </span>
            </label>
            <label className="purchase-consent__check">
              <input
                type="checkbox"
                checked={agreeBilling}
                onChange={(e) => setAgreeBilling(e.target.checked)}
              />
              <span>
                {pendingMonthly.agreement?.checkboxBillingAuthLabel ||
                  "I authorize Amaré Wellness Studio to charge my selected payment method monthly until I cancel according to the membership terms."}
              </span>
            </label>
            <div className="purchase-consent__actions">
              <button
                type="button"
                className="btn btn--cream"
                disabled={!agreeTerms || !agreeBilling || busySku != null}
                onClick={submitMonthly}
              >
                Agree & Complete Purchase
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PurchaseRow({
  item,
  busy,
  signedIn,
  blocked,
  lockLabel,
  onSelect,
}: {
  item: PurchaseCatalogItem;
  busy: boolean;
  signedIn: boolean;
  blocked: boolean;
  lockLabel?: string;
  onSelect: () => void;
}) {
  const disabled = busy || !item.available || !item.checkoutEnabled || blocked;
  const price = formatCatalogPrice(item.amountCents, item.currency);
  const period = item.kind === "monthlyMembership" ? "/ mo" : "";
  let cta = "Buy";
  if (blocked) cta = lockLabel || "Unavailable";
  else if (!item.available) cta = "Unavailable";
  else if (!item.checkoutEnabled) cta = "Checkout off";
  else if (busy) cta = lockLabel || "Opening…";

  return (
    <li className="card purchase-item">
      <div className="purchase-item__copy">
        <h3>{item.shortName}</h3>
        <p className="purchase-item__price">
          {price}
          {period}
        </p>
        {item.description ? <p className="card__meta">{item.description}</p> : null}
        {item.oneTimePerClient ? <p className="purchase-item__note">First-time clients only.</p> : null}
      </div>
      <button type="button" className="btn btn--cream" disabled={disabled && signedIn} onClick={onSelect}>
        {cta}
      </button>
    </li>
  );
}
