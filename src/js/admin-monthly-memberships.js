/**
 * Admin — Monthly Memberships lookup + Change Membership.
 * Reads use the admin token; plan changes also send the billing admin credential.
 */
(function adminMonthlyMemberships() {
  const root = document.querySelector("[data-mm-admin-root]");
  if (!root) return;
  const shared = window.AmareFollowUpAdmin;
  if (!shared) return;

  const API = "/api/admin/monthly-memberships";
  const BILLING_ACTOR_KEY = "amare_mm_billing_actor";
  const BILLING_SECRET_KEY = "amare_mm_billing_key";
  const ACTIVE_STATUSES = ["executing", "syncing", "needs_reconciliation", "scheduled"];
  const POLL_STATUSES = ["executing", "syncing"];

  const q = (sel) => root.querySelector(sel);
  const esc = shared.esc;
  const authPanel = q("[data-mm-auth-panel]");
  const mainPanel = q("[data-mm-main]");
  const resultsEl = q("[data-mm-results]");
  const detailEl = q("[data-mm-detail]");
  const statusEl = q("[data-mm-status]");
  const errorEl = q("[data-mm-error]");
  const changeDialog = q("[data-mm-change-dialog]");
  const confirmDialog = q("[data-mm-confirm-dialog]");

  /** @type {any} */
  let details = null;
  /** @type {string | null} */
  let billingActor = null;
  /** @type {string | null} */
  let billingRole = null;
  const change = { toSku: "", policy: "", preview: /** @type {any} */ (null), requestId: "" };
  /** @type {number | null} */
  let pollTimer = null;

  function setMsg(el, msg) {
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function usd(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
  }

  function day(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" }).format(d);
  }

  function billingHeaders() {
    const actor = sessionStorage.getItem(BILLING_ACTOR_KEY) || "";
    const key = sessionStorage.getItem(BILLING_SECRET_KEY) || "";
    return actor && key ? { "x-billing-actor": actor, "x-billing-key": key } : {};
  }

  /**
   * @param {string} url
   * @param {{ method?: string, body?: unknown, billing?: boolean }} [opts]
   */
  async function api(url, opts = {}) {
    const headers = { "x-admin-token": shared.getToken() };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.billing) Object.assign(headers, billingHeaders());
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.message || data.error || `HTTP ${res.status}`);
      /** @type {any} */ (err).data = data;
      /** @type {any} */ (err).status = res.status;
      throw err;
    }
    return data;
  }

  /* ----------------------------- auth ----------------------------- */

  function unlock(token) {
    shared.setToken(token);
    if (authPanel) authPanel.hidden = true;
    if (mainPanel) mainPanel.hidden = false;
    void restoreBilling();
    const params = new URLSearchParams(location.search);
    const preset = params.get("subscriptionId") || params.get("q");
    if (preset) {
      const input = q("[data-mm-query]");
      if (input) input.value = preset;
      void search(preset);
    }
  }

  const unlockBtn = shared.findAdminUnlockButton(root);
  unlockBtn?.addEventListener("click", () => {
    if (unlockBtn.disabled) return;
    void (async () => {
      shared.setUnlockButtonLoading(unlockBtn, true);
      try {
        unlock(await shared.resolveAdminSession(root));
      } catch (e) {
        setMsg(q("[data-mm-auth-error]"), e instanceof Error ? e.message : "Login failed");
      } finally {
        shared.setUnlockButtonLoading(unlockBtn, false);
      }
    })();
  });
  if (shared.getToken()) unlock(shared.getToken());

  function renderBillingState() {
    const state = q("[data-mm-billing-state]");
    const form = q("[data-mm-billing-form]");
    const enable = q("[data-mm-billing-enable]");
    const disable = q("[data-mm-billing-disable]");
    const manage = q("[data-mm-billing-manage]");
    if (billingActor) {
      if (state) state.innerHTML = `Billing actions enabled for <strong>${esc(billingActor)}</strong> (${esc(billingRole || "")}). Every change is recorded under this id.`;
      if (form) form.hidden = true;
      if (enable) enable.hidden = true;
      if (disable) disable.hidden = false;
      if (manage) manage.hidden = false;
      void loadBillingAdmins();
    } else {
      if (state) state.textContent = "Changing a plan needs an owner / superadmin billing credential. Front-desk admin access can view memberships only.";
      if (form) form.hidden = false;
      if (enable) enable.hidden = false;
      if (disable) disable.hidden = true;
      if (manage) manage.hidden = true;
    }
    if (details) renderDetail();
  }

  /** @param {any} data */
  function setBillingIdentity(data) {
    billingActor = data?.actor?.id || null;
    billingRole = data?.actor?.role || null;
  }

  async function restoreBilling() {
    if (!billingHeaders()["x-billing-actor"]) return renderBillingState();
    try {
      setBillingIdentity(await api(API, { method: "POST", body: { action: "whoami" }, billing: true }));
    } catch {
      sessionStorage.removeItem(BILLING_ACTOR_KEY);
      sessionStorage.removeItem(BILLING_SECRET_KEY);
      setBillingIdentity(null);
    }
    renderBillingState();
  }

  function manageMsg() {
    return q("[data-mm-manage-msg]");
  }

  async function loadBillingAdmins() {
    const host = q("[data-mm-billing-admins]");
    if (!host) return;
    try {
      const data = await api(API, { method: "POST", body: { action: "billing-admins-list" }, billing: true });
      const canRevoke = billingRole === "owner";
      host.innerHTML =
        `<div class="admin-sms__table-wrap"><table class="admin-sms__table"><thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Last verified</th><th></th></tr></thead><tbody>` +
        (data.admins || [])
          .map(
            (a) =>
              `<tr><td>${esc(a.actorId)}${a.displayName ? `<br /><small>${esc(a.displayName)}</small>` : ""}</td><td>${esc(a.role)}</td><td>${esc(a.status)}</td>` +
              `<td>${esc(day(a.lastVerifiedAt))}</td><td>${canRevoke && a.status === "active" ? `<button type="button" class="btn btn--ghost" data-mm-revoke="${esc(a.actorId)}">Revoke</button>` : ""}</td></tr>`,
          )
          .join("") +
        `</tbody></table></div>`;
    } catch (e) {
      host.innerHTML = "";
      setMsg(manageMsg(), e instanceof Error ? e.message : "Could not load billing admins");
    }
  }

  q("[data-mm-enroll]")?.addEventListener("click", () => {
    const body = {
      action: "billing-admin-enroll",
      actorId: String(q("[data-mm-enroll-id]")?.value || "").trim().toLowerCase(),
      displayName: String(q("[data-mm-enroll-name]")?.value || "").trim(),
      role: String(q("[data-mm-enroll-role]")?.value || "superadmin"),
      key: String(q("[data-mm-enroll-key]")?.value || ""),
    };
    void (async () => {
      try {
        await api(API, { method: "POST", body, billing: true });
        const keyInput = q("[data-mm-enroll-key]");
        if (keyInput) keyInput.value = "";
        setMsg(manageMsg(), `Enrolled ${body.actorId}. Give them the key privately; they should change it after signing in.`);
        void loadBillingAdmins();
      } catch (e) {
        setMsg(manageMsg(), e instanceof Error ? e.message : "Enroll failed");
      }
    })();
  });

  q("[data-mm-rotate]")?.addEventListener("click", () => {
    const input = q("[data-mm-rotate-key]");
    const newKey = String(input?.value || "");
    void (async () => {
      try {
        await api(API, { method: "POST", body: { action: "billing-key-rotate", newKey }, billing: true });
        sessionStorage.setItem(BILLING_SECRET_KEY, newKey);
        if (input) input.value = "";
        setMsg(manageMsg(), "Your billing key was changed.");
      } catch (e) {
        setMsg(manageMsg(), e instanceof Error ? e.message : "Key change failed");
      }
    })();
  });

  q("[data-mm-billing-admins]")?.addEventListener("click", (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest("[data-mm-revoke]");
    if (!btn) return;
    const actorId = btn.getAttribute("data-mm-revoke") || "";
    if (!window.confirm(`Revoke billing access for ${actorId}?`)) return;
    void (async () => {
      try {
        await api(API, { method: "POST", body: { action: "billing-admin-revoke", actorId }, billing: true });
        setMsg(manageMsg(), `Revoked ${actorId}.`);
        if (actorId === billingActor) q("[data-mm-billing-disable]")?.click();
        else void loadBillingAdmins();
      } catch (e) {
        setMsg(manageMsg(), e instanceof Error ? e.message : "Revoke failed");
      }
    })();
  });

  q("[data-mm-billing-enable]")?.addEventListener("click", () => {
    const actor = String(q("[data-mm-billing-actor]")?.value || "").trim().toLowerCase();
    const key = String(q("[data-mm-billing-key]")?.value || "");
    setMsg(q("[data-mm-billing-error]"), "");
    if (!actor || !key) return setMsg(q("[data-mm-billing-error]"), "Enter billing admin id and key.");
    sessionStorage.setItem(BILLING_ACTOR_KEY, actor);
    sessionStorage.setItem(BILLING_SECRET_KEY, key);
    void (async () => {
      try {
        setBillingIdentity(await api(API, { method: "POST", body: { action: "whoami" }, billing: true }));
        const keyInput = q("[data-mm-billing-key]");
        if (keyInput) keyInput.value = "";
      } catch (e) {
        sessionStorage.removeItem(BILLING_ACTOR_KEY);
        sessionStorage.removeItem(BILLING_SECRET_KEY);
        setBillingIdentity(null);
        setMsg(q("[data-mm-billing-error]"), e instanceof Error ? e.message : "Billing sign-in failed");
      }
      renderBillingState();
    })();
  });

  q("[data-mm-billing-disable]")?.addEventListener("click", () => {
    sessionStorage.removeItem(BILLING_ACTOR_KEY);
    sessionStorage.removeItem(BILLING_SECRET_KEY);
    setBillingIdentity(null);
    renderBillingState();
  });

  /* ----------------------------- lookup ----------------------------- */

  async function search(term) {
    setMsg(errorEl, "");
    setMsg(statusEl, "Searching…");
    if (resultsEl) resultsEl.innerHTML = "";
    try {
      const data = await api(`${API}?q=${encodeURIComponent(term)}`);
      setMsg(statusEl, `${data.count} membership${data.count === 1 ? "" : "s"} found.`);
      renderResults(data.results || []);
      if (data.results?.length === 1) void loadDetail(data.results[0].subscriptionRecordId);
    } catch (e) {
      setMsg(statusEl, "");
      setMsg(errorEl, e instanceof Error ? e.message : "Search failed");
    }
  }

  q("[data-mm-search]")?.addEventListener("click", () => {
    const term = String(q("[data-mm-query]")?.value || "").trim();
    if (term) void search(term);
  });
  q("[data-mm-query]")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      q("[data-mm-search]")?.click();
    }
  });

  function renderResults(rows) {
    if (!resultsEl) return;
    if (!rows.length) {
      resultsEl.innerHTML = `<p class="admin-sms__empty">No Stripe monthly memberships matched.</p>`;
      return;
    }
    resultsEl.innerHTML =
      `<div class="admin-sms__table-wrap"><table class="admin-sms__table"><thead><tr>` +
      `<th>Member</th><th>Plan</th><th>Status</th><th>Next billing</th><th></th></tr></thead><tbody>` +
      rows
        .map(
          (r) =>
            `<tr><td>${esc(r.customerName || "—")}<br /><small>${esc(r.customerEmail || "")}${r.mindbodyClientId ? ` · MB ${esc(String(r.mindbodyClientId))}` : ""}</small></td>` +
            `<td>${esc(r.planName)}${r.supported ? "" : " <small>(not changeable here)</small>"}${r.pendingPlanChange ? `<br /><small>Pending → ${esc(r.pendingPlanChange.toSku)}</small>` : ""}</td>` +
            `<td>${esc(r.status)}</td><td>${esc(day(r.currentPeriodEnd))}</td>` +
            `<td><button type="button" class="btn btn--ghost" data-mm-open="${esc(r.subscriptionRecordId)}">Open</button></td></tr>`,
        )
        .join("") +
      `</tbody></table></div>`;
  }

  resultsEl?.addEventListener("click", (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest("[data-mm-open]");
    if (btn) void loadDetail(btn.getAttribute("data-mm-open") || "");
  });

  /* ----------------------------- detail ----------------------------- */

  async function loadDetail(subscriptionId) {
    if (!detailEl) return;
    stopPolling();
    detailEl.innerHTML = `<section class="admin-sms__panel"><p class="admin-sms__status">Loading membership…</p></section>`;
    try {
      details = await api(`${API}?subscriptionId=${encodeURIComponent(subscriptionId)}`);
      renderDetail();
      const active = details.activeOperation;
      if (active && POLL_STATUSES.includes(active.status)) startPolling(active.id);
    } catch (e) {
      details = null;
      detailEl.innerHTML = `<section class="admin-sms__panel"><p class="admin-sms__error">${esc(e instanceof Error ? e.message : "Could not load membership")}</p></section>`;
    }
  }

  function noticeList(items, cls) {
    if (!items?.length) return "";
    return `<ul class="${cls}">${items.map((n) => `<li>${esc(n.message)}</li>`).join("")}</ul>`;
  }

  function operationBlock(op, canBill) {
    if (!op) return "";
    const actions = [];
    actions.push(`<button type="button" class="btn btn--ghost" data-mm-op-refresh="${esc(op.id)}">Refresh status</button>`);
    if (canBill && op.status === "scheduled") {
      actions.push(`<button type="button" class="btn btn--ghost" data-mm-op-cancel="${esc(op.id)}">Cancel scheduled change</button>`);
    }
    if (canBill && op.status === "needs_reconciliation" && op.errorCode === "mindbody_sync_failed") {
      actions.push(`<button type="button" class="btn" data-mm-op-retry="${esc(op.id)}">Retry Mindbody sync (no charge)</button>`);
    }
    const tone = op.status === "completed" ? "" : op.status === "failed" || op.status === "payment_required" || op.status === "needs_reconciliation" ? " admin-sms__flag--failed" : "";
    return (
      `<section class="admin-sms__panel admin-sms__panel--stack" data-mm-op="${esc(op.id)}">` +
      `<h3 class="admin-sms__panel-title">Plan change</h3>` +
      `<p class="admin-sms__attention"><span class="admin-sms__flag${tone}">${esc(op.status.replace(/_/g, " "))}</span> ${esc(op.stage)}</p>` +
      `<dl class="admin-sms__meta">` +
      `<div><dt>Change</dt><dd>${esc(op.fromSku)} → ${esc(op.toSku)}</dd></div>` +
      `<div><dt>Billing</dt><dd>${esc(op.billingPolicy.replace(/_/g, " "))}</dd></div>` +
      `<div><dt>Previewed</dt><dd>${usd(op.previewAmountCents)}</dd></div>` +
      `<div><dt>Charged</dt><dd>${op.amountChargedCents != null ? usd(op.amountChargedCents) : "—"}</dd></div>` +
      `<div><dt>Effective</dt><dd>${esc(day(op.effectiveAt))}</dd></div>` +
      `<div><dt>Stripe invoice</dt><dd><code>${esc(op.stripeInvoiceId || "—")}</code></dd></div>` +
      `<div><dt>Mindbody sale</dt><dd>${esc(op.mindbodySaleId || "—")}</dd></div>` +
      `<div><dt>Started by</dt><dd>${esc(op.actorId)}</dd></div>` +
      `</dl>` +
      (op.errorMessage ? `<p class="admin-sms__warn">${esc(op.errorMessage)}</p>` : "") +
      (op.recoveryNote ? `<p class="admin-sms__hint">${esc(op.recoveryNote)}</p>` : "") +
      `<div class="admin-sms__actions">${actions.join("")}</div>` +
      `</section>`
    );
  }

  function renderDetail() {
    if (!detailEl || !details) return;
    const m = details.membership;
    const pkg = m.mindbodyPackage;
    const credits = !pkg
      ? "Mindbody unavailable"
      : pkg.unlimited
        ? "Unlimited"
        : pkg.remaining != null
          ? `${pkg.remaining} remaining`
          : "No current package found";
    const priceNote =
      m.stripeUnitAmountCents != null && m.catalogAmountCents != null && m.stripeUnitAmountCents !== m.catalogAmountCents
        ? ` <small>(catalog ${usd(m.catalogAmountCents)})</small>`
        : "";
    const canBill = Boolean(billingActor);
    const blocked = (details.subscriptionBlockers || []).length > 0;
    const canChange =
      canBill &&
      m.supported &&
      !blocked &&
      (details.options || []).some((o) =>
        o.policies.some((p) => p.available || p.blockers.every((b) => b.code === "catalog_product_not_prepared")),
      );
    const pending = m.pendingPlanChange
      ? `${esc(m.pendingPlanChange.fromSku)} → ${esc(m.pendingPlanChange.toSku)} on ${esc(day(m.pendingPlanChange.effectiveAt))}`
      : "None";
    const history = (details.recentOperations || [])
      .filter((op) => !details.activeOperation || op.id !== details.activeOperation.id)
      .map(
        (op) =>
          `<tr><td>${esc(day(op.createdAt))}</td><td>${esc(op.fromSku)} → ${esc(op.toSku)}</td><td>${esc(op.status.replace(/_/g, " "))}</td>` +
          `<td>${op.amountChargedCents != null ? usd(op.amountChargedCents) : "—"}</td><td>${esc(op.actorId)}</td></tr>`,
      )
      .join("");
    detailEl.innerHTML =
      `<section class="admin-sms__panel admin-sms__panel--stack">` +
      `<h2 class="admin-sms__panel-title">Current membership</h2>` +
      `<dl class="admin-sms__meta">` +
      `<div><dt>Member</dt><dd>${esc(m.customerName || "—")}<br /><small>${esc(m.customerEmail || "")}</small></dd></div>` +
      `<div><dt>Plan</dt><dd><strong>${esc(m.planName)}</strong></dd></div>` +
      `<div><dt>Monthly price</dt><dd>${usd(m.stripeUnitAmountCents)}${priceNote}</dd></div>` +
      `<div><dt>Stripe status</dt><dd>${esc(m.stripeStatus || "—")} <small>(record: ${esc(m.recordStatus)})</small></dd></div>` +
      `<div><dt>Next billing date</dt><dd>${esc(day(m.nextBillingDate))}</dd></div>` +
      `<div><dt>Commitment end</dt><dd>${esc(day(m.commitmentEndDate))}</dd></div>` +
      `<div><dt>Credits</dt><dd>${esc(credits)}</dd></div>` +
      `<div><dt>Future bookings</dt><dd>${m.futureBookingCount == null ? "Unknown" : esc(String(m.futureBookingCount))}</dd></div>` +
      `<div><dt>Pending change</dt><dd>${pending}</dd></div>` +
      `<div><dt>Mindbody client</dt><dd>${esc(String(m.mindbodyClientId ?? "—"))}</dd></div>` +
      `</dl>` +
      noticeList(details.subscriptionBlockers, "admin-sms__warn") +
      `<div class="admin-sms__actions">` +
      `<button type="button" class="btn" data-mm-change-open ${canChange ? "" : "disabled"}>Change Membership</button>` +
      `<button type="button" class="btn btn--ghost" data-mm-reload>Reload</button>` +
      `</div>` +
      (!canBill ? `<p class="admin-sms__hint">Enable billing actions above to change this plan.</p>` : "") +
      (!m.supported ? `<p class="admin-sms__hint">This plan is not a Stripe-managed Monthly 5 / 8 / Unlimited membership.</p>` : "") +
      `</section>` +
      operationBlock(details.activeOperation, canBill) +
      (history
        ? `<section class="admin-sms__panel admin-sms__panel--stack"><h3 class="admin-sms__panel-title">Previous plan changes</h3>` +
          `<div class="admin-sms__table-wrap"><table class="admin-sms__table"><thead><tr><th>Date</th><th>Change</th><th>Status</th><th>Charged</th><th>By</th></tr></thead><tbody>${history}</tbody></table></div></section>`
        : "");
  }

  detailEl?.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    if (t.closest("[data-mm-reload]") && details) return void loadDetail(details.membership.subscriptionRecordId);
    if (t.closest("[data-mm-change-open]")) return openChangeDialog();
    const refresh = t.closest("[data-mm-op-refresh]");
    if (refresh) return void refreshOperation(refresh.getAttribute("data-mm-op-refresh") || "");
    const cancel = t.closest("[data-mm-op-cancel]");
    if (cancel) return void cancelScheduled(cancel.getAttribute("data-mm-op-cancel") || "", /** @type {HTMLButtonElement} */ (cancel));
    const retry = t.closest("[data-mm-op-retry]");
    if (retry) return void retrySync(retry.getAttribute("data-mm-op-retry") || "", /** @type {HTMLButtonElement} */ (retry));
  });

  function replaceOperation(op) {
    if (!details) return;
    details.activeOperation = ACTIVE_STATUSES.includes(op.status) ? op : null;
    details.recentOperations = [op, ...(details.recentOperations || []).filter((o) => o.id !== op.id)];
    renderDetail();
    if (!ACTIVE_STATUSES.includes(op.status)) {
      const host = detailEl?.querySelector("[data-mm-reload]")?.closest("section");
      host?.insertAdjacentHTML("afterend", operationBlock(op, Boolean(billingActor)));
    }
  }

  async function refreshOperation(id) {
    try {
      const data = await api(`${API}?operationId=${encodeURIComponent(id)}`);
      replaceOperation(data.operation);
      return data.operation;
    } catch (e) {
      setMsg(errorEl, e instanceof Error ? e.message : "Status check failed");
      return null;
    }
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function startPolling(id) {
    stopPolling();
    const startedAt = Date.now();
    const tick = async () => {
      const op = await refreshOperation(id);
      if (op && POLL_STATUSES.includes(op.status) && Date.now() - startedAt < 4 * 60 * 1000) {
        pollTimer = window.setTimeout(tick, 4000);
      } else if (op && !POLL_STATUSES.includes(op.status) && details) {
        void loadDetail(details.membership.subscriptionRecordId);
      }
    };
    pollTimer = window.setTimeout(tick, 3000);
  }

  async function cancelScheduled(id, btn) {
    if (!window.confirm("Cancel the scheduled plan change? The member stays on the current plan.")) return;
    btn.disabled = true;
    try {
      const data = await api(API, { method: "POST", body: { action: "cancel-scheduled", operationId: id }, billing: true });
      replaceOperation(data.operation);
      if (details) void loadDetail(details.membership.subscriptionRecordId);
    } catch (e) {
      btn.disabled = false;
      setMsg(errorEl, e instanceof Error ? e.message : "Cancel failed");
    }
  }

  async function retrySync(id, btn) {
    btn.disabled = true;
    try {
      const data = await api(API, { method: "POST", body: { action: "reconcile", operationId: id, retryMindbodySync: true }, billing: true });
      replaceOperation(data.operation);
    } catch (e) {
      btn.disabled = false;
      setMsg(errorEl, e instanceof Error ? e.message : "Retry failed");
    }
  }

  /* ----------------------------- change dialog ----------------------------- */

  function selectedOption() {
    return (details?.options || []).find((o) => o.sku === change.toSku) || null;
  }

  function openChangeDialog() {
    if (!details || !changeDialog) return;
    const m = details.membership;
    change.toSku = "";
    change.policy = "";
    resetPreview();
    q("[data-mm-change-current]").innerHTML =
      `<dl class="admin-sms__meta"><div><dt>Current plan</dt><dd><strong>${esc(m.planName)}</strong> · ${usd(m.stripeUnitAmountCents)}/month</dd></div>` +
      `<div><dt>Next billing</dt><dd>${esc(day(m.nextBillingDate))}</dd></div>` +
      `<div><dt>Commitment end</dt><dd>${esc(day(m.commitmentEndDate))}</dd></div></dl>`;
    renderPlanChoices();
    renderPolicyChoices();
    setMsg(q("[data-mm-change-error]"), "");
    changeDialog.showModal();
  }

  function renderPlanChoices() {
    const host = q("[data-mm-change-plans]");
    if (!host || !details) return;
    host.innerHTML = (details.options || [])
      .map((o) => {
        const any = o.policies.some((p) => p.available);
        const preparable = o.policies.some((p) => p.blockers.some((b) => b.code === "catalog_product_not_prepared"));
        return (
          `<label class="admin-events__check"><input type="radio" name="mm-plan" value="${esc(o.sku)}" ${any || preparable ? "" : "disabled"} ${change.toSku === o.sku ? "checked" : ""} /> ` +
          `<strong>${esc(o.displayName)}</strong> — ${usd(o.amountCents)}/month · ${esc(o.direction || "")}` +
          (any ? "" : preparable ? " <small>(Stripe product needs preparing)</small>" : " <small>(not available)</small>") +
          `</label>`
        );
      })
      .join("");
  }

  function renderPolicyChoices() {
    const host = q("[data-mm-change-policies]");
    if (!host) return;
    const opt = selectedOption();
    if (!opt) {
      host.innerHTML = `<p class="admin-sms__hint">Choose a new membership first.</p>`;
      return;
    }
    if (!change.policy || !opt.policies.some((p) => p.policy === change.policy && p.available)) {
      const preferred = opt.policies.find((p) => p.policy === opt.default && p.available) || opt.policies.find((p) => p.available);
      change.policy = preferred ? preferred.policy : "";
    }
    const needsProduct = opt.policies.some((p) => p.blockers.some((b) => b.code === "catalog_product_not_prepared"));
    host.innerHTML =
      opt.policies
        .map(
          (p) =>
            `<label class="admin-events__check"><input type="radio" name="mm-policy" value="${esc(p.policy)}" ${p.available ? "" : "disabled"} ${change.policy === p.policy ? "checked" : ""} /> ` +
            `<strong>${p.timing === "immediate" ? "Immediately" : "At next billing cycle"}</strong> — ${esc(p.label)}</label>` +
            (p.available ? "" : noticeList(p.blockers, "admin-sms__hint")),
        )
        .join("") +
      (needsProduct && billingActor
        ? `<div class="admin-sms__actions"><button type="button" class="btn btn--ghost" data-mm-prepare="${esc(opt.sku)}">Prepare Stripe product for ${esc(opt.displayName)} (one-time, no charge)</button></div>` +
          `<p class="admin-sms__status" data-mm-prepare-status hidden role="status"></p>`
        : "");
  }

  changeDialog?.addEventListener("click", (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest("[data-mm-prepare]");
    if (!btn || !details) return;
    const sku = btn.getAttribute("data-mm-prepare") || "";
    const statusLine = q("[data-mm-prepare-status]");
    /** @type {HTMLButtonElement} */ (btn).disabled = true;
    setMsg(statusLine, "Creating the Stripe product from the AMARÉ catalog…");
    void (async () => {
      try {
        await api(API, { method: "POST", billing: true, body: { action: "prepare-catalog", toSku: sku } });
        setMsg(statusLine, "Prepared. Stripe can take up to a minute to index it — checking…");
        for (let i = 0; i < 12; i += 1) {
          await new Promise((r) => setTimeout(r, 5000));
          details = await api(`${API}?subscriptionId=${encodeURIComponent(details.membership.subscriptionRecordId)}`);
          const opt = selectedOption();
          if (opt && !opt.policies.some((p) => p.blockers.some((b) => b.code === "catalog_product_not_prepared"))) break;
        }
        renderPlanChoices();
        renderPolicyChoices();
      } catch (e) {
        /** @type {HTMLButtonElement} */ (btn).disabled = false;
        setMsg(statusLine, e instanceof Error ? e.message : "Prepare failed");
      }
    })();
  });

  changeDialog?.addEventListener("change", (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.name === "mm-plan") {
      change.toSku = t.value;
      change.policy = "";
      renderPolicyChoices();
      resetPreview();
    } else if (t.name === "mm-policy") {
      change.policy = t.value;
      resetPreview();
    } else if (t.matches("[data-mm-ack]")) {
      updateContinue();
    }
  });

  function resetPreview() {
    change.preview = null;
    change.requestId = "";
    const out = q("[data-mm-preview-out]");
    if (out) out.innerHTML = "";
    updateContinue();
  }

  function ackInputs() {
    return [...(q("[data-mm-preview-out]")?.querySelectorAll("[data-mm-ack]") || [])];
  }

  function updateContinue() {
    const btn = q("[data-mm-continue]");
    if (!btn) return;
    const p = change.preview;
    btn.disabled = !(p && p.ok && p.previewToken && ackInputs().every((i) => /** @type {HTMLInputElement} */ (i).checked));
  }

  q("[data-mm-preview]")?.addEventListener("click", () => {
    if (!details || !change.toSku || !change.policy) {
      return setMsg(q("[data-mm-change-error]"), "Choose a new membership and a billing option.");
    }
    const btn = /** @type {HTMLButtonElement} */ (q("[data-mm-preview]"));
    btn.disabled = true;
    setMsg(q("[data-mm-change-error]"), "");
    const out = q("[data-mm-preview-out]");
    if (out) out.innerHTML = `<p class="admin-sms__status">Asking Stripe for an invoice preview…</p>`;
    void (async () => {
      try {
        const data = await api(API, {
          method: "POST",
          billing: true,
          body: { action: "preview", subscriptionId: details.membership.subscriptionRecordId, toSku: change.toSku, policy: change.policy },
        }).catch((e) => {
          if (e.data && e.data.blockers) return e.data;
          throw e;
        });
        change.preview = data;
        change.requestId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        renderPreview(data);
      } catch (e) {
        if (out) out.innerHTML = "";
        setMsg(q("[data-mm-change-error]"), e instanceof Error ? e.message : "Preview failed");
      } finally {
        btn.disabled = false;
        updateContinue();
      }
    })();
  });

  function renderPreview(p) {
    const out = q("[data-mm-preview-out]");
    if (!out) return;
    const b = p.billing || {};
    const lines = (b.lines || [])
      .map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.kind.replace(/_/g, " "))}</td><td>${usd(l.amountCents)}</td></tr>`)
      .join("");
    const warnings = (p.warnings || [])
      .map((w) =>
        w.ackRequired
          ? `<label class="admin-events__check admin-sms__warn"><input type="checkbox" data-mm-ack="${esc(w.code)}" /> ${esc(w.message)}</label>`
          : `<li>${esc(w.message)}</li>`,
      );
    const infos = warnings.filter((w) => w.startsWith("<li>"));
    const acks = warnings.filter((w) => !w.startsWith("<li>"));
    out.innerHTML =
      `<section class="admin-sms__panel admin-sms__panel--stack">` +
      `<h3 class="admin-sms__panel-title">Preview ${p.ok ? "" : "— cannot continue"}</h3>` +
      noticeList(p.blockers, "admin-sms__warn") +
      `<dl class="admin-sms__meta">` +
      `<div><dt>Current plan</dt><dd>${esc(p.fromPlanName)}</dd></div>` +
      `<div><dt>New plan</dt><dd><strong>${esc(p.toPlanName)}</strong></dd></div>` +
      `<div><dt>Effective</dt><dd>${esc(day(b.effectiveAt))}</dd></div>` +
      `<div><dt>Charge today</dt><dd><strong>${usd(b.chargeTodayCents)}</strong></dd></div>` +
      `<div><dt>Credit applied</dt><dd>${b.creditCents ? usd(b.creditCents) : "None"}</dd></div>` +
      (b.discountCents ? `<div><dt>Discount</dt><dd>${usd(-b.discountCents)}</dd></div>` : "") +
      (b.taxCents ? `<div><dt>Tax</dt><dd>${usd(b.taxCents)}</dd></div>` : "") +
      `<div><dt>Next renewal</dt><dd>${usd(b.nextRenewalAmountCents)} on ${esc(day(b.nextRenewalDate))}</dd></div>` +
      `</dl>` +
      (lines
        ? `<div class="admin-sms__table-wrap"><table class="admin-sms__table"><thead><tr><th>Stripe line</th><th>Type</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table></div>`
        : "") +
      (p.commitmentImpact ? `<p class="admin-sms__hint"><strong>Commitment:</strong> ${esc(p.commitmentImpact)}</p>` : "") +
      (p.mindbodyImpact ? `<p class="admin-sms__hint"><strong>Mindbody:</strong> ${esc(p.mindbodyImpact)}</p>` : "") +
      (infos.length ? `<ul class="admin-sms__hint">${infos.join("")}</ul>` : "") +
      (acks.length ? `<p class="admin-sms__label">Confirm each item before continuing:</p>${acks.join("")}` : "") +
      (p.ok ? `<p class="admin-sms__hint">Preview valid until ${esc(new Date(p.previewExpiresAt).toLocaleTimeString())}.</p>` : "") +
      `</section>`;
  }

  q("[data-mm-close]")?.addEventListener("click", () => changeDialog?.close());

  q("[data-mm-continue]")?.addEventListener("click", () => {
    const p = change.preview;
    if (!p?.ok || !confirmDialog) return;
    const b = p.billing;
    const immediate = p.timing === "immediate";
    q("[data-mm-confirm-body]").innerHTML =
      `<p>${esc(details.membership.customerName || details.membership.customerEmail || "Member")}: <strong>${esc(p.fromPlanName)}</strong> → <strong>${esc(p.toPlanName)}</strong></p>` +
      (immediate
        ? `<p class="admin-sms__warn">The saved card will be charged <strong>${usd(b.chargeTodayCents)}</strong> now. The new billing cycle starts today; next renewal ${usd(b.nextRenewalAmountCents)} on ${esc(day(b.nextRenewalDate))}.</p>`
        : `<p class="admin-sms__warn">Nothing is charged today. The plan switches on <strong>${esc(day(b.effectiveAt))}</strong> and renews at ${usd(b.nextRenewalAmountCents)}.</p>`) +
      `<p class="admin-sms__hint">Recorded as <strong>${esc(billingActor || "")}</strong>.</p>`;
    const go = /** @type {HTMLButtonElement} */ (q("[data-mm-confirm-go]"));
    go.textContent = immediate ? `Charge ${usd(b.chargeTodayCents)} and change plan` : "Schedule plan change";
    go.disabled = false;
    setMsg(q("[data-mm-confirm-error]"), "");
    confirmDialog.showModal();
  });

  q("[data-mm-confirm-cancel]")?.addEventListener("click", () => confirmDialog?.close());

  q("[data-mm-confirm-go]")?.addEventListener("click", () => {
    const p = change.preview;
    const go = /** @type {HTMLButtonElement} */ (q("[data-mm-confirm-go]"));
    if (!p?.ok || go.disabled) return;
    go.disabled = true;
    go.classList.add("admin-sms__btn--loading");
    setMsg(q("[data-mm-confirm-error]"), "");
    const acknowledgements = Object.fromEntries(
      ackInputs().map((i) => [i.getAttribute("data-mm-ack"), /** @type {HTMLInputElement} */ (i).checked]),
    );
    void (async () => {
      try {
        const data = await api(API, {
          method: "POST",
          billing: true,
          body: {
            action: "execute",
            previewToken: p.previewToken,
            confirmAmountCents: p.billing.chargeTodayCents,
            requestId: change.requestId,
            acknowledgements,
          },
        });
        confirmDialog?.close();
        changeDialog?.close();
        replaceOperation(data.operation);
        if (POLL_STATUSES.includes(data.operation.status)) startPolling(data.operation.id);
        else if (details) void loadDetail(details.membership.subscriptionRecordId);
      } catch (e) {
        const code = /** @type {any} */ (e).data?.error;
        const msg = e instanceof Error ? e.message : "Change failed";
        setMsg(q("[data-mm-confirm-error]"), msg);
        if (code === "stale_preview" || code === "preview_expired" || code === "invalid_preview") {
          resetPreview();
          setMsg(q("[data-mm-change-error]"), `${msg} Run the preview again.`);
          confirmDialog?.close();
        } else if (code !== "operation_in_progress") {
          go.disabled = false;
        }
      } finally {
        go.classList.remove("admin-sms__btn--loading");
      }
    })();
  });
})();
