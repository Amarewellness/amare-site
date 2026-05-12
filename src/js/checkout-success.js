/**
 * /checkout/success — read order status from the server (read-only). Never fulfills here;
 * the Stripe webhook is the source of truth.
 *
 * Polls a few times with backoff so customers see "synced" instead of "pending" if the webhook
 * fires within a few seconds.
 *
 * Onboarding: when the webhook created a brand-new Mindbody client for this order, the API
 * surfaces `clientWasNewlyCreated:true`. That buyer can't sign in to book yet — but they don't
 * need a password reset link either: Mindbody Identity prompts first-time clients to create a
 * password automatically on their first sign-in. So we swap the primary CTA from "Book a class"
 * → "Sign in with Mindbody" and explain the "create password on first sign-in" flow. Existing/
 * logged-in clients keep the regular "Book a class" CTA.
 */
(function checkoutSuccessBootstrap() {
  var mount = document.querySelector("[data-checkout-mount]");
  if (!mount) return;
  var card = mount.querySelector("[data-checkout-card]");
  var leadEl = mount.querySelector("[data-checkout-lead]");
  var detailEl = mount.querySelector("[data-checkout-detail]");
  var metaEl = mount.querySelector("[data-checkout-meta]");
  var orderEl = mount.querySelector("[data-checkout-order]");
  var packageEl = mount.querySelector("[data-checkout-package]");
  var amountEl = mount.querySelector("[data-checkout-amount]");

  var onboardingEl = mount.querySelector("[data-checkout-onboarding]");
  var onboardingTitleEl = mount.querySelector("[data-checkout-onboarding-title]");
  var onboardingBodyEl = mount.querySelector("[data-checkout-onboarding-body]");
  var onboardingHintEl = mount.querySelector("[data-checkout-onboarding-hint]");
  var onboardingEmailEl = mount.querySelector("[data-checkout-onboarding-email]");
  var onboardingEmailHintEl = mount.querySelector("[data-checkout-onboarding-email-hint]");
  var ctaPrimaryEl = mount.querySelector("[data-checkout-cta-primary]");
  var ctaSecondaryEl = mount.querySelector("[data-checkout-cta-secondary]");

  var url;
  try {
    url = new URL(window.location.href);
  } catch (e) {
    return;
  }
  var orderId = (url.searchParams.get("orderId") || "").trim();
  var sessionId = (url.searchParams.get("session_id") || "").trim();

  function ga(eventName, params) {
    if (typeof window.gtag !== "function") return;
    try {
      var payload = {
        page_location: window.location.href,
        page_title: document.title || "",
      };
      if (params) {
        Object.keys(params).forEach(function (k) {
          var v = params[k];
          if (v !== undefined && v !== null && String(v).trim() !== "") payload[k] = String(v).trim();
        });
      }
      window.gtag("event", eventName, payload);
    } catch (e) {
      /* noop */
    }
  }

  ga("stripe_payment_success_page_view", {
    order_id: orderId || undefined,
    session_id: sessionId || undefined,
  });

  function setBucket(bucket) {
    if (card && card.setAttribute) card.setAttribute("data-bucket", bucket || "unknown");
  }

  function setText(el, value) {
    if (el && typeof value === "string") el.textContent = value;
  }

  function formatMoney(cents, currency) {
    if (typeof cents !== "number" || !isFinite(cents)) return "";
    var amount = cents / 100;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: (currency || "USD").toUpperCase(),
      }).format(amount);
    } catch (e) {
      return "$" + amount.toFixed(2);
    }
  }

  /**
   * Build the Sign-in-with-Mindbody URL.
   *
   *  • return — send the buyer back to /classes after OAuth so they can immediately book the
   *    package they just bought.
   *  • login_hint — pre-fill the email on Mindbody Identity so the buyer signs in as the exact
   *    client we just created (not a different Mindbody account).
   *  • prompt=login — force the credentials screen even if Mindbody Identity has an SSO cookie
   *    for a different account in this browser. Otherwise Mindbody could silently resume the
   *    previous session and the wallet would show a different client's data.
   *
   * @param {string} email
   */
  function buildSignInHref(email) {
    var ret = "/classes";
    var qs = "return=" + encodeURIComponent(ret);
    if (typeof email === "string" && email.indexOf("@") > 0) {
      qs += "&login_hint=" + encodeURIComponent(email);
      qs += "&prompt=login";
    }
    return "/api/mindbody/oauth/start?" + qs;
  }

  /**
   * Pick the buyer's email for display. The success URL holds an unguessable session_id / orderId
   * so only the buyer reaches this page; we show the full address so they can confirm which inbox
   * they used. Falls back to the server-masked form if for some reason the raw field is absent.
   *
   * @param {{ customerEmail?: unknown; customerEmailMasked?: unknown } | null} o
   * @returns {string}
   */
  function safeDisplayEmail(o) {
    if (!o) return "";
    if (typeof o.customerEmail === "string" && o.customerEmail.indexOf("@") > 0) {
      return o.customerEmail;
    }
    if (typeof o.customerEmailMasked === "string" && o.customerEmailMasked) {
      return o.customerEmailMasked;
    }
    return "";
  }

  function setCta(el, label, href) {
    if (!el) return;
    if (typeof label === "string" && label) el.textContent = label;
    if (typeof href === "string" && href) {
      try {
        el.setAttribute("href", href);
      } catch (e) {
        /* noop */
      }
    }
  }

  function resetCtasToDefault() {
    [ctaPrimaryEl, ctaSecondaryEl].forEach(function (el) {
      if (!el) return;
      var defLabel = el.getAttribute("data-default-label") || el.textContent;
      var defHref = el.getAttribute("data-default-href") || el.getAttribute("href");
      setCta(el, defLabel, defHref);
    });
  }

  /**
   * For brand-new Mindbody clients, the first-time sign-in flow handles password creation —
   * no email link click required. Point them straight at Sign in with Mindbody, prefilled with
   * the email they used at checkout so they sign in as the exact client we just created (not a
   * different Mindbody account that may already be SSO'd in this browser).
   *
   * @param {string} email
   */
  function applyNewClientOnboardingCtas(email) {
    setCta(ctaPrimaryEl, "Sign in with Mindbody", buildSignInHref(email));
    setCta(ctaSecondaryEl, "Book a class", "/classes");
  }

  function showOnboardingForNewClient(o) {
    if (!onboardingEl) return;
    onboardingEl.removeAttribute("hidden");
    var email = safeDisplayEmail(o);
    if (email) {
      setText(onboardingEmailEl, email);
      setText(onboardingEmailHintEl, email);
    }
    if (o && o.welcomeEmailSent === false && onboardingHintEl) {
      onboardingHintEl.removeAttribute("hidden");
    }
  }

  function hideOnboarding() {
    if (onboardingEl) onboardingEl.setAttribute("hidden", "hidden");
  }

  function showOrder(o) {
    if (!o || typeof o !== "object") return;
    setBucket(o.bucket);
    setText(leadEl, o.message || "");
    var bucket = o.bucket || "unknown";
    var detailLines = {
      synced: "Your visits are loaded onto your Mindbody account.",
      pending: "We'll keep checking in the background — feel free to refresh in a moment.",
      manual_review:
        "We've recorded your payment and our team will finish setup. You'll get an email when it's ready.",
      canceled: "",
      test_mode:
        "This was a Stripe test-mode payment (developer environment). Mindbody sync was intentionally skipped.",
      unknown: "",
    };
    setText(detailEl, detailLines[bucket] || "");

    if (metaEl) {
      metaEl.removeAttribute("hidden");
      setText(orderEl, o.orderId || "");
      setText(packageEl, o.localSku || "");
      setText(amountEl, formatMoney(o.amountCents, o.currency));
    }

    /**
     * Decide the "next steps" UX. Only swap CTAs once we have a definitive synced state — while
     * pending we keep the defaults so users don't see a flash of the wrong button.
     */
    if (bucket === "synced" && o.clientWasNewlyCreated) {
      showOnboardingForNewClient(o);
      applyNewClientOnboardingCtas(safeDisplayEmail(o));
    } else if (bucket === "synced") {
      hideOnboarding();
      resetCtasToDefault();
    } else if (bucket === "manual_review" || bucket === "canceled" || bucket === "test_mode") {
      hideOnboarding();
      resetCtasToDefault();
    }
  }

  function fetchOnce() {
    var qs = [];
    if (orderId) qs.push("orderId=" + encodeURIComponent(orderId));
    if (sessionId) qs.push("session_id=" + encodeURIComponent(sessionId));
    var path = "/api/stripe/order-status" + (qs.length ? "?" + qs.join("&") : "");
    return fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        return res
          .text()
          .then(function (text) {
            var data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch (e) {
              data = null;
            }
            return { status: res.status, data: data };
          });
      })
      .catch(function () {
        return { status: 0, data: null };
      });
  }

  function poll() {
    var attempts = 0;
    var maxAttempts = 8;
    var intervals = [800, 1200, 1800, 2400, 3000, 4000, 5000, 6000];

    function step() {
      attempts += 1;
      fetchOnce().then(function (res) {
        if (res.status === 200 && res.data && res.data.ok && res.data.order) {
          var o = res.data.order;
          showOrder(o);
          if (o.bucket === "synced") {
            ga("stripe_order_synced_to_mindbody", {
              order_id: o.orderId,
              local_sku: o.localSku,
              new_client: o.clientWasNewlyCreated ? "1" : "0",
              welcome_email_sent: o.welcomeEmailSent ? "1" : "0",
            });
            return;
          }
          if (o.bucket === "manual_review" || o.bucket === "canceled") {
            ga("stripe_order_sync_failed", {
              order_id: o.orderId,
              local_sku: o.localSku,
              status: o.mindbodySyncStatus,
            });
            return;
          }
          if (o.bucket === "test_mode") {
            ga("stripe_order_test_mode_skipped", {
              order_id: o.orderId,
              local_sku: o.localSku,
              status: o.mindbodySyncStatus,
            });
            return;
          }
          if (attempts < maxAttempts) {
            setTimeout(step, intervals[Math.min(attempts, intervals.length - 1)]);
          }
          return;
        }
        if (res.status === 404) {
          setBucket("unknown");
          setText(leadEl, "We couldn't find that order.");
          setText(
            detailEl,
            "If you just paid, please refresh in a moment. If the issue continues, contact the studio.",
          );
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(step, intervals[Math.min(attempts, intervals.length - 1)]);
        }
      });
    }
    step();
  }

  if (!orderId && !sessionId) {
    setBucket("unknown");
    setText(leadEl, "We couldn't read your order reference from the URL.");
    return;
  }

  poll();
})();
