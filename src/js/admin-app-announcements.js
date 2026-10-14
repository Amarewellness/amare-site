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
    displayTypeValue: root.querySelector("[data-app-announcement-display-type-value]"),
    displayTypeButtons: root.querySelectorAll("[data-announcement-display-type]"),
    requireAckRow: root.querySelector("[data-app-announcement-require-ack-row]"),
    activeSummary: root.querySelector("[data-app-announcement-active-summary]"),
    listBody: root.querySelector("[data-app-announcement-list-body]"),
    startsNow: root.querySelector("[data-app-announcement-starts-now]"),
    startsInput: root.querySelector("[data-app-announcement-starts]"),
    expiresInput: root.querySelector("[data-app-announcement-expires]"),
  };

  const STUDIO_TZ = "America/New_York";

  /** @type {string | null} */
  let formBaselineJson = null;

  function token() {
    return shared.getToken();
  }

  function studioEtDatetimeLocalFromDate(d) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const pick = (t) => parts.find((p) => p.type === t)?.value ?? "";
    return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
  }

  function studioEtDatetimeLocalNow() {
    return studioEtDatetimeLocalFromDate(new Date());
  }

  /** @param {string} localStr `YYYY-MM-DDTHH:mm` studio wall time */
  function etDatetimeLocalToUtcMs(localStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(localStr || "").trim());
    if (!m) return NaN;
    try {
      if (typeof Temporal !== "undefined") {
        return Temporal.ZonedDateTime.from({
          timeZone: STUDIO_TZ,
          year: +m[1],
          month: +m[2],
          day: +m[3],
          hour: +m[4],
          minute: +m[5],
          second: 0,
        }).epochMilliseconds;
      }
    } catch {
      /* fall through */
    }
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 5, +m[5], 0);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 48; i++) {
      const p = fmt.formatToParts(new Date(t));
      const n = (ty) => parseInt(p.find((x) => x.type === ty)?.value || "0", 10);
      if (
        n("year") === +m[1] &&
        n("month") === +m[2] &&
        n("day") === +m[3] &&
        n("hour") === +m[4] &&
        n("minute") === +m[5]
      ) {
        return t;
      }
      t +=
        (+m[4] - n("hour")) * 3600000 +
        (+m[5] - n("minute")) * 60000 +
        (+m[3] - n("day")) * 86400000;
    }
    return t;
  }

  /** @param {number} days */
  function setExpiresDaysAfterStart(days) {
    const startEl = el.startsInput || el.form?.elements.namedItem("startsAt");
    const expEl = el.expiresInput || el.form?.elements.namedItem("expiresAt");
    if (!expEl || !("value" in expEl)) return;
    const base =
      startEl && "value" in startEl && String(startEl.value || "").trim()
        ? String(startEl.value).trim()
        : studioEtDatetimeLocalNow();
    const ms = etDatetimeLocalToUtcMs(base);
    if (!Number.isFinite(ms)) {
      /** @type {HTMLInputElement} */ (expEl).value = studioEtDatetimeLocalNow();
      return;
    }
    /** @type {HTMLInputElement} */ (expEl).value = studioEtDatetimeLocalFromDate(
      new Date(ms + days * 86400000),
    );
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
    const v =
      el.displayTypeValue && "value" in el.displayTypeValue ? String(el.displayTypeValue.value) : "popup";
    return v === "board" ? "board" : "popup";
  }

  function syncDisplayTypeUi(displayType) {
    const isBoard = displayType === "board";
    const dt = isBoard ? "board" : "popup";
    if (el.displayTypeValue) el.displayTypeValue.value = dt;
    for (const btn of el.displayTypeButtons || []) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      const btnType = btn.getAttribute("data-announcement-display-type") === "board" ? "board" : "popup";
      const active = btnType === dt;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
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

  /** @param {Record<string, unknown> | null} ann @param {string} [editingDisplayType] */
  function fillForm(ann, editingDisplayType) {
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
    const dt =
      ann != null
        ? ann.displayType === "board"
          ? "board"
          : "popup"
        : editingDisplayType === "board"
          ? "board"
          : "popup";
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
    const editingType = data.displayType === "board" ? "board" : "popup";
    fillForm(data.announcement && typeof data.announcement === "object" ? data.announcement : null, editingType);
    renderActiveByTypeSummary(data);
    renderSummary(data);
    renderReceipts(Array.isArray(data.receipts) ? data.receipts : []);
    captureFormBaseline();
  }

  function beginNewAnnouncementLocal() {
    shared.showError(el.formErr, "");
    showFormOk("");
    fillForm(null, selectedDisplayType());
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

  async function loadAnnouncementById(id) {
    const data = await shared.adminFetch(
      token(),
      `/api/admin/app-announcement/current?id=${encodeURIComponent(id)}`,
    );
    applyPayload(data);
    if (el.form) el.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** @param {Record<string, unknown>[]} rows */
  function renderAnnouncementList(rows) {
    if (!el.listBody) return;
    if (!rows.length) {
      el.listBody.innerHTML = `<tr><td colspan="6">No announcements yet.</td></tr>`;
      return;
    }
    el.listBody.innerHTML = rows
      .map((ann) => {
        const id = shared.esc(String(ann.id || ""));
        const typeLabel = ann.displayType === "board" ? "Home board" : "Popup";
        const title = shared.esc(String(ann.title || "—"));
        const active = ann.isActive === true;
        const status = active ? `<strong>ACTIVE</strong>` : "Inactive";
        const window = `${shared.esc(fmtIso(ann.startsAt))} → ${shared.esc(fmtIso(ann.expiresAt))}`;
        const seen = Number(ann.seenClients) || 0;
        const toggleLabel = active ? "Deactivate" : "Activate";
        const toggleClass = active ? "btn btn--ghost" : "btn btn--ghost";
        const deleteDisabled = active ? " disabled title=\"Deactivate first\"" : "";
        return `<tr data-ann-id="${id}">
          <td>${shared.esc(typeLabel)}</td>
          <td>${title}</td>
          <td>${status}</td>
          <td>${window}</td>
          <td>${seen}</td>
          <td class="admin-sms__actions admin-sms__actions--inline">
            <button type="button" class="btn btn--ghost" data-ann-edit="${id}">Edit</button>
            <button type="button" class="${toggleClass}" data-ann-toggle="${id}" data-ann-active="${active ? "1" : "0"}">${toggleLabel}</button>
            <button type="button" class="btn btn--ghost" data-ann-delete="${id}"${deleteDisabled}>Delete</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  async function refreshList() {
    if (!el.listBody) return;
    try {
      const data = await shared.adminFetch(token(), "/api/admin/app-announcement/list");
      renderAnnouncementList(Array.isArray(data.announcements) ? data.announcements : []);
    } catch {
      el.listBody.innerHTML = `<tr><td colspan="6">Could not load list.</td></tr>`;
    }
  }

  async function reloadAll() {
    await Promise.all([loadCurrent(), refreshList()]);
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
      await reloadAll();
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
      await refreshList();
      showFormOk(hadId ? "Announcement updated." : "Announcement created.");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Save failed");
    }
  });

  async function setActiveForId(id, active) {
    shared.showError(el.formErr, "");
    showFormOk("");
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
      await refreshList();
      if (active) showFormOk("Announcement activated.");
      else showFormOk("Announcement deactivated.");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Update failed");
    }
  }

  async function deleteAnnouncementById(id) {
    if (!window.confirm("Delete this announcement permanently? Receipt analytics will be removed.")) return;
    shared.showError(el.formErr, "");
    showFormOk("");
    try {
      await shared.adminFetch(token(), "/api/admin/app-announcement/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (el.idInput?.value?.trim() === id) beginNewAnnouncementLocal();
      await reloadAll();
      showFormOk("Announcement deleted.");
    } catch (e) {
      shared.showError(el.formErr, e instanceof Error ? e.message : "Delete failed");
    }
  }

  el.activate?.addEventListener("click", () => {
    const id = el.idInput?.value?.trim();
    if (id) void setActiveForId(id, true);
  });
  el.deactivate?.addEventListener("click", () => {
    const id = el.idInput?.value?.trim();
    if (id) void setActiveForId(id, false);
  });

  el.listBody?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const editId = t.getAttribute("data-ann-edit");
    const toggleId = t.getAttribute("data-ann-toggle");
    const deleteId = t.getAttribute("data-ann-delete");
    if (editId) {
      if (isFormDirty()) {
        const ok = window.confirm("Discard unsaved changes and open this announcement?");
        if (!ok) return;
      }
      void loadAnnouncementById(editId);
      return;
    }
    if (toggleId) {
      const makeActive = t.getAttribute("data-ann-active") !== "1";
      void setActiveForId(toggleId, makeActive);
      return;
    }
    if (deleteId && !t.hasAttribute("disabled")) void deleteAnnouncementById(deleteId);
  });

  el.startsNow?.addEventListener("click", () => {
    const input = el.startsInput || el.form?.elements.namedItem("startsAt");
    if (input && "value" in input) {
      /** @type {HTMLInputElement} */ (input).value = studioEtDatetimeLocalNow();
    }
  });

  root.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const raw = t.getAttribute("data-app-announcement-expires-days");
    if (raw == null) return;
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 1) return;
    setExpiresDaysAfterStart(days);
  });

  async function switchDisplayType(nextType) {
    const dt = nextType === "board" ? "board" : "popup";
    if (dt === selectedDisplayType()) return;
    if (isFormDirty()) {
      const ok = window.confirm("Discard unsaved changes and switch display type?");
      if (!ok) {
        try {
          const b = JSON.parse(formBaselineJson || "{}");
          syncDisplayTypeUi(b.displayType === "board" ? "board" : "popup");
        } catch {
          syncDisplayTypeUi("popup");
        }
        return;
      }
    }
    syncDisplayTypeUi(dt);
    await loadCurrent();
  }

  for (const btn of el.displayTypeButtons || []) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-announcement-display-type");
      void switchDisplayType(next);
    });
  }

  if (token().length >= 16) void unlock();
})();
