/**
 * Static-card → Stripe Express Checkout (lightweight handler).
 *
 * Used by any page that ships a static promo card (price + features in HTML) and
 * wants Buy Now to open the same Stripe Express Checkout dialog as `/pricing`,
 * without loading the full `pricing-api.js` (which fetches Mindbody catalogs,
 * parses contract terms, etc.).
 *
 * Currently used on:
 *   • `/index.html` — homepage NCS promo
 *   • `/first-visit.html` — first-visit landing card
 *   • (any future static card landing page)
 *
 * `/pricing` does NOT load this script — its static NCS card uses
 * `pricing-api.js`'s native `[data-mb-checkout]` delegation instead, since
 * `pricing-api.js` is already loaded there for the dynamic monthly/packs/drop-ins.
 *
 * What this script does:
 *   • Listens (delegated on `document`) for clicks on `[data-mb-fv-buy="<localSku>"]`
 *     buttons anywhere on the page.
 *   • Resolves SKU label from the embedded `mb-stripe-onetime-config` JSON blob
 *     (must be present on the page — the build replaces it from
 *     `stripeOneTimeConfigJson()`).
 *   • Opens the shared `#mb-pricing-checkout-dialog` Express chooser dialog (must
 *     also be present on the page).
 *   • POSTs to `/api/stripe/checkout/create-session` with the SKU + cta location.
 *   • Redirects to the returned Stripe Checkout URL on success, surfaces a
 *     human-readable error + Mindbody Classic fallback on failure.
 *
 * Per-button data attributes:
 *   • `data-mb-fv-buy="<localSku>"` (required) — must match `expressEnabledSkus`.
 *   • `data-mb-fv-price="$XX"` (optional) — label shown inside the dialog header.
 *   • `data-mb-fv-classic="<URL>"` (optional) — Mindbody Classic fallback link
 *     inside the dialog and on errors.
 *   • `data-cta-location="<key>"` (optional) — GA4 location label; defaults to
 *     `static_card_express`.
 *
 * Pricing on the page is rendered statically in HTML for speed — keep it in sync
 * with `netlify/functions/_embedded/stripe-mindbody-catalog.config.json` (the
 * server-side source of truth that determines the actual Stripe charge). See
 * `docs/MINDBODY-CHECKOUT-OVERVIEW.md` → "Maintenance runbook".
 */
(function stripeExpressCtaBootstrap() {
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById("mb-pricing-checkout-dialog"));
  const dlgBody = document.getElementById("mb-pricing-checkout-body");
  const dlgActions = document.getElementById("mb-pricing-checkout-actions");
  const cfgEl = document.getElementById("mb-stripe-onetime-config");
  if (!dlg || !dlgBody || !dlgActions || !cfgEl) return;

  /** @type {{ apiPath?: string, expressEnabledSkus?: Array<{ localSku: string, displayName: string }> } | null} */
  let cfg = null;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch {
    cfg = null;
  }
  if (!cfg || !Array.isArray(cfg.expressEnabledSkus)) return;
  const skus = cfg.expressEnabledSkus;
  const apiPath = typeof cfg.apiPath === "string" && cfg.apiPath ? cfg.apiPath : "/api/stripe/checkout/create-session";

  /**
   * Schedule-proxy origin (empty = same-origin /api/...). Read from any element on the
   * page that carries `data-mb-proxy` — usually `#mb-pricing-root` or `#mb-fv-root`,
   * but we don't care which page wraps it. Mirrors the resolution in `pricing-api.js`.
   */
  function readMbProxyRaw() {
    const holder = document.querySelector("[data-mb-proxy]");
    if (!(holder instanceof HTMLElement)) return "";
    const raw = typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
    return raw;
  }

  function mbApiPath(/** @type {string} */ p) {
    const raw = readMbProxyRaw().replace(/\/$/, "");
    const path = p.startsWith("/") ? p : `/${p}`;
    return raw ? `${raw}${path}` : path;
  }

  /** Ngrok Free returns an HTML interstitial without this header on API fetches. */
  function fetchHeaders() {
    /** @type {Record<string, string>} */
    const out = { "Content-Type": "application/json", Accept: "application/json" };
    let host = "";
    try {
      const raw = readMbProxyRaw();
      host = raw ? new URL(raw, window.location.href).hostname : window.location.hostname;
    } catch {
      host = typeof window !== "undefined" ? window.location.hostname : "";
    }
    if (host && host.includes("ngrok")) out["ngrok-skip-browser-warning"] = "true";
    return out;
  }

  function ga4Event(/** @type {string} */ name, /** @type {Record<string, unknown>} */ params) {
    try {
      const w = /** @type {{ gtag?: (...args: unknown[]) => void }} */ (window);
      if (typeof w.gtag === "function") w.gtag("event", name, params || {});
    } catch {
      /** ignore */
    }
  }

  function escapeHtml(/** @type {unknown} */ s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => {
      switch (m) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return m;
      }
    });
  }

  /** Wire close X once the dialog is in the DOM (idempotent guard via dataset). */
  function ensureDialogCloseWired() {
    if (dlg.dataset.mbStripeCtaCloseWired === "1") return;
    dlg.dataset.mbStripeCtaCloseWired = "1";
    const xBtn = dlg.querySelector("[data-mb-pricing-close]");
    if (xBtn instanceof HTMLElement) {
      xBtn.addEventListener("click", () => {
        try {
          dlg.close();
        } catch {
          /** ignore */
        }
      });
    }
  }

  /**
   * Show the chooser dialog: primary Express CTA + quiet Mindbody Classic fallback link.
   * @param {{ localSku: string, displayName: string }} match
   * @param {string} priceLabel
   * @param {string} classicHref
   * @param {string} ctaLocation
   */
  function showChooser(match, priceLabel, classicHref, ctaLocation) {
    dlgBody.innerHTML =
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(match.displayName)}</strong>${
        priceLabel ? ` · ${escapeHtml(priceLabel)}` : ""
      }</p>` +
      `<p class="mb-book-dialog__sub">Pay easily with Apple Pay, Google Pay, Link, or card.</p>`;
    dlgActions.innerHTML =
      `<div class="mb-book-dialog__cta-row mb-book-dialog__cta-row--single">` +
      `<button type="button" class="btn btn--cream mb-book-dialog__cta-stack" data-mb-stripe-express="1">` +
      `<span class="mb-book-dialog__cta-title">Express checkout</span>` +
      `<span class="mb-book-dialog__cta-meta">Apple Pay, Google Pay or card</span>` +
      `</button></div>` +
      (classicHref
        ? `<p class="mb-book-dialog__quiet">Prefer the classic flow? <a href="${escapeHtml(classicHref)}" target="_blank" rel="noopener noreferrer" data-mb-fv-classic-fallback="1">Continue to Mindbody</a>.</p>`
        : "");

    ensureDialogCloseWired();
    try {
      if (typeof dlg.showModal === "function") dlg.showModal();
    } catch {
      /** ignore — dialog already open */
    }

    const expressBtn = dlgActions.querySelector("[data-mb-stripe-express]");
    if (expressBtn instanceof HTMLElement) {
      expressBtn.addEventListener(
        "click",
        () => {
          dlgBody.innerHTML =
            `<p class="mb-book-dialog__lead"><strong>${escapeHtml(match.displayName)}</strong>${
              priceLabel ? ` · ${escapeHtml(priceLabel)}` : ""
            }</p>` +
            `<div class="mb-pricing-checkout-loader" role="status" aria-live="polite" aria-busy="true">` +
            `<span class="mb-pricing-checkout-loader__spinner" aria-hidden="true"></span>` +
            `<p class="mb-pricing-checkout-loader__label">Opening Stripe…</p></div>`;
          dlgActions.innerHTML = "";
          void startStripeCheckout(match, classicHref, ctaLocation);
        },
        { once: true },
      );
    }
  }

  /**
   * @param {{ localSku: string, displayName: string }} match
   * @param {string} classicHref
   * @param {string} ctaLocation
   */
  async function startStripeCheckout(match, classicHref, ctaLocation) {
    ga4Event("stripe_checkout_started", {
      local_sku: match.localSku,
      cta_location: ctaLocation,
      sku_label: match.displayName,
      sku_type: "package",
      mindbody_logged_in: "0",
    });

    let res;
    try {
      res = await fetch(mbApiPath(apiPath), {
        method: "POST",
        credentials: "include",
        headers: fetchHeaders(),
        body: JSON.stringify({
          localSku: match.localSku,
          ctaLocation: ctaLocation,
          pageLocation: (window.location.href || "").slice(0, 200),
        }),
      });
    } catch {
      ga4Event("stripe_checkout_failed_to_start", { local_sku: match.localSku, error: "network_error" });
      renderError(match, classicHref, "We couldn't reach the express checkout service. Please try again or use Mindbody classic checkout below.");
      return;
    }

    let txt = "";
    try {
      txt = await res.text();
    } catch {
      txt = "";
    }
    /** @type {unknown} */
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      json = null;
    }
    const obj = json && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : null;
    if (!res.ok || !obj || obj.ok !== true || typeof obj.url !== "string" || !obj.url) {
      const errCode = obj && typeof obj.error === "string" ? obj.error : "unknown";
      ga4Event("stripe_checkout_failed_to_start", {
        local_sku: match.localSku,
        error: errCode,
        http_status: String(res.status || 0),
      });
      let humanMsg = "We couldn't start express checkout right now.";
      if (errCode === "ncs_already_used") {
        humanMsg = "This studio account already has a New Client Special on file. Please choose a different package.";
      } else if (errCode === "stripe_one_time_checkout_disabled") {
        humanMsg = "Express checkout is not active right now. Use Mindbody classic checkout below.";
      } else if (errCode === "sku_not_enabled_for_express_checkout") {
        humanMsg = "Express checkout is not available for this package. Use Mindbody classic below.";
      }
      renderError(match, classicHref, humanMsg);
      return;
    }

    ga4Event("stripe_checkout_redirected", {
      local_sku: match.localSku,
      order_id: typeof obj.orderId === "string" ? obj.orderId : undefined,
    });
    /** Top-level redirect — Stripe hosted Checkout shows Apple Pay / Google Pay / card / Link. */
    window.location.assign(String(obj.url));
  }

  /**
   * @param {{ localSku: string, displayName: string }} match
   * @param {string} classicHref
   * @param {string} msg
   */
  function renderError(match, classicHref, msg) {
    dlgBody.innerHTML =
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(match.displayName)}</strong></p>` +
      `<p class="mb-book-dialog__sub">${escapeHtml(msg)}</p>`;
    dlgActions.innerHTML = classicHref
      ? `<div class="mb-book-dialog__cta-row"><a class="btn btn--cream" href="${escapeHtml(classicHref)}" target="_blank" rel="noopener noreferrer">Mindbody classic checkout</a></div>`
      : "";
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest("[data-mb-fv-buy]");
    if (!(btn instanceof HTMLElement)) return;
    const sku = btn.getAttribute("data-mb-fv-buy") || "";
    const match = skus.find((s) => s && typeof s.localSku === "string" && s.localSku === sku);
    if (!match) return;
    ev.preventDefault();
    const priceLabel = btn.getAttribute("data-mb-fv-price") || "";
    const classicHref = btn.getAttribute("data-mb-fv-classic") || "";
    const ctaLocation = btn.getAttribute("data-cta-location") || "static_card_express";
    ga4Event("buy_package_click", {
      local_sku: match.localSku,
      sku_label: match.displayName,
      cta_location: ctaLocation,
    });
    showChooser({ localSku: match.localSku, displayName: match.displayName }, priceLabel, classicHref, ctaLocation);
  });
})();
