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

  function setScheduleGuestIntroVisible(visible) {
    const guestIntro = document.getElementById("mb-schedule-guest-intro");
    if (guestIntro) guestIntro.hidden = !visible;
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

    strip.innerHTML = `
      <div class="mb-auth-bar__identity-block">
        ${whoHtml}
        ${walletSlotHtml}
      </div>
      <a class="mb-auth-bar__out btn btn--ghost" href="${mbApiPath(`/api/mindbody/oauth/logout${retParam}`)}">Sign out</a>
    `;
    setScheduleGuestIntroVisible(false);
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
    const startFresh = mbApiPath(`/api/mindbody/oauth/start${retParam}&prompt=login`);
    strip.innerHTML = `
      <span class="mb-auth-bar__hint">Connect your Mindbody member account (same login as the studio app).</span>
      <span class="mb-auth-bar__cta-wrap">
        <a class="mb-auth-bar__cta btn btn--cream" href="${escapeHtml(startSigned)}">Sign in with Mindbody</a>
        <a class="mb-auth-bar__fresh link-quiet" href="${escapeHtml(startFresh)}">Use a different account</a>
      </span>
    `;
    setScheduleGuestIntroVisible(true);
  }

  async function refresh() {
    strip.hidden = false;
    strip.classList.remove("mb-auth-bar--logged-in");
    const hint = strip.querySelector(".mb-auth-bar__hint");
    if (hint) hint.textContent = "Checking account…";

    const ret = encodeURIComponent(returnTarget());
    const retParam = `?return=${ret}`;

    let data = null;
    try {
      const res = await fetch(mbApiPath("/api/mindbody/oauth/session"), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const txt = await res.text();
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
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
