/**
 * Public front desk shift availability submission.
 */
(function staffAvailabilityPage() {
  const root = document.querySelector("[data-staff-availability-root]");
  if (!root) return;

  const API = "/api/staff-schedule/availability";
  const SLOTS = ["early_morning", "morning", "evening"];

  const weekLabelEl = root.querySelector("[data-availability-week-label]");
  const staffSelect = root.querySelector("[data-availability-staff]");
  const pinInput = root.querySelector("[data-availability-pin]");
  const gridWrap = root.querySelector("[data-availability-grid-wrap]");
  const gridHead = root.querySelector("[data-availability-grid-head]");
  const gridBody = root.querySelector("[data-availability-grid-body]");
  const emptyEl = root.querySelector("[data-availability-empty]");
  const submitBtn = root.querySelector("[data-availability-submit]");
  const statusEl = root.querySelector("[data-availability-status]");
  const errorEl = root.querySelector("[data-availability-error]");
  const noticeEl = root.querySelector("[data-availability-notice]");

  /** @type {string} */
  let weekStart = "";
  /** @type {Record<string, unknown>[]} */
  let days = [];
  /** @type {Set<string>} */
  const selected = new Set();
  /** @type {string} */
  let existingSubmittedAt = "";
  /** @type {Record<string, string[]>} */
  let otherSelectionsByCell = {};
  /** @type {boolean} */
  let canSubmit = true;
  /** @type {boolean} */
  let readOnly = false;

  const summarySection = root.querySelector("[data-availability-summary]");
  const summaryMeta = root.querySelector("[data-availability-summary-meta]");
  const summaryList = root.querySelector("[data-availability-summary-list]");
  const summaryEmpty = root.querySelector("[data-availability-summary-empty]");

  /** @param {string} msg */
  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.hidden = !msg;
  }

  /** @param {string} msg */
  function showErr(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  /** @param {string} s */
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {string | null | undefined} start @param {string | null | undefined} end */
  function formatTimeRange(start, end) {
    const fmt = (t) => {
      if (!t) return "";
      const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
      const h12 = hh % 12 || 12;
      const ap = hh >= 12 ? "PM" : "AM";
      return mm ? `${h12}:${String(mm).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
    };
    if (!start && !end) return "";
    return `${fmt(start)}–${fmt(end)}`;
  }

  function selectionKey(date, slot) {
    return `${date}|${slot}`;
  }

  /** @param {string} date @param {string} slot */
  function othersForCell(date, slot) {
    return otherSelectionsByCell[selectionKey(date, slot)] || [];
  }

  /** @param {string} slot */
  function slotLabel(slot) {
    if (slot === "early_morning") return "Early Morning";
    if (slot === "morning") return "Morning";
    if (slot === "evening") return "Evening";
    return slot;
  }

  /** @param {string | null | undefined} iso */
  function formatSubmittedAt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  }

  function buildSummaryItems() {
    /** @type {{ date: string; day: string; slot: string; slotId: string; time: string }[]} */
    const items = [];
    for (const key of selected) {
      const [date, slotId] = key.split("|");
      if (!date || !slotId) continue;
      const dayRow = days.find((d) => String(d.date || "") === date);
      const daySlots = Array.isArray(dayRow?.slots) ? dayRow.slots : [];
      const slotRow = daySlots.find((s) => String(s.slot || "") === slotId);
      items.push({
        date,
        day: String(dayRow?.day || date),
        slotId,
        slot: slotLabel(slotId),
        time: formatTimeRange(slotRow?.start, slotRow?.end),
      });
    }
    items.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return SLOTS.indexOf(a.slotId) - SLOTS.indexOf(b.slotId);
    });
    return items;
  }

  function renderSummary() {
    if (!summarySection) return;
    const staffOk = staffSelect instanceof HTMLSelectElement && staffSelect.value;
    const show = Boolean(staffOk && (pinReady() || selected.size > 0));
    summarySection.hidden = !show;
    if (!show) return;

    const items = buildSummaryItems();
    if (summaryList) {
      summaryList.innerHTML = items
        .map(
          (item) =>
            `<li><strong>${item.day}</strong> (${item.date}) — ${item.slot}${
              item.time ? ` <span class="staff-availability__summary-time">${item.time}</span>` : ""
            }</li>`,
        )
        .join("");
    }
    if (summaryEmpty) summaryEmpty.hidden = items.length > 0;
    if (summaryList) summaryList.hidden = items.length === 0;

    if (summaryMeta) {
      const savedAt = formatSubmittedAt(existingSubmittedAt);
      summaryMeta.textContent = savedAt ? `Last saved ${savedAt}.` : "";
      summaryMeta.hidden = !savedAt;
    }
  }

  function readWeekStartFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return (params.get("weekStart") || params.get("week") || "").trim();
  }

  function pinReady() {
    const pin = pinInput instanceof HTMLInputElement ? pinInput.value.replace(/\D/g, "") : "";
    return pin.length >= 4 && pin.length <= 6;
  }

  function updateSubmitEnabled() {
    if (!(submitBtn instanceof HTMLButtonElement)) return;
    const staffOk = staffSelect instanceof HTMLSelectElement && staffSelect.value;
    submitBtn.disabled = !(staffOk && pinReady() && selected.size > 0 && canSubmit && !readOnly);
    if (submitBtn) submitBtn.hidden = readOnly;
  }

  function renderGrid() {
    if (!gridHead || !gridBody) return;

    const slotSet = new Set();
    for (const day of days) {
      const slots = Array.isArray(day.slots) ? day.slots : [];
      for (const slot of slots) slotSet.add(String(slot.slot));
    }
    const activeSlots = SLOTS.filter((id) => slotSet.has(id));

    if (!activeSlots.length) {
      if (gridWrap) gridWrap.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
      updateSubmitEnabled();
      return;
    }

    if (gridWrap) gridWrap.hidden = false;
    if (emptyEl) emptyEl.hidden = true;

    gridHead.innerHTML = `<tr><th scope="col">Day</th>${activeSlots
      .map((slot) => {
        const label =
          slot === "early_morning" ? "Early" : slot === "morning" ? "Morning" : "Evening";
        return `<th scope="col">${label}</th>`;
      })
      .join("")}</tr>`;

    gridBody.innerHTML = "";
    for (const day of days) {
      const date = String(day.date || "");
      const daySlots = Array.isArray(day.slots) ? day.slots : [];
      const bySlot = new Map(daySlots.map((s) => [String(s.slot), s]));
      if (!daySlots.length) continue;

      const tr = document.createElement("tr");
      tr.innerHTML = `<td>
        <span class="staff-availability__day">${String(day.day || "")}</span>
        <span class="staff-availability__date">${date}</span>
      </td>`;

      for (const slotId of activeSlots) {
        const slot = bySlot.get(slotId);
        const td = document.createElement("td");
        if (!slot) {
          td.textContent = "—";
          tr.appendChild(td);
          continue;
        }
        const key = selectionKey(date, slotId);
        const checked = selected.has(key);
        const time = formatTimeRange(slot.start, slot.end);
        const others = othersForCell(date, slotId);
        if (others.length) td.classList.add("staff-availability__cell--others");
        const othersHtml =
          others.length > 0
            ? `<div class="staff-availability__others" aria-label="Also requested by">${others
                .map(
                  (name) =>
                    `<span class="staff-availability__others-name">${esc(name)}<span class="staff-availability__others-check" aria-hidden="true">✓</span></span>`,
                )
                .join("")}</div>`
            : "";
        td.innerHTML = `<label>
          <input class="staff-availability__check" type="checkbox" data-date="${esc(date)}" data-slot="${esc(slotId)}" ${
            checked ? "checked" : ""
          }${readOnly ? " disabled" : ""} />
          ${time ? `<span class="staff-availability__slot-time">${esc(time)}</span>` : ""}
        </label>${othersHtml}`;
        tr.appendChild(td);
      }
      gridBody.appendChild(tr);
    }

    gridBody.querySelectorAll("input[type=checkbox]").forEach((input) => {
      if (readOnly) return;
      input.addEventListener("change", () => {
        const date = input.getAttribute("data-date") || "";
        const slot = input.getAttribute("data-slot") || "";
        const key = selectionKey(date, slot);
        if (input.checked) selected.add(key);
        else selected.delete(key);
        updateSubmitEnabled();
        renderSummary();
      });
    });

    updateSubmitEnabled();
    renderSummary();
  }

  /** @param {Record<string, unknown>} data */
  function applyFormData(data) {
    weekStart = String(data.weekStart || "");
    canSubmit = data.canSubmit !== false;
    readOnly = data.readOnly === true || !canSubmit;
    days = Array.isArray(data.days) ? data.days : [];

    if (noticeEl) {
      const msg =
        typeof data.redirectMessage === "string" && data.redirectMessage.trim()
          ? data.redirectMessage
          : readOnly && data.availabilityStatus === "locked"
            ? "The schedule for this week has been published. You can view your submission but cannot change it."
            : readOnly && data.availabilityStatus === "closed"
              ? "Availability is not open for this week yet. Check back when your manager opens the form."
              : "";
      noticeEl.textContent = msg;
      noticeEl.hidden = !msg;
    }

    if (data.redirectedFrom && weekStart) {
      const params = new URLSearchParams(window.location.search);
      params.set("weekStart", weekStart);
      const next = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState(null, "", next);
    }

    if (weekLabelEl) {
      weekLabelEl.textContent = data.weekLabel
        ? `Week of ${String(data.weekLabel)}`
        : weekStart
          ? `Week starting ${weekStart}`
          : "";
      weekLabelEl.hidden = !weekLabelEl.textContent;
    }

    if (staffSelect instanceof HTMLSelectElement) {
      const current = staffSelect.value;
      staffSelect.innerHTML = '<option value="">— Select —</option>';
      const staff = Array.isArray(data.staff) ? data.staff : [];
      for (const row of staff) {
        const opt = document.createElement("option");
        opt.value = String(row.id || "");
        opt.textContent = String(row.name || "");
        staffSelect.appendChild(opt);
      }
      if (current) staffSelect.value = current;
    }

    selected.clear();
    const existing = Array.isArray(data.existingSelections) ? data.existingSelections : [];
    for (const row of existing) {
      selected.add(selectionKey(String(row.date || ""), String(row.slot || "")));
    }
    existingSubmittedAt =
      typeof data.existingSubmittedAt === "string" ? data.existingSubmittedAt : "";
    otherSelectionsByCell =
      data.otherSelectionsByCell && typeof data.otherSelectionsByCell === "object"
        ? /** @type {Record<string, string[]>} */ (data.otherSelectionsByCell)
        : {};

    renderGrid();
    renderSummary();
  }

  async function loadForm(includePin, opts) {
    showErr("");
    if (!opts?.quiet) setStatus("Loading…");
    const params = new URLSearchParams();
    const urlWeek = readWeekStartFromUrl();
    if (urlWeek) params.set("weekStart", urlWeek);
    if (staffSelect instanceof HTMLSelectElement && staffSelect.value) {
      params.set("staffId", staffSelect.value);
    }
    if (includePin && pinInput instanceof HTMLInputElement && pinReady()) {
      params.set("pin", pinInput.value.replace(/\D/g, ""));
    }

    try {
      const res = await fetch(`${API}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Load failed (${res.status})`);
      }
      applyFormData(data);
      if (!opts?.quiet) setStatus("");
    } catch (e) {
      if (!opts?.quiet) setStatus("");
      showErr(e instanceof Error ? e.message : "Failed to load form");
    }
  }

  async function submitForm() {
    showErr("");
    if (!(staffSelect instanceof HTMLSelectElement) || !(pinInput instanceof HTMLInputElement)) return;
    if (!(submitBtn instanceof HTMLButtonElement)) return;

    const staffId = staffSelect.value;
    const pin = pinInput.value.replace(/\D/g, "");
    if (!staffId || !pinReady()) {
      showErr("Select your name and enter your PIN.");
      return;
    }

    /** @type {{ date: string; slot: string }[]} */
    const selections = [];
    for (const key of selected) {
      const [date, slot] = key.split("|");
      if (date && slot) selections.push({ date, slot });
    }

    submitBtn.disabled = true;
    setStatus("Submitting…");
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart, staffId, pin, selections }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.hint || data.error || `Submit failed (${res.status})`);
      }
      if (typeof data.submittedAt === "string") {
        existingSubmittedAt = data.submittedAt;
      }
      await loadForm(true, { quiet: true });
      renderSummary();
      setStatus(
        data.selectionCount === 1
          ? "Thanks — 1 shift saved. You can update anytime before the schedule is published."
          : `Thanks — ${data.selectionCount} shifts saved. You can update anytime before the schedule is published.`,
      );
    } catch (e) {
      showErr(e instanceof Error ? e.message : "Submit failed");
    } finally {
      updateSubmitEnabled();
    }
  }

  staffSelect?.addEventListener("change", () => {
    selected.clear();
    existingSubmittedAt = "";
    renderSummary();
    void loadForm(false);
  });

  pinInput?.addEventListener("change", () => {
    if (pinReady()) void loadForm(true);
    else {
      existingSubmittedAt = "";
      updateSubmitEnabled();
      renderSummary();
    }
  });

  submitBtn?.addEventListener("click", () => {
    void submitForm();
  });

  void loadForm(false);
})();
