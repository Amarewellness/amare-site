/**
 * Mindbody OAuth strip — shared by `/classes` (schedule) and `/login`.
 * Expects Netlify redirects → `/.netlify/functions/mindbody-oauth-*`.
 */
(function () {
  const strip = document.getElementById("mb-auth-strip");
  if (!strip) return;

  /** SCHEDULE_PROXY_BASE at build time, or empty = same origin (`/api/mindbody/...`). */
  function mbApiPrefix() {
    const holder = strip.closest("[data-mb-proxy]");
    const raw =
      holder && typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
    return raw.replace(/\/$/, "");
  }

  function mbApiPath(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}${p}` : p;
  }

  /** Ngrok Free can return an HTML interstitial unless this header is set on API fetches. */
  function ngrokBypassHeaders(/** @type {Record<string, string>} */ extra = {}) {
    const out = { ...extra };
    let host = "";
    try {
      const holder = strip.closest("[data-mb-proxy]");
      const raw =
        holder && typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
      host = raw ? new URL(raw, window.location.href).hostname : window.location.hostname;
    } catch {
      host = typeof window !== "undefined" ? window.location.hostname : "";
    }
    if (host.includes("ngrok")) out["ngrok-skip-browser-warning"] = "true";
    return out;
  }

  /** Mindbody `/client/stored-cards` badge — off during Classic-checkout phase; reuse slot/UI when express uses a future non-Mindbody backend. */
  const AUTH_MINDBODY_WALLET_PROBE_ENABLED = false;

  /** Prefer extensionless paths that match `public/_redirects` (e.g. `/member` not `/member.html`). */
  function oauthReturnPath() {
    let path = window.location.pathname || "/";
    if (path === "/member.html") path = "/member";
    return path + (window.location.search || "");
  }

  /** Express-checkout wallet strip (`/client/stored-cards`) runs only when `AUTH_MINDBODY_WALLET_PROBE_ENABLED` and path is Pricing. */
  function shouldProbeStoredWalletBanner() {
    if (!AUTH_MINDBODY_WALLET_PROBE_ENABLED) return false;
    const p = (window.location.pathname || "").toLowerCase();
    /** Match /pricing, /pricing.html, /pricing/ — and tolerate the legacy /pricing-api path until the 301 propagates. */
    return /^\/pricing(?:[-./]|$)/.test(p) || p.includes("pricing-api");
  }

  function returnTarget() {
    const fromData = strip.getAttribute("data-mb-return");
    if (fromData && fromData.trim()) return fromData.trim();
    return oauthReturnPath();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isLoggedInPayload(j) {
    if (!j || typeof j !== "object") return false;
    if (j.authenticated === false || j.loggedIn === false) return false;
    if (
      j.email ||
      j.name ||
      j.displayName ||
      j.given_name ||
      j.family_name ||
      j.sub
    )
      return true;
    if (j.authenticated === true || j.loggedIn === true) return true;
    return false;
  }

  function pickName(j) {
    if (!j || typeof j !== "object") return "";
    if (typeof j.name === "string" && j.name.trim()) return j.name.trim();
    if (typeof j.displayName === "string" && j.displayName.trim()) return j.displayName.trim();
    const gn = typeof j.given_name === "string" ? j.given_name : "";
    const fn = typeof j.family_name === "string" ? j.family_name : "";
    const combined = `${gn} ${fn}`.trim();
    return combined;
  }

  /** Human-friendly label — avoid showing raw OIDC `sub` when email/name exist. */
  function displayLabel(j) {
    const name = pickName(j) || j.name || "";
    const email = j.email || "";
    if (email && name) return `${name} (${email})`;
    if (email) return email;
    if (name) return name;
    return "Member";
  }

  function needsStudioProfileCompletion(/** @type {Record<string, unknown>} */ j) {
    return typeof j.linkStatus === "string" && j.linkStatus === "no_studio_client";
  }

  /** Studio Client exists but Consumer is not associated yet (Mindbody email link step). */
  function needsMindbodyEmailLink(/** @type {Record<string, unknown>} */ j) {
    if (!j || typeof j !== "object") return false;
    if (needsStudioProfileCompletion(j)) return false;
    if (j.consumerAssociated === true || j.bookingAllowed === true) return false;
    if (typeof j.linkStatus === "string" && j.linkStatus === "ready") return false;
    return (
      j.clientExists === true ||
      (typeof j.clientId === "number" && j.clientId > 0) ||
      j.linkStatus === "not_associated"
    );
  }

  const MINDBODY_LINK_DIALOG_COPY = {
    title: "One more step — check your email",
    lead:
      "Your AMARÉ studio profile is set up. Mindbody sent an email to connect your login to the studio.",
    steps:
      "Open the email titled “Add Amare Wellness Studio to your Mindbody account”, tap Link your account, and confirm with the same email you used to sign in here.",
    refresh: "I've linked my account — refresh",
    continue: "Continue browsing",
  };

  /**
   * @param {string} email
   */
  function mindbodyEmailLinkBannerHtml(email) {
    const em = email ? escapeHtml(email) : "the email you signed in with";
    return `<div class="mb-auth-bar__mindbody-link" data-mb-mindbody-link-banner>
      <p class="mb-auth-bar__mindbody-link-lead"><strong>Check your email from Mindbody</strong></p>
      <p class="mb-auth-bar__mindbody-link-detail">We sent a message to link <span translate="no">${em}</span> to AMARÉ. Tap <strong>Link your account</strong> in that email, then click below — no need to sign out.</p>
      <div class="mb-auth-bar__mindbody-link-actions">
        <button type="button" class="btn btn--cream" data-mb-mindbody-link-refresh>${escapeHtml(MINDBODY_LINK_DIALOG_COPY.refresh)}</button>
      </div>
      <p class="mb-auth-bar__mindbody-link-status" data-mb-mindbody-link-status hidden></p>
    </div>`;
  }

  function ensureMindbodyLinkDialog() {
    let dlg = document.getElementById("mb-mindbody-link-dialog");
    if (dlg instanceof HTMLDialogElement) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "mb-mindbody-link-dialog";
    dlg.className = "mb-mindbody-link-dialog";
    document.body.append(dlg);
    return dlg;
  }

  /**
   * @param {string} email
   */
  function showMindbodyLinkDialog(email) {
    const dlg = ensureMindbodyLinkDialog();
    const em = email ? escapeHtml(email) : "your sign-in email";
    dlg.innerHTML = `
      <div class="mb-mindbody-link-dialog__inner">
        <h2 class="mb-mindbody-link-dialog__title">${escapeHtml(MINDBODY_LINK_DIALOG_COPY.title)}</h2>
        <p class="mb-mindbody-link-dialog__text">${escapeHtml(MINDBODY_LINK_DIALOG_COPY.lead)}</p>
        <p class="mb-mindbody-link-dialog__text">${escapeHtml(MINDBODY_LINK_DIALOG_COPY.steps)}</p>
        <p class="mb-mindbody-link-dialog__email" translate="no">${em}</p>
        <div class="mb-mindbody-link-dialog__actions">
          <button type="button" class="btn btn--cream" data-mb-mindbody-link-refresh-dialog>${escapeHtml(MINDBODY_LINK_DIALOG_COPY.refresh)}</button>
          <button type="button" class="btn btn--ghost" data-mb-mindbody-link-dialog-close>${escapeHtml(MINDBODY_LINK_DIALOG_COPY.continue)}</button>
        </div>
        <p class="mb-mindbody-link-dialog__status" data-mb-mindbody-link-dialog-status hidden></p>
      </div>
    `;
    const closeBtn = dlg.querySelector("[data-mb-mindbody-link-dialog-close]");
    if (closeBtn instanceof HTMLButtonElement) {
      closeBtn.addEventListener("click", () => dlg.close());
    }
    const refreshBtn = dlg.querySelector("[data-mb-mindbody-link-refresh-dialog]");
    if (refreshBtn instanceof HTMLButtonElement) {
      refreshBtn.addEventListener("click", () => {
        void refreshMindbodyLinkStatus(dlg.querySelector("[data-mb-mindbody-link-dialog-status]"));
      });
    }
    if (typeof dlg.showModal === "function") dlg.showModal();
  }

  /**
   * @param {HTMLElement | null} statusEl
   */
  async function refreshMindbodyLinkStatus(statusEl) {
    if (statusEl instanceof HTMLElement) {
      statusEl.hidden = false;
      statusEl.textContent = "Checking link status…";
    }
    const data = await fetchSessionPayload(true);
    if (!data || !isLoggedInPayload(data)) {
      if (statusEl instanceof HTMLElement) {
        statusEl.textContent = "Session expired — please sign in again.";
      }
      return null;
    }
    if (!needsMindbodyEmailLink(data)) {
      if (statusEl instanceof HTMLElement) {
        statusEl.textContent = "You're linked to AMARÉ. You're all set.";
      }
      document.dispatchEvent(new CustomEvent("mb-studio-link-updated", { detail: data }));
      const dlg = document.getElementById("mb-mindbody-link-dialog");
      if (dlg instanceof HTMLDialogElement) dlg.close();
      const ret = encodeURIComponent(returnTarget());
      renderLoggedIn(data, `?return=${ret}`, { walletPending: shouldProbeStoredWalletBanner() });
      return data;
    }
    if (statusEl instanceof HTMLElement) {
      statusEl.textContent =
        "Still waiting for Mindbody — open the email and tap Link your account, then try again.";
    }
    return data;
  }

  /**
   * @param {HTMLElement} root
   */
  function bindMindbodyLinkRefresh(root) {
    const btn = root.querySelector("[data-mb-mindbody-link-refresh]");
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.addEventListener("click", () => {
      const statusEl = root.querySelector("[data-mb-mindbody-link-status]");
      void refreshMindbodyLinkStatus(statusEl instanceof HTMLElement ? statusEl : null);
    });
  }

  /**
   * @param {boolean} [reprobeLink]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function fetchSessionPayload(reprobeLink) {
    try {
      const q = reprobeLink === true ? "?reprobe_link=1" : "";
      const res = await fetch(mbApiPath(`/api/mindbody/oauth/session${q}`), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const txt = await res.text();
      /** @type {Record<string, unknown> | null} */
      let data = null;
      try {
        data = txt ? /** @type {Record<string, unknown>} */ (JSON.parse(txt)) : null;
      } catch {
        data = null;
      }
      if (!res.ok || !isLoggedInPayload(data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * @param {HTMLElement} root
   */
  function bindStudioCompleteForm(root) {
    const form = root.querySelector("[data-mb-studio-complete-form]");
    if (!(form instanceof HTMLFormElement)) return;

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const errEl = root.querySelector("[data-mb-studio-complete-error]");
      const input = form.querySelector('input[name="mobilePhone"]');
      const btn = form.querySelector('button[type="submit"]');
      if (!(input instanceof HTMLInputElement) || !(btn instanceof HTMLButtonElement)) return;

      const phone = input.value.trim();
      if (!phone) {
        if (errEl instanceof HTMLElement) {
          errEl.hidden = false;
          errEl.textContent = "Please enter your mobile number.";
        }
        return;
      }

      if (errEl instanceof HTMLElement) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = "Linking…";

      try {
        const res = await fetch(mbApiPath("/api/mindbody/oauth/complete-studio-profile"), {
          method: "POST",
          credentials: "include",
          headers: ngrokBypassHeaders({
            Accept: "application/json",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ mobilePhone: phone }),
        });
        const txt = await res.text();
        /** @type {Record<string, unknown> | null} */
        let j = null;
        try {
          j = txt ? JSON.parse(txt) : null;
        } catch {
          j = null;
        }
        if (!res.ok || !j || j.ok !== true) {
          const msg =
            res.status === 502 || res.status === 504
              ? "The server timed out linking your profile. Please wait a moment and try again."
              : j && typeof j.message === "string" && j.message.trim()
                ? j.message.trim()
                : "We could not link your studio profile. Please try again or contact us.";
          if (errEl instanceof HTMLElement) {
            errEl.hidden = false;
            errEl.textContent = msg;
          }
          return;
        }
        document.dispatchEvent(new CustomEvent("mb-studio-link-updated", { detail: j }));
        if (needsMindbodyEmailLink(j)) {
          showMindbodyLinkDialog(email);
        }
        void refresh();
      } catch {
        if (errEl instanceof HTMLElement) {
          errEl.hidden = false;
          errEl.textContent = "Network error — please try again.";
        }
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });
  }

  function setScheduleGuestIntroVisible(visible) {
    const guestIntro = document.getElementById("mb-schedule-guest-intro");
    if (guestIntro) guestIntro.hidden = !visible;
  }

  /**
   * `/pricing`: default HTML loads guest order — New Client block, then auth strip — so first-time buyers
   * see the promo before Sign in. When signed in, move the strip above New Client so account context lands first.
   *
   * @param {boolean} loggedIn
   */
  function syncPricingAuthStripPosition(loggedIn) {
    if (!strip.closest("#mb-pricing-root")) return;
    const nc = document.getElementById("pricing-new-client-block");
    const monthly = document.getElementById("pricing-monthly-block");
    /** @type {HTMLElement | null} */
    const host =
      nc && nc.parentElement && nc.parentElement instanceof HTMLElement ? nc.parentElement : null;
    if (!(nc instanceof HTMLElement) || !(monthly instanceof HTMLElement) || !host) return;
    if (strip.parentElement !== host) return;
    if (loggedIn) host.insertBefore(strip, nc);
    else host.insertBefore(strip, monthly);
  }

  /**
   * @param {unknown} sessionPayload
   * @param {string} retParam
   * @param {{ walletPending?: boolean }} [opts]
   */
  function renderLoggedIn(sessionPayload, retParam, opts) {
    strip.classList.add("mb-auth-bar--logged-in");
    const payload = sessionPayload && typeof sessionPayload === "object" ? sessionPayload : {};
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const name = pickName(payload);
    const walletPending = opts && opts.walletPending === true;

    let whoHtml = "";
    if (email && name) {
      whoHtml = `
      <span class="mb-auth-bar__who mb-auth-bar__who--split">
        <span class="mb-auth-bar__identity">Signed in as ${escapeHtml(name)}</span>
        <span class="mb-auth-bar__email" translate="no">${escapeHtml(email)}</span>
      </span>`;
    } else {
      whoHtml = `<span class="mb-auth-bar__who mb-auth-bar__who--compact">Signed in as ${escapeHtml(displayLabel(payload))}</span>`;
    }

    let walletSlotHtml = "";
    if (walletPending) {
      walletSlotHtml = `<div class="mb-auth-bar__wallet-slot" data-mb-wallet-slot aria-busy="true">
        <p class="mb-auth-bar__express mb-auth-bar__express--pending">Checking saved payment methods…</p>
      </div>`;
    }

    const studioCompleteHtml = needsStudioProfileCompletion(payload)
      ? `<div class="mb-auth-bar__studio-complete" data-mb-studio-complete>
        <p class="mb-auth-bar__studio-complete-lead">Your Mindbody login is connected. Enter your mobile number to finish linking your AMARÉ studio profile (required by our booking system).</p>
        <form class="mb-auth-bar__studio-complete-form" data-mb-studio-complete-form novalidate>
          <label class="mb-auth-bar__studio-complete-label">
            <span class="mb-auth-bar__studio-complete-label-text">Mobile phone</span>
            <input type="tel" name="mobilePhone" class="mb-auth-bar__studio-complete-input" inputmode="tel" autocomplete="tel" placeholder="(555) 555-5555" required />
          </label>
          <p class="mb-auth-bar__studio-complete-error" data-mb-studio-complete-error hidden></p>
          <button type="submit" class="btn btn--cream mb-auth-bar__studio-complete-submit">Link to studio</button>
        </form>
      </div>`
      : "";

    const mindbodyLinkHtml =
      needsMindbodyEmailLink(payload) && !needsStudioProfileCompletion(payload)
        ? mindbodyEmailLinkBannerHtml(email)
        : "";

    /**
     * `prompt=login` forces Mindbody to re-prompt for credentials even when its
     * SSO cookies could auto-approve the current session — so this link
     * cleanly switches the buyer to a different Mindbody account. We only
     * surface it AFTER login (showing it on the logged-out bar would be
     * confusing — there is nothing to "switch" from).
     */
    const startFresh = mbApiPath(`/api/mindbody/oauth/start${retParam}&prompt=login`);
    const logoutHref = mbApiPath(`/api/mindbody/oauth/logout${retParam}`);
    strip.innerHTML = `
      <div class="mb-auth-bar__identity-block">
        ${whoHtml}
        ${studioCompleteHtml}
        ${mindbodyLinkHtml}
        ${walletSlotHtml}
      </div>
      <span class="mb-auth-bar__cta-wrap">
        <a class="mb-auth-bar__out btn btn--ghost" href="${escapeHtml(logoutHref)}">Sign out</a>
        <a class="mb-auth-bar__fresh link-quiet" href="${escapeHtml(startFresh)}">Use a different account</a>
      </span>
    `;
    bindStudioCompleteForm(strip);
    bindMindbodyLinkRefresh(strip);
    setScheduleGuestIntroVisible(false);
    syncPricingAuthStripPosition(true);
  }

  /** Replace or remove the wallet strip after async `stored-cards` (keeps name/email without waiting on Mindbody). */
  function applyStoredCardBanner(/** @type {boolean} */ hasStoredCard) {
    const slot = strip.querySelector("[data-mb-wallet-slot]");
    if (!slot) return;
    if (hasStoredCard) {
      slot.innerHTML = `<p class="mb-auth-bar__express" role="status">
          <span class="mb-auth-bar__express-badge">Eligible for express checkout</span>
          <span class="mb-auth-bar__express-detail">Your Mindbody account has a saved payment method — you can complete purchases faster on this site.</span>
        </p>`;
      slot.removeAttribute("aria-busy");
      return;
    }
    slot.remove();
  }

  function renderLoggedOut(retParam) {
    strip.classList.remove("mb-auth-bar--logged-in");
    const startSigned = mbApiPath(`/api/mindbody/oauth/start${retParam}`);
    /**
     * No "Use a different account" link here — the buyer is already signed
     * out, so there is nothing to switch from and the link only adds noise.
     * It is rendered inside `renderLoggedIn` instead.
     *
     * Short prompt above the CTA for guests (classes, pricing, login, etc.).
     */
    strip.innerHTML = `
      <div class="mb-auth-bar__logged-out-stack">
        <div class="mb-auth-bar__logged-out-copy">
          <p class="mb-auth-bar__logged-out-lead">Already have an account?</p>
          <p class="mb-auth-bar__logged-out-sub">Sign in with Mindbody to continue faster.</p>
        </div>
        <span class="mb-auth-bar__cta-wrap">
          <a class="mb-auth-bar__cta btn btn--cream" href="${escapeHtml(startSigned)}">Sign in with Mindbody</a>
        </span>
      </div>
    `;
    setScheduleGuestIntroVisible(true);
    syncPricingAuthStripPosition(false);
  }

  async function refresh(/** @type {{ reprobeLink?: boolean }} */ opts = {}) {
    strip.hidden = false;
    strip.classList.remove("mb-auth-bar--logged-in");

    const ret = encodeURIComponent(returnTarget());
    const retParam = `?return=${ret}`;

    let data = null;
    try {
      data = await fetchSessionPayload(opts?.reprobeLink === true);
      if (!data) {
        renderLoggedOut(retParam);
        return;
      }
    } catch (_) {
      renderLoggedOut(retParam);
      return;
    }

    if (!isLoggedInPayload(data)) {
      renderLoggedOut(retParam);
      return;
    }

    const probeWallet = shouldProbeStoredWalletBanner();
    renderLoggedIn(data, retParam, { walletPending: probeWallet });

    if (!probeWallet) return;

    void (async () => {
      let hasStoredCard = false;
      /** @type {Response | null} */
      let cr = null;
      try {
        cr = await fetch(mbApiPath("/api/mindbody/client/stored-cards"), {
          credentials: "include",
          headers: ngrokBypassHeaders({ Accept: "application/json" }),
        });
        const raw = await cr.text();
        /** @type {unknown} */
        let cj = null;
        try {
          cj = raw ? JSON.parse(raw) : null;
        } catch {
          cj = null;
        }
        if (cr.ok && cj && typeof cj === "object" && /** @type {{ ok?: unknown }} */ (cj).ok === true) {
          if (/** @type {{ hasStoredCard?: unknown }} */ (cj).hasStoredCard === true) hasStoredCard = true;
        }
        if (!hasStoredCard) {
          const o = cj && typeof cj === "object" ? /** @type {Record<string, unknown>} */ (cj) : null;
          const wh = typeof o?.walletHint === "string" ? o.walletHint : "";
          const suffix = wh ? ` — ${wh}` : "";
          /** Expected: Admin may show billing while Public API omits vault — no console noise. */
          const omitConsole =
            /mindbody_did_not_expose_stored_card/i.test(wh) &&
            wh.includes("through_tested_public_api_endpoints");
          if (!omitConsole) {
            const sp =
              o?.staffProbe && typeof o.staffProbe === "object"
                ? /** @type {Record<string, unknown>} */ (o.staffProbe)
                : null;
            console.warn(`[mb-auth] No saved Mindbody payment method (express checkout badge hidden)${suffix}`, {
              clientId: o?.clientId,
              walletHint: wh || undefined,
              staffAttempted: sp?.attempted,
              staffHeadersAvailable: sp?.staffHeadersAvailable,
              staffCciScoped: sp?.cciScoped,
              staffProbe: o?.staffProbe,
              httpStatus: cr.status,
              responseOk: cr.ok,
              probe: {
                ok: o?.ok,
                hasStoredCard: o?.hasStoredCard,
                cardCount: o?.cardCount,
                error: o?.error,
                detail: o?.detail,
              },
            });
          }
        }
      } catch (err) {
        console.warn("[mb-auth] stored-cards request failed (no express badge)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      applyStoredCardBanner(hasStoredCard);
    })();
  }

  void refresh();

  let lastVisibilityAuthMs = Date.now();
  const AUTH_VISIBILITY_MIN_MS = 90_000;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastVisibilityAuthMs < AUTH_VISIBILITY_MIN_MS) return;
    lastVisibilityAuthMs = now;
    void refresh();
  });
})();
