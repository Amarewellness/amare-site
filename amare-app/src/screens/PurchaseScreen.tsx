import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPurchaseCatalog, formatCatalogPrice, type PurchaseCatalogItem } from "../api/catalog";
import { createHostedCheckoutSession, openHostedCheckoutUrl } from "../api/checkout";
import { ApiError } from "../api/client";
import { fetchMobileOrderStatus, fetchMobilePendingOrders, prepareMobilePayment } from "../api/mobile-payments";
import { useAuth } from "../auth/AuthContext";
import { useMemberSummary } from "../hooks/useMemberSummary";
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
  const { reload } = useMemberSummary();
  const [items, setItems] = useState<PurchaseCatalogItem[]>([]);
  const [groupTitles, setGroupTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [uiState, setUiState] = useState<PurchaseUiState>("idle");
  const [pendingMonthly, setPendingMonthly] = useState<PurchaseCatalogItem | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeBilling, setAgreeBilling] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const resumed = useRef(false);
  const pollStop = useRef(false);
  const presentingRef = useRef(false);
  const [sheetActive, setSheetActive] = useState(false);

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
        const titles: Record<string, string> = {};
        for (const group of data.groups || []) {
          titles[group.id] = group.title;
          for (const item of group.items || []) next.push(item);
        }
        setItems(next);
        setGroupTitles(titles);
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

  const oneTime = useMemo(
    () => items.filter((i) => i.kind !== "monthlyMembership"),
    [items],
  );
  const monthly = useMemo(
    () => items.filter((i) => i.kind === "monthlyMembership"),
    [items],
  );

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

  async function startHostedMonthly(item: PurchaseCatalogItem, extras: Record<string, unknown> = {}) {
    if (!accessToken) {
      signIn();
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
    if (!isLoggedIn) {
      signIn();
      return;
    }
    if (incompleteAccess) {
      setError("Finish connecting your studio profile before purchasing.");
      return;
    }
    if (!item.available || !item.checkoutEnabled) {
      setError("This package is not available for checkout right now.");
      return;
    }
    if (uiState === "sync_unknown") return;
    if (presentingRef.current || (attemptLocked && isPaymentSheetSku(item.localSku))) return;
    if (item.kind === "monthlyMembership" || isMonthlyHostedSku(item.localSku, item.kind, item.stripeMode)) {
      setAgreeTerms(false);
      setAgreeBilling(false);
      setLegalName("");
      setPendingMonthly(item);
      return;
    }
    void startOneTimePaymentSheet(item);
  }

  function submitMonthly() {
    if (!pendingMonthly) return;
    if (!agreeTerms || !agreeBilling) {
      setError("Please confirm the membership agreement and monthly billing.");
      return;
    }
    const agreement = pendingMonthly.agreement;
    if (!agreement?.contractVersion || !agreement.termsHtml) {
      setError("Membership terms are unavailable. Please try again later.");
      return;
    }
    const item = pendingMonthly;
    setPendingMonthly(null);
    void startHostedMonthly(item, {
      requiresMembershipAgreement: true,
      membershipAgreementAccepted: true,
      membershipBillingAuthorized: true,
      membershipTermsContractVersion: agreement.contractVersion,
      membershipTermsDisplayedHtml: agreement.termsHtml,
      ...(legalName.trim() ? { membershipFullLegalName: legalName.trim() } : {}),
    });
  }

  const statusCopy = purchaseStatusCopy(uiState);

  return (
    <div className="purchase-page">
      <p className="purchase-page__back">
        <Link to="/">Home</Link>
      </p>
      <h1 className="schedule-page__title">Buy a pass</h1>
      <p className="purchase-page__lede">
        One-time packs use in-app checkout on Android. Monthly memberships open AMARÉ Checkout.
        Prices come from the studio catalog.
      </p>

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
          Sign in to buy. You can still browse packages below.
        </div>
      )}

      {loading ? (
        <div className="spinner">Loading packages…</div>
      ) : (
        <>
          <section className="purchase-group">
            <h2>{groupTitles.one_time || "One-time"}</h2>
            {oneTime.length === 0 ? (
              <p className="card__meta">No one-time packages are available.</p>
            ) : (
              <ul className="purchase-list">
                {oneTime.map((item) => (
                  <PurchaseRow
                    key={item.localSku}
                    item={item}
                    busy={busySku === item.localSku || (attemptLocked && isPaymentSheetSku(item.localSku))}
                    signedIn={isLoggedIn}
                    blocked={incompleteAccess || uiState === "sync_unknown"}
                    lockLabel={rowLockLabel(uiState, busySku === item.localSku)}
                    onSelect={() => onSelect(item)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="purchase-group">
            <h2>{groupTitles.monthly || "Monthly"}</h2>
            {monthly.length === 0 ? (
              <p className="card__meta">No monthly memberships are available.</p>
            ) : (
              <ul className="purchase-list">
                {monthly.map((item) => (
                  <PurchaseRow
                    key={item.localSku}
                    item={item}
                    busy={busySku === item.localSku}
                    signedIn={isLoggedIn}
                    blocked={incompleteAccess || uiState === "sync_unknown"}
                    lockLabel={uiState === "sync_unknown" ? "Unavailable" : undefined}
                    onSelect={() => onSelect(item)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {pendingMonthly && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingMonthly(null)}>
          <div
            className="modal card purchase-consent"
            role="dialog"
            aria-labelledby="purchase-consent-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="purchase-consent-title">{pendingMonthly.agreement?.title || "Membership agreement"}</h2>
            <p className="card__meta">
              {pendingMonthly.displayName} ·{" "}
              {formatCatalogPrice(pendingMonthly.amountCents, pendingMonthly.currency)} / month
            </p>
            {pendingMonthly.agreement?.summaryLines?.length ? (
              <ul className="purchase-consent__summary">
                {pendingMonthly.agreement.summaryLines.map((line) => (
                  <li key={line}>{line.replace(/\*\*/g, "")}</li>
                ))}
              </ul>
            ) : null}
            {pendingMonthly.agreement?.termsHtml ? (
              <div
                className="purchase-consent__terms"
                dangerouslySetInnerHTML={{ __html: pendingMonthly.agreement.termsHtml }}
              />
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
                  "I have read and agree to the Membership Agreement."}
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
                  "I authorize recurring monthly billing."}
              </span>
            </label>
            <label className="purchase-consent__name">
              Legal name (optional)
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                autoComplete="name"
              />
            </label>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setPendingMonthly(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                disabled={!agreeTerms || !agreeBilling || busySku != null || uiState === "sync_unknown"}
                onClick={submitMonthly}
              >
                Continue to checkout
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
  if (!signedIn) cta = "Sign in to buy";
  else if (blocked) cta = lockLabel || "Unavailable";
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
      <button type="button" className="btn" disabled={disabled && signedIn} onClick={onSelect}>
        {cta}
      </button>
    </li>
  );
}
