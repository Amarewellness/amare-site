(function () {
  const root = document.querySelector("[data-admin-events-root]");
  if (!root || !window.AmareFollowUpAdmin) return;
  const shared = window.AmareFollowUpAdmin;

  const el = {
    authPanel: root.querySelector("[data-events-auth-panel]"),
    main: root.querySelector("[data-events-main]"),
    tokenInput: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-token-input]")),
    unlock: root.querySelector("[data-events-token-unlock]"),
    authErr: root.querySelector("[data-events-auth-error]"),
    summary: root.querySelector("[data-events-summary]"),
    tbody: root.querySelector("[data-events-tbody]"),
    formsTbody: root.querySelector("[data-events-forms-tbody]"),
    formsSummary: root.querySelector("[data-events-forms-summary]"),
    formsErr: root.querySelector("[data-events-forms-error]"),
    refresh: root.querySelector("[data-events-refresh]"),
    mainErr: root.querySelector("[data-events-main-error]"),
    mainStatus: root.querySelector("[data-events-main-status]"),
    customDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-custom-dialog]")),
    customForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-custom-form]")),
    customWho: root.querySelector("[data-events-custom-who]"),
    customAmount: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-custom-amount]")),
    customDesc: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-custom-desc]")),
    customErr: root.querySelector("[data-events-custom-error]"),
    customCancel: root.querySelector("[data-events-custom-cancel]"),
    moveDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-move-dialog]")),
    moveForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-move-form]")),
    moveWho: root.querySelector("[data-events-move-who]"),
    moveDate: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-move-date]")),
    moveTime: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-move-time]")),
    moveErr: root.querySelector("[data-events-move-error]"),
    moveCancel: root.querySelector("[data-events-move-cancel]"),
    cancelDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-cancel-dialog]")),
    cancelForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-cancel-form]")),
    cancelWho: root.querySelector("[data-events-cancel-who]"),
    cancelNote: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-cancel-note]")),
    cancelErr: root.querySelector("[data-events-cancel-error]"),
    cancelClose: root.querySelector("[data-events-cancel-close]"),
  };

  /** @type {Record<string, unknown>[]} */
  let rows = [];
  /** @type {Record<string, unknown>[]} */
  let formRows = [];
  let filter = "upcoming";
  let busy = false;
  let customChargeId = "";
  let moveId = "";
  let cancelId = "";

  function token() {
    return shared.getToken();
  }

  /** @param {number} cents */
  function money(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
  }

  /** @param {string} ymd @param {string} hhmm */
  function whenLabel(ymd, hhmm) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return shared.esc(ymd || "—");
    const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
    const [h, mi] = String(hhmm || "00:00")
      .split(":")
      .map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, mo - 1, d, 16, 0, 0));
    const dateLine = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(dt);
    const hour = Number.isFinite(h) ? h : 0;
    const min = Number.isFinite(mi) ? mi : 0;
    const h12 = ((hour + 11) % 12) + 1;
    const ampm = hour < 12 ? "AM" : "PM";
    return `${dateLine} · ${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  }

  /** @param {string} room */
  function roomLabel(room) {
    if (room === "reformer") return "Reformer";
    if (room === "mat") return "Mat";
    if (room === "kangoo") return "Kangoo";
    return String(room || "—");
  }

  /** @param {string} status */
  function statusMeta(status) {
    if (status === "deposit_paid_pending_confirm") {
      return { label: "Needs confirm", cls: "admin-events__pill--needs" };
    }
    if (status === "confirmed") return { label: "Confirmed", cls: "admin-events__pill--ok" };
    if (status === "deposit_pending") return { label: "Checkout open", cls: "admin-events__pill--muted" };
    if (status === "expired") return { label: "Expired", cls: "admin-events__pill--muted" };
    if (status === "canceled") return { label: "Canceled", cls: "admin-events__pill--bad" };
    return { label: status || "—", cls: "admin-events__pill--muted" };
  }

  /** @param {string} msg */
  function setStatus(msg) {
    if (!el.mainStatus) return;
    if (msg) {
      el.mainStatus.textContent = msg;
      el.mainStatus.hidden = false;
    } else {
      el.mainStatus.textContent = "";
      el.mainStatus.hidden = true;
    }
  }

  /** @param {Record<string, unknown>} summary */
  function renderSummary(summary) {
    if (!el.summary) return;
    const by = summary && typeof summary.byStatus === "object" && summary.byStatus ? summary.byStatus : {};
    el.summary.innerHTML = `
      <span><strong>Total:</strong> ${shared.esc(summary.total ?? 0)}</span>
      <span><strong>Upcoming:</strong> ${shared.esc(summary.upcoming ?? 0)}</span>
      <span><strong>Needs confirm:</strong> ${shared.esc(summary.needsConfirm ?? 0)}</span>
      <span><strong>Confirmed:</strong> ${shared.esc(by.confirmed ?? 0)}</span>
    `;
  }

  /** @param {Record<string, unknown>} r */
  function extrasHtml(r) {
    const overtime = Array.isArray(r.overtimeCharges) ? r.overtimeCharges : [];
    const custom = Array.isArray(r.customCharges) ? r.customCharges : [];
    const extras = Number(r.extrasCentsTotal);
    const total = Number.isFinite(extras)
      ? extras
      : (Number(r.overtimeCentsTotal) || 0) + (Number(r.customCentsTotal) || 0);
    const lines = [
      ...overtime.map((c) => {
        const row = /** @type {Record<string, unknown>} */ (c);
        return `+${row.minutes || "?"} min · ${money(Number(row.cents) || 0)}`;
      }),
      ...custom.map((c) => {
        const row = /** @type {Record<string, unknown>} */ (c);
        return `${row.description || "Other"} · ${money(Number(row.cents) || 0)}`;
      }),
    ];
    if (!lines.length) return shared.esc(money(0));
    return `${shared.esc(money(total))}<div class="admin-events__sub">${lines.map((line) => shared.esc(line)).join("<br />")}</div>`;
  }

  function overtimeOptionsHtml() {
    const opts = [];
    for (let minutes = 30; minutes <= 240; minutes += 30) {
      const hours = minutes / 60;
      const timeLabel = minutes < 60 ? `${minutes} min` : hours === 1 ? "1 hr" : `${hours} hr`;
      opts.push(`<option value="${minutes}">${shared.esc(`${timeLabel} · ${money((minutes / 30) * 5000)}`)}</option>`);
    }
    return opts.join("");
  }

  function visibleRows() {
    if (filter === "all") return rows;
    return rows.filter((r) => String(r.whenBucket) === filter);
  }

  function renderTable() {
    if (!el.tbody) return;
    const list = visibleRows();
    if (!list.length) {
      const empty =
        rows.length === 0
          ? "No reservations yet. They appear here after a $200 deposit is paid. Local memory is cleared if the server restarts."
          : `No ${filter} reservations.`;
      el.tbody.innerHTML = `<tr><td colspan="10">${shared.esc(empty)}</td></tr>`;
      return;
    }
    el.tbody.innerHTML = list
      .map((r) => {
        const id = String(r.id || "");
        const st = statusMeta(String(r.status || ""));
        const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "—";
        const contact = [r.email, r.phone].filter(Boolean).join(" · ");
        const styling = r.styling ? money(Number(r.stylingCents) || 0) : "No";
        const pastCls = r.whenBucket === "past" ? " admin-events__when--past" : "";
        const confirmBtn = r.canConfirm
          ? `<button type="button" class="btn btn--small" data-events-confirm="${shared.esc(id)}">Confirm</button>`
          : "";
        const remainingBtn = r.canChargeRemaining
          ? `<button type="button" class="btn btn--small" data-events-remaining="${shared.esc(id)}">Charge remaining</button>`
          : "";
        const moveBtn = r.canReschedule
          ? `<button type="button" class="btn btn--ghost btn--small" data-events-move="${shared.esc(id)}">Move date</button>`
          : "";
        const cancelBtn = r.canCancel
          ? `<button type="button" class="btn btn--ghost btn--small" data-events-cancel="${shared.esc(id)}">Cancel</button>`
          : "";
        const actions =
          confirmBtn || remainingBtn || moveBtn || cancelBtn
            ? `${confirmBtn}${remainingBtn}${moveBtn}${cancelBtn}`
            : "—";
        const remainingCell = r.remainingPaid
          ? `${shared.esc(money(Number(r.remainingCents) || 0))}<div class="admin-events__sub"><span class="admin-events__pill admin-events__pill--ok">Paid</span></div>`
          : shared.esc(money(Number(r.remainingCents) || 0));
        const extraTime = r.canChargeOvertime
          ? `<div class="admin-events__ot">
              <select class="admin-sms__input admin-events__ot-select" data-events-ot-min="${shared.esc(id)}" aria-label="Extra time">
                ${overtimeOptionsHtml()}
              </select>
              <button type="button" class="btn btn--ghost btn--small" data-events-ot="${shared.esc(id)}">Charge</button>
              <button type="button" class="btn btn--ghost btn--small" data-events-other="${shared.esc(id)}">Other</button>
            </div>`
          : "—";
        return `<tr class="${pastCls.trim()}">
          <td>
            ${shared.esc(whenLabel(String(r.eventDate || ""), String(r.eventTime || "")))}
            <div class="admin-events__sub">${shared.esc(String(r.guests || "—"))} guests</div>
          </td>
          <td>
            ${shared.esc(name)}
            <div class="admin-events__sub">${shared.esc(contact || "—")}</div>
          </td>
          <td>${shared.esc(roomLabel(String(r.room || "")))}</td>
          <td>${shared.esc(styling)}</td>
          <td>${shared.esc(money(Number(r.depositCents) || 0))}</td>
          <td>${remainingCell}</td>
          <td>${extrasHtml(r)}</td>
          <td>${extraTime}</td>
          <td><span class="admin-events__pill ${st.cls}">${shared.esc(st.label)}</span></td>
          <td><div class="admin-events__actions">${actions}</div></td>
        </tr>`;
      })
      .join("");

    el.tbody.querySelectorAll("[data-events-confirm]").forEach((btn) => {
      btn.addEventListener("click", () => void confirmRow(String(btn.getAttribute("data-events-confirm") || "")));
    });
    el.tbody.querySelectorAll("[data-events-ot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = String(btn.getAttribute("data-events-ot") || "");
        const select = /** @type {HTMLSelectElement|null} */ (
          el.tbody?.querySelector(`[data-events-ot-min="${CSS.escape(id)}"]`)
        );
        const minutes = Number(select?.value || 0);
        void chargeOvertime(id, minutes);
      });
    });
    el.tbody.querySelectorAll("[data-events-other]").forEach((btn) => {
      btn.addEventListener("click", () => openCustomDialog(String(btn.getAttribute("data-events-other") || "")));
    });
    el.tbody.querySelectorAll("[data-events-remaining]").forEach((btn) => {
      btn.addEventListener("click", () => void chargeRemaining(String(btn.getAttribute("data-events-remaining") || "")));
    });
    el.tbody.querySelectorAll("[data-events-move]").forEach((btn) => {
      btn.addEventListener("click", () => openMoveDialog(String(btn.getAttribute("data-events-move") || "")));
    });
    el.tbody.querySelectorAll("[data-events-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => openCancelDialog(String(btn.getAttribute("data-events-cancel") || "")));
    });
  }

  function setFilter(next) {
    filter = next;
    root.querySelectorAll("[data-events-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-events-filter") === next);
    });
    renderTable();
  }

  /** @param {string} iso */
  function submittedLabel(iso) {
    const raw = String(iso || "");
    const dt = new Date(raw);
    if (!raw || Number.isNaN(dt.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(dt);
  }

  function renderForms() {
    if (el.formsSummary) {
      el.formsSummary.innerHTML = `<span><strong>Total:</strong> ${shared.esc(formRows.length)}</span>`;
    }
    if (!el.formsTbody) return;
    if (!formRows.length) {
      el.formsTbody.innerHTML =
        `<tr><td colspan="5">${shared.esc("No event forms yet. New /privateevents inquiries appear here after submit.")}</td></tr>`;
      return;
    }
    el.formsTbody.innerHTML = formRows
      .map((r) => {
        const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "—";
        const contact = [r.email, r.phone].filter(Boolean).join(" · ") || "—";
        const preferred = r.eventDate
          ? whenLabel(String(r.eventDate || ""), String(r.eventTime || ""))
          : r.eventTime
            ? shared.esc(String(r.eventTime))
            : "—";
        return `<tr>
          <td>${shared.esc(submittedLabel(String(r.createdAt || "")))}</td>
          <td>${preferred}</td>
          <td>${shared.esc(name)}</td>
          <td>${shared.esc(contact)}</td>
          <td class="admin-events__msg">${shared.esc(String(r.message || "—"))}</td>
        </tr>`;
      })
      .join("");
  }

  async function loadForms() {
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/forms");
      formRows = Array.isArray(data.forms) ? data.forms : [];
      renderForms();
      shared.showError(el.formsErr, "");
    } catch (e) {
      formRows = [];
      renderForms();
      shared.showError(el.formsErr, e instanceof Error ? e.message : "Could not load event forms");
    }
  }

  async function loadList() {
    const data = await shared.adminFetch(token(), "/api/admin/events/list");
    rows = Array.isArray(data.reservations) ? data.reservations : [];
    renderSummary(data.summary && typeof data.summary === "object" ? data.summary : {});
    renderTable();
    await loadForms();
  }

  async function unlock() {
    let t = shared.getToken();
    if (!t) {
      try {
        t = await shared.resolveAdminSession(root);
      } catch (e) {
        shared.showError(el.authErr, e instanceof Error ? e.message : "Enter username and password.");
        return;
      }
    }
    shared.setToken(t);
    try {
      await loadList();
      if (el.authPanel) el.authPanel.hidden = true;
      if (el.main) el.main.hidden = false;
      shared.showError(el.authErr, "");
      shared.showError(el.mainErr, "");
    } catch (e) {
      shared.setToken("");
      shared.showError(el.authErr, e instanceof Error ? e.message : "Unauthorized");
    }
  }

  /** @param {string} id */
  async function confirmRow(id) {
    if (busy) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const when = row ? whenLabel(String(row.eventDate || ""), String(row.eventTime || "")) : "";
    if (!window.confirm(`Confirm this date for ${name}${when ? ` — ${when}` : ""}? This locks the date for the day-before balance charge.`)) {
      return;
    }
    busy = true;
    setStatus("Confirming…");
    try {
      await shared.adminFetch(token(), "/api/admin/events/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Confirmed ${name}.`);
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Confirm failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id @param {number} minutes */
  async function chargeOvertime(id, minutes) {
    if (busy) return;
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 240 || minutes % 30 !== 0) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const dollars = money((minutes / 30) * 5000);
    if (!window.confirm(`Charge ${dollars} (+${minutes} min) to ${name}'s saved card?`)) {
      return;
    }
    busy = true;
    setStatus(`Charging ${dollars}…`);
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/charge-overtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, minutes }),
      });
      await loadList();
      shared.showError(el.mainErr, "");
      const formatted =
        data.charged && typeof data.charged === "object"
          ? String(/** @type {Record<string, unknown>} */ (data.charged).formatted || dollars)
          : dollars;
      setStatus(`Charged ${formatted} overtime for ${name}.`);
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Charge failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id */
  async function chargeRemaining(id) {
    if (busy) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const dollars = money(Number(row?.remainingCents) || 0);
    if (!window.confirm(`Charge the remaining ${dollars} to ${name}'s saved card?`)) {
      return;
    }
    busy = true;
    setStatus(`Charging remaining ${dollars}…`);
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/charge-remaining", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadList();
      shared.showError(el.mainErr, "");
      const formatted =
        data.charged && typeof data.charged === "object"
          ? String(/** @type {Record<string, unknown>} */ (data.charged).formatted || dollars)
          : dollars;
      setStatus(`Charged remaining ${formatted} for ${name}.`);
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Charge remaining failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id */
  function openCustomDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    customChargeId = id;
    if (el.customWho) el.customWho.textContent = `Charge ${name}'s saved card.`;
    if (el.customAmount) el.customAmount.value = "";
    if (el.customDesc) el.customDesc.value = "";
    shared.showError(el.customErr, "");
    if (el.customDialog && typeof el.customDialog.showModal === "function") {
      el.customDialog.showModal();
      el.customAmount?.focus();
    }
  }

  function closeCustomDialog() {
    customChargeId = "";
    if (el.customDialog && typeof el.customDialog.close === "function") el.customDialog.close();
  }

  /** @param {number} hour @param {number} min */
  function clockLabel(hour, min) {
    const h12 = ((hour + 11) % 12) + 1;
    const ampm = hour < 12 ? "AM" : "PM";
    return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  }

  /** @param {string} ymd */
  function weekdayFromYmd(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return null;
    const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
    return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)).getUTCDay();
  }

  /** @param {string} [selected] */
  function fillMoveTimes(selected) {
    if (!el.moveTime) return;
    const ymd = el.moveDate?.value || "";
    const friday = weekdayFromYmd(ymd) === 5;
    const keep = selected || el.moveTime.value || "";
    const opts = [];
    for (let minutes = 8 * 60; minutes <= 22 * 60; minutes += 30) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const val = `${String(h).padStart(2, "0")}:${m === 0 ? "00" : "30"}`;
      const blocked = friday && minutes > 16 * 60;
      opts.push(
        `<option value="${val}"${blocked ? " disabled" : ""}${!blocked && val === keep ? " selected" : ""}>${shared.esc(clockLabel(h, m))}${blocked ? " — Friday cutoff" : ""}</option>`,
      );
    }
    el.moveTime.innerHTML = opts.join("");
    if (friday && keep) {
      const [hh, mm] = keep.split(":").map((n) => parseInt(n, 10));
      if (hh * 60 + mm > 16 * 60) el.moveTime.value = "16:00";
    }
  }

  /** @param {string} id */
  function openMoveDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    moveId = id;
    if (el.moveWho) {
      el.moveWho.textContent = `Move ${name} — currently ${whenLabel(String(row?.eventDate || ""), String(row?.eventTime || ""))}.`;
    }
    if (el.moveDate) {
      el.moveDate.value = String(row?.eventDate || "");
      el.moveDate.min = new Date().toISOString().slice(0, 10);
    }
    fillMoveTimes(String(row?.eventTime || ""));
    shared.showError(el.moveErr, "");
    if (el.moveDialog && typeof el.moveDialog.showModal === "function") {
      el.moveDialog.showModal();
      el.moveDate?.focus();
    }
  }

  function closeMoveDialog() {
    moveId = "";
    if (el.moveDialog && typeof el.moveDialog.close === "function") el.moveDialog.close();
  }

  /** @param {SubmitEvent} ev */
  async function submitMove(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = moveId;
    const eventDate = el.moveDate?.value || "";
    const eventTime = el.moveTime?.value || "";
    if (!id) return;
    if (weekdayFromYmd(eventDate) === 6) {
      shared.showError(el.moveErr, "We’re closed on Saturdays. Pick Sunday through Friday.");
      return;
    }
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    if (!window.confirm(`Move ${name} to ${whenLabel(eventDate, eventTime)}? This emails the client.`)) {
      return;
    }
    busy = true;
    setStatus("Moving date…");
    try {
      await shared.adminFetch(token(), "/api/admin/events/reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, eventDate, eventTime }),
      });
      closeMoveDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Moved ${name} to ${whenLabel(eventDate, eventTime)}.`);
    } catch (e) {
      shared.showError(el.moveErr, e instanceof Error ? e.message : "Move failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id */
  function openCancelDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    cancelId = id;
    if (el.cancelWho) {
      const paidNote = row?.remainingPaid
        ? " Remaining balance was already charged — refund in Stripe if needed."
        : " Refund the $200 deposit in Stripe if it applies.";
      el.cancelWho.textContent = `Cancel ${name} — ${whenLabel(String(row?.eventDate || ""), String(row?.eventTime || ""))}.${paidNote}`;
    }
    if (el.cancelNote) el.cancelNote.value = "";
    shared.showError(el.cancelErr, "");
    if (el.cancelDialog && typeof el.cancelDialog.showModal === "function") {
      el.cancelDialog.showModal();
      el.cancelNote?.focus();
    }
  }

  function closeCancelDialog() {
    cancelId = "";
    if (el.cancelDialog && typeof el.cancelDialog.close === "function") el.cancelDialog.close();
  }

  /** @param {SubmitEvent} ev */
  async function submitCancel(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = cancelId;
    const note = (el.cancelNote?.value || "").trim();
    if (!id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    if (!window.confirm(`Cancel the event for ${name}? This emails the client. Refund the deposit in Stripe if it applies.`)) {
      return;
    }
    busy = true;
    setStatus("Canceling…");
    try {
      await shared.adminFetch(token(), "/api/admin/events/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, note }),
      });
      closeCancelDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Canceled ${name}. Refund the $200 deposit in Stripe if it applies.`);
    } catch (e) {
      shared.showError(el.cancelErr, e instanceof Error ? e.message : "Cancel failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {SubmitEvent} ev */
  async function submitCustomCharge(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = customChargeId;
    const amountUsd = el.customAmount?.value || "";
    const description = (el.customDesc?.value || "").trim();
    if (!id) return;
    if (!description || description.length < 2) {
      shared.showError(el.customErr, "Enter a short description.");
      return;
    }
    const amount = Number(String(amountUsd).replace(/[$,]/g, ""));
    if (!Number.isFinite(amount) || amount < 1) {
      shared.showError(el.customErr, "Enter an amount of at least $1.00.");
      return;
    }
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    if (!window.confirm(`Charge ${money(Math.round(amount * 100))} for “${description}” to ${name}'s saved card?`)) {
      return;
    }
    busy = true;
    setStatus(`Charging ${money(Math.round(amount * 100))}…`);
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/charge-custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, amountUsd: amount, description }),
      });
      closeCustomDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      const formatted =
        data.charged && typeof data.charged === "object"
          ? String(/** @type {Record<string, unknown>} */ (data.charged).formatted || money(Math.round(amount * 100)))
          : money(Math.round(amount * 100));
      setStatus(`Charged ${formatted} (${description}) for ${name}.`);
    } catch (e) {
      shared.showError(el.customErr, e instanceof Error ? e.message : "Charge failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  el.unlock?.addEventListener("click", () => void unlock());
  el.refresh?.addEventListener("click", () => {
    void loadList()
      .then(() => {
        shared.showError(el.mainErr, "");
        setStatus("Refreshed.");
      })
      .catch((e) => shared.showError(el.mainErr, e instanceof Error ? e.message : "Refresh failed"));
  });
  root.querySelectorAll("[data-events-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setFilter(String(btn.getAttribute("data-events-filter") || "upcoming")));
  });
  el.customForm?.addEventListener("submit", (ev) => void submitCustomCharge(ev));
  el.customCancel?.addEventListener("click", () => closeCustomDialog());
  el.customDialog?.addEventListener("close", () => {
    customChargeId = "";
    shared.showError(el.customErr, "");
  });
  el.moveDate?.addEventListener("change", () => fillMoveTimes());
  el.moveForm?.addEventListener("submit", (ev) => void submitMove(ev));
  el.moveCancel?.addEventListener("click", () => closeMoveDialog());
  el.moveDialog?.addEventListener("close", () => {
    moveId = "";
    shared.showError(el.moveErr, "");
  });
  el.cancelForm?.addEventListener("submit", (ev) => void submitCancel(ev));
  el.cancelClose?.addEventListener("click", () => closeCancelDialog());
  el.cancelDialog?.addEventListener("close", () => {
    cancelId = "";
    shared.showError(el.cancelErr, "");
  });

  const saved = shared.getToken();
  if (saved && el.tokenInput) {
    el.tokenInput.value = saved;
    void unlock();
  }
})();
