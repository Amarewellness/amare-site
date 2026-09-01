/**
 * Annual membership admin — lookup, cancel renewal, revoke current term.
 */
(function adminAnnualMemberships() {
  const root = document.querySelector("[data-annual-admin-root]");
  if (!root) return;

  const shared = window.AmareFollowUpAdmin;
  if (!shared) return;

  const API_URL = "/api/admin/annual-memberships";
  const authPanel = root.querySelector("[data-annual-admin-auth-panel]");
  const mainPanel = root.querySelector("[data-annual-admin-main]");
  const authError = root.querySelector("[data-annual-admin-auth-error]");
  const statusEl = root.querySelector("[data-annual-admin-status]");
  const errorEl = root.querySelector("[data-annual-admin-error]");
  const resultsEl = root.querySelector("[data-annual-admin-results]");

  /** @param {HTMLElement | null} el @param {string} msg */
  function setMsg(el, msg) {
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  /** @param {boolean} busy */
  function setBusy(busy) {
    root.querySelector("[data-annual-admin-search]")?.toggleAttribute("disabled", busy);
    root.querySelector("[data-annual-admin-recent]")?.toggleAttribute("disabled", busy);
    resultsEl?.querySelectorAll("button").forEach((btn) => btn.toggleAttribute("disabled", busy));
  }

  function unlock(token) {
    shared.setToken(token);
    if (authPanel) authPanel.hidden = true;
    if (mainPanel) mainPanel.hidden = false;
    shared.showError(authError, "");
  }

  root.querySelector("[data-annual-admin-unlock]")?.addEventListener("click", () => {
    void shared
      .resolveAdminSession(root)
      .then((token) => unlock(token))
      .catch((e) => shared.showError(authError, e instanceof Error ? e.message : "Login failed"));
  });

  /** @param {unknown} cents */
  function formatUsd(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n / 100);
  }

  /** @param {string[]} flags */
  function attentionHtml(flags) {
    if (!flags.length) return "";
    return `<p class="admin-sms__attention">${flags.map((f) => `<span class="admin-sms__flag admin-sms__flag--${f}">${f.replace(/_/g, " ")}</span>`).join(" ")}</p>`;
  }

  /** @param {Record<string, unknown> | null} period @param {string} title */
  function periodBlock(period, title) {
    if (!period) {
      return `<section class="admin-sms__panel"><h3 class="admin-sms__panel-title">${title}</h3><p class="admin-sms__hint">None</p></section>`;
    }
    const flags = Array.isArray(period.attention) ? period.attention : [];
    return (
      `<section class="admin-sms__panel">` +
      `<h3 class="admin-sms__panel-title">${title}</h3>` +
      attentionHtml(/** @type {string[]} */ (flags)) +
      `<dl class="admin-sms__meta">` +
      `<div><dt>Period index</dt><dd>${period.period_index ?? "—"}</dd></div>` +
      `<div><dt>Start</dt><dd>${period.period_start_date ?? "—"}</dd></div>` +
      `<div><dt>End</dt><dd>${period.period_end_date ?? "—"}</dd></div>` +
      `<div><dt>Status</dt><dd><strong>${period.status ?? "—"}</strong></dd></div>` +
      `<div><dt>Mindbody product id</dt><dd>${period.mindbody_product_id ?? "—"}</dd></div>` +
      `<div><dt>Mindbody SaleId</dt><dd>${period.mindbody_sale_id ?? "—"}</dd></div>` +
      `<div><dt>Mindbody ClientServiceId</dt><dd>${period.mindbody_client_service_id ?? "—"}</dd></div>` +
      `<div><dt>Issued at</dt><dd>${period.issued_at ?? "—"}</dd></div>` +
      `<div><dt>Attempt count</dt><dd>${period.attempt_count ?? 0}</dd></div>` +
      `<div><dt>Last error</dt><dd>${period.last_error ? String(period.last_error) : "—"}</dd></div>` +
      `</dl></section>`
    );
  }

  /** @param {Record<string, unknown>} m */
  function actionsBlock(m) {
    const id = String(m.annual_membership_id || "");
    const status = String(m.status || "");
    const canCancelRenewal = status === "active";
    const canRevoke = status === "active" || status === "past_due";
    if (!canCancelRenewal && !canRevoke) {
      return `<section class="admin-sms__panel"><p class="admin-sms__hint">No admin actions available for status <strong>${status}</strong>.</p></section>`;
    }
    return (
      `<section class="admin-sms__panel admin-sms__panel--stack">` +
      `<h3 class="admin-sms__panel-title">Admin actions</h3>` +
      (canCancelRenewal
        ? `<div class="admin-sms__actions">` +
          `<button type="button" class="btn btn--ghost" data-annual-action="cancel_renewal" data-annual-id="${id}">Cancel renewal</button>` +
          `</div>` +
          `<p class="admin-sms__hint">Stops the next annual Stripe renewal. The member keeps access and monthly credit refreshes through the end of the current paid annual term (<strong>${m.term_end_date ?? "—"}</strong>).</p>`
        : "") +
      (canRevoke
        ? `<div class="admin-sms__actions">` +
          `<button type="button" class="btn" data-annual-action="revoke_term" data-annual-id="${id}">Stop current annual membership</button>` +
          `</div>` +
          `<p class="admin-sms__hint admin-sms__hint--warn">Stops all future monthly entitlement allocations for the current annual term. Already-issued Mindbody services are <strong>not</strong> automatically removed. This action does not issue a Stripe refund.</p>`
        : "") +
      `<p class="admin-sms__action-result" data-annual-action-result="${id}" hidden role="status"></p>` +
      `</section>`
    );
  }

  /** @param {Record<string, unknown>[]} memberships */
  function renderResults(memberships) {
    if (!resultsEl) return;
    if (!memberships.length) {
      resultsEl.innerHTML = `<section class="admin-sms__panel"><p class="admin-sms__hint">No annual memberships matched.</p></section>`;
      return;
    }
    resultsEl.innerHTML = memberships
      .map((m) => {
        const flags = Array.isArray(m.attention) ? m.attention : [];
        return (
          `<article class="admin-sms__panel admin-sms__panel--stack" data-annual-card="${m.annual_membership_id ?? ""}">` +
          `<h2 class="admin-sms__panel-title">Annual membership</h2>` +
          attentionHtml(/** @type {string[]} */ (flags)) +
          `<dl class="admin-sms__meta">` +
          `<div><dt>annual_membership_id</dt><dd><code>${m.annual_membership_id ?? "—"}</code></dd></div>` +
          `<div><dt>Mindbody client id</dt><dd>${m.mindbody_client_id ?? "—"}</dd></div>` +
          `<div><dt>SKU</dt><dd>${m.sku ?? "—"}</dd></div>` +
          `<div><dt>Status</dt><dd><strong>${m.status ?? "—"}</strong></dd></div>` +
          `<div><dt>Stripe subscription id</dt><dd><code>${m.stripe_subscription_id ?? "—"}</code></dd></div>` +
          `<div><dt>Stripe invoice id</dt><dd><code>${m.stripe_invoice_id ?? "—"}</code></dd></div>` +
          `<div><dt>Annual amount</dt><dd>${formatUsd(m.annual_amount_cents)}</dd></div>` +
          `<div><dt>Term start</dt><dd>${m.term_start_date ?? "—"}</dd></div>` +
          `<div><dt>Term end</dt><dd>${m.term_end_date ?? "—"}</dd></div>` +
          `</dl>` +
          actionsBlock(m) +
          periodBlock(/** @type {Record<string, unknown> | null} */ (m.current_period), "Current entitlement period") +
          periodBlock(/** @type {Record<string, unknown> | null} */ (m.next_period), "Next period") +
          `</article>`
        );
      })
      .join("");
  }

  /** @param {Record<string, string>} params */
  function runSearch(params) {
    const token = shared.getToken();
    if (!token) return;
    setMsg(errorEl, "");
    setBusy(true);
    setMsg(statusEl, "Loading…");
    const qs = new URLSearchParams(params).toString();
    shared
      .adminFetch(token, `${API_URL}?${qs}`)
      .then((body) => {
        const list = Array.isArray(body.memberships) ? body.memberships : [];
        renderResults(list);
        setMsg(statusEl, `${list.length} result${list.length === 1 ? "" : "s"}.`);
      })
      .catch((err) => {
        renderResults([]);
        setMsg(statusEl, "");
        setMsg(errorEl, err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }

  /** @param {string} membershipId @param {string} action */
  function runAction(membershipId, action) {
    const token = shared.getToken();
    if (!token) return;
    /** @type {Record<string, string>} */
    const payload = { action, annualMembershipId: membershipId };
    if (action === "cancel_renewal") {
      const ok = window.confirm(
        "Cancel renewal?\n\nThis stops the next annual Stripe renewal. The member keeps access and monthly credit refreshes through the end of the current paid annual term.\n\nNo refund is issued.",
      );
      if (!ok) return;
    } else if (action === "revoke_term") {
      const typed = window.prompt(
        'Stop current annual membership?\n\nThis stops all future monthly entitlement allocations for the current annual term. Already-issued Mindbody services are NOT automatically removed. This does not issue a Stripe refund.\n\nType STOP to confirm.',
      );
      if (String(typed || "").trim().toUpperCase() !== "STOP") {
        setMsg(errorEl, "Revocation canceled — type STOP exactly to confirm.");
        return;
      }
      payload.confirmStop = "STOP";
    }

    setBusy(true);
    setMsg(errorEl, "");
    fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
      },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          throw new Error(body.message || body.error || `Request failed (${res.status})`);
        }
        const resultEl = resultsEl?.querySelector(`[data-annual-action-result="${membershipId}"]`);
        if (resultEl instanceof HTMLElement) {
          if (action === "cancel_renewal") {
            resultEl.textContent = `Renewal canceled. Current term ends ${body.currentTermEnds ?? "—"}. Stripe status: ${body.stripe?.status ?? "—"}.`;
          } else {
            const issued = body.currentIssuedPeriod;
            const csId = issued?.mindbody_client_service_id ?? "—";
            resultEl.textContent =
              `Term status: ${body.termStatus ?? "revoked"}. Future periods skipped: ${body.futurePeriodsSkipped ?? 0}. Issued periods preserved: ${body.issuedPeriodsPreserved ?? 0}. ` +
              `Current Mindbody ClientServiceId: ${csId}. ${body.mindbodyNote ?? "Current Mindbody entitlement remains until separately removed or adjusted."}`;
          }
          resultEl.hidden = false;
        }
        runSearch({ id: membershipId });
      })
      .catch((err) => setMsg(errorEl, err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  resultsEl?.addEventListener("click", (event) => {
    const target = event.target;
    const btn = target instanceof Element ? target.closest("[data-annual-action]") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const action = btn.dataset.annualAction;
    const id = btn.dataset.annualId;
    if (!action || !id) return;
    runAction(id, action);
  });

  root.querySelector("[data-annual-admin-search]")?.addEventListener("click", () => {
    /** @type {Record<string, string>} */
    const params = {};
    const id = (root.querySelector("[data-annual-lookup-id]")?.value || "").trim();
    const client = (root.querySelector("[data-annual-lookup-client]")?.value || "").trim();
    const sub = (root.querySelector("[data-annual-lookup-sub]")?.value || "").trim();
    const invoice = (root.querySelector("[data-annual-lookup-invoice]")?.value || "").trim();
    if (id) params.id = id;
    else if (client) params.mindbodyClientId = client;
    else if (sub) params.stripeSubscriptionId = sub;
    else if (invoice) params.stripeInvoiceId = invoice;
    else {
      setMsg(errorEl, "Enter one lookup field.");
      return;
    }
    runSearch(params);
  });

  root.querySelector("[data-annual-admin-recent]")?.addEventListener("click", () => {
    runSearch({ limit: "10" });
  });
})();
