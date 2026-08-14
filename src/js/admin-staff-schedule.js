/**
 * AMARÉ Front Desk Schedule — admin UI (Phase A1).
 */
(function adminStaffSchedule() {
  const root = document.querySelector("[data-staff-schedule-root]");
  if (!root) return;

  const shared = window.AmareFollowUpAdmin;
  if (!shared) return;

  const API = "/api/admin/staff-schedule";
  const STAFF_BUFFER_HOURS_PER_SHIFT = 45 / 60; // 30 min before + 15 min after
  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const SLOTS = [
    { id: "early_morning", label: "Early Morning" },
    { id: "morning", label: "Morning" },
    { id: "evening", label: "Evening" },
  ];

  const authPanel = root.querySelector("[data-staff-schedule-auth-panel]");
  const mainPanel = root.querySelector("[data-staff-schedule-main]");
  const tokenInput = root.querySelector("[data-staff-schedule-token-input]");
  const authError = root.querySelector("[data-staff-schedule-auth-error]");
  const staffListBody = root.querySelector("[data-staff-list-body]");
  const staffListEmpty = root.querySelector("[data-staff-list-empty]");
  const staffManageError = root.querySelector("[data-staff-manage-error]");
  const weekStartInput = root.querySelector("[data-week-start]");
  const weekGridHead = root.querySelector("[data-week-grid-head]");
  const weekGridBody = root.querySelector("[data-week-grid-body]");
  const weekStatusBadge = root.querySelector("[data-week-status-badge]");
  const weekRangeHint = root.querySelector("[data-week-range-hint]");
  const weekStatus = root.querySelector("[data-week-status]");
  const weekError = root.querySelector("[data-week-error]");
  const sharePreview = root.querySelector("[data-week-share-preview]");
  const summaryTitle = root.querySelector("[data-week-summary-title]");
  const summaryStatus = root.querySelector("[data-week-summary-status]");
  const summaryHead = root.querySelector("[data-week-summary-head]");
  const summaryBody = root.querySelector("[data-week-summary-body]");
  const confirmDialogEl = root.querySelector("[data-staff-schedule-confirm]");
  const confirmTitleEl = root.querySelector("[data-staff-schedule-confirm-title]");
  const confirmMessageEl = root.querySelector("[data-staff-schedule-confirm-message]");
  const confirmOkBtn = root.querySelector("[data-staff-schedule-confirm-ok]");
  const confirmCancelBtn = root.querySelector("[data-staff-schedule-confirm-cancel]");
  const staffAddDialog = root.querySelector("[data-staff-add-dialog]");
  const staffAddForm = root.querySelector("[data-staff-add-form]");
  const staffAddError = root.querySelector("[data-staff-add-error]");
  const staffAddOpenBtn = root.querySelector("[data-staff-add-open]");
  const staffAddCancelBtn = root.querySelector("[data-staff-add-cancel]");
  const weekSwitchDialog = root.querySelector("[data-week-switch-dialog]");
  const weekSwitchForm = root.querySelector("[data-week-switch-form]");
  const weekSwitchFrom = root.querySelector("[data-week-switch-from]");
  const weekSwitchOther = root.querySelector("[data-week-switch-other]");
  const weekSwitchStaff = root.querySelector("[data-week-switch-staff]");
  const weekSwitchError = root.querySelector("[data-week-switch-error]");
  const weekSwitchReassignWrap = root.querySelector("[data-week-switch-reassign]");
  const weekSwitchSwapWrap = root.querySelector("[data-week-switch-swap]");
  const staffEditDialog = root.querySelector("[data-staff-edit-dialog]");
  const staffEditName = root.querySelector("[data-staff-edit-name]");
  const staffEditEmail = root.querySelector("[data-staff-edit-email]");
  const staffEditPin = root.querySelector("[data-staff-edit-pin]");
  const staffEditHourlyRate = root.querySelector("[data-staff-edit-hourly-rate]");
  const staffEditActive = root.querySelector("[data-staff-edit-active]");
  const staffEditSaveBtn = root.querySelector("[data-staff-edit-save]");
  const staffEditCancelBtn = root.querySelector("[data-staff-edit-cancel]");
  const staffTotalsBody = root.querySelector("[data-staff-totals-body]");
  const staffTotalsFoot = root.querySelector("[data-staff-totals-foot]");
  const staffTotalsEmpty = root.querySelector("[data-staff-totals-empty]");
  const staffTotalsRange = root.querySelector("[data-staff-totals-range]");
  const staffTotalsError = root.querySelector("[data-staff-totals-error]");
  const staffTotalsDisclaimer = root.querySelector("[data-staff-totals-disclaimer]");
  const staffTotalsMonthInput = root.querySelector("[data-staff-totals-month]");
  const staffTotalsPublishedOnly = root.querySelector("[data-staff-totals-published-only]");
  const staffTotalsModeBtns = root.querySelectorAll("[data-staff-totals-mode]");
  const staffTotalsWeekNav = root.querySelector("[data-staff-totals-week-nav]");
  const staffTotalsMonthNav = root.querySelector("[data-staff-totals-month-nav]");
  const staffTotalsWeekStartInput = root.querySelector("[data-staff-totals-week-start]");
  const commissionBody = root.querySelector("[data-commission-body]");
  const commissionFoot = root.querySelector("[data-commission-foot]");
  const commissionEmpty = root.querySelector("[data-commission-empty]");
  const commissionError = root.querySelector("[data-commission-error]");
  const commissionAddDialog = root.querySelector("[data-commission-add-dialog]");
  const commissionAddForm = root.querySelector("[data-commission-add-form]");
  const commissionAddError = root.querySelector("[data-commission-add-error]");
  const commissionStaffSelect = root.querySelector("[data-commission-staff]");
  const commissionPackageSelect = root.querySelector("[data-commission-package]");
  const commissionAmountInput = root.querySelector("[data-commission-amount]");
  const commissionClientInput = root.querySelector("[data-commission-client]");
  const commissionDateInput = root.querySelector("[data-commission-date]");
  const commissionTimeInput = root.querySelector("[data-commission-time]");
  const commissionRatesDialog = root.querySelector("[data-commission-rates-dialog]");
  const commissionRatesForm = root.querySelector("[data-commission-rates-form]");
  const commissionRatesFields = root.querySelector("[data-commission-rates-fields]");
  const commissionRatesError = root.querySelector("[data-commission-rates-error]");
  /** @type {{ id: string, label: string, amountUsd: number }[]} */
  let commissionPackages = [];
  const availabilityFormLink = root.querySelector("[data-week-open-availability-form]");
  const availabilityWeekStartInput = root.querySelector("[data-availability-week-start]");
  const availabilityRangeHint = root.querySelector("[data-week-availability-range-hint]");
  const availabilityList = root.querySelector("[data-week-availability-list]");
  const availabilityEmpty = root.querySelector("[data-week-availability-empty]");
  const availabilityHint = root.querySelector("[data-week-availability-hint]");
  const availabilityContext = root.querySelector("[data-week-availability-context]");
  const availabilityError = root.querySelector("[data-week-availability-error]");

  /** @type {Record<string, unknown>[]} */
  let staffRows = [];
  /** @type {Record<string, unknown> | null} */
  let weekDoc = null;
  /** @type {string} */
  let weekStart = "";
  /** @type {string} */
  let availabilityWeekStart = "";
  /** @type {boolean} */
  let emailStaffAvailable = false;
  /** @type {"week"|"month"} */
  let staffTotalsMode = "week";
  /** @type {Record<string, unknown> | null} */
  let staffTotalsSummary = null;
  /** @type {string} */
  let staffTotalsWeekStart = "";
  /** @type {string | null} */
  let editingStaffId = null;
  /** @type {Record<string, unknown> | null} */
  let availabilityWindow = null;
  /** @type {Map<string, { staffId: string; staffName: string }[]>} */
  let availabilityByCell = new Map();
  let switchPickMode = false;
  /** @type {{ date: string, slot: string }[]} */
  let switchPicks = [];

  const availabilityOpenBtn = root.querySelector("[data-week-availability-open]");
  const availabilityCloseBtn = root.querySelector("[data-week-availability-close]");
  const availabilitySendReminderBtn = root.querySelector("[data-week-availability-send-reminder]");
  const availabilityStatusBadge = root.querySelector("[data-week-availability-status]");
  const availabilityEarlyMorningCheck = root.querySelector("[data-week-availability-early-morning]");
  const availabilityReminderDialog = root.querySelector("[data-availability-reminder-dialog]");
  const availabilityReminderMessage = root.querySelector("[data-availability-reminder-message]");
  const availabilityReminderSelectAll = root.querySelector("[data-availability-reminder-select-all]");
  const availabilityReminderStaffList = root.querySelector("[data-availability-reminder-staff-list]");
  const availabilityReminderError = root.querySelector("[data-availability-reminder-error]");
  const availabilityReminderSendBtn = root.querySelector("[data-availability-reminder-send]");
  const availabilityReminderCancelBtn = root.querySelector("[data-availability-reminder-cancel]");

  /** @param {string} msg */
  function setWeekStatus(msg) {
    if (!weekStatus) return;
    weekStatus.textContent = msg || "";
    weekStatus.hidden = !msg;
  }

  /** @param {HTMLElement | null} el @param {string} msg */
  function showErr(el, msg) {
    shared.showError(el, msg);
  }

  /**
   * @param {{ title: string; message: string; confirmLabel?: string; cancelLabel?: string }} opts
   * @returns {Promise<boolean>}
   */
  function confirmDialog(opts) {
    const { title, message, confirmLabel = "Confirm", cancelLabel = "Cancel" } = opts;
    if (
      !(confirmDialogEl instanceof HTMLDialogElement) ||
      !confirmTitleEl ||
      !confirmMessageEl ||
      !(confirmOkBtn instanceof HTMLButtonElement) ||
      !(confirmCancelBtn instanceof HTMLButtonElement)
    ) {
      return Promise.resolve(window.confirm(message));
    }

    return new Promise((resolve) => {
      confirmTitleEl.textContent = title;
      confirmMessageEl.textContent = message;
      confirmOkBtn.textContent = confirmLabel;
      confirmCancelBtn.textContent = cancelLabel;

      /** @param {boolean} result */
      const finish = (result) => {
        confirmOkBtn.removeEventListener("click", onOk);
        confirmCancelBtn.removeEventListener("click", onCancel);
        confirmDialogEl.removeEventListener("cancel", onCancel);
        if (confirmDialogEl.open) confirmDialogEl.close();
        resolve(result);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);

      confirmOkBtn.addEventListener("click", onOk);
      confirmCancelBtn.addEventListener("click", onCancel);
      confirmDialogEl.addEventListener("cancel", onCancel);
      confirmDialogEl.showModal();
      confirmOkBtn.focus();
    });
  }

  /** @param {string} token @param {string} path @param {RequestInit} [init] */
  function api(token, path, init) {
    return shared.adminFetch(token, `${API}${path}`, init);
  }

  /** @param {string} ymd */
  function isWeekStartYmdLocal(ymd) {
    const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
  }

  /** @param {string} ymd */
  function weekStartForYmdLocal(ymd) {
    const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDaysYmd(ymd, -dow);
  }

  /** @param {string} ymd @param {number} days */
  function addDaysYmd(ymd, days) {
    const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
    const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
    return dt.toISOString().slice(0, 10);
  }

  function todayYmdEt() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  }

  /** @param {string} start */
  function weekDatesFromStart(start) {
    /** @type {string[]} */
    const out = [];
    for (let i = 0; i < 7; i += 1) out.push(addDaysYmd(start, i));
    return out;
  }

  /** @param {string} ym */
  function monthRangeFromInput(ym) {
    const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  }

  function currentMonthInputValue() {
    return todayYmdEt().slice(0, 7);
  }

  /** @param {string} ymd */
  function setStaffTotalsWeekStart(ymd) {
    staffTotalsWeekStart = isWeekStartYmdLocal(ymd) ? ymd : weekStartForYmdLocal(ymd);
    if (staffTotalsWeekStartInput instanceof HTMLInputElement) {
      staffTotalsWeekStartInput.value = staffTotalsWeekStart;
    }
  }

  /** @returns {{ from: string; to: string } | null} */
  function staffTotalsDateRange() {
    if (staffTotalsMode === "week" || staffTotalsMode === "two_weeks") {
      if (!staffTotalsWeekStart || !isWeekStartYmdLocal(staffTotalsWeekStart)) return null;
      const days = staffTotalsMode === "two_weeks" ? 13 : 6;
      return { from: staffTotalsWeekStart, to: addDaysYmd(staffTotalsWeekStart, days) };
    }
    if (!(staffTotalsMonthInput instanceof HTMLInputElement)) return null;
    const ym = staffTotalsMonthInput.value || currentMonthInputValue();
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    return monthRangeFromInput(ym);
  }

  /** @param {number | null | undefined} value */
  function formatHourlyRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `$${n.toFixed(2)}`;
  }

  /** @param {number | null | undefined} value */
  function formatPayAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `$${n.toFixed(2)}`;
  }

  /** @param {unknown} raw @returns {number | null | undefined} */
  function parseHourlyRateInput(raw) {
    if (raw === undefined) return undefined;
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const n = parseFloat(text);
    if (!Number.isFinite(n) || n < 0) throw new Error("Hourly rate must be a non-negative number.");
    return Math.round(n * 100) / 100;
  }

  /** @param {number} plannedHours @param {number} totalShifts @param {unknown} [apiTotalHours] */
  function displayStaffTotalHours(plannedHours, totalShifts, apiTotalHours) {
    const api = Number(apiTotalHours);
    if (Number.isFinite(api) && api > 0) return api;
    const planned = Number(plannedHours) || 0;
    const shifts = Number(totalShifts) || 0;
    if (!shifts) return Number.isFinite(api) ? api : 0;
    return Math.round((planned + shifts * STAFF_BUFFER_HOURS_PER_SHIFT) * 10) / 10;
  }

  /** @param {Record<string, unknown>} summary */
  function renderStaffTotals(summary) {
    staffTotalsSummary = summary;
    const staff = Array.isArray(summary.staff) ? summary.staff : [];
    const withShifts = staff.filter((row) => Number(row.totalShifts) > 0);

    if (staffTotalsBody) {
      staffTotalsBody.innerHTML = "";
      for (const row of staff) {
        const tr = document.createElement("tr");
        const shifts = Number(row.totalShifts) || 0;
        const plannedHours = Number(row.plannedHours) || 0;
        const totalHours = displayStaffTotalHours(plannedHours, shifts, row.totalHours);
        const hourlyRate = Number(row.hourlyRate);
        const totalPay =
          Number.isFinite(hourlyRate) && hourlyRate > 0 && totalHours > 0
            ? Math.round(hourlyRate * totalHours * 100) / 100
            : row.totalPay;
        const inactive = row.active === false && shifts === 0;
        tr.innerHTML = `
          <td>${shared.esc(row.name)}${inactive ? ' <span class="admin-staff-schedule__totals-inactive">(inactive)</span>' : ""}</td>
          <td>${shifts}</td>
          <td>${plannedHours}</td>
          <td>${totalHours}</td>
          <td>${formatHourlyRate(row.hourlyRate)}</td>
          <td>${formatPayAmount(totalPay)}</td>
          <td>${formatPayAmount(row.commissionTotal)}</td>
          <td>${formatPayAmount(row.combinedPay ?? ((Number(totalPay) || 0) + (Number(row.commissionTotal) || 0)))}</td>
          <td>${Number(row.bySlot?.early_morning) || 0}</td>
          <td>${Number(row.bySlot?.morning) || 0}</td>
          <td>${Number(row.bySlot?.evening) || 0}</td>`;
        staffTotalsBody.appendChild(tr);
      }
    }

    if (staffTotalsFoot) {
      if (withShifts.length > 0) {
        staffTotalsFoot.hidden = false;
        staffTotalsFoot.innerHTML = `<tr>
          <td>Total</td>
          <td>${Number(summary.totalShifts) || 0}</td>
          <td>${Number(summary.plannedHours) || 0}</td>
          <td>${displayStaffTotalHours(
            Number(summary.plannedHours) || 0,
            Number(summary.totalShifts) || 0,
            summary.totalHours,
          )}</td>
          <td>—</td>
          <td>${formatPayAmount(summary.totalPay)}</td>
          <td>${formatPayAmount(summary.commissionTotal)}</td>
          <td>${formatPayAmount(summary.combinedPay)}</td>
          <td colspan="3"></td>
        </tr>`;
      } else {
        staffTotalsFoot.hidden = true;
        staffTotalsFoot.innerHTML = "";
      }
    }

    if (staffTotalsEmpty) staffTotalsEmpty.hidden = withShifts.length > 0;
    if (staffTotalsDisclaimer) {
      const skipped = Array.isArray(summary.weeksSkipped) ? summary.weeksSkipped.length : 0;
      const skippedNote =
        skipped > 0 ? ` ${skipped} week(s) skipped (draft or no saved data).` : "";
      const disclaimer =
        typeof summary.disclaimer === "string" && summary.disclaimer.trim()
          ? summary.disclaimer
          : "Planned hours are shift time only. Total adds 30 min before and 15 min after each shift (arrival/departure). Verify against Mindbody Time Clock for payroll.";
      staffTotalsDisclaimer.textContent = `${disclaimer}${skippedNote}`;
      staffTotalsDisclaimer.hidden = false;
    }
  }

  /** @param {"week"|"two_weeks"|"month"} mode */
  function setStaffTotalsMode(mode) {
    staffTotalsMode = mode;
    staffTotalsModeBtns.forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      const active = btn.getAttribute("data-staff-totals-mode") === mode;
      btn.classList.toggle("is-active", active);
    });
    const showMonth = mode === "month";
    if (staffTotalsMonthInput instanceof HTMLInputElement) {
      if (showMonth && !staffTotalsMonthInput.value) {
        staffTotalsMonthInput.value = currentMonthInputValue();
      }
    }
    if (staffTotalsWeekNav) staffTotalsWeekNav.hidden = showMonth;
    if (staffTotalsMonthNav) staffTotalsMonthNav.hidden = !showMonth;
    const weekLabel = root.querySelector("[data-staff-totals-week-label]");
    if (weekLabel) {
      weekLabel.textContent =
        mode === "two_weeks" ? "2 weeks starting (Sunday)" : "Week starting (Sunday)";
    }
  }

  /** @param {string} token */
  async function loadStaffTotals(token) {
    showErr(staffTotalsError, "");
    const range = staffTotalsDateRange();
    if (!range) {
      showErr(staffTotalsError, "Choose a valid week, 2-week period, or month.");
      return;
    }

    const publishedOnly =
      staffTotalsPublishedOnly instanceof HTMLInputElement
        ? staffTotalsPublishedOnly.checked
        : true;
    const qs = new URLSearchParams({
      from: range.from,
      to: range.to,
      publishedOnly: publishedOnly ? "1" : "0",
    });

    if (staffTotalsRange) {
      const label =
        staffTotalsMode === "week"
          ? `Week ${range.from} – ${range.to}`
          : staffTotalsMode === "two_weeks"
            ? `2 weeks ${range.from} – ${range.to}`
            : `Month ${range.from.slice(0, 7)} (${range.from} – ${range.to})`;
      staffTotalsRange.textContent = label;
      staffTotalsRange.hidden = false;
    }

    try {
      const data = await api(token, `/reports/staff-summary?${qs.toString()}`);
      const summary =
        data.summary && typeof data.summary === "object" ? data.summary : null;
      if (!summary) throw new Error("Invalid summary response");
      renderStaffTotals(summary);
      try {
        await loadCommissions(token, range);
      } catch (ce) {
        showErr(commissionError, ce instanceof Error ? ce.message : "Failed to load commissions");
      }
    } catch (e) {
      staffTotalsSummary = null;
      if (staffTotalsBody) staffTotalsBody.innerHTML = "";
      if (staffTotalsFoot) {
        staffTotalsFoot.hidden = true;
        staffTotalsFoot.innerHTML = "";
      }
      if (staffTotalsEmpty) staffTotalsEmpty.hidden = true;
      if (staffTotalsDisclaimer) staffTotalsDisclaimer.hidden = true;
      showErr(staffTotalsError, e instanceof Error ? e.message : "Failed to load totals");
    }
  }

  /** @param {string} token */
  async function exportStaffTotalsCsv(token) {
    const range = staffTotalsDateRange();
    if (!range) throw new Error("Choose a valid week, 2-week period, or month.");
    const publishedOnly =
      staffTotalsPublishedOnly instanceof HTMLInputElement
        ? staffTotalsPublishedOnly.checked
        : true;
    const qs = new URLSearchParams({
      from: range.from,
      to: range.to,
      publishedOnly: publishedOnly ? "1" : "0",
    });
    const url = `${API}/reports/staff-summary/export.csv?${qs.toString()}`;
    const res = await fetch(url, { headers: { "x-admin-token": token } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `amare-staff-summary-${range.from}_to_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setWeekStatus("Staff totals CSV downloaded.");
  }

  /** @param {string} ymd @param {string} [hhmm] */
  function commissionWhenLabel(ymd, hhmm) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return ymd || "—";
    const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    const dateLine = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(dt);
    if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return dateLine;
    const [h, mi] = hhmm.split(":").map((n) => parseInt(n, 10));
    const h12 = ((h + 11) % 12) + 1;
    const ampm = h < 12 ? "AM" : "PM";
    return `${dateLine} · ${h12}:${String(mi).padStart(2, "0")} ${ampm}`;
  }

  function staffNameById(id) {
    const row = staffRows.find((s) => String(s.id) === String(id));
    return row ? String(row.name || id) : String(id || "—");
  }

  function fillCommissionStaffOptions() {
    if (!(commissionStaffSelect instanceof HTMLSelectElement)) return;
    const current = commissionStaffSelect.value;
    const active = staffRows.filter((s) => s.active !== false);
    commissionStaffSelect.innerHTML = active
      .map((s) => `<option value="${shared.esc(s.id)}">${shared.esc(s.name)}</option>`)
      .join("");
    if (current && [...commissionStaffSelect.options].some((o) => o.value === current)) {
      commissionStaffSelect.value = current;
    }
  }

  function fillCommissionPackageOptions() {
    if (!(commissionPackageSelect instanceof HTMLSelectElement)) return;
    const current = commissionPackageSelect.value;
    commissionPackageSelect.innerHTML = commissionPackages
      .map(
        (p) =>
          `<option value="${shared.esc(p.id)}" data-amount="${shared.esc(p.amountUsd)}">${shared.esc(p.label)} · $${Number(p.amountUsd).toFixed(2)}</option>`,
      )
      .join("");
    if (current && [...commissionPackageSelect.options].some((o) => o.value === current)) {
      commissionPackageSelect.value = current;
    }
    syncCommissionAmountFromPackage();
  }

  function syncCommissionAmountFromPackage() {
    if (!(commissionPackageSelect instanceof HTMLSelectElement)) return;
    if (!(commissionAmountInput instanceof HTMLInputElement)) return;
    const pack = commissionPackages.find((p) => p.id === commissionPackageSelect.value);
    if (pack) commissionAmountInput.value = String(pack.amountUsd);
  }

  /** @param {Record<string, unknown>[]} entries @param {number} total */
  function renderCommissions(entries, total) {
    if (commissionBody) {
      commissionBody.innerHTML = "";
      for (const row of entries) {
        const tr = document.createElement("tr");
        const id = String(row.id || "");
        tr.innerHTML = `
          <td>${shared.esc(commissionWhenLabel(String(row.soldDate || ""), String(row.soldTime || "")))}</td>
          <td>${shared.esc(staffNameById(String(row.staffId || "")))}</td>
          <td>${shared.esc(row.packageLabel || row.packageId || "—")}</td>
          <td>${formatPayAmount(row.amountUsd)}</td>
          <td>${shared.esc(row.clientName || "—")}</td>
          <td><button type="button" class="btn btn--ghost btn--small" data-commission-delete="${shared.esc(id)}">Remove</button></td>`;
        commissionBody.appendChild(tr);
      }
      commissionBody.querySelectorAll("[data-commission-delete]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = String(btn.getAttribute("data-commission-delete") || "");
          const token = shared.getToken();
          if (token && id) void deleteCommission(token, id);
        });
      });
    }
    if (commissionFoot) {
      if (entries.length) {
        commissionFoot.hidden = false;
        commissionFoot.innerHTML = `<tr><td colspan="3">Total</td><td>${formatPayAmount(total)}</td><td colspan="2"></td></tr>`;
      } else {
        commissionFoot.hidden = true;
        commissionFoot.innerHTML = "";
      }
    }
    if (commissionEmpty) commissionEmpty.hidden = entries.length > 0;
  }

  /** @param {string} token @param {{ from: string, to: string }} range */
  async function loadCommissions(token, range) {
    showErr(commissionError, "");
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    const data = await api(token, `/commissions?${qs.toString()}`);
    commissionPackages = Array.isArray(data.packages) ? data.packages : [];
    const entries = Array.isArray(data.entries) ? data.entries : [];
    renderCommissions(entries, Number(data.total) || 0);
  }

  function openCommissionAddDialog() {
    fillCommissionStaffOptions();
    fillCommissionPackageOptions();
    if (commissionClientInput instanceof HTMLInputElement) commissionClientInput.value = "";
    if (commissionDateInput instanceof HTMLInputElement) commissionDateInput.value = todayYmdEt();
    if (commissionTimeInput instanceof HTMLInputElement) commissionTimeInput.value = "";
    showErr(commissionAddError, "");
    if (commissionAddDialog instanceof HTMLDialogElement) {
      commissionAddDialog.showModal();
      if (commissionStaffSelect instanceof HTMLSelectElement) commissionStaffSelect.focus();
    }
  }

  function closeCommissionAddDialog() {
    if (commissionAddDialog instanceof HTMLDialogElement && commissionAddDialog.open) {
      commissionAddDialog.close();
    }
  }

  function openCommissionRatesDialog() {
    if (!commissionRatesFields) return;
    commissionRatesFields.innerHTML = commissionPackages
      .map(
        (p) => `<label class="admin-sms__label" for="commission-rate-${shared.esc(p.id)}">${shared.esc(p.label)}
          <input id="commission-rate-${shared.esc(p.id)}" class="admin-sms__input" type="number" min="0" max="2000" step="0.01" inputmode="decimal" data-commission-rate-id="${shared.esc(p.id)}" data-commission-rate-label="${shared.esc(p.label)}" value="${shared.esc(p.amountUsd)}" />
        </label>`,
      )
      .join("");
    showErr(commissionRatesError, "");
    if (commissionRatesDialog instanceof HTMLDialogElement) commissionRatesDialog.showModal();
  }

  function closeCommissionRatesDialog() {
    if (commissionRatesDialog instanceof HTMLDialogElement && commissionRatesDialog.open) {
      commissionRatesDialog.close();
    }
  }

  /** @param {string} token @param {string} id */
  async function deleteCommission(token, id) {
    if (!window.confirm("Remove this commission?")) return;
    try {
      await api(token, `/commissions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadStaffTotals(token);
      setWeekStatus("Commission removed.");
    } catch (e) {
      showErr(commissionError, e instanceof Error ? e.message : "Failed to remove");
    }
  }

  /** @param {string} token */
  async function loadStaff(token) {
    const data = await api(token, "/staff");
    staffRows = Array.isArray(data.staff) ? data.staff : [];
    emailStaffAvailable = data.emailStaffAvailable === true;
    renderStaffList(token);
  }

  /** @param {unknown} pin */
  function formatPinDisplay(pin) {
    const p = String(pin || "").replace(/\D/g, "");
    if (p.length >= 4) return "••••";
    return "—";
  }

  /** @param {string} token */
  function renderStaffList(token) {
    if (!staffListBody) return;
    staffListBody.innerHTML = "";
    if (staffListEmpty) staffListEmpty.hidden = staffRows.length > 0;

    for (const row of staffRows) {
      const tr = document.createElement("tr");
      const activeLabel = row.active === false ? "No" : "Yes";
      const id = String(row.id || "");
      tr.innerHTML = `
        <td>${shared.esc(row.name)}</td>
        <td>${shared.esc(row.email)}</td>
        <td>${formatPinDisplay(row.pin)}</td>
        <td>${formatHourlyRate(row.hourlyRate)}</td>
        <td>${activeLabel}</td>
        <td>
          <div class="admin-sms__row-actions">
            <button type="button" class="btn btn--ghost btn--small" data-staff-send-login="${shared.esc(id)}"${
              emailStaffAvailable ? "" : ' disabled title="Email not configured — set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend settings."'
            }>Send login</button>
            <button type="button" class="btn btn--ghost btn--small" data-staff-edit="${shared.esc(id)}">Edit</button>
            <button type="button" class="btn btn--ghost btn--small" data-staff-delete="${shared.esc(id)}">Delete</button>
          </div>
        </td>`;
      staffListBody.appendChild(tr);
    }

    staffListBody.querySelectorAll("[data-staff-send-login]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-staff-send-login");
        if (!id) return;
        void sendStaffLogin(token, id);
      });
    });

    staffListBody.querySelectorAll("[data-staff-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-staff-edit");
        if (!id) return;
        openStaffEditDialog(id);
      });
    });

    staffListBody.querySelectorAll("[data-staff-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-staff-delete");
        if (!id) return;
        void deleteStaff(token, id);
      });
    });

    if (weekDoc) renderWeekGrid();
  }

  /** @param {string} token @param {string} staffId */
  async function sendStaffLogin(token, staffId) {
    const row = staffRows.find((s) => String(s.id) === staffId);
    if (!row) return;
    showErr(staffManageError, "");
    if (!emailStaffAvailable) {
      showErr(
        staffManageError,
        "Email not configured. Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend env vars.",
      );
      return;
    }
    const name = String(row.name || "Staff");
    const email = String(row.email || "");
    const ok = await confirmDialog({
      title: "Send login details?",
      message: `Email ${name} at ${email} with their PIN and the shift availability form link?`,
      confirmLabel: "Send email",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    try {
      const data = await api(token, `/staff/${encodeURIComponent(staffId)}/send-login`, {
        method: "POST",
      });
      const to = typeof data.to === "string" ? data.to : email;
      showErr(staffManageError, "");
      setWeekStatus(`Login details sent to ${to}.`);
    } catch (e) {
      showErr(staffManageError, e instanceof Error ? e.message : "Send failed");
    }
  }

  /** @param {string} staffId */
  function openStaffEditDialog(staffId) {
    const row = staffRows.find((s) => String(s.id) === staffId);
    if (!row || !(staffEditDialog instanceof HTMLDialogElement)) return;
    editingStaffId = staffId;
    if (staffEditName instanceof HTMLInputElement) staffEditName.value = String(row.name || "");
    if (staffEditEmail instanceof HTMLInputElement) staffEditEmail.value = String(row.email || "");
    if (staffEditPin instanceof HTMLInputElement) staffEditPin.value = "";
    if (staffEditHourlyRate instanceof HTMLInputElement) {
      const rate = Number(row.hourlyRate);
      staffEditHourlyRate.value = Number.isFinite(rate) && rate > 0 ? String(rate) : "";
    }
    if (staffEditActive instanceof HTMLInputElement) staffEditActive.checked = row.active !== false;
    staffEditDialog.showModal();
    staffEditName?.focus();
  }

  /** @param {string} token */
  async function saveStaffEdit(token) {
    if (!editingStaffId) return;
    showErr(staffManageError, "");
    const name = staffEditName instanceof HTMLInputElement ? staffEditName.value.trim() : "";
    const email = staffEditEmail instanceof HTMLInputElement ? staffEditEmail.value.trim() : "";
    const pin = staffEditPin instanceof HTMLInputElement ? staffEditPin.value.trim() : "";
    const active = staffEditActive instanceof HTMLInputElement ? staffEditActive.checked : true;
    /** @type {Record<string, unknown>} */
    const body = { name, email, active };
    if (pin) body.pin = pin;
    if (staffEditHourlyRate instanceof HTMLInputElement) {
      try {
        body.hourlyRate = parseHourlyRateInput(staffEditHourlyRate.value);
      } catch (e) {
        showErr(staffManageError, e instanceof Error ? e.message : "Invalid hourly rate");
        return;
      }
    }
    try {
      await api(token, `/staff/${encodeURIComponent(editingStaffId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (staffEditDialog instanceof HTMLDialogElement && staffEditDialog.open) {
        staffEditDialog.close();
      }
      editingStaffId = null;
      await loadStaff(token);
      if (weekDoc) await loadWeek(token);
      const totalsToken = shared.getToken();
      if (totalsToken) void loadStaffTotals(totalsToken);
      setWeekStatus("Staff updated.");
    } catch (e) {
      showErr(staffManageError, e instanceof Error ? e.message : "Update failed");
    }
  }

  /** @param {string} token @param {string} id */
  async function deleteStaff(token, id) {
    const row = staffRows.find((s) => String(s.id) === id);
    const name = row ? String(row.name) : "this staff member";
    const ok = await confirmDialog({
      title: "Delete staff?",
      message: `Remove ${name} from the roster? This cannot be undone.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    showErr(staffManageError, "");
    try {
      await api(token, `/staff/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadStaff(token);
      if (weekDoc) await loadWeek(token);
      setWeekStatus("Staff deleted.");
    } catch (e) {
      showErr(staffManageError, e instanceof Error ? e.message : "Delete failed");
    }
  }

  /** @param {string} slot */
  function slotLabelShort(slot) {
    if (slot === "early_morning") return "Early";
    if (slot === "morning") return "Morning";
    if (slot === "evening") return "Evening";
    return slot;
  }

  function availabilityStatusLabel(status) {
    if (status === "open") return "Open";
    if (status === "locked") return "Locked (published)";
    return "Closed";
  }

  /** @param {Record<string, unknown> | null} windowMeta */
  function updateAvailabilityWindowUi(windowMeta) {
    availabilityWindow = windowMeta;
    const status = windowMeta && typeof windowMeta.status === "string" ? windowMeta.status : "closed";
    const canOpen = windowMeta?.canOpen === true;
    const canClose = windowMeta?.canClose === true;
    const isTargetWeek = windowMeta?.isStaffTargetWeek !== false;
    const canSendReminder =
      emailStaffAvailable && isTargetWeek && status !== "locked";

    if (availabilityStatusBadge) {
      availabilityStatusBadge.textContent = availabilityStatusLabel(status);
      availabilityStatusBadge.hidden = false;
      availabilityStatusBadge.classList.remove(
        "is-open",
        "is-closed",
        "is-locked",
      );
      availabilityStatusBadge.classList.add(
        status === "open" ? "is-open" : status === "locked" ? "is-locked" : "is-closed",
      );
    }
    if (availabilityOpenBtn instanceof HTMLButtonElement) {
      availabilityOpenBtn.hidden = !canOpen;
      availabilityOpenBtn.disabled = !canOpen;
    }
    if (availabilityCloseBtn instanceof HTMLButtonElement) {
      availabilityCloseBtn.hidden = !canClose;
      availabilityCloseBtn.disabled = !canClose;
    }
    if (availabilitySendReminderBtn instanceof HTMLButtonElement) {
      availabilitySendReminderBtn.disabled = !canSendReminder;
      if (!emailStaffAvailable) {
        availabilitySendReminderBtn.title =
          "Email not configured — set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend settings.";
      } else if (!isTargetWeek) {
        availabilitySendReminderBtn.title =
          "Navigate to next week in Staff availability before sending request emails.";
      } else if (status === "locked") {
        availabilitySendReminderBtn.title = "Published weeks cannot receive availability requests.";
      } else {
        availabilitySendReminderBtn.title = "Email selected staff with the availability form link and PIN.";
      }
    }
    if (availabilityFormLink instanceof HTMLAnchorElement) {
      availabilityFormLink.href = "/staff/availability";
      const targetWeek =
        typeof windowMeta?.staffTargetWeekStart === "string"
          ? windowMeta.staffTargetWeekStart
          : "";
      availabilityFormLink.title = targetWeek
        ? `Opens staff form (current availability week: ${targetWeek})`
        : "Opens staff availability form";
    }
    if (availabilityContext) {
      const viewingLabel = availabilityWeekStart ? `Viewing week: ${availabilityWeekStart}` : "";
      const formWeek =
        typeof windowMeta?.staffTargetWeekStart === "string"
          ? windowMeta.staffTargetWeekStart
          : "";
      const formLabel = formWeek ? `Staff form week (next week): ${formWeek}` : "";
      const notTarget =
        windowMeta?.isStaffTargetWeek === false && formWeek
          ? "Open/Close and email requests apply only when viewing next week."
          : "";
      const text = [viewingLabel, formLabel, notTarget].filter(Boolean).join(" · ");
      availabilityContext.textContent = text;
      availabilityContext.hidden = !text;
    }
  }

  function updateAvailabilityFormLink() {
    if (availabilityWindow) updateAvailabilityWindowUi(availabilityWindow);
  }

  /** @param {Record<string, unknown> | null | undefined} availability */
  function buildAvailabilityByCell(availability) {
    /** @type {Map<string, { staffId: string; staffName: string }[]>} */
    const map = new Map();
    const rows = Array.isArray(availability?.submissions) ? availability.submissions : [];
    for (const row of rows) {
      const staffId = String(row.staffId || "");
      const staffName = String(row.staffName || "");
      if (!staffId) continue;
      const selections = Array.isArray(row.selections) ? row.selections : [];
      for (const sel of selections) {
        const date = String(sel.date || "");
        const slot = String(sel.slot || "");
        if (!date || !slot) continue;
        const key = `${date}|${slot}`;
        const list = map.get(key) || [];
        if (!list.some((entry) => entry.staffId === staffId)) {
          list.push({ staffId, staffName });
        }
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.staffName.localeCompare(b.staffName));
    }
    return map;
  }

  /** @param {string} date @param {string} slot */
  function availabilityRequestsForCell(date, slot) {
    return availabilityByCell.get(`${date}|${slot}`) || [];
  }

  /** @param {Record<string, unknown>} availability @param {string} plannerWeek */
  function renderAvailabilityPanel(availability, plannerWeek) {
    const rows = Array.isArray(availability.submissions) ? availability.submissions : [];
    const status =
      availabilityWindow && typeof availabilityWindow.status === "string"
        ? availabilityWindow.status
        : "closed";
    const canReset = status !== "locked";
    if (availabilityHint) {
      const statusNote =
        status === "open"
          ? "Staff can submit for this week."
          : status === "locked"
            ? "Published — submissions closed."
            : "Closed — click Open availability to let staff submit.";
      availabilityHint.textContent =
        rows.length > 0
          ? `${rows.length} submission(s) for week ${plannerWeek}. ${statusNote}${canReset ? " Use Reset to clear a staff member's choices so they can submit again." : ""}`
          : `No submissions yet for week ${plannerWeek}. ${statusNote}`;
    }
    if (availabilityList) {
      availabilityList.innerHTML = "";
      for (const row of rows) {
        const li = document.createElement("li");
        li.className = "admin-staff-schedule__availability-row";
        const selections = Array.isArray(row.selections) ? row.selections : [];
        const parts = selections.map((sel) => {
          const day = String(sel.day || sel.date || "");
          return `${day} ${slotLabelShort(String(sel.slot || ""))}`;
        });
        const submittedAt = row.submittedAt ? String(row.submittedAt).slice(0, 16).replace("T", " ") : "";
        const staffId = String(row.staffId || "");
        const resetAttrs = canReset
          ? ""
          : ' disabled title="Cannot reset after the week is published."';
        li.innerHTML = `<div class="admin-staff-schedule__availability-row-body"><strong>${shared.esc(row.staffName)}</strong> — ${shared.esc(
          parts.join(", ") || "No shifts selected",
        )}<br /><span class="admin-staff-schedule__availability-meta">${shared.esc(
          submittedAt ? `Submitted ${submittedAt} UTC` : "",
        )}</span></div>
        <button type="button" class="btn btn--ghost btn--small" data-availability-reset="${shared.esc(staffId)}"${resetAttrs}>Reset</button>`;
        availabilityList.appendChild(li);
      }

      availabilityList.querySelectorAll("[data-availability-reset]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-availability-reset");
          if (!id) return;
          const row = rows.find((r) => String(r.staffId) === id);
          const name = row ? String(row.staffName || "Staff") : "Staff";
          const token = shared.getToken();
          if (token) void resetAvailabilitySubmission(token, id, name);
        });
      });
    }
    if (availabilityEmpty) availabilityEmpty.hidden = rows.length > 0;
  }

  /** @returns {Record<string, unknown>[]} */
  function staffEligibleForAvailabilityReminder() {
    return staffRows.filter((row) => row.active !== false);
  }

  /**
   * @param {string | undefined} weekLabel
   * @returns {Promise<string[] | null>}
   */
  function pickStaffForAvailabilityReminder(weekLabel) {
    const eligible = staffEligibleForAvailabilityReminder();
    if (
      !(availabilityReminderDialog instanceof HTMLDialogElement) ||
      !availabilityReminderStaffList ||
      !(availabilityReminderSelectAll instanceof HTMLInputElement) ||
      !(availabilityReminderSendBtn instanceof HTMLButtonElement) ||
      !(availabilityReminderCancelBtn instanceof HTMLButtonElement)
    ) {
      return Promise.resolve(eligible.map((row) => String(row.id || "")).filter(Boolean));
    }

    if (availabilityReminderMessage) {
      const weekText = weekLabel ? ` for week ${weekLabel}` : "";
      availabilityReminderMessage.textContent = `Choose who should receive the availability form email${weekText}. Staff without email or PIN are skipped when sending.`;
    }
    if (availabilityReminderError) {
      availabilityReminderError.textContent = "";
      availabilityReminderError.hidden = true;
    }

    availabilityReminderStaffList.innerHTML = "";
    if (!eligible.length) {
      availabilityReminderStaffList.innerHTML =
        '<li class="admin-staff-schedule__reminder-staff-row">No active staff — add team members above first.</li>';
      availabilityReminderSelectAll.checked = false;
      availabilityReminderSelectAll.disabled = true;
      availabilityReminderSendBtn.disabled = true;
    } else {
      availabilityReminderSelectAll.checked = true;
      availabilityReminderSelectAll.disabled = false;
      availabilityReminderSendBtn.disabled = false;
      for (const row of eligible) {
        const id = String(row.id || "");
        if (!id) continue;
        const li = document.createElement("li");
        const email = String(row.email || "").trim();
        const label = document.createElement("label");
        label.className = "admin-staff-schedule__reminder-staff-row";
        label.innerHTML = `<input type="checkbox" data-availability-reminder-staff="${shared.esc(id)}" checked />
          <span>${shared.esc(row.name)}${
            email
              ? `<span class="admin-staff-schedule__reminder-staff-email">${shared.esc(email)}</span>`
              : `<span class="admin-staff-schedule__reminder-staff-email">No email on file</span>`
          }</span>`;
        availabilityReminderStaffList.appendChild(li);
        li.appendChild(label);
      }
    }

    /** @type {HTMLInputElement[]} */
    const staffChecks = Array.from(
      availabilityReminderStaffList.querySelectorAll("[data-availability-reminder-staff]"),
    ).filter((el) => el instanceof HTMLInputElement);

    const syncSelectAll = () => {
      if (!staffChecks.length) return;
      availabilityReminderSelectAll.checked = staffChecks.every((cb) => cb.checked);
      availabilityReminderSelectAll.indeterminate =
        !availabilityReminderSelectAll.checked && staffChecks.some((cb) => cb.checked);
    };

    availabilityReminderSelectAll.onchange = () => {
      const checked = availabilityReminderSelectAll.checked;
      availabilityReminderSelectAll.indeterminate = false;
      for (const cb of staffChecks) cb.checked = checked;
    };

    for (const cb of staffChecks) {
      cb.addEventListener("change", syncSelectAll);
    }

    return new Promise((resolve) => {
      /** @param {string[] | null} result */
      const finish = (result) => {
        availabilityReminderSendBtn.removeEventListener("click", onSend);
        availabilityReminderCancelBtn.removeEventListener("click", onCancel);
        availabilityReminderDialog.removeEventListener("cancel", onCancel);
        availabilityReminderSelectAll.onchange = null;
        if (availabilityReminderDialog.open) availabilityReminderDialog.close();
        resolve(result);
      };

      const onCancel = () => finish(null);
      const onSend = () => {
        const ids = staffChecks.filter((cb) => cb.checked).map((cb) => cb.getAttribute("data-availability-reminder-staff") || "").filter(Boolean);
        if (!ids.length) {
          if (availabilityReminderError) {
            availabilityReminderError.textContent = "Select at least one staff member.";
            availabilityReminderError.hidden = false;
          }
          return;
        }
        finish(ids);
      };

      availabilityReminderSendBtn.addEventListener("click", onSend);
      availabilityReminderCancelBtn.addEventListener("click", onCancel);
      availabilityReminderDialog.addEventListener("cancel", onCancel);
      availabilityReminderDialog.showModal();
      availabilityReminderSendBtn.focus();
    });
  }

  /**
   * @param {string} token
   * @param {string} targetWeekStart
   * @param {string[]} staffIds
   * @param {boolean} openIfClosed
   */
  async function sendAvailabilityReminder(token, targetWeekStart, staffIds, openIfClosed) {
    showErr(availabilityError, "");
    setWeekStatus("Sending availability request emails…");
    try {
      const data = await api(
        token,
        `/weeks/${encodeURIComponent(targetWeekStart)}/availability/send-reminder`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ staffIds, openIfClosed }),
        },
      );
      if (data.availabilityWindow && typeof data.availabilityWindow === "object") {
        updateAvailabilityWindowUi(data.availabilityWindow);
      }
      await loadAvailabilityPanel(token);
      if (weekStart === availabilityWeekStart) void syncPlannerAvailabilityHints(token);
      const sent = typeof data.sent === "number" ? data.sent : staffIds.length;
      const opened = data.openedAvailability === true;
      const weekRange =
        typeof data.weekRangeLabel === "string" ? data.weekRangeLabel : targetWeekStart;
      setWeekStatus(
        opened
          ? `Availability opened. Sent ${sent} request email(s) for week of ${weekRange}.`
          : `Sent ${sent} availability request email(s) for week of ${weekRange}.`,
      );
    } catch (e) {
      setWeekStatus("");
      showErr(availabilityError, e instanceof Error ? e.message : "Failed to send availability emails");
    }
  }

  /** @param {string} token */
  async function startAvailabilityReminderFlow(token) {
    showErr(availabilityError, "");
    if (!emailStaffAvailable) {
      showErr(
        availabilityError,
        "Email not configured. Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend env vars.",
      );
      return;
    }
    const targetWeekStart = availabilityWeekStart;
    if (!targetWeekStart) return;
    if (availabilityWindow?.isStaffTargetWeek === false) {
      showErr(
        availabilityError,
        "Navigate Staff availability to next week before sending request emails.",
      );
      return;
    }
    const status =
      availabilityWindow && typeof availabilityWindow.status === "string"
        ? availabilityWindow.status
        : "closed";
    if (status === "locked") {
      showErr(availabilityError, "This week is published — unpublish before requesting availability.");
      return;
    }

    let openIfClosed = false;
    if (status === "closed") {
      const ok = await confirmDialog({
        title: "Open registration?",
        message:
          "Availability is closed for this week. Open registration for staff and continue to send request emails?",
        confirmLabel: "Open and continue",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      openIfClosed = true;
    }

    const weekLabel =
      typeof availabilityWindow?.staffTargetLabel === "string"
        ? availabilityWindow.staffTargetLabel
        : targetWeekStart;
    const staffIds = await pickStaffForAvailabilityReminder(weekLabel);
    if (!staffIds || !staffIds.length) return;
    await sendAvailabilityReminder(token, targetWeekStart, staffIds, openIfClosed);
  }

  /** @param {string} token @param {string} staffId @param {string} staffName */
  async function resetAvailabilitySubmission(token, staffId, staffName) {
    if (!availabilityWeekStart) return;
    showErr(availabilityError, "");
    const ok = await confirmDialog({
      title: "Reset availability?",
      message: `Clear ${staffName}'s shift selections for week ${availabilityWeekStart}? They can submit again from the staff form.`,
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    try {
      const data = await api(
        token,
        `/weeks/${encodeURIComponent(availabilityWeekStart)}/availability/submissions/${encodeURIComponent(staffId)}/reset`,
        { method: "POST" },
      );
      if (data.availabilityWindow && typeof data.availabilityWindow === "object") {
        updateAvailabilityWindowUi(data.availabilityWindow);
      }
      const panelAvailability =
        data.availability && typeof data.availability === "object" ? data.availability : { submissions: [] };
      renderAvailabilityPanel(panelAvailability, availabilityWeekStart);
      availabilityByCell = buildAvailabilityByCell(panelAvailability);
      if (weekDoc && weekStart === availabilityWeekStart) renderWeekGrid();
      setWeekStatus(`${staffName}'s availability reset.`);
    } catch (e) {
      showErr(availabilityError, e instanceof Error ? e.message : "Reset failed");
    }
  }

  /** @param {string} ymd */
  function setAvailabilityWeekStart(ymd) {
    availabilityWeekStart = isWeekStartYmdLocal(ymd) ? ymd : weekStartForYmdLocal(ymd);
    if (availabilityWeekStartInput instanceof HTMLInputElement) {
      availabilityWeekStartInput.value = availabilityWeekStart;
    }
    updateAvailabilityWeekMeta();
  }

  function updateAvailabilityWeekMeta() {
    if (!availabilityRangeHint || !availabilityWeekStart) return;
    const dates = weekDatesFromStart(availabilityWeekStart);
    availabilityRangeHint.textContent = `Submissions ${dates[0]} through ${dates[6]} (America/New_York).`;
  }

  /** @param {string} token */
  async function syncPlannerAvailabilityHints(token) {
    if (!weekStart) return;
    try {
      const panelData = await api(token, `/weeks/${encodeURIComponent(weekStart)}/availability`);
      const panelAvailability =
        panelData.availability && typeof panelData.availability === "object"
          ? panelData.availability
          : null;
      availabilityByCell = buildAvailabilityByCell(panelAvailability);
      if (weekDoc) renderWeekGrid();
    } catch {
      availabilityByCell = new Map();
      if (weekDoc) renderWeekGrid();
    }
  }

  /** @param {string} token */
  async function loadAvailabilityPanel(token) {
    if (!availabilityWeekStart) return;
    if (!isWeekStartYmdLocal(availabilityWeekStart)) {
      showErr(availabilityError, "Week start must be a Sunday (YYYY-MM-DD).");
      return;
    }
    showErr(availabilityError, "");
    try {
      const panelData = await api(token, `/weeks/${encodeURIComponent(availabilityWeekStart)}/availability`);
      const panelAvailability =
        panelData.availability && typeof panelData.availability === "object"
          ? panelData.availability
          : null;
      if (panelData.availabilityWindow && typeof panelData.availabilityWindow === "object") {
        updateAvailabilityWindowUi(panelData.availabilityWindow);
      }
      if (availabilityEarlyMorningCheck instanceof HTMLInputElement) {
        availabilityEarlyMorningCheck.checked = panelData.staffAvailabilityEarlyMorning === true;
      }
      if (panelAvailability) renderAvailabilityPanel(panelAvailability, availabilityWeekStart);
      else renderAvailabilityPanel({ submissions: [] }, availabilityWeekStart);
      updateAvailabilityWeekMeta();
    } catch (e) {
      showErr(
        availabilityError,
        e instanceof Error ? e.message : "Failed to load availability",
      );
    }
  }

  /** @param {string} token @param {number} deltaDays */
  function navigateAvailabilityWeek(token, deltaDays) {
    if (!availabilityWeekStart) return;
    setAvailabilityWeekStart(addDaysYmd(availabilityWeekStart, deltaDays));
    void loadAvailabilityPanel(token);
  }

  /** @param {string} token */
  async function loadWeekAvailability(token) {
    await loadAvailabilityPanel(token);
  }

  /** @param {string} token */
  async function saveAvailabilityEarlyMorning(token) {
    if (!(availabilityEarlyMorningCheck instanceof HTMLInputElement)) return;
    showErr(availabilityError, "");
    const enabled = availabilityEarlyMorningCheck.checked;
    try {
      await api(token, "/availability-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffAvailabilityEarlyMorning: enabled }),
      });
    } catch (e) {
      availabilityEarlyMorningCheck.checked = !enabled;
      showErr(
        availabilityError,
        e instanceof Error ? e.message : "Failed to update Early Morning setting",
      );
    }
  }

  /** @param {string} token */
  async function setAvailabilityWindow(token, action) {
    if (!availabilityWeekStart) return;
    showErr(availabilityError, "");
    setWeekStatus(action === "open" ? "Opening availability…" : "Closing availability…");
    try {
      const data = await api(
        token,
        `/weeks/${encodeURIComponent(availabilityWeekStart)}/availability/${action}`,
        { method: "POST" },
      );
      if (data.availabilityWindow && typeof data.availabilityWindow === "object") {
        updateAvailabilityWindowUi(data.availabilityWindow);
      }
      await loadAvailabilityPanel(token);
      if (weekStart === availabilityWeekStart) void syncPlannerAvailabilityHints(token);
      setWeekStatus(action === "open" ? "Availability opened for this week." : "Availability closed.");
    } catch (e) {
      setWeekStatus("");
      showErr(availabilityError, e instanceof Error ? e.message : "Availability update failed");
    }
  }

  /** @param {string} token */
  async function loadWeek(token) {
    setSwitchPickMode(false);
    showErr(weekError, "");
    if (!weekStart || !isWeekStartYmdLocal(weekStart)) {
      showErr(weekError, "Week start must be a Sunday (YYYY-MM-DD).");
      return;
    }
    try {
      const data = await api(token, `/weeks/${encodeURIComponent(weekStart)}`);
      if (typeof data.resolvedWeekStart === "string") {
        weekStart = data.resolvedWeekStart;
        if (weekStartInput) weekStartInput.value = weekStart;
      } else if (data.week && typeof data.week.weekStart === "string") {
        weekStart = String(data.week.weekStart);
        if (weekStartInput) weekStartInput.value = weekStart;
      }
      weekDoc = data.week && typeof data.week === "object" ? data.week : null;
      emailStaffAvailable = data.emailStaffAvailable === true;
      if (staffRows.length) renderStaffList(token);
      renderWeekGrid();
      updateWeekMeta();
      updateAvailabilityFormLink();
      void syncPlannerAvailabilityHints(token);
    } catch (e) {
      weekDoc = null;
      renderWeekGrid();
      showErr(weekError, e instanceof Error ? e.message : "Failed to load week");
    }
  }

  function updateWeekMeta() {
    if (!weekDoc) return;
    const dates = weekDatesFromStart(weekStart);
    if (weekRangeHint) {
      const coverage = weekDoc.classCoverage && typeof weekDoc.classCoverage === "object" ? weekDoc.classCoverage : null;
      const sun = coverage?.[dates[0]];
      const sunEarly = sun?.early_morning;
      const sunMorning = sun?.morning;
      const sunEvening = sun?.evening;
      const sunLine =
        sunEarly?.source === "classes" &&
        sunEarly?.start &&
        sunEarly?.end &&
        sunMorning?.source === "classes" &&
        sunMorning?.start &&
        sunMorning?.end &&
        sunEvening?.source === "classes" &&
        sunEvening?.start &&
        sunEvening?.end
          ? ` Example Sun: Early ${sunEarly.start}–${sunEarly.end}, Morning ${sunMorning.start}–${sunMorning.end}, Evening ${sunEvening.start}–${sunEvening.end} (Mindbody).`
          : " Shift times follow this week's Mindbody class schedule (Early Morning before 08:00).";
      weekRangeHint.textContent = `Coverage ${dates[0]} through ${dates[6]} (America/New_York).${sunLine}`;
    }
    if (weekStatusBadge) {
      const published = weekDoc.status === "published";
      weekStatusBadge.textContent = published ? "Published" : "Draft";
      weekStatusBadge.hidden = false;
      weekStatusBadge.classList.toggle("is-published", published);
      weekStatusBadge.classList.toggle("is-draft", !published);
    }
    updateWeekActionButtons();
  }

  function isWeekPublished() {
    return weekDoc?.status === "published";
  }

  function updateWeekActionButtons() {
    const published = isWeekPublished();
    const emailBtn = root.querySelector("[data-week-email-staff]");
    const saveBtn = root.querySelector("[data-week-save]");
    const publishBtn = root.querySelector("[data-week-publish]");
    const unpublishBtn = root.querySelector("[data-week-unpublish]");

    if (saveBtn instanceof HTMLButtonElement) {
      saveBtn.disabled = published;
      saveBtn.title = published ? "Unpublish the week before editing assignments." : "";
    }
    if (publishBtn instanceof HTMLButtonElement) {
      publishBtn.disabled = published;
      publishBtn.title = published ? "This week is already published." : "";
    }
    if (unpublishBtn instanceof HTMLButtonElement) {
      unpublishBtn.disabled = !published;
    }
    const switchBtn = root.querySelector("[data-week-switch]");
    if (switchBtn instanceof HTMLButtonElement) {
      switchBtn.disabled = !weekDoc;
      switchBtn.title = published
        ? "Click two shifts on the grid to swap them, without unpublishing."
        : "Click two shifts on the grid to swap them, or edit the draft grid directly.";
    }
    if (!(emailBtn instanceof HTMLButtonElement)) return;
    emailBtn.disabled = !published;
    emailBtn.classList.toggle("is-muted", published && !emailStaffAvailable);
    if (!published) {
      emailBtn.title = "Publish the week before emailing staff.";
    } else if (!emailStaffAvailable) {
      emailBtn.title =
        "Email not configured — add ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend settings to .env, then restart dev.";
    } else {
      emailBtn.title = "Send schedule email to assigned staff.";
    }
  }

  function countOpenApplicableSlots() {
    if (!weekGridBody) return 0;
    let count = 0;
    for (const shift of collectShiftsFromGrid()) {
      const date = String(shift.date || "");
      const slot = String(shift.slot || "");
      if (!slotActiveForDate(date, slot)) continue;
      if (shift.status === "open") count += 1;
    }
    return count;
  }

  /** @param {string} date @param {string} slot */
  function slotActiveForDate(date, slot) {
    if (weekDoc?.classScheduleAvailable === false) return true;
    const shift = weekDoc?.shifts?.find((s) => s.date === date && s.slot === slot);
    if (shift && typeof shift.slotActive === "boolean") return shift.slotActive;
    const cov = weekDoc?.classCoverage?.[date]?.[slot];
    return cov?.source === "classes" && (cov.classCount ?? 0) > 0;
  }

  /** @param {string | null | undefined} start @param {string | null | undefined} end */
  function formatTimeRange24(start, end) {
    if (!start || !end) return "";
    return `${start}–${end}`;
  }

  /** @param {string} ymd */
  function weekdayLongForYmd(ymd) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    }).format(new Date(`${ymd}T12:00:00`));
  }

  /** @param {string} staffId */
  function staffNameForId(staffId) {
    const row = staffRows.find((s) => String(s.id) === staffId);
    return row?.name ? String(row.name) : null;
  }

  /** @param {string} date @param {string} slot */
  function slotTimesFor(date, slot) {
    const coverage = weekDoc?.classCoverage?.[date]?.[slot];
    if (coverage?.source === "classes" && coverage.start && coverage.end) {
      return formatTimeRange24(String(coverage.start), String(coverage.end));
    }
    const shift = weekDoc?.shifts?.find((s) => s.date === date && s.slot === slot);
    if (shift?.start && shift?.end && shift.coverageSource === "classes") {
      return formatTimeRange24(String(shift.start), String(shift.end));
    }
    const tmpl = weekDoc?.config?.shiftTemplates?.[slot];
    if (tmpl?.start && tmpl?.end) {
      return formatTimeRange24(String(tmpl.start), String(tmpl.end));
    }
    return slot === "early_morning" ? "Early Morning" : slot === "morning" ? "Morning" : "Evening";
  }

  function buildWhatsAppTextLocal() {
    if (!weekGridBody || !weekStart) return "";
    const gridShifts = collectShiftsFromGrid();
    /** @type {Map<string, Record<string, unknown>>} */
    const byKey = new Map(
      gridShifts.map((s) => [`${String(s.date)}:${String(s.slot)}`, s]),
    );
    const dates = weekDatesFromStart(weekStart);
    const lines = [`AMARÉ Front Desk Schedule — Week of ${weekStart}`, ""];
    let currentDay = "";
    for (const date of dates) {
      for (const slot of SLOTS) {
        if (!slotActiveForDate(date, slot.id)) continue;
        const shift = byKey.get(`${date}:${slot.id}`);
        if (!shift) continue;
        const dayName = weekdayLongForYmd(date);
        if (dayName !== currentDay) {
          currentDay = dayName;
          lines.push(currentDay);
        }
        const time = slotTimesFor(date, slot.id);
        let who = "Open";
        if (shift.status === "cancelled") who = "No coverage";
        else if (shift.status === "assigned" && shift.staffId) {
          who = staffNameForId(String(shift.staffId)) || "Assigned";
        }
        lines.push(`${slot.label} ${time} — ${who}`);
      }
    }
    return lines.join("\n");
  }

  /** @param {Record<string, unknown>} shift @param {string} date @param {string} slot */
  function assignmentLabelForShift(shift, date, slot) {
    if (!slotActiveForDate(date, slot)) {
      return `<div class="admin-staff-schedule__summary-cell admin-staff-schedule__summary-cell--inactive">
        <span class="admin-staff-schedule__summary-name">—</span>
      </div>`;
    }
    const time = slotTimesFor(date, slot);
    const note = typeof shift.note === "string" ? shift.note.trim() : "";
    let name = "Open";
    let cellClass = "admin-staff-schedule__summary-cell--open";
    if (shift.status === "cancelled") {
      name = "No coverage";
      cellClass = "admin-staff-schedule__summary-cell--none";
    } else if (shift.status === "assigned" && shift.staffId) {
      name = staffNameForId(String(shift.staffId)) || "Assigned";
      cellClass = "";
    }
    const noteHtml = note ? `<span class="admin-staff-schedule__summary-note">${shared.esc(note)}</span>` : "";
    return `<div class="admin-staff-schedule__summary-cell ${cellClass}">
      <span class="admin-staff-schedule__summary-name">${shared.esc(name)}</span>
      <span class="admin-staff-schedule__summary-time">${shared.esc(time)}</span>
      ${noteHtml}
    </div>`;
  }

  function renderWeeklySummaryTable() {
    if (!summaryHead || !summaryBody || !weekStart || !weekGridBody) return;
    const dates = weekDatesFromStart(weekStart);
    const gridShifts = collectShiftsFromGrid();
    /** @type {Map<string, Record<string, unknown>>} */
    const byKey = new Map(
      gridShifts.map((s) => [`${String(s.date)}:${String(s.slot)}`, s]),
    );

    if (summaryTitle) {
      const status = weekDoc?.status === "published" ? "Published" : "Draft";
      summaryTitle.textContent = `Weekly summary — ${weekStart} (${status})`;
    }

    summaryHead.innerHTML = `<tr><th scope="col">Shift</th>${dates
      .map(
        (d, i) =>
          `<th scope="col">${DAY_LABELS[i]}<br /><span class="admin-staff-schedule__date">${shared.esc(d.slice(5))}</span></th>`,
      )
      .join("")}</tr>`;

    summaryBody.innerHTML = "";
    for (const slot of SLOTS) {
      const cells = [`<th scope="row">${slot.label}</th>`];
      for (const date of dates) {
        const shift = byKey.get(`${date}:${slot.id}`) || {
          date,
          slot: slot.id,
          status: "open",
          staffId: null,
          note: "",
        };
        cells.push(`<td>${assignmentLabelForShift(shift, date, slot.id)}</td>`);
      }
      const tr = document.createElement("tr");
      tr.innerHTML = cells.join("");
      summaryBody.appendChild(tr);
    }
  }

  function renderWeekGrid() {
    if (!weekGridHead || !weekGridBody || !weekDoc) return;
    const dates = weekDatesFromStart(weekStart);
    const shifts = Array.isArray(weekDoc.shifts) ? weekDoc.shifts : [];

    weekGridHead.innerHTML = `<tr><th scope="col">Shift</th>${dates
      .map((d, i) => `<th scope="col">${DAY_LABELS[i]}<br /><span class="admin-staff-schedule__date">${shared.esc(d.slice(5))}</span></th>`)
      .join("")}</tr>`;

    weekGridBody.innerHTML = "";
    for (const slot of SLOTS) {
      const tr = document.createElement("tr");
      const cells = [`<th scope="row">${slot.label}</th>`];
      for (const date of dates) {
        const shift = shifts.find((s) => s.date === date && s.slot === slot.id) || {
          date,
          slot: slot.id,
          staffId: null,
          status: "open",
          note: "",
        };
        cells.push(renderCell(shift));
      }
      tr.innerHTML = cells.join("");
      weekGridBody.appendChild(tr);
    }
    renderWeeklySummaryTable();
  }

  /** @param {Record<string, unknown>} shift */
  function renderCell(shift) {
    const date = String(shift.date || "");
    const slot = String(shift.slot || "");

    if (!slotActiveForDate(date, slot)) {
      return `<td class="admin-staff-schedule__cell admin-staff-schedule__cell--inactive" data-cell-date="${shared.esc(date)}" data-cell-slot="${shared.esc(slot)}" data-cell-inactive="1">
        <span class="admin-staff-schedule__inactive-label">No classes</span>
      </td>`;
    }

    const status = String(shift.status || "open");
    const staffId = shift.staffId ? String(shift.staffId) : "";
    const note = typeof shift.note === "string" ? shift.note : "";

    let selectValue = "__open__";
    if (status === "cancelled") selectValue = "__cancelled__";
    else if (status === "assigned" && staffId) selectValue = staffId;

    const requests = availabilityRequestsForCell(date, slot);
    const requestedStaffIds = new Set(requests.map((r) => r.staffId));

    const options = [
      `<option value="__open__"${selectValue === "__open__" ? " selected" : ""}>Open</option>`,
      `<option value="__cancelled__"${selectValue === "__cancelled__" ? " selected" : ""}>No coverage</option>`,
    ];
    for (const s of staffRows.filter((r) => r.active !== false)) {
      const id = String(s.id);
      const name = String(s.name || "");
      const label = requestedStaffIds.has(id) ? `${name} ✓` : name;
      options.push(
        `<option value="${shared.esc(id)}"${selectValue === id ? " selected" : ""}>${shared.esc(label)}</option>`,
      );
    }

    const hintsHtml =
      requests.length > 0
        ? `<div class="admin-staff-schedule__avail-hints" aria-label="Staff who requested this shift">${requests
            .map(
              (r) =>
                `<span class="admin-staff-schedule__avail-hint">${shared.esc(r.staffName)}<span class="admin-staff-schedule__avail-check" aria-hidden="true">✓</span></span>`,
            )
            .join("")}</div>`
        : "";

    const cellClass =
      requests.length > 0
        ? "admin-staff-schedule__cell admin-staff-schedule__cell--requested"
        : "admin-staff-schedule__cell";
    const locked = isWeekPublished();
    const lockedClass = locked ? " admin-staff-schedule__cell--locked" : "";
    const disabledAttr = locked ? " disabled" : "";

    return `<td class="${cellClass}${lockedClass}" data-cell-date="${shared.esc(date)}" data-cell-slot="${shared.esc(slot)}">
      ${hintsHtml}
      <select class="admin-staff-schedule__select" data-cell-assign aria-label="Assign ${shared.esc(slot)} ${shared.esc(date)}"${disabledAttr}>${options.join("")}</select>
      <input class="admin-staff-schedule__note" type="text" placeholder="Note" value="${shared.esc(note)}" data-cell-note maxlength="500"${disabledAttr} />
    </td>`;
  }

  function collectShiftsFromGrid() {
    if (!weekGridBody) return [];
    /** @type {Record<string, unknown>[]} */
    const out = [];
    weekGridBody.querySelectorAll("[data-cell-date]").forEach((cell) => {
      if (!(cell instanceof HTMLElement)) return;
      const date = cell.dataset.cellDate || "";
      const slot = cell.dataset.cellSlot || "";
      if (cell.dataset.cellInactive === "1") {
        out.push({ date, slot, status: "cancelled", staffId: null, note: "" });
        return;
      }
      const sel = cell.querySelector("[data-cell-assign]");
      const noteEl = cell.querySelector("[data-cell-note]");
      const val = sel instanceof HTMLSelectElement ? sel.value : "__open__";
      const note = noteEl instanceof HTMLInputElement ? noteEl.value.trim() : "";

      /** @type {Record<string, unknown>} */
      const row = { date, slot, note };
      if (val === "__cancelled__") {
        row.status = "cancelled";
        row.staffId = null;
      } else if (val === "__open__") {
        row.status = "open";
        row.staffId = null;
      } else {
        row.status = "assigned";
        row.staffId = val;
      }
      out.push(row);
    });
    return out;
  }

  /** @param {string} token @param {{ quiet?: boolean }} [opts] */
  async function saveWeek(token, opts) {
    showErr(weekError, "");
    if (isWeekPublished()) {
      showErr(weekError, "This week is published. Unpublish before editing assignments.");
      return;
    }
    if (!opts?.quiet) setWeekStatus("Saving…");
    try {
      const shifts = collectShiftsFromGrid();
      const data = await api(token, `/weeks/${encodeURIComponent(weekStart)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shifts }),
      });
      weekDoc = data.week;
      emailStaffAvailable = data.emailStaffAvailable === true;
      renderWeekGrid();
      updateWeekMeta();
      if (!opts?.quiet) setWeekStatus("Draft saved.");
    } catch (e) {
      setWeekStatus("");
      showErr(weekError, e instanceof Error ? e.message : "Save failed");
      throw e;
    }
  }

  /** @param {string} token */
  async function publishWeek(token) {
    showErr(weekError, "");
    const openCount = countOpenApplicableSlots();
    if (openCount > 0) {
      const msg =
        openCount === 1
          ? "1 shift is still Open (no assignee)."
          : `${openCount} shifts are still Open (no assignees).`;
      const ok = await confirmDialog({
        title: "Publish with open shifts?",
        message: `${msg} Publish this week anyway?`,
        confirmLabel: "Publish anyway",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
    setWeekStatus("Publishing…");
    try {
      await saveWeek(token, { quiet: true });
      await api(token, `/weeks/${encodeURIComponent(weekStart)}/publish`, { method: "POST" });
      await loadWeek(token);
      setWeekStatus("Week published.");
    } catch (e) {
      setWeekStatus("");
      showErr(weekError, e instanceof Error ? e.message : "Publish failed");
    }
  }

  /** @param {string} token */
  async function emailStaff(token) {
    showErr(weekError, "");
    if (weekDoc?.status !== "published") {
      showErr(weekError, "Publish the week before emailing staff.");
      return;
    }
    if (!emailStaffAvailable) {
      showErr(
        weekError,
        "Email not configured. Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend env vars.",
      );
      return;
    }
    const ok = await confirmDialog({
      title: "Email staff?",
      message: "Send the published schedule by email to each assigned staff member?",
      confirmLabel: "Send email",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setWeekStatus("Sending email…");
    try {
      const data = await api(token, `/weeks/${encodeURIComponent(weekStart)}/email`, {
        method: "POST",
      });
      const sent = typeof data.sent === "number" ? data.sent : 0;
      setWeekStatus(sent === 1 ? "Schedule emailed to 1 staff member." : `Schedule emailed to ${sent} staff members.`);
    } catch (e) {
      setWeekStatus("");
      showErr(weekError, e instanceof Error ? e.message : "Email failed");
    }
  }

  /** @param {string} token */
  async function unpublishWeek(token) {
    await api(token, `/weeks/${encodeURIComponent(weekStart)}/unpublish`, { method: "POST" });
    await loadWeek(token);
    setWeekStatus("Reverted to draft.");
  }

  /** @param {string} token */
  async function exportCsv(token) {
    const url = `${API}/weeks/${encodeURIComponent(weekStart)}/export.csv`;
    const res = await fetch(url, { headers: { "x-admin-token": token } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `amare-front-desk-${weekStart}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setWeekStatus("CSV downloaded.");
  }

  /** @param {string} token */
  async function unlockDashboard(token) {
    showErr(authError, "");
    try {
      await api(token, "/staff?active=1");
      shared.setToken(token);
      if (authPanel) authPanel.hidden = true;
      if (mainPanel) mainPanel.hidden = false;
      weekStart = weekStartForYmdLocal(todayYmdEt());
      if (weekStartInput) weekStartInput.value = weekStart;
      setAvailabilityWeekStart(addDaysYmd(weekStart, 7));
      setStaffTotalsWeekStart(weekStart);
      await loadStaff(token);
      await loadWeek(token);
      await loadAvailabilityPanel(token);
      await loadStaffTotals(token);
    } catch (e) {
      showErr(authError, e instanceof Error ? e.message : "Invalid token");
    }
  }

  root.querySelector("[data-staff-schedule-token-unlock]")?.addEventListener("click", () => {
    void shared
      .resolveAdminSession(root)
      .then((token) => unlockDashboard(token))
      .catch((e) => showErr(authError, e instanceof Error ? e.message : "Login failed"));
  });

  staffEditSaveBtn?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    void saveStaffEdit(token);
  });

  staffEditCancelBtn?.addEventListener("click", () => {
    if (staffEditDialog instanceof HTMLDialogElement && staffEditDialog.open) {
      staffEditDialog.close();
    }
    editingStaffId = null;
  });

  staffEditDialog?.addEventListener("cancel", () => {
    editingStaffId = null;
  });

  function closeStaffAddDialog() {
    if (staffAddDialog instanceof HTMLDialogElement && staffAddDialog.open) {
      staffAddDialog.close();
    }
  }

  function openStaffAddDialog() {
    const nameEl = root.querySelector("[data-staff-add-name]");
    const emailEl = root.querySelector("[data-staff-add-email]");
    const pinEl = root.querySelector("[data-staff-add-pin]");
    const hourlyRateEl = root.querySelector("[data-staff-add-hourly-rate]");
    if (nameEl instanceof HTMLInputElement) nameEl.value = "";
    if (emailEl instanceof HTMLInputElement) emailEl.value = "";
    if (pinEl instanceof HTMLInputElement) pinEl.value = "";
    if (hourlyRateEl instanceof HTMLInputElement) hourlyRateEl.value = "";
    showErr(staffAddError, "");
    showErr(staffManageError, "");
    if (staffAddDialog instanceof HTMLDialogElement) {
      staffAddDialog.showModal();
      if (nameEl instanceof HTMLInputElement) nameEl.focus();
    }
  }

  staffAddOpenBtn?.addEventListener("click", () => openStaffAddDialog());
  staffAddCancelBtn?.addEventListener("click", () => closeStaffAddDialog());

  staffAddForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = shared.getToken();
    if (!token) return;
    const nameEl = root.querySelector("[data-staff-add-name]");
    const emailEl = root.querySelector("[data-staff-add-email]");
    const pinEl = root.querySelector("[data-staff-add-pin]");
    const hourlyRateEl = root.querySelector("[data-staff-add-hourly-rate]");
    const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : "";
    const email = emailEl instanceof HTMLInputElement ? emailEl.value.trim() : "";
    const pin = pinEl instanceof HTMLInputElement ? pinEl.value.trim() : "";
    showErr(staffAddError, "");
    showErr(staffManageError, "");
    /** @type {Record<string, unknown>} */
    const body = { name, email, pin };
    try {
      if (hourlyRateEl instanceof HTMLInputElement) {
        body.hourlyRate = parseHourlyRateInput(hourlyRateEl.value);
      }
    } catch (e) {
      showErr(staffAddError, e instanceof Error ? e.message : "Invalid hourly rate");
      return;
    }
    void api(token, "/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(() => {
        closeStaffAddDialog();
        return loadStaff(token);
      })
      .then(() => setWeekStatus("Staff added."))
      .catch((e) => showErr(staffAddError, e instanceof Error ? e.message : "Failed"));
  });

  root.querySelector("[data-week-prev]")?.addEventListener("click", () => {
    if (!weekStart) return;
    weekStart = addDaysYmd(weekStart, -7);
    if (weekStartInput) weekStartInput.value = weekStart;
    const token = shared.getToken();
    if (token) void loadWeek(token);
  });

  root.querySelector("[data-week-next]")?.addEventListener("click", () => {
    if (!weekStart) return;
    weekStart = addDaysYmd(weekStart, 7);
    if (weekStartInput) weekStartInput.value = weekStart;
    const token = shared.getToken();
    if (token) void loadWeek(token);
  });

  weekStartInput?.addEventListener("change", () => {
    if (!(weekStartInput instanceof HTMLInputElement)) return;
    const picked = weekStartInput.value;
    if (!picked) return;
    weekStart = isWeekStartYmdLocal(picked) ? picked : weekStartForYmdLocal(picked);
    weekStartInput.value = weekStart;
    const token = shared.getToken();
    if (token) void loadWeek(token);
  });

  root.querySelector("[data-week-save]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void saveWeek(token);
  });

  root.querySelector("[data-week-publish]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void publishWeek(token);
  });

  availabilityOpenBtn?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void setAvailabilityWindow(token, "open");
  });

  availabilityCloseBtn?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void setAvailabilityWindow(token, "close");
  });

  root.querySelector("[data-availability-week-prev]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) navigateAvailabilityWeek(token, -7);
  });

  root.querySelector("[data-availability-week-next]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) navigateAvailabilityWeek(token, 7);
  });

  availabilityWeekStartInput?.addEventListener("change", () => {
    if (!(availabilityWeekStartInput instanceof HTMLInputElement)) return;
    const picked = availabilityWeekStartInput.value;
    if (!picked) return;
    setAvailabilityWeekStart(picked);
    const token = shared.getToken();
    if (token) void loadAvailabilityPanel(token);
  });

  availabilityEarlyMorningCheck?.addEventListener("change", () => {
    const token = shared.getToken();
    if (token) void saveAvailabilityEarlyMorning(token);
  });

  availabilitySendReminderBtn?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void startAvailabilityReminderFlow(token);
  });

  root.querySelector("[data-week-unpublish]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (token) void unpublishWeek(token);
  });

  function setSwitchPickMode(on) {
    switchPickMode = on;
    if (!on) switchPicks = [];
    const weekGrid = root.querySelector("[data-week-grid]");
    weekGrid?.classList.toggle("is-switch-picking", on);
    weekGridBody?.classList.toggle("is-switch-picking", on);
    updateSwitchPickHighlights();
    const switchBtn = root.querySelector("[data-week-switch]");
    if (switchBtn instanceof HTMLButtonElement) {
      switchBtn.classList.toggle("is-active", on);
    }
  }

  function updateSwitchPickHighlights() {
    if (!weekGridBody) return;
    weekGridBody.querySelectorAll("[data-cell-date]").forEach((cell) => {
      if (!(cell instanceof HTMLElement)) return;
      const picked = switchPicks.some(
        (p) => p.date === cell.dataset.cellDate && p.slot === cell.dataset.cellSlot,
      );
      cell.classList.toggle("is-switch-picked", picked);
    });
  }

  function switchMode() {
    const checked = root.querySelector("[data-week-switch-mode]:checked");
    return checked instanceof HTMLInputElement ? checked.value : "reassign";
  }

  function syncSwitchModeUi() {
    const swap = switchMode() === "swap";
    if (weekSwitchReassignWrap instanceof HTMLElement) weekSwitchReassignWrap.hidden = swap;
    if (weekSwitchSwapWrap instanceof HTMLElement) weekSwitchSwapWrap.hidden = !swap;
  }

  function shiftOptionLabel(date, slot, staffId, status) {
    const day = weekdayLongForYmd(date).slice(0, 3);
    const times = slotTimesFor(date, slot);
    const who =
      status === "cancelled"
        ? "No coverage"
        : staffId
          ? staffNameForId(staffId) || "Assigned"
          : "Open";
    return `${day} ${date.slice(5)} · ${times} · ${who}`;
  }

  function fillSwitchShiftOptions() {
    if (!(weekSwitchFrom instanceof HTMLSelectElement) || !(weekSwitchOther instanceof HTMLSelectElement)) {
      return;
    }
    const shifts = Array.isArray(weekDoc?.shifts) ? weekDoc.shifts : [];
    const opts = [];
    for (const date of weekDatesFromStart(weekStart)) {
      for (const slot of SLOTS) {
        if (!slotActiveForDate(date, slot.id)) continue;
        const shift = shifts.find((s) => s.date === date && s.slot === slot.id) || {};
        const value = `${date}|${slot.id}`;
        const label = shiftOptionLabel(date, slot.id, shift.staffId ? String(shift.staffId) : "", String(shift.status || "open"));
        opts.push(`<option value="${shared.esc(value)}">${shared.esc(label)}</option>`);
      }
    }
    weekSwitchFrom.innerHTML = opts.join("");
    weekSwitchOther.innerHTML = opts.join("");
    if (weekSwitchOther.options.length > 1) weekSwitchOther.selectedIndex = 1;
    if (weekSwitchStaff instanceof HTMLSelectElement) {
      const current = weekSwitchStaff.value;
      weekSwitchStaff.innerHTML = [
        `<option value="__open__">Open (unassign)</option>`,
        ...staffRows
          .filter((s) => s.active !== false)
          .map((s) => `<option value="${shared.esc(s.id)}">${shared.esc(s.name)}</option>`),
      ].join("");
      if (current && [...weekSwitchStaff.options].some((o) => o.value === current)) {
        weekSwitchStaff.value = current;
      }
    }
  }

  function openWeekSwitchDialog(preset) {
    if (!weekDoc) return;
    fillSwitchShiftOptions();
    const useSwap = preset?.from && preset?.other;
    const swapRadio = root.querySelector('[data-week-switch-mode][value="swap"]');
    const reassignRadio = root.querySelector('[data-week-switch-mode][value="reassign"]');
    if (useSwap && swapRadio instanceof HTMLInputElement) swapRadio.checked = true;
    else if (reassignRadio instanceof HTMLInputElement) reassignRadio.checked = true;
    if (weekSwitchFrom instanceof HTMLSelectElement && preset?.from) {
      weekSwitchFrom.value = `${preset.from.date}|${preset.from.slot}`;
    }
    if (weekSwitchOther instanceof HTMLSelectElement && preset?.other) {
      weekSwitchOther.value = `${preset.other.date}|${preset.other.slot}`;
    }
    syncSwitchModeUi();
    showErr(weekSwitchError, "");
    if (weekSwitchDialog instanceof HTMLDialogElement) weekSwitchDialog.showModal();
  }

  function closeWeekSwitchDialog() {
    if (weekSwitchDialog instanceof HTMLDialogElement && weekSwitchDialog.open) {
      weekSwitchDialog.close();
    }
    setSwitchPickMode(false);
  }

  weekGridBody?.addEventListener("click", (ev) => {
    if (!switchPickMode) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const cell = target.closest("[data-cell-date]");
    if (!(cell instanceof HTMLElement) || cell.dataset.cellInactive === "1") return;
    ev.preventDefault();
    ev.stopPropagation();
    const date = cell.dataset.cellDate || "";
    const slot = cell.dataset.cellSlot || "";
    if (!date || !slot) return;
    const idx = switchPicks.findIndex((p) => p.date === date && p.slot === slot);
    if (idx >= 0) switchPicks.splice(idx, 1);
    else if (switchPicks.length < 2) switchPicks.push({ date, slot });
    else switchPicks = [switchPicks[1], { date, slot }];
    updateSwitchPickHighlights();
    if (switchPicks.length === 2) {
      openWeekSwitchDialog({ from: switchPicks[0], other: switchPicks[1] });
    } else {
      setWeekStatus(
        switchPicks.length === 1
          ? "Shift selected. Click a second shift to switch."
          : "Click two shifts on the grid to switch them.",
      );
    }
  });

  root.querySelector("[data-week-switch]")?.addEventListener("click", () => {
    if (!weekDoc) return;
    if (switchPickMode && switchPicks.length < 2) {
      setSwitchPickMode(false);
      openWeekSwitchDialog();
      return;
    }
    setSwitchPickMode(true);
    setWeekStatus("Click two shifts on the grid to switch them. Click Switch again for the list.");
  });
  root.querySelector("[data-week-switch-cancel]")?.addEventListener("click", () => closeWeekSwitchDialog());
  root.querySelectorAll("[data-week-switch-mode]").forEach((el) => {
    el.addEventListener("change", () => syncSwitchModeUi());
  });
  weekSwitchForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = shared.getToken();
    if (!token || !weekStart) return;
    const fromVal = weekSwitchFrom instanceof HTMLSelectElement ? weekSwitchFrom.value : "";
    const [fromDate, fromSlot] = fromVal.split("|");
    /** @type {Record<string, string>} */
    const body = { fromDate, fromSlot };
    if (switchMode() === "swap") {
      const otherVal = weekSwitchOther instanceof HTMLSelectElement ? weekSwitchOther.value : "";
      const [swapDate, swapSlot] = otherVal.split("|");
      body.swapDate = swapDate;
      body.swapSlot = swapSlot;
    } else {
      body.toStaffId = weekSwitchStaff instanceof HTMLSelectElement ? weekSwitchStaff.value : "";
    }
    showErr(weekSwitchError, "");
    void api(token, `/weeks/${encodeURIComponent(weekStart)}/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((data) => {
        weekDoc = data.week && typeof data.week === "object" ? data.week : weekDoc;
        emailStaffAvailable = data.emailStaffAvailable === true;
        renderWeekGrid();
        updateWeekMeta();
        closeWeekSwitchDialog();
        setWeekStatus("Shift switched. Staff totals will use the new assignment.");
        return loadStaffTotals(token);
      })
      .catch((e) => showErr(weekSwitchError, e instanceof Error ? e.message : "Switch failed"));
  });

  root.querySelector("[data-week-email-staff]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    void emailStaff(token).catch((e) =>
      showErr(weekError, e instanceof Error ? e.message : "Email failed"),
    );
  });

  root.querySelector("[data-week-export-csv]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    void exportCsv(token).catch((e) => showErr(weekError, e instanceof Error ? e.message : "Export failed"));
  });

  /** @param {string} text */
  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Clipboard copy failed");
  }

  root.querySelector("[data-week-copy-whatsapp]")?.addEventListener("click", () => {
    const text = buildWhatsAppTextLocal();
    if (!text) {
      setWeekStatus("Nothing to copy.");
      if (summaryStatus) {
        summaryStatus.textContent = "Nothing to copy.";
        summaryStatus.hidden = false;
      }
      return;
    }
    if (sharePreview) {
      sharePreview.textContent = text;
      sharePreview.hidden = false;
    }
    void copyTextToClipboard(text)
      .then(() => {
        setWeekStatus("Copied to clipboard.");
        if (summaryStatus) {
          summaryStatus.textContent = "Copied to clipboard.";
          summaryStatus.hidden = false;
        }
      })
      .catch(() => {
        setWeekStatus("Could not copy. Select the text below and copy manually.");
        if (summaryStatus) {
          summaryStatus.textContent = "Could not copy. Select the text below and copy manually.";
          summaryStatus.hidden = false;
        }
      });
  });

  root.querySelector("[data-week-print]")?.addEventListener("click", () => {
    window.print();
  });

  staffTotalsModeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-staff-totals-mode");
      if (mode !== "week" && mode !== "two_weeks" && mode !== "month") return;
      setStaffTotalsMode(mode);
      const token = shared.getToken();
      if (token) void loadStaffTotals(token);
    });
  });

  root.querySelector("[data-staff-totals-week-prev]")?.addEventListener("click", () => {
    if (!staffTotalsWeekStart) return;
    const step = staffTotalsMode === "two_weeks" ? -14 : -7;
    setStaffTotalsWeekStart(addDaysYmd(staffTotalsWeekStart, step));
    const token = shared.getToken();
    if (token && (staffTotalsMode === "week" || staffTotalsMode === "two_weeks")) void loadStaffTotals(token);
  });

  root.querySelector("[data-staff-totals-week-next]")?.addEventListener("click", () => {
    if (!staffTotalsWeekStart) return;
    const step = staffTotalsMode === "two_weeks" ? 14 : 7;
    setStaffTotalsWeekStart(addDaysYmd(staffTotalsWeekStart, step));
    const token = shared.getToken();
    if (token && (staffTotalsMode === "week" || staffTotalsMode === "two_weeks")) void loadStaffTotals(token);
  });

  staffTotalsWeekStartInput?.addEventListener("change", () => {
    if (!(staffTotalsWeekStartInput instanceof HTMLInputElement)) return;
    const picked = staffTotalsWeekStartInput.value;
    if (!picked) return;
    setStaffTotalsWeekStart(picked);
    const token = shared.getToken();
    if (token && (staffTotalsMode === "week" || staffTotalsMode === "two_weeks")) void loadStaffTotals(token);
  });

  staffTotalsMonthInput?.addEventListener("change", () => {
    const token = shared.getToken();
    if (token && staffTotalsMode === "month") void loadStaffTotals(token);
  });

  staffTotalsPublishedOnly?.addEventListener("change", () => {
    const token = shared.getToken();
    if (token) void loadStaffTotals(token);
  });

  root.querySelector("[data-staff-totals-export]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    void exportStaffTotalsCsv(token).catch((e) =>
      showErr(staffTotalsError, e instanceof Error ? e.message : "Export failed"),
    );
  });

  root.querySelector("[data-commission-add-open]")?.addEventListener("click", () => openCommissionAddDialog());
  root.querySelector("[data-commission-add-cancel]")?.addEventListener("click", () => closeCommissionAddDialog());
  commissionPackageSelect?.addEventListener("change", () => syncCommissionAmountFromPackage());
  commissionAddForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = shared.getToken();
    if (!token) return;
    const staffId = commissionStaffSelect instanceof HTMLSelectElement ? commissionStaffSelect.value : "";
    const packageId = commissionPackageSelect instanceof HTMLSelectElement ? commissionPackageSelect.value : "";
    const amountUsd = commissionAmountInput instanceof HTMLInputElement ? commissionAmountInput.value : "";
    const clientName = commissionClientInput instanceof HTMLInputElement ? commissionClientInput.value.trim() : "";
    const soldDate = commissionDateInput instanceof HTMLInputElement ? commissionDateInput.value : "";
    const soldTime = commissionTimeInput instanceof HTMLInputElement ? commissionTimeInput.value : "";
    showErr(commissionAddError, "");
    void api(token, "/commissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId, packageId, amountUsd, clientName, soldDate, soldTime }),
    })
      .then(() => {
        closeCommissionAddDialog();
        return loadStaffTotals(token);
      })
      .then(() => setWeekStatus("Commission added."))
      .catch((e) => showErr(commissionAddError, e instanceof Error ? e.message : "Failed to add"));
  });

  root.querySelector("[data-commission-rates-open]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    const open = () => openCommissionRatesDialog();
    if (commissionPackages.length) {
      open();
      return;
    }
    void api(token, "/commission-packages")
      .then((data) => {
        commissionPackages = Array.isArray(data.packages) ? data.packages : [];
        open();
      })
      .catch((e) => showErr(commissionError, e instanceof Error ? e.message : "Failed to load rates"));
  });
  root.querySelector("[data-commission-rates-cancel]")?.addEventListener("click", () => closeCommissionRatesDialog());
  commissionRatesForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = shared.getToken();
    if (!token) return;
    const packages = [...root.querySelectorAll("[data-commission-rate-id]")].map((input) => ({
      id: input.getAttribute("data-commission-rate-id"),
      label: input.getAttribute("data-commission-rate-label"),
      amountUsd: input instanceof HTMLInputElement ? input.value : "",
    }));
    showErr(commissionRatesError, "");
    void api(token, "/commission-packages", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packages }),
    })
      .then((data) => {
        commissionPackages = Array.isArray(data.packages) ? data.packages : packages;
        closeCommissionRatesDialog();
        setWeekStatus("Commission rates saved.");
      })
      .catch((e) => showErr(commissionRatesError, e instanceof Error ? e.message : "Failed to save rates"));
  });

  if (staffTotalsMonthInput instanceof HTMLInputElement) {
    staffTotalsMonthInput.value = currentMonthInputValue();
  }
  setStaffTotalsMode("week");

  const saved = shared.getToken();
  if (saved.length >= 16) {
    if (tokenInput) tokenInput.value = saved;
    void unlockDashboard(saved);
  }
})();
