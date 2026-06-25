(function () {
  const root = document.querySelector("[data-admin-coupons-root]");
  if (!root || !window.AmareFollowUpAdmin) return;
  const shared = window.AmareFollowUpAdmin;

  const el = {
    authPanel: root.querySelector("[data-coupons-auth-panel]"),
    main: root.querySelector("[data-coupons-main]"),
    tokenInput: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-coupons-token-input]")),
    unlock: root.querySelector("[data-coupons-token-unlock]"),
    authErr: root.querySelector("[data-coupons-auth-error]"),
    form: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-coupons-form]")),
    formErr: root.querySelector("[data-coupons-form-error]"),
    editMode: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-coupons-edit-mode]")),
    resetForm: root.querySelector("[data-coupons-reset-form]"),
    catalog: root.querySelector("[data-coupons-catalog]"),
    frequency: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-coupons-frequency]")),
    frequencyHint: root.querySelector("[data-coupons-frequency-hint]"),
    month: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-coupons-month]")),
    refresh: root.querySelector("[data-coupons-refresh]"),
    exportBtn: root.querySelector("[data-coupons-export]"),
    summary: root.querySelector("[data-coupons-summary]"),
    tbody: root.querySelector("[data-coupons-redemptions-body]"),
  };

  function token() {
    return shared.getToken();
  }

  function monthValue() {
    if (el.month?.value) return el.month.value;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function setMonthDefault() {
    if (el.month && !el.month.value) el.month.value = monthValue();
  }

  function frequencyLabel(type) {
    return type === "once_per_campaign" ? "Campaign (once)" : "Monthly";
  }

  function syncFrequencyHint() {
    const isCampaign = el.frequency?.value === "once_per_campaign";
    if (el.frequencyHint) el.frequencyHint.hidden = !isCampaign;
  }

  /** @param {Record<string, unknown>} benefit */
  function fillForm(benefit) {
    if (!el.form) return;
    const f = el.form;
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("title")).value = String(benefit.title || "");
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("partnerDisplayName")).value = String(
      benefit.partnerDisplayName || "",
    );
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("partnerSlug")).value = String(benefit.partnerSlug || "");
    /** @type {HTMLTextAreaElement|null} */ (f.elements.namedItem("description")).value = String(benefit.description || "");
    /** @type {HTMLTextAreaElement|null} */ (f.elements.namedItem("terms")).value = String(
      benefit.terms || "One per active monthly member per calendar month.",
    );
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("logoUrl")).value = String(benefit.logoUrl || "");
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("activeFrom")).value = String(benefit.activeFrom || "");
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("activeUntil")).value = String(benefit.activeUntil || "");
    const freq =
      benefit.frequency && typeof benefit.frequency === "object"
        ? String(/** @type {Record<string, unknown>} */ (benefit.frequency).type || "calendar_month")
        : "calendar_month";
    /** @type {HTMLSelectElement|null} */ (f.elements.namedItem("frequencyType")).value =
      freq === "once_per_campaign" ? "once_per_campaign" : "calendar_month";
    syncFrequencyHint();
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("active")).checked = benefit.active !== false;
    if (el.editMode) {
      el.editMode.value = "1";
      el.editMode.dataset.id = String(benefit.id || "");
    }
    if (el.resetForm) el.resetForm.hidden = false;
  }

  function resetForm() {
    if (!el.form) return;
    el.form.reset();
    /** @type {HTMLInputElement|null} */ (el.form.elements.namedItem("active")).checked = true;
    if (el.editMode) {
      el.editMode.value = "0";
      delete el.editMode.dataset.id;
    }
    if (el.resetForm) el.resetForm.hidden = true;
    syncFrequencyHint();
    shared.showError(el.formErr, "");
  }

  /** @param {Record<string, unknown>[]} benefits */
  function renderCatalog(benefits) {
    if (!el.catalog) return;
    if (!benefits.length) {
      el.catalog.innerHTML = `<p class="admin-sms__hint">No benefits yet.</p>`;
      return;
    }
    el.catalog.innerHTML = `<table class="admin-sms__table"><thead><tr><th>Title</th><th>Partner</th><th>Frequency</th><th>Active</th><th></th></tr></thead><tbody>${benefits
      .map(
        (b) => {
          const freq =
            b.frequency && typeof b.frequency === "object"
              ? String(/** @type {Record<string, unknown>} */ (b.frequency).type || "calendar_month")
              : "calendar_month";
          return `<tr>
          <td>${shared.esc(b.title)}</td>
          <td>${shared.esc(b.partnerDisplayName)}</td>
          <td>${shared.esc(frequencyLabel(freq))}</td>
          <td>${b.active === false ? "Off" : "On"}</td>
          <td><button type="button" class="btn btn--ghost" data-coupons-edit="${shared.esc(b.id)}">Edit</button></td>
        </tr>`;
        },
      )
      .join("")}</tbody></table>`;
    el.catalog.querySelectorAll("[data-coupons-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-coupons-edit");
        const row = benefits.find((b) => String(b.id) === id);
        if (row) fillForm(row);
      });
    });
  }

  /** @type {Record<string, unknown>[]} */
  let catalogCache = [];

  async function loadCatalog() {
    const data = await shared.adminFetch(token(), "/api/admin/benefits/list");
    catalogCache = Array.isArray(data.benefits) ? data.benefits : [];
    renderCatalog(catalogCache);
  }

  /** @param {Record<string, unknown>[]} rows */
  function renderRedemptions(rows, summary) {
    if (el.summary) {
      el.summary.innerHTML = `<span><strong>Total:</strong> ${summary.total ?? rows.length}</span>
        <span><strong>By benefit:</strong> ${shared.formatCountMap(summary.byBenefit)}</span>
        <span><strong>By partner:</strong> ${shared.formatCountMap(summary.byPartner)}</span>`;
    }
    if (!el.tbody) return;
    if (!rows.length) {
      el.tbody.innerHTML = `<tr><td colspan="4">No redemptions this month.</td></tr>`;
      return;
    }
    el.tbody.innerHTML = rows
      .map((r) => {
        const when = r.redeemedAt ? new Date(String(r.redeemedAt)).toLocaleString() : "—";
        return `<tr>
          <td>${shared.esc(when)}</td>
          <td>${shared.esc(r.memberDisplayName)}</td>
          <td>${shared.esc(r.benefitTitle)}</td>
          <td>${shared.esc(r.partnerDisplayName)}</td>
        </tr>`;
      })
      .join("");
  }

  async function loadRedemptions() {
    const month = monthValue();
    const data = await shared.adminFetch(token(), `/api/admin/benefits/redemptions?month=${encodeURIComponent(month)}`);
    renderRedemptions(Array.isArray(data.rows) ? data.rows : [], data);
  }

  async function unlock() {
    const t = (el.tokenInput?.value || "").trim();
    if (!t) {
      shared.showError(el.authErr, "Enter admin token.");
      return;
    }
    shared.setToken(t);
    try {
      await loadCatalog();
      setMonthDefault();
      await loadRedemptions();
      if (el.authPanel) el.authPanel.hidden = true;
      if (el.main) el.main.hidden = false;
      shared.showError(el.authErr, "");
    } catch (e) {
      shared.setToken("");
      shared.showError(el.authErr, e instanceof Error ? e.message : "Unauthorized");
    }
  }

  async function saveBenefit(ev) {
    ev.preventDefault();
    if (!el.form) return;
    const fd = new FormData(el.form);
    const body = {
      title: fd.get("title"),
      partnerDisplayName: fd.get("partnerDisplayName"),
      partnerSlug: fd.get("partnerSlug"),
      description: fd.get("description"),
      terms: fd.get("terms"),
      logoUrl: fd.get("logoUrl"),
      activeFrom: fd.get("activeFrom"),
      activeUntil: fd.get("activeUntil"),
      frequencyType: fd.get("frequencyType"),
      active: fd.get("active") === "1",
    };
    const editing = el.editMode?.value === "1" && el.editMode.dataset.id;
    try {
      if (editing) {
        await shared.adminFetch(token(), "/api/admin/benefits/update", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, id: el.editMode.dataset.id }),
        });
      } else {
        await shared.adminFetch(token(), "/api/admin/benefits/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      resetForm();
      await loadCatalog();
      shared.showError(el.formErr, "");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Save failed");
    }
  }

  async function exportCsv() {
    const month = monthValue();
    const t = token();
    const res = await fetch(`/api/admin/benefits/redemptions/export?month=${encodeURIComponent(month)}`, {
      headers: { "x-admin-token": t },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `benefits-redemptions-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  el.unlock?.addEventListener("click", () => void unlock());
  el.form?.addEventListener("submit", (ev) => void saveBenefit(ev));
  el.resetForm?.addEventListener("click", resetForm);
  el.frequency?.addEventListener("change", syncFrequencyHint);
  el.refresh?.addEventListener("click", () => void loadRedemptions().catch((e) => shared.showError(el.formErr, String(e.message))));
  el.exportBtn?.addEventListener("click", () => void exportCsv().catch((e) => shared.showError(el.formErr, String(e.message))));

  const saved = shared.getToken();
  if (saved && el.tokenInput) {
    el.tokenInput.value = saved;
    void unlock();
  }
})();
