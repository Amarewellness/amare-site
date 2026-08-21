import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPurchaseCatalog, formatCatalogPrice, type PurchaseCatalogItem } from "../api/catalog";
import { createHostedCheckoutSession, openHostedCheckoutUrl } from "../api/checkout";
import { ApiError } from "../api/client";
import { fetchMobileOrderStatus, fetchMobilePendingOrders, prepareMobilePayment } from "../api/mobile-payments";
import { useAuth } from "../auth/AuthContext";
import { AppHero } from "../components/AppHero";
import { MemberBenefitsDialog } from "../components/MemberBenefitsDialog";
import { useMemberSummary } from "../hooks/useMemberSummary";
import {
  ACTIVE_MONTHLY_MEMBERSHIP_COPY,
  hasActiveMonthlyMembership,
} from "../lib/member-profile-utils";
import {
  parseGuestCheckoutIdentity,
  type GuestCheckoutIdentity,
} from "../lib/guest-checkout";
import { purchaseAttemptIdForSku, clearPurchaseAttemptId, restorePurchaseAttemptId } from "../lib/purchase-attempt";
import {
  clearPendingMobilePurchase,
  loadPendingMobilePurchase,
  savePendingMobilePurchase,
} from "../lib/pending-mobile-purchase";
import {
  pickUnresolvedMobileOrder,
  recoveryFromMobileStatus,
  sanitizePendingMobilePurchase,
  shouldCreateNewChargeAfterRestart,
} from "../lib/purchase-recovery";
import {
  groupPurchaseItems,
  isMonthlyHostedSku,
  isPaymentSheetSku,
  nextStateAfterStatusPoll,
  type PurchaseUiState,
} from "../lib/purchase-flow";
import { getActiveOneTimeCheckout, setActiveOneTimeCheckout } from "../lib/purchase-session";
import { nativePaymentSheetAvailable, presentNativePaymentSheet } from "../plugins/amare-stripe-payment";

const POLL_MS = 2000;
const POLL_MAX = 90;

export function PurchaseScreen() {
  const { accessToken, isLoggedIn, signIn, profile } = useAuth();
  const { reload, summary } = useMemberSummary();
  const activeMonthlyMembership = useMemo(() => hasActiveMonthlyMembership(summary), [summary]);
  const [items, setItems] = useState<PurchaseCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [uiState, setUiState] = useState<PurchaseUiState>("idle");
  const [pendingMonthly, setPendingMonthly] = useState<PurchaseCatalogItem | null>(null);
  const [choiceItem, setChoiceItem] = useState<PurchaseCatalogItem | null>(null);
  const [guestItem, setGuestItem] = useState<PurchaseCatalogItem | null>(null);
  const [guestForm, setGuestForm] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [guestIdentity, setGuestIdentity] = useState<GuestCheckoutIdentity | null>(null);
  const [guestFormError, setGuestFormError] = useState<string | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeBilling, setAgreeBilling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const resumed = useRef(false);
  const pollStop = useRef(false);
  const presentingRef = useRef(false);
  const [sheetActive, setSheetActive] = useState(false);
  const [benefitsOpen, setBenefitsOpen] = useState(false);

  const incompleteAccess =
    profile?.studioAccess === "candidate" ||
    profile?.studioAccess === "needs_profile" ||
    profile?.studioAccess === "ambiguous" ||
    profile?.studioAccess === "conflict";

  const attemptLocked =
    sheetActive ||
    uiState === "preparing" ||
    uiState === "payment_sheet_open" ||
    uiState === "payment_completed_processing" ||
    uiState === "sync_unknown";

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

  useEffect(() => {
    return () => {
      pollStop.current = true;
    };
  }, []);

  useEffect(() => {
    if (resumed.current || !accessToken) return;
    resumed.current = true;
    pollStop.current = false;
    void recoverOwnedPurchase(accessToken);
  }, [accessToken]);

  async function applyFulfillmentSuccess(sku: string) {
    setActiveOneTimeCheckout(null);
    clearPurchaseAttemptId(sku);
    await clearPendingMobilePurchase();
    await reload();
    setUiState("success");
    setBusySku(null);
    setNote("Your package is ready.");
  }

  async function recoverOwnedPurchase(token: string) {
    if (shouldCreateNewChargeAfterRestart()) return;
    let recovered = pickUnresolvedMobileOrder([]);
    try {
      const listed = await fetchMobilePendingOrders(token);
      recovered = pickUnresolvedMobileOrder(listed.orders || []);
    } catch {
      recovered = null;
    }
    if (!recovered?.orderId) {
      const local = await loadPendingMobilePurchase();
      if (local) {
        recovered = {
          orderId: local.orderId,
          localSku: local.sku,
          purchaseAttemptId: local.purchaseAttemptId,
          createdAt: local.createdAt,
        };
      }
    }
    if (!recovered?.orderId) {
      const existing = getActiveOneTimeCheckout();
      if (existing) {
        setBusySku(existing.sku);
        setUiState("payment_completed_processing");
        setNote("Payment received. We're finishing your package setup…");
        await pollForFulfillment(existing.sku, existing.orderId, token);
      }
      return;
    }

    let status;
    try {
      status = await fetchMobileOrderStatus(token, recovered.orderId);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        await clearPendingMobilePurchase();
        if (recovered.localSku) clearPurchaseAttemptId(recovered.localSku);
        return;
      }
      const local = await loadPendingMobilePurchase();
      if (local) {
        setBusySku(local.sku);
        setUiState("payment_completed_processing");
        setNote("Payment received. We're finishing your package setup…");
        await pollForFulfillment(local.sku, local.orderId, token);
      }
      return;
    }

    const sku = status.localSku || recovered.localSku || "";
    const attemptId = status.purchaseAttemptId || recovered.purchaseAttemptId || "";
    if (sku && attemptId) restorePurchaseAttemptId(sku, attemptId);
    const pending = sanitizePendingMobilePurchase({
      orderId: status.orderId || recovered.orderId,
      purchaseAttemptId: attemptId,
      sku,
      createdAt: recovered.createdAt || new Date().toISOString(),
    });
    if (pending) await savePendingMobilePurchase(pending);

    const decision = recoveryFromMobileStatus({
      ...status,
      mindbodySyncStatus: status.mindbodySyncStatus,
    });
    if (decision.clearPending) {
      await clearPendingMobilePurchase();
      if (sku) clearPurchaseAttemptId(sku);
    }
    if (decision.ui === "success") {
      await applyFulfillmentSuccess(sku);
      return;
    }
    if (decision.ui === "sync_unknown") {
      setBusySku(null);
      setUiState("sync_unknown");
      setNote("Your payment was received. We're confirming your class credits.");
      setError(null);
      return;
    }
    if (decision.ui === "failed") {
      setBusySku(null);
      setUiState("failed");
      setError("We received your payment but could not finish setup. Please contact the studio.");
      setNote(null);
      return;
    }
    if (decision.pollStatus && sku && recovered.orderId) {
      setBusySku(sku);
      setActiveOneTimeCheckout({ sku, orderId: recovered.orderId });
      setUiState("payment_completed_processing");
      setNote("Payment received. We're finishing your package setup…");
      await pollForFulfillment(sku, recovered.orderId, token);
    }
  }

  async function pollForFulfillment(sku: string, orderId: string, token: string) {
    for (let i = 0; i < POLL_MAX; i += 1) {
      if (pollStop.current) return;
      try {
        const status = await fetchMobileOrderStatus(token, orderId);
        const next = nextStateAfterStatusPoll(status);
        if (next === "success") {
          await applyFulfillmentSuccess(sku);
          return;
        }
        if (next === "sync_unknown") {
          setUiState("sync_unknown");
          setBusySku(null);
          setNote("Your payment was received. We're confirming your class credits.");
          setError(null);
          return;
        }
        if (next === "failed") {
          setUiState("failed");
          setBusySku(null);
          setError("We received your payment but could not finish setup. Please contact the studio.");
          setNote(null);
          return;
        }
      } catch {
        /* keep polling; webhook is the authority */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    setUiState("payment_completed_processing");
    setNote("Payment received. We're still confirming your class credits.");
  }

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

  async function startHostedMonthly(item: PurchaseCatalogItem, extras: Record<string, unknown> = {}) {
    if (!accessToken) {
      signIn();
      return;
    }
    if (activeMonthlyMembership) {
      setError(ACTIVE_MONTHLY_MEMBERSHIP_COPY);
      return;
    }
    setBusySku(item.localSku);
    setError(null);
    setNote(null);
    try {
      const session = await createHostedCheckoutSession(accessToken, {
        localSku: item.localSku,
        ctaLocation: "app_purchase",
        idempotencyKey: purchaseAttemptIdForSku(`hosted:${item.localSku}`),
        ...extras,
      });
      if (!session.url) throw new Error("Checkout did not return a URL.");
      await openHostedCheckoutUrl(session.url, () => {
        void reload();
      });
      setNote("If you finished payment, credits usually appear within a minute. Pull to refresh Profile if needed.");
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
    } finally {
      setBusySku(null);
    }
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
    setBusySku(item.localSku);
    setError(null);
    setNote(null);
    try {
      const session = await createHostedCheckoutSession(null, {
        localSku: item.localSku,
        ctaLocation: "app_purchase",
        idempotencyKey: purchaseAttemptIdForSku(`hosted-guest:${item.localSku}`),
        guest: identity,
        ...extras,
      });
      if (!session.url) throw new Error("Checkout did not return a URL.");
      clearGuestCheckout();
      await openHostedCheckoutUrl(session.url);
      setNote("Complete checkout in the browser. After payment, confirmation is emailed to you.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
    } finally {
      setBusySku(null);
    }
  }

  async function startOneTimePaymentSheet(item: PurchaseCatalogItem) {
    if (!accessToken) {
      signIn();
      return;
    }
    if (presentingRef.current) return;
    presentingRef.current = true;
    setSheetActive(true);
    if (!isPaymentSheetSku(item.localSku)) {
      presentingRef.current = false;
      setSheetActive(false);
      setError("This package is not available for in-app checkout.");
      return;
    }
    if (!nativePaymentSheetAvailable()) {
      presentingRef.current = false;
      setSheetActive(false);
      setError("Card and Google Pay checkout is available in the AMARÉ Android app.");
      return;
    }

    const purchaseAttemptId = purchaseAttemptIdForSku(item.localSku);
    setBusySku(item.localSku);
    setError(null);
    setNote(null);
    setUiState("preparing");
    try {
      const prepared = await prepareMobilePayment(accessToken, {
        sku: item.localSku,
        purchaseAttemptId,
      });
      if (!prepared.publishableKey || !prepared.paymentIntentClientSecret || !prepared.orderId) {
        throw new Error("Checkout is missing payment configuration.");
      }
      await savePendingMobilePurchase({
        orderId: prepared.orderId,
        purchaseAttemptId,
        sku: item.localSku,
        createdAt: new Date().toISOString(),
      });
      setUiState("payment_sheet_open");
      const sheet = await presentNativePaymentSheet({
        publishableKey: prepared.publishableKey,
        clientSecret: prepared.paymentIntentClientSecret,
        merchantDisplayName: prepared.merchantDisplayName || "AMARÉ",
      });
      if (sheet.status === "ignored") {
        if (import.meta.env.DEV) console.debug("payment_sheet_busy ignored");
        return;
      }
      if (sheet.status === "canceled") {
        setUiState("canceled");
        setBusySku(null);
        setNote("Payment canceled. You can try again.");
        return;
      }
      if (sheet.status !== "completed") {
        setUiState("failed");
        setBusySku(null);
        setError(sheet.message || "Payment did not complete.");
        return;
      }
      setActiveOneTimeCheckout({ sku: item.localSku, orderId: prepared.orderId });
      setUiState("payment_completed_processing");
      setNote("Payment received. We're finishing your package setup…");
      await pollForFulfillment(item.localSku, prepared.orderId, accessToken);
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      if (raw === "payment_sheet_busy") {
        if (import.meta.env.DEV) console.debug("payment_sheet_busy ignored");
        return;
      }
      setUiState("failed");
      setBusySku(null);
      setError("Could not start checkout.");
    } finally {
      presentingRef.current = false;
      setSheetActive(false);
    }
  }

  function onSelect(item: PurchaseCatalogItem) {
    if (!item.available || !item.checkoutEnabled) {
      setError("This package is not available for checkout right now.");
      return;
    }
    if (uiState === "sync_unknown") return;
    if (presentingRef.current || (attemptLocked && isPaymentSheetSku(item.localSku))) return;

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
    void startOneTimePaymentSheet(item);
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

  const statusCopy = purchaseStatusCopy(uiState);

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
      {(note || statusCopy) && uiState !== "failed" && (
        <div className={uiState === "success" ? "success-banner" : "wallet-banner"}>{note || statusCopy}</div>
      )}
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
                      busy={busySku === item.localSku || (attemptLocked && isPaymentSheetSku(item.localSku))}
                      signedIn={isLoggedIn}
                      blocked={
                        incompleteAccess ||
                        uiState === "sync_unknown" ||
                        (activeMonthlyMembership &&
                          (item.kind === "monthlyMembership" ||
                            isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode)))
                      }
                      lockLabel={
                        activeMonthlyMembership &&
                        (item.kind === "monthlyMembership" ||
                          isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode))
                          ? "Contact studio"
                          : rowLockLabel(uiState, busySku === item.localSku)
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
                disabled={!agreeTerms || !agreeBilling || busySku != null || uiState === "sync_unknown"}
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

function purchaseStatusCopy(state: PurchaseUiState): string | null {
  if (state === "preparing") return "Preparing payment…";
  if (state === "payment_sheet_open") return "Complete payment in the sheet.";
  if (state === "payment_completed_processing") return "Payment received. We're finishing your package setup…";
  if (state === "sync_unknown") return "Your payment was received. We're confirming your class credits.";
  return null;
}

function rowLockLabel(state: PurchaseUiState, thisSkuBusy: boolean): string | undefined {
  if (state === "sync_unknown") return "Unavailable";
  if (state === "preparing" && thisSkuBusy) return "Preparing…";
  if (state === "payment_sheet_open" && thisSkuBusy) return "Pay…";
  if (state === "payment_completed_processing") return "Confirming…";
  return undefined;
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
