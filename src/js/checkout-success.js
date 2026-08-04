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

  /**
   * Idempotency for conversion events.
   *
   * The success page is polled multiple times after payment until `bucket === "synced"`,
   * and customers commonly refresh the tab or use back/forward. Both would re-fire the
   * GA4 `purchase` event and inflate revenue / conversion counts in reports — and worse,
   * any Google Ads conversion bid pulled from this event would multi-count.
   *
   * Guard: keyed by `orderId` in `sessionStorage` (per-tab). One firing per order, ever.
   * `sessionStorage` is intentional — `localStorage` would persist across browser
   * sessions, but the success page is a one-shot per purchase anyway, and tabs that
   * navigate away and come back would lose context already.
   */
  function purchaseEventAlreadyFired(orderIdValue) {
    if (!orderIdValue) return false;
    var key = "amare_purchase_event_fired_" + orderIdValue;
    try {
      if (window.sessionStorage.getItem(key)) return true;
      window.sessionStorage.setItem(key, "1");
      return false;
    } catch (e) {
      /** Storage may be blocked (incognito with strict policies). Fall through — over-counting in this rare case is preferable to never firing. */
      return false;
    }
  }

  /**
   * Fire the canonical GA4 ecommerce `purchase` event. Maps to GA4's "Conversions" /
   * "Monetization" reports out-of-the-box and is the conversion event Google Ads expects
   * for return-on-ad-spend tracking.
   *
   * Also fires a side-channel `new_client_special_purchase` event (with `cta_location`)
   * for orders whose `localSku` is `new_client_special_3_for_65`. NCS sits on three
   * surface pages — `/`, `/first-visit`, `/pricing` — and product wants to attribute the
   * conversion back to which surface drove it. The standard `purchase` event has no
   * native `cta_location` slot, so we surface it as a custom event the team can build a
   * funnel against.
   *
   * @param {{orderId:string, localSku:string, displayName?:string, amountCents?:number, currency?:string, ctaLocation?:string|null, clientWasNewlyCreated?:boolean, promotionCode?:string}} order
   */
  function fireConversionEvents(order) {
    if (!order || !order.orderId) return;
    if (purchaseEventAlreadyFired(order.orderId)) return;

    /** `amountCents` from order-status is post-coupon paid total when the webhook has landed. */
    var cents = typeof order.amountCents === "number" && isFinite(order.amountCents) ? order.amountCents : 0;
    var value = cents > 0 ? Math.round(cents) / 100 : 0;
    var currency = (order.currency || "USD").toUpperCase();
    var displayName = order.displayName || order.localSku || "Package";
    var coupon =
      typeof order.promotionCode === "string" && order.promotionCode.trim()
        ? order.promotionCode.trim()
        : undefined;

    ga("purchase", {
      transaction_id: order.orderId,
      value: value,
      currency: currency,
      affiliation: "Stripe",
      coupon: coupon,
      tax: 0,
      shipping: 0,
      items: [
        {
          item_id: order.localSku,
          item_name: displayName,
          item_category: "package",
          price: value,
          quantity: 1,
        },
      ],
      cta_location: order.ctaLocation || undefined,
      new_client: order.clientWasNewlyCreated ? "1" : "0",
    });

    if (order.localSku === "new_client_special_3_for_65") {
      ga("new_client_special_purchase", {
        transaction_id: order.orderId,
        value: value,
        currency: currency,
        cta_location: order.ctaLocation || "unknown",
        new_client: order.clientWasNewlyCreated ? "1" : "0",
      });
    }

    try {
      if (
        window.amareOpenAiConversion &&
        typeof window.amareOpenAiConversion.measureOpenAiConversion === "function"
      ) {
        window.amareOpenAiConversion.measureOpenAiConversion(order);
      }
    } catch (e) {
      /* OpenAI measurement must never block GA4 or the success page */
    }
  }

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

  /**
   * Checkout started from the schedule booking-fail package list (`classes_booking_fail_packages`).
   * @param {{ ctaLocation?: unknown } | null | undefined} o
   */
  function isBookingFailCheckout(o) {
    return !!(
      o &&
      (o.purchaseSource === "classes" ||
        o.ctaLocation === "classes_booking_fail_packages" ||
        o.ctaLocation === "classes_anonymous_book_packages" ||
        (o.pendingBook && o.pendingBook.source === "book"))
    );
  }

  var STUDIO_TZ = "America/New_York";

  /**
   * Mindbody timestamps are studio wall time without a zone; parse as America/New_York.
   * @param {unknown} isoLike
   */
  function mindbodyInstantToUtcMs(isoLike) {
    if (isoLike == null || typeof isoLike !== "string") return NaN;
    var raw = isoLike.trim();
    if (!raw) return NaN;
    if (/[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw)) {
      var t = Date.parse(raw);
      return Number.isNaN(t) ? NaN : t;
    }
    var mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
    if (!mm) {
      var t2 = Date.parse(raw);
      return Number.isNaN(t2) ? NaN : t2;
    }
    var y = +mm[1],
      mo = +mm[2],
      d = +mm[3],
      h = +mm[4],
      mi = +mm[5],
      se = mm[6] != null ? +mm[6] : 0;
    try {
      if (typeof Temporal !== "undefined") {
        var z = Temporal.ZonedDateTime.from({
          timeZone: STUDIO_TZ,
          calendar: "iso8601",
          year: y,
          month: mo,
          day: d,
          hour: h,
          minute: mi,
          second: se,
          millisecond: 0,
        });
        return z.epochMilliseconds;
      }
    } catch (e) {
      /* fall through */
    }
    return naiveEtWallIterateToUtcMs(y, mo, d, h, mi, se);
  }

  function naiveEtWallIterateToUtcMs(y, mo, d, h, mi, se) {
    var t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (var i = 0; i < 48; i++) {
      var parts = fmt.formatToParts(new Date(t));
      var num = function (typ) {
        return parseInt(
          (parts.find(function (p) {
            return p.type === typ;
          }) || {}).value || "0",
          10,
        );
      };
      var yy = num("year"),
        MM = num("month"),
        dd = num("day"),
        HH = num("hour"),
        mmm = num("minute"),
        ss = num("second");
      if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
      t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
      if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
    }
    return NaN;
  }

  /**
   * @param {unknown} isoLike
   * @returns {string} e.g. "Friday, July 10 at 11:00 AM"
   */
  function formatStudioClassWhen(isoLike) {
    var ms = mindbodyInstantToUtcMs(isoLike);
    if (!Number.isFinite(ms)) return "";
    var d = new Date(ms);
    try {
      var weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: STUDIO_TZ,
        weekday: "long",
      }).format(d);
      var monthDay = new Intl.DateTimeFormat("en-US", {
        timeZone: STUDIO_TZ,
        month: "long",
        day: "numeric",
      }).format(d);
      var time = new Intl.DateTimeFormat("en-US", {
        timeZone: STUDIO_TZ,
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
      return weekday + ", " + monthDay + " at " + time;
    } catch (e) {
      return "";
    }
  }

  /**
   * @param {{ pendingBook?: { classStartIso?: unknown } | null } | null | undefined} o
   * @returns {string}
   */
  function pendingBookWhenPhrase(o) {
    var iso = o && o.pendingBook && o.pendingBook.classStartIso;
    var when = formatStudioClassWhen(iso);
    return when ? " on " + when : "";
  }

  /**
   * @param {{ status?: unknown } | null | undefined} db
   */
  function deferredBookStatus(db) {
    return db && typeof db.status === "string" ? db.status : null;
  }

  /** @param {string | null} status */
  function deferredBookIsPending(status) {
    return status === "pending" || status === "attempting";
  }

  /**
   * @param {{ deferredBook?: { status?: unknown } | null; pendingBook?: { className?: unknown } | null } | null | undefined} o
   */
  function bookingFailLeadForOrder(o) {
    var db = o && o.deferredBook;
    var status = deferredBookStatus(db);
    var classLabel =
      o && o.pendingBook && typeof o.pendingBook.className === "string" && o.pendingBook.className.trim()
        ? o.pendingBook.className.trim()
        : "your class";
    var whenPhrase = pendingBookWhenPhrase(o);
    if (status === "booked") return "You're booked for " + classLabel + whenPhrase + ".";
    if (status === "class_full") {
      return "Your credits are ready, but " + classLabel + whenPhrase + " filled up before we could reserve your spot.";
    }
    if (status === "class_past") {
      return "Your credits are ready, but " + classLabel + whenPhrase + " already started.";
    }
    if (status === "no_credits_yet") {
      return "Payment received — we're waiting for your credits to appear before we can book " + classLabel + whenPhrase + ".";
    }
    if (status === "payment_not_applied") {
      return "We couldn't apply your new credits to " + classLabel + whenPhrase + " automatically.";
    }
    if (status === "failed") {
      return "We couldn't complete your booking for " + classLabel + whenPhrase + " automatically.";
    }
    if (deferredBookIsPending(status)) {
      return "Payment received — finishing your booking for " + classLabel + whenPhrase + "…";
    }
    if (o && o.bucket === "synced") {
      return "Your credits are ready. We're confirming your booking…";
    }
    if (o && o.bucket === "pending") {
      return "Payment received — setting up your package and booking…";
    }
    return o && o.message ? o.message : "Payment received.";
  }

  /**
   * @param {{ bucket?: unknown; deferredBook?: { status?: unknown } | null } | null | undefined} o
   */
  function bookingFailDetailForOrder(o) {
    var status = deferredBookStatus(o && o.deferredBook);
    if (status === "booked") {
      return "Check your email for confirmation. You can view or cancel this visit on the schedule anytime.";
    }
    if (status === "class_full") {
      return "Join the waitlist on the schedule or pick another class — your new credits are on your account.";
    }
    if (status === "class_past") {
      return "Choose another class on the schedule — your new credits are ready to use.";
    }
    if (status === "no_credits_yet") {
      return "This usually takes a few seconds. Refresh this page shortly, or open the schedule and tap Confirm booking.";
    }
    if (status === "payment_not_applied" || status === "failed") {
      return "Your package was added in Mindbody. Open the schedule, find your class, and tap Confirm booking — or contact us if it keeps failing.";
    }
    if (deferredBookIsPending(status)) {
      return "This usually takes a few seconds — feel free to keep this page open.";
    }
    return detailLineForBucket((o && o.bucket) || "unknown", o);
  }

  /**
   * @param {string} bucket
   * @param {{ ctaLocation?: unknown } | null | undefined} o
   */
  function detailLineForBucket(bucket, o) {
    if (isBookingFailCheckout(o)) {
      return bookingFailDetailForOrder(o);
    }
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
    return detailLines[bucket] || "";
  }

  function showOrder(o) {
    if (!o || typeof o !== "object") return;
    setBucket(o.bucket);
    var bucket = o.bucket || "unknown";
    var dbStatus = deferredBookStatus(o.deferredBook);
    if (isBookingFailCheckout(o)) {
      setText(leadEl, bookingFailLeadForOrder(o));
      setText(detailEl, bookingFailDetailForOrder(o));
    } else {
      setText(leadEl, o.message || "");
      setText(detailEl, detailLineForBucket(bucket, o));
    }

    if (metaEl) {
      metaEl.removeAttribute("hidden");
      setText(orderEl, o.orderId != null ? String(o.orderId) : "");
      setText(packageEl, o.displayName || o.localSku || "");
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
      if (isBookingFailCheckout(o)) {
        if (dbStatus === "booked") {
          setCta(ctaPrimaryEl, "View schedule", "/classes");
          setCta(ctaSecondaryEl, "Contact studio", "/contact");
        } else if (dbStatus === "class_full") {
          setCta(ctaPrimaryEl, "Open schedule", "/classes");
          setCta(ctaSecondaryEl, "Contact studio", "/contact");
        } else if (dbStatus === "class_past") {
          setCta(ctaPrimaryEl, "Choose another class", "/classes");
        } else if (
          dbStatus === "no_credits_yet" ||
          dbStatus === "failed" ||
          dbStatus === "payment_not_applied"
        ) {
          setCta(ctaPrimaryEl, "Try booking on schedule", "/classes");
          setCta(ctaSecondaryEl, "Contact studio", "/contact");
        } else if (deferredBookIsPending(dbStatus)) {
          setCta(ctaPrimaryEl, "Open schedule", "/classes");
        } else {
          setCta(ctaPrimaryEl, "Book your class now", "/classes");
        }
      }
    } else if (bucket === "pending" && isBookingFailCheckout(o)) {
      hideOnboarding();
      setCta(ctaPrimaryEl, "Open schedule", "/classes");
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

  var confirmationEmailRequestedForOrder = null;

  function shouldRequestDeferredConfirmationEmail(o) {
    if (!isBookingFailCheckout(o)) return false;
    if (!o.deferredBook || o.deferredBook.status !== "booked") return false;
    if (o.deferredBook.mindbodyConfirmationEmailSent === true) return false;
    return true;
  }

  function requestDeferredConfirmationEmail(o) {
    if (!o || !o.orderId) return Promise.resolve(false);
    if (confirmationEmailRequestedForOrder === o.orderId) return Promise.resolve(false);
    confirmationEmailRequestedForOrder = o.orderId;
    return fetch("/api/stripe/deferred-book/confirm-email", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ orderId: o.orderId }),
    })
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
      .then(function (res) {
        return !!(res.status === 200 && res.data && res.data.ok && res.data.mindbodyConfirmationEmailSent);
      })
      .catch(function () {
        return false;
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
              deferred_book_status: deferredBookStatus(o.deferredBook) || undefined,
            });
            var deferStatus = deferredBookStatus(o.deferredBook);
            if (isBookingFailCheckout(o) && deferredBookIsPending(deferStatus) && attempts < maxAttempts) {
              setTimeout(step, intervals[Math.min(attempts, intervals.length - 1)]);
              return;
            }
            if (shouldRequestDeferredConfirmationEmail(o)) {
              requestDeferredConfirmationEmail(o).then(function (sent) {
                if (sent) {
                  fetchOnce().then(function (refresh) {
                    if (refresh.status === 200 && refresh.data && refresh.data.ok && refresh.data.order) {
                      showOrder(refresh.data.order);
                    }
                  });
                }
              });
            }
            fireConversionEvents(o);
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
