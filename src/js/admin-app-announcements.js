(function () {
  const root = document.querySelector("[data-admin-app-announcement-root]");
  if (!root || !window.AmareFollowUpAdmin) return;
  const shared = window.AmareFollowUpAdmin;

  const el = {
    authPanel: root.querySelector("[data-app-announcement-auth-panel]"),
    main: root.querySelector("[data-app-announcement-main]"),
    tokenInput: root.querySelector("[data-app-announcement-token-input]"),
    unlock: root.querySelector("[data-app-announcement-unlock]"),
    authErr: root.querySelector("[data-app-announcement-auth-error]"),
    form: root.querySelector("[data-app-announcement-form]"),
    formErr: root.querySelector("[data-app-announcement-form-error]"),
    formOk: root.querySelector("[data-app-announcement-form-ok]"),
    idInput: root.querySelector("[data-app-announcement-id]"),
    statusHint: root.querySelector("[data-app-announcement-status]"),
    newBtn: root.querySelector("[data-app-announcement-new]"),
    activate: root.querySelector("[data-app-announcement-activate]"),
    deactivate: root.querySelector("[data-app-announcement-deactivate]"),
    summary: root.querySelector("[data-app-announcement-summary]"),
    tbody: root.querySelector("[data-app-announcement-receipts-body]"),
    displayType: root.querySelector("[data-app-announcement-display-type]"),
    requireAckRow: root.querySelector("[data-app-announcement-require-ack-row]"),
    activeSummary: root.querySelector("[data-app-announcement-active-summary]"),
  };

  /** @type {string | null} */
  let formBaselineJson = null;

  function token() {
    return shared.getToken();
  }

  function fmtIso(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(String(iso));
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString("en-US", { timeZone: "America/New_York" });
    } catch {
      return "—";
    }
  }

  function showFormOk(msg) {
    if (!el.formOk) return;
    if (msg) {
      el.formOk.textContent = msg;
      el.formOk.hidden = false;
    } else {
      el.formOk.textContent = "";
      el.formOk.hidden = true;
    }
  }

  function snapshotFormJson() {
    const p = formPayload();
    return JSON.stringify(p ?? {});
  }

  function captureFormBaseline() {
    formBaselineJson = snapshotFormJson();
  }

  function isFormDirty() {
    if (formBaselineJson == null) return false;
    return snapshotFormJson() !== formBaselineJson;
  }

  function emptyAnalyticsPanel() {
    renderSummary({ seenClients: 0, acknowledgedClients: 0, ackRate: null, ackAnalyticsApplicable: true });
    renderReceipts([]);
  }

  function selectedDisplayType() {
    const v = el.displayType && "value" in el.displayType ? String(el.displayType.value) : "popup";
    return v === "board" ? "board" : "popup";
  }

  function syncDisplayTypeUi(displayType) {
    const isBoard = displayType === "board";
    if (el.displayType) el.displayType.value = isBoard ? "board" : "popup";
    if (el.requireAckRow) {
      el.requireAckRow.hidden = isBoard;
      if (isBoard) {
        const ack = el.form?.elements.namedItem("requireAcknowledgment");
        if (ack && "checked" in ack) ack.checked = false;
      }
    }
  }

  /** @param {Record<string, unknown>} data */
  function renderActiveByTypeSummary(data) {
    if (!el.activeSummary) return;
    const fmt = (label, row) => {
      if (!row || typeof row !== "object") return `<p><strong>${label}:</strong> None</p>`;
      const title = row.title ? shared.esc(String(row.title)) : "—";
      const active = row.isActive === true ? "ACTIVE" : "inactive";
      return `<p><strong>${label}:</strong> ${title} <span class="admin-sms__hint">(${active})</span></p>`;
    };
    el.activeSummary.innerHTML =
      fmt("Active popup", data.activePopup) + fmt("Active home board", data.activeBoard);
  }

  function setCreatingNewMode() {
    if (el.statusHint) {
      el.statusHint.hidden = false;
      el.statusHint.textContent =
        "Creating a new announcement. Save to create a new campaign; users who saw a previous announcement can see this one.";
    }
  }

  /** @param {Record<string, unknown> | null} ann */
  function fillForm(ann) {
    if (!el.form) return;
    const f = el.form;
    if (el.idInput) el.idInput.value = ann && ann.id ? String(ann.id) : "";
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("title")).value =
      ann && ann.title ? String(ann.title) : "";
    /** @type {HTMLTextAreaElement|null} */ (f.elements.namedItem("message")).value =
      ann && ann.message ? String(ann.message) : "";
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("startsAt")).value =
      ann && ann.startsAtEt ? String(ann.startsAtEt) : "";
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("expiresAt")).value =
      ann && ann.expiresAtEt ? String(ann.expiresAtEt) : "";
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("requireAcknowledgment")).checked =
      ann ? ann.requireAcknowledgment === true : false;
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("ctaLabel")).value =
      ann && ann.ctaLabel ? String(ann.ctaLabel) : "Got it";
    /** @type {HTMLInputElement|null} */ (f.elements.namedItem("ctaUrl")).value =
      ann && ann.ctaUrl ? String(ann.ctaUrl) : "";
    const dt = ann && ann.displayType === "board" ? "board" : "popup";
    syncDisplayTypeUi(dt);
    if (el.statusHint) {
      if (ann && ann.isActive) {
        el.statusHint.hidden = false;
        el.statusHint.textContent =
          dt === "board"
            ? "Status: ACTIVE board (Home card when within start/end window)."
            : "Status: ACTIVE popup (modal when within start/end window).";
      } else if (ann && ann.id) {
        el.statusHint.hidden = false;
        el.statusHint.textContent = "Status: inactive (not shown in app).";
      } else {
        el.statusHint.hidden = true;
        el.statusHint.textContent = "";
      }
    }
  }

  /** @param {Record<string, unknown>} data */
  function renderSummary(data) {
    if (!el.summary) return;
    const seen = Number(data.seenClients) || 0;
    const ackApplicable = data.ackAnalyticsApplicable !== false;
    const ack =
      ackApplicable && data.acknowledgedClients != null ? Number(data.acknowledgedClients) || 0 : null;
    const rate =
      ackApplicable && typeof data.ackRate === "number" ? `${(data.ackRate * 100).toFixed(1)}%` : "N/A";
    el.summary.innerHTML = `<p><strong>Seen clients:</strong> ${seen}</p>
      <p><strong>Acknowledged:</strong> ${ackApplicable ? ack : "N/A"}</p>
      <p><strong>Acknowledgment rate:</strong> ${rate}</p>`;
  }

  /** @param {Record<string, unknown>[]} rows */
  function renderReceipts(rows) {
    if (!el.tbody) return;
    if (!rows.length) {
      el.tbody.innerHTML = `<tr><td colspan="5">No views yet.</td></tr>`;
      return;
    }
    el.tbody.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${shared.esc(r.email || "—")}</td>
          <td>${r.mindbodyClientId != null ? shared.esc(String(r.mindbodyClientId)) : "—"}</td>
          <td>${shared.esc(fmtIso(r.firstSeenAt))}</td>
          <td>${r.acknowledged ? "Yes" : "—"}</td>
          <td>${shared.esc(fmtIso(r.acknowledgedAt))}</td>
        </tr>`,
      )
      .join("");
  }

  /** @param {Record<string, unknown>} data */
  function applyPayload(data) {
    if (data.displayType === "board" || data.displayType === "popup") {
      syncDisplayTypeUi(String(data.displayType));
    }
    fillForm(data.announcement && typeof data.announcement === "object" ? data.announcement : null);
    renderActiveByTypeSummary(data);
    renderSummary(data);
    renderReceipts(Array.isArray(data.receipts) ? data.receipts : []);
    captureFormBaseline();
  }

  function beginNewAnnouncementLocal() {
    shared.showError(el.formErr, "");
    showFormOk("");
    fillForm(null);
    syncDisplayTypeUi(selectedDisplayType());
    emptyAnalyticsPanel();
    setCreatingNewMode();
    captureFormBaseline();
  }

  function currentApiPath() {
    return `/api/admin/app-announcement/current?displayType=${encodeURIComponent(selectedDisplayType())}`;
  }

  async function loadCurrent() {
    const data = await shared.adminFetch(token(), currentApiPath());
    applyPayload(data);
  }

  function formPayload() {
    if (!el.form) return null;
    const f = el.form;
    return {
      id: el.idInput?.value?.trim() || undefined,
      title: /** @type {HTMLInputElement} */ (f.elements.namedItem("title")).value,
      message: /** @type {HTMLTextAreaElement} */ (f.elements.namedItem("message")).value,
      startsAt: /** @type {HTMLInputElement} */ (f.elements.namedItem("startsAt")).value,
      expiresAt: /** @type {HTMLInputElement} */ (f.elements.namedItem("expiresAt")).value,
      displayType: selectedDisplayType(),
      requireAcknowledgment:
        selectedDisplayType() === "board"
          ? false
          : /** @type {HTMLInputElement} */ (f.elements.namedItem("requireAcknowledgment")).checked,
      ctaLabel: /** @type {HTMLInputElement} */ (f.elements.namedItem("ctaLabel")).value,
      ctaUrl: /** @type {HTMLInputElement} */ (f.elements.namedItem("ctaUrl")).value.trim() || null,
    };
  }

  async function unlock() {
    shared.showError(el.authErr, "");
    try {
      const t = await shared.resolveAdminSession(root);
      shared.setToken(t);
      if (el.authPanel) el.authPanel.hidden = true;
      if (el.main) el.main.hidden = false;
      await loadCurrent();
    } catch (e) {
      shared.showError(el.authErr, e instanceof Error ? e.message : "Unlock failed");
    }
  }

  el.unlock?.addEventListener("click", () => void unlock());

  el.newBtn?.addEventListener("click", () => {
    if (isFormDirty()) {
      const ok = window.confirm("Discard unsaved changes and create a new announcement?");
      if (!ok) return;
    }
    beginNewAnnouncementLocal();
  });

  el.form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    shared.showError(el.formErr, "");
    showFormOk("");
    const hadId = !!(el.idInput?.value?.trim());
    try {
      const body = formPayload();
      const data = await shared.adminFetch(token(), "/api/admin/app-announcement/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      applyPayload(data);
      showFormOk(hadId ? "Announcement updated." : "Announcement created.");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Save failed");
    }
  });

  async function setActive(active) {
    shared.showError(el.formErr, "");
    showFormOk("");
    const id = el.idInput?.value?.trim();
    if (!id) {
      shared.showError(el.formErr, "Save the announcement first to get an ID.");
      return;
    }
    try {
      const data = await shared.adminFetch(token(), "/api/admin/app-announcement/set-active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active }),
      });
      applyPayload(data);
      if (active) showFormOk("Announcement activated.");
      else showFormOk("Announcement deactivated.");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Update failed");
    }
  }

  el.activate?.addEventListener("click", () => void setActive(true));
  el.deactivate?.addEventListener("click", () => void setActive(false));

  el.displayType?.addEventListener("change", () => {
    if (isFormDirty()) {
      const ok = window.confirm("Discard unsaved changes and switch display type?");
      if (!ok) {
        void loadCurrent();
        return;
      }
    }
    syncDisplayTypeUi(selectedDisplayType());
    void loadCurrent();
  });

  if (token().length >= 16) void unlock();
})();
