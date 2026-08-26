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
    tableWrap: root.querySelector("[data-events-table-wrap]"),
    cal: root.querySelector("[data-events-cal]"),
    calGrid: root.querySelector("[data-events-cal-grid]"),
    calTitle: root.querySelector("[data-events-cal-title]"),
    calDay: root.querySelector("[data-events-cal-day]"),
    calPrev: root.querySelector("[data-events-cal-prev]"),
    calNext: root.querySelector("[data-events-cal-next]"),
    calToday: root.querySelector("[data-events-cal-today]"),
    formsTbody: root.querySelector("[data-events-forms-tbody]"),
    formsSummary: root.querySelector("[data-events-forms-summary]"),
    formsErr: root.querySelector("[data-events-forms-error]"),
    offerDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-offer-dialog]")),
    offerForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-offer-form]")),
    offerWho: root.querySelector("[data-events-offer-who]"),
    offerFirst: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-first]")),
    offerLast: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-last]")),
    offerEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-email]")),
    offerPhone: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-phone]")),
    offerDate: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-date]")),
    offerTime: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-time]")),
    offerPackage: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-package]")),
    offerDeposit: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-deposit]")),
    offerGuests: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-guests]")),
    offerRoom: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-room]")),
    offerTimeHint: root.querySelector("[data-events-offer-time-hint]"),
    offerBeforeMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-before-min]")),
    offerSessionMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-session-min]")),
    offerAfterMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-after-min]")),
    offerSessionLabel: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-offer-session-label]")),
    offerSchedPreview: root.querySelector("[data-events-offer-sched-preview]"),
    offerSchedReset: root.querySelector("[data-events-offer-sched-reset]"),
    offerCleaning: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-cleaning]")),
    offerCleaningWrap: root.querySelector("[data-events-offer-cleaning-wrap]"),
    offerCleaningUsd: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-cleaning-usd]")),
    offerLockWhen: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-lock-when]")),
    offerLockParty: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-lock-party]")),
    offerEditName: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-edit-name]")),
    offerEditEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-edit-email]")),
    offerEditPhone: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-edit-phone]")),
    offerSendEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-offer-send-email]")),
    offerErr: root.querySelector("[data-events-offer-error]"),
    offerSuccess: root.querySelector("[data-events-offer-success]"),
    offerLink: root.querySelector("[data-events-offer-link]"),
    offerSendBtns: root.querySelectorAll("[data-events-offer-kind]"),
    offerCopy: root.querySelector("[data-events-offer-copy]"),
    offerClose: root.querySelector("[data-events-offer-close]"),
    addOpen: root.querySelector("[data-events-add]"),
    addDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-add-dialog]")),
    addForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-add-form]")),
    addFirst: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-first]")),
    addLast: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-last]")),
    addEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-email]")),
    addPhone: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-phone]")),
    addDate: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-date]")),
    addTime: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-time]")),
    addGuests: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-guests]")),
    addRoom: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-room]")),
    addPackage: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-package]")),
    addDeposit: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-deposit]")),
    addDepositPaid: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-deposit-paid]")),
    addStyling: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-styling]")),
    addCleaning: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-cleaning]")),
    addCleaningWrap: root.querySelector("[data-events-add-cleaning-wrap]"),
    addCleaningUsd: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-cleaning-usd]")),
    addPriceSumBody: root.querySelector("[data-events-add-price-sum-body]"),
    addBeforeMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-before-min]")),
    addSessionMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-session-min]")),
    addAfterMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-after-min]")),
    addSessionLabel: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-add-session-label]")),
    addSchedPreview: root.querySelector("[data-events-add-sched-preview]"),
    addSchedReset: root.querySelector("[data-events-add-sched-reset]"),
    addNeedsConfirm: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-needs-confirm]")),
    addRemainingPaid: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-remaining-paid]")),
    addSendEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-send-email]")),
    addLockWhen: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-lock-when]")),
    addLockParty: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-lock-party]")),
    addSendBook: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-send-book]")),
    addNotes: /** @type {HTMLTextAreaElement|null} */ (root.querySelector("[data-events-add-notes]")),
    addErr: root.querySelector("[data-events-add-error]"),
    addShare: root.querySelector("[data-events-add-share]"),
    addSuccess: root.querySelector("[data-events-add-success]"),
    addLink: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-add-link]")),
    addBook: root.querySelector("[data-events-add-book]"),
    addCopy: root.querySelector("[data-events-add-copy]"),
    addSubmit: root.querySelector("[data-events-add-submit]"),
    addClose: root.querySelector("[data-events-add-close]"),
    editDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-edit-dialog]")),
    editForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-edit-form]")),
    editWho: root.querySelector("[data-events-edit-who]"),
    editFirst: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-first]")),
    editLast: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-last]")),
    editEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-email]")),
    editPhone: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-phone]")),
    editDate: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-date]")),
    editTime: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-time]")),
    editGuests: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-guests]")),
    editRoom: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-room]")),
    editPackage: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-package]")),
    editDeposit: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-deposit]")),
    editDepositPaid: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-deposit-paid]")),
    editStyling: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-styling]")),
    editCleaning: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-cleaning]")),
    editCleaningWrap: root.querySelector("[data-events-edit-cleaning-wrap]"),
    editCleaningUsd: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-cleaning-usd]")),
    editPriceSumBody: root.querySelector("[data-events-edit-price-sum-body]"),
    editBeforeMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-before-min]")),
    editSessionMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-session-min]")),
    editAfterMin: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-after-min]")),
    editSessionLabel: /** @type {HTMLSelectElement|null} */ (root.querySelector("[data-events-edit-session-label]")),
    editSchedPreview: root.querySelector("[data-events-edit-sched-preview]"),
    editSchedReset: root.querySelector("[data-events-edit-sched-reset]"),
    editRemainingPaid: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-remaining-paid]")),
    editNotes: /** @type {HTMLTextAreaElement|null} */ (root.querySelector("[data-events-edit-notes]")),
    editPricingHint: root.querySelector("[data-events-edit-pricing-hint]"),
    editShare: root.querySelector("[data-events-edit-share]"),
    editShareHint: root.querySelector("[data-events-edit-share-hint]"),
    editSuccess: root.querySelector("[data-events-edit-success]"),
    editLink: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-edit-link]")),
    editCopy: root.querySelector("[data-events-edit-copy]"),
    editBook: root.querySelector("[data-events-edit-book]"),
    editErr: root.querySelector("[data-events-edit-error]"),
    editClose: root.querySelector("[data-events-edit-close]"),
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
    cancelSendEmail: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-cancel-send-email]")),
    cancelHint: root.querySelector("[data-events-cancel-hint]"),
    cancelErr: root.querySelector("[data-events-cancel-error]"),
    cancelClose: root.querySelector("[data-events-cancel-close]"),
    deleteDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-delete-dialog]")),
    deleteForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-delete-form]")),
    deleteWho: root.querySelector("[data-events-delete-who]"),
    deleteHint: root.querySelector("[data-events-delete-hint]"),
    deleteConfirm: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-events-delete-confirm]")),
    deleteErr: root.querySelector("[data-events-delete-error]"),
    deleteClose: root.querySelector("[data-events-delete-close]"),
    archiveDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-archive-dialog]")),
    archiveForm: /** @type {HTMLFormElement|null} */ (root.querySelector("[data-events-archive-form]")),
    archiveWho: root.querySelector("[data-events-archive-who]"),
    archiveErr: root.querySelector("[data-events-archive-error]"),
    archiveClose: root.querySelector("[data-events-archive-close]"),
    notesDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-notes-dialog]")),
    notesWho: root.querySelector("[data-events-notes-who]"),
    notesBody: root.querySelector("[data-events-notes-body]"),
    notesClose: root.querySelector("[data-events-notes-close]"),
    logDialog: /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-events-log-dialog]")),
    logWho: root.querySelector("[data-events-log-who]"),
    logMeta: root.querySelector("[data-events-log-meta]"),
    logBody: root.querySelector("[data-events-log-body]"),
    logErr: root.querySelector("[data-events-log-error]"),
    logClose: root.querySelector("[data-events-log-close]"),
  };

  /** @type {Record<string, unknown>[]} */
  let rows = [];
  /** @type {Record<string, unknown>[]} */
  let formRows = [];
  let filter = "upcoming";
  let archiveScope = "active";
  let viewMode = "table";
  let tableSort = "event";
  const nowCal = new Date();
  let calYear = nowCal.getFullYear();
  let calMonth = nowCal.getMonth();
  let calSelected = "";
  /** @type {Map<number, Map<string, string[]>>} */
  const israelHolidayYears = new Map();
  /** @type {Set<number>} */
  const israelHolidayLoading = new Set();
  let busy = false;
  const CHARGE_REMAINING_LABEL = "Charge remaining";

  /** @param {HTMLButtonElement|null|undefined} btn @param {boolean} loading @param {string} [label] */
  function setChargeRemainingButtonLoading(btn, loading, label = "Charging…") {
    if (!btn) return;
    if (loading) {
      if (!btn.dataset.eventsPrevLabel) {
        btn.dataset.eventsPrevLabel = btn.textContent?.trim() || CHARGE_REMAINING_LABEL;
      }
      btn.disabled = true;
      btn.classList.add("admin-events__btn--loading");
      btn.setAttribute("aria-busy", "true");
      btn.textContent = label;
      return;
    }
    btn.disabled = false;
    btn.classList.remove("admin-events__btn--loading");
    btn.removeAttribute("aria-busy");
    btn.textContent = btn.dataset.eventsPrevLabel || CHARGE_REMAINING_LABEL;
    delete btn.dataset.eventsPrevLabel;
  }

  let customChargeId = "";
  let moveId = "";
  let cancelId = "";
  let deleteId = "";
  let archiveId = "";
  let editId = "";
  let offerInquiryId = "";
  let lastOfferUrl = "";
  let lastAddOfferUrl = "";
  let lastAddReservationId = "";
  let lastEditOfferUrl = "";

  function token() {
    return shared.getToken();
  }

  /** @param {number} cents */
  const STYLING_REFORMER_CENTS = 15000;
  const STYLING_MAT_CENTS = 20000;

  function money(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
  }

  /** @param {unknown} value @param {number} fallbackCents */
  function usdInputToCents(value, fallbackCents) {
    const n = Number(String(value ?? "").trim());
    if (!Number.isFinite(n) || n < 0) return fallbackCents;
    return Math.round(n * 100);
  }

  /** @param {unknown} roomValue @param {unknown} guestsValue */
  function previewRoom(roomValue, guestsValue) {
    const want = String(roomValue || "auto").trim().toLowerCase();
    if (want === "kangoo" || want === "reformer" || want === "mat") return want;
    const guests = Number(guestsValue);
    if (Number.isFinite(guests) && guests > 9) return "mat";
    return "reformer";
  }

  /** @param {string} room @param {boolean} styling */
  function stylingCentsForPreview(room, styling) {
    if (!styling) return 0;
    if (room === "reformer") return STYLING_REFORMER_CENTS;
    if (room === "mat") return STYLING_MAT_CENTS;
    return 0;
  }

  /** @param {string} room */
  function stylingSumLabel(room) {
    if (room === "reformer") return "Room styling (Reformer)";
    if (room === "mat") return "Room styling (Mat)";
    if (room === "kangoo") return "Room styling (Kangoo)";
    return "Room styling";
  }

  /**
   * @param {Element | null} body
   * @param {{
   *   packageCents: number,
   *   stylingOn: boolean,
   *   stylingCents: number,
   *   stylingLabel: string,
   *   cleaningOn: boolean,
   *   cleaningCents: number,
   *   depositCents: number,
   *   depositPaid: boolean,
   * }} p
   */
  function renderPriceSum(body, p) {
    if (!body) return;
    const total = p.packageCents + p.stylingCents + p.cleaningCents;
    const remaining = Math.max(0, total - p.depositCents);
    /** @type {{ label: string, amount: string, kind?: string }[]} */
    const lines = [{ label: "Event package", amount: money(p.packageCents) }];
    if (p.stylingOn) lines.push({ label: p.stylingLabel, amount: money(p.stylingCents) });
    if (p.cleaningOn) lines.push({ label: "Cleaning fee", amount: money(p.cleaningCents) });
    lines.push({ label: "Total", amount: money(total), kind: "total" });
    lines.push({
      label: p.depositPaid ? "Deposit (paid)" : "Deposit",
      amount: p.depositCents > 0 ? `−${money(p.depositCents)}` : money(0),
      kind: "deposit",
    });
    lines.push({
      label: "Remaining",
      amount: money(remaining),
      kind: "remain",
    });
    body.innerHTML = lines
      .map((line) => {
        const cls = line.kind ? ` class="admin-events__price-sum-${line.kind}"` : "";
        return `<tr${cls}><th scope="row">${shared.esc(line.label)}</th><td>${shared.esc(line.amount)}</td></tr>`;
      })
      .join("");
  }

  function refreshAddPriceSum() {
    const room = previewRoom(el.addRoom?.value, el.addGuests?.value);
    const stylingOn = el.addStyling?.checked === true;
    const cleaningOn = el.addCleaning?.checked === true;
    renderPriceSum(el.addPriceSumBody, {
      packageCents: usdInputToCents(el.addPackage?.value, 55000),
      stylingOn,
      stylingCents: stylingCentsForPreview(room, stylingOn),
      stylingLabel: stylingSumLabel(room),
      cleaningOn,
      cleaningCents: cleaningOn ? usdInputToCents(el.addCleaningUsd?.value, 0) : 0,
      depositCents: usdInputToCents(el.addDeposit?.value, 0),
      depositPaid: el.addDepositPaid?.checked === true,
    });
  }

  function refreshEditPriceSum() {
    const room = previewRoom(el.editRoom?.value, el.editGuests?.value);
    const stylingOn = el.editStyling?.checked === true;
    const cleaningOn = el.editCleaning?.checked === true;
    renderPriceSum(el.editPriceSumBody, {
      packageCents: usdInputToCents(el.editPackage?.value, 55000),
      stylingOn,
      stylingCents: stylingCentsForPreview(room, stylingOn),
      stylingLabel: stylingSumLabel(room),
      cleaningOn,
      cleaningCents: cleaningOn ? usdInputToCents(el.editCleaningUsd?.value, 0) : 0,
      depositCents: usdInputToCents(el.editDeposit?.value, 0),
      depositPaid: el.editDepositPaid?.checked === true,
    });
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

  /** @param {string} ymd */
  function dateOnlyLabel(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return ymd || "—";
    const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, mo - 1, d, 16, 0, 0)));
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

  /** @param {Record<string, unknown>} r */
  function notesPreviewHtml(r) {
    const notes = String(r.staffNotes || "").trim();
    if (!notes) return "";
    return `<div class="admin-events__sub"><button type="button" class="btn btn--ghost btn--small" data-events-notes="${shared.esc(String(r.id || ""))}">Notes</button></div>`;
  }

  function visibleRows() {
    let list = rows;
    if (archiveScope === "active") list = list.filter((r) => r.archived !== true);
    else if (archiveScope === "archived") list = list.filter((r) => r.archived === true);
    if (filter === "all") return list;
    return list.filter((r) => String(r.whenBucket) === filter);
  }

  /** @param {Record<string, unknown>[]} list */
  function sortRowsForTable(list) {
    const copy = [...list];
    if (tableSort === "created") {
      return copy.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    }
    return copy.sort((a, b) => {
      const whenA = `${a.eventDate}T${a.eventTime || "00:00"}`;
      const whenB = `${b.eventDate}T${b.eventTime || "00:00"}`;
      if (filter === "all" && a.whenBucket !== b.whenBucket) {
        return a.whenBucket === "upcoming" ? -1 : 1;
      }
      if (filter === "past" || (filter === "all" && a.whenBucket === "past")) {
        return whenB.localeCompare(whenA);
      }
      return whenA.localeCompare(whenB);
    });
  }

  function renderTable() {
    if (!el.tbody) return;
    const list = sortRowsForTable(visibleRows());
    if (!list.length) {
      const scopeLabel =
        archiveScope === "archived" ? "archived" : archiveScope === "all" ? "" : "active";
      const empty =
        rows.length === 0
          ? "No reservations yet. They appear here after a $200 deposit is paid. Local memory is cleared if the server restarts."
          : scopeLabel
            ? `No ${scopeLabel} ${filter === "all" ? "" : filter + " "}reservations.`
            : `No ${filter === "all" ? "" : filter + " "}reservations.`;
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
        const cleaning = Number(r.cleaningCents || 0) > 0
          ? `<div class="admin-events__sub">Cleaning ${shared.esc(money(Number(r.cleaningCents)))}</div>`
          : "";
        const pastCls = r.whenBucket === "past" ? " admin-events__when--past" : "";
        const actions = reservationActionsHtml(r);
        const createdSub =
          tableSort === "created" && r.createdAt
            ? `<div class="admin-events__sub">Added ${shared.esc(submittedLabel(String(r.createdAt)))}</div>`
            : "";
        const paidBadge =
          '<div class="admin-events__sub"><span class="admin-events__pill admin-events__pill--ok">Paid</span></div>';
        const depositCell = r.depositPaid
          ? `${shared.esc(money(Number(r.depositCents) || 0))}${paidBadge}`
          : shared.esc(money(Number(r.depositCents) || 0));
        const remainingCell = r.remainingPaid
          ? `${shared.esc(money(Number(r.remainingCents) || 0))}${paidBadge}`
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
            ${createdSub}
          </td>
          <td>
            ${shared.esc(name)}
            <div class="admin-events__sub">${shared.esc(contact || "—")}</div>
            ${notesPreviewHtml(r)}
          </td>
          <td>${shared.esc(roomLabel(String(r.room || "")))}</td>
          <td>${shared.esc(styling)}${cleaning}</td>
          <td>${depositCell}</td>
          <td>${remainingCell}</td>
          <td>${extrasHtml(r)}</td>
          <td>${extraTime}</td>
          <td>
            <span class="admin-events__pill ${st.cls}">${shared.esc(st.label)}</span>
            ${r.manualEntry ? `<div class="admin-events__sub"><span class="admin-events__pill admin-events__pill--muted">Manual</span></div>` : ""}
          </td>
          <td><div class="admin-events__actions">${actions}</div></td>
        </tr>`;
      })
      .join("");

    bindReservationActions(el.tbody);
  }

  /** @param {Element | null} scope */
  function bindReservationActions(scope) {
    if (!scope) return;
    scope.querySelectorAll("[data-events-confirm]").forEach((btn) => {
      btn.addEventListener("click", () => void confirmRow(String(btn.getAttribute("data-events-confirm") || "")));
    });
    scope.querySelectorAll("[data-events-ot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = String(btn.getAttribute("data-events-ot") || "");
        const select = /** @type {HTMLSelectElement|null} */ (scope.querySelector(`[data-events-ot-min="${CSS.escape(id)}"]`));
        const minutes = Number(select?.value || 0);
        void chargeOvertime(id, minutes);
      });
    });
    scope.querySelectorAll("[data-events-other]").forEach((btn) => {
      btn.addEventListener("click", () => openCustomDialog(String(btn.getAttribute("data-events-other") || "")));
    });
    scope.querySelectorAll("[data-events-remaining]").forEach((btn) => {
      btn.addEventListener("click", () =>
        void chargeRemaining(
          String(btn.getAttribute("data-events-remaining") || ""),
          /** @type {HTMLButtonElement} */ (btn),
        ),
      );
    });
    scope.querySelectorAll("[data-events-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openEditDialog(String(btn.getAttribute("data-events-edit") || "")));
    });
    scope.querySelectorAll("[data-events-details]").forEach((btn) => {
      btn.addEventListener("click", () => void sendReservationDetails(String(btn.getAttribute("data-events-details") || "")));
    });
    scope.querySelectorAll("[data-events-booking]").forEach((btn) => {
      btn.addEventListener("click", () => void sendReservationBooking(String(btn.getAttribute("data-events-booking") || "")));
    });
    scope.querySelectorAll("[data-events-move]").forEach((btn) => {
      btn.addEventListener("click", () => openMoveDialog(String(btn.getAttribute("data-events-move") || "")));
    });
    scope.querySelectorAll("[data-events-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => openCancelDialog(String(btn.getAttribute("data-events-cancel") || "")));
    });
    scope.querySelectorAll("[data-events-delete]").forEach((btn) => {
      btn.addEventListener("click", () => openDeleteDialog(String(btn.getAttribute("data-events-delete") || "")));
    });
    scope.querySelectorAll("[data-events-archive]").forEach((btn) => {
      btn.addEventListener("click", () => openArchiveDialog(String(btn.getAttribute("data-events-archive") || "")));
    });
    scope.querySelectorAll("[data-events-restore]").forEach((btn) => {
      btn.addEventListener("click", () => void restoreRow(String(btn.getAttribute("data-events-restore") || "")));
    });
    scope.querySelectorAll("[data-events-notes]").forEach((btn) => {
      btn.addEventListener("click", () => openNotesDialog(String(btn.getAttribute("data-events-notes") || "")));
    });
    scope.querySelectorAll("[data-events-log]").forEach((btn) => {
      btn.addEventListener("click", () => void openLogDialog(String(btn.getAttribute("data-events-log") || "")));
    });
  }

  /** @param {string} id */
  function openNotesDialog(id) {
    if (!id) return;
    const row = rows.find((r) => String(r.id) === id);
    if (!row) return;
    const name = `${row.firstName || ""} ${row.lastName || ""}`.trim() || id;
    const notes = String(row.staffNotes || "").trim();
    if (el.notesWho) {
      el.notesWho.textContent = `${name} — ${whenLabel(String(row.eventDate || ""), String(row.eventTime || ""))}`;
    }
    if (el.notesBody) el.notesBody.textContent = notes;
    if (el.notesDialog && typeof el.notesDialog.showModal === "function") {
      el.notesDialog.showModal();
    }
  }

  function closeNotesDialog() {
    if (el.notesDialog && typeof el.notesDialog.close === "function") el.notesDialog.close();
  }

  /** @param {string} at */
  function activityWhenLabel(at) {
    const d = new Date(String(at || ""));
    if (Number.isNaN(d.getTime())) return String(at || "");
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  }

  /** @param {string} kind */
  function activityKindLabel(kind) {
    const map = {
      created: "Created",
      booking_link_sent: "Link sent",
      booking_link_opened: "Link opened",
      checkout_started: "Checkout",
      checkout_canceled: "Canceled checkout",
      deposit_paid: "Deposit paid",
      remaining_paid: "Balance paid",
      remaining_charged: "Balance charged",
      confirmed: "Confirmed",
      canceled: "Canceled",
      archived: "Archived",
      restored: "Restored",
      rescheduled: "Rescheduled",
      details_sent: "Details email",
      overtime_charged: "Extra time",
      custom_charged: "Other charge",
    };
    return map[String(kind || "")] || String(kind || "Event");
  }

  /** @param {string} id */
  async function openLogDialog(id) {
    if (!id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() || id : id;
    if (el.logWho) {
      el.logWho.textContent = row
        ? `${name} — ${whenLabel(String(row.eventDate || ""), String(row.eventTime || ""))}`
        : name;
    }
    if (el.logMeta) {
      const created = row?.createdAt ? activityWhenLabel(String(row.createdAt)) : "";
      el.logMeta.textContent = created ? `Event created ${created}` : "";
      el.logMeta.hidden = !created;
    }
    if (el.logBody) el.logBody.innerHTML = `<p class="admin-sms__hint">Loading activity…</p>`;
    if (el.logErr) {
      el.logErr.hidden = true;
      el.logErr.textContent = "";
    }
    if (el.logDialog && typeof el.logDialog.showModal === "function") el.logDialog.showModal();
    try {
      const data = await shared.adminFetch(token(), `/api/admin/events/activity?id=${encodeURIComponent(id)}`);
      if (!data?.ok) throw new Error(String(data?.message || data?.error || "Could not load activity"));
      const timeline = Array.isArray(data.timeline) ? data.timeline : [];
      if (!el.logBody) return;
      if (!timeline.length) {
        el.logBody.innerHTML = `<p class="admin-sms__hint">No activity recorded yet.</p>`;
        return;
      }
      el.logBody.innerHTML = timeline
        .map((item) => {
          const rowItem = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {};
          const label = String(rowItem.label || "");
          const kind = String(rowItem.kind || "");
          const when = activityWhenLabel(String(rowItem.at || ""));
          return `<article class="admin-events__activity-item">
            <p class="admin-events__activity-when">${shared.esc(when)}</p>
            <div>
              <p class="admin-events__activity-label">${shared.esc(label)}</p>
              <span class="admin-events__activity-kind">${shared.esc(activityKindLabel(kind))}</span>
            </div>
          </article>`;
        })
        .join("");
    } catch (err) {
      if (el.logBody) el.logBody.innerHTML = "";
      if (el.logErr) {
        el.logErr.hidden = false;
        el.logErr.textContent = String(/** @type {{ message?: string }} */ (err)?.message || err || "Could not load activity.");
      }
    }
  }

  function closeLogDialog() {
    if (el.logDialog && typeof el.logDialog.close === "function") el.logDialog.close();
  }

  /** @param {string} hhmm */
  function timeLabel(hhmm) {
    const [h, mi] = String(hhmm || "00:00")
      .split(":")
      .map((n) => parseInt(n, 10));
    return clockLabel(Number.isFinite(h) ? h : 0, Number.isFinite(mi) ? mi : 0);
  }

  /** @param {string} ymd */
  function padYmd(y, m, d) {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function todayYmd() {
    const n = new Date();
    return padYmd(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }

  function jumpCalToRelevantMonth() {
    const list = visibleRows().filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.eventDate || "")));
    if (!list.length) return;
    const prefix = padYmd(calYear, calMonth + 1, 1).slice(0, 7);
    if (list.some((r) => String(r.eventDate).startsWith(prefix))) return;
    const today = todayYmd();
    const sorted = [...list].sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
    const next = sorted.find((r) => String(r.eventDate) >= today) || sorted[sorted.length - 1];
    const [y, mo] = String(next.eventDate).split("-").map((n) => parseInt(n, 10));
    if (Number.isFinite(y) && Number.isFinite(mo)) {
      calYear = y;
      calMonth = mo - 1;
    }
  }

  /** @param {Record<string, unknown>} r */
  function reservationActionsHtml(r) {
    const id = String(r.id || "");
    const archived = r.archived === true;
    const logBtn = id
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-log="${shared.esc(id)}">Log</button>`
      : "";
    if (archived) {
      const restoreBtn = r.canRestore
        ? `<button type="button" class="btn btn--small" data-events-restore="${shared.esc(id)}">Restore</button>`
        : "";
      return restoreBtn || logBtn ? `${logBtn}${restoreBtn}` : "—";
    }
    const editBtn =
      r.canEdit !== false
        ? `<button type="button" class="btn btn--ghost btn--small" data-events-edit="${shared.esc(id)}">Edit</button>`
        : "";
    const confirmBtn = r.canConfirm
      ? `<button type="button" class="btn btn--small" data-events-confirm="${shared.esc(id)}">Confirm</button>`
      : "";
    const remainingBtn = r.canChargeRemaining
      ? `<button type="button" class="btn btn--small" data-events-remaining="${shared.esc(id)}">Charge remaining</button>`
      : "";
    const detailsBtn = r.canSendDetails
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-details="${shared.esc(id)}">Send details</button>`
      : "";
    const bookingBtn = r.canSendBooking
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-booking="${shared.esc(id)}">${r.bookingLinkSent ? "Resend booking" : "Send booking"}</button>`
      : "";
    const moveBtn = r.canReschedule
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-move="${shared.esc(id)}">Move date</button>`
      : "";
    const cancelBtn = r.canCancel
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-cancel="${shared.esc(id)}">Cancel</button>`
      : "";
    const archiveBtn = r.canArchive
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-archive="${shared.esc(id)}">Archive</button>`
      : "";
    const deleteBtn = r.canDelete
      ? `<button type="button" class="btn btn--ghost btn--small" data-events-delete="${shared.esc(id)}">Delete</button>`
      : "";
    const body =
      editBtn ||
      logBtn ||
      detailsBtn ||
      bookingBtn ||
      confirmBtn ||
      remainingBtn ||
      moveBtn ||
      cancelBtn ||
      archiveBtn ||
      deleteBtn
        ? `${logBtn}${editBtn}${detailsBtn}${bookingBtn}${confirmBtn}${remainingBtn}${moveBtn}${cancelBtn}${archiveBtn}${deleteBtn}`
        : logBtn || "—";
    return body;
  }

  /** @param {number} year */
  function holidaysForYear(year) {
    return israelHolidayYears.get(year) || new Map();
  }

  /** @param {string} ymd */
  function holidaysOn(ymd) {
    const year = parseInt(String(ymd || "").slice(0, 4), 10);
    if (!Number.isFinite(year)) return [];
    return holidaysForYear(year).get(ymd) || [];
  }

  /** @param {number} year */
  function loadIsraelHolidays(year) {
    if (israelHolidayYears.has(year) || israelHolidayLoading.has(year)) return;
    israelHolidayLoading.add(year);
    const url =
      "https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&c=off&geo=none&i=on&lg=h&year=" +
      encodeURIComponent(String(year));
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("holiday_fetch_failed"))))
      .then((data) => {
        /** @type {Map<string, string[]>} */
        const byDate = new Map();
        const items = data && Array.isArray(data.items) ? data.items : [];
        for (const raw of items) {
          const item = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
          if (!item || item.category !== "holiday") continue;
          const ymd = String(item.date || "").slice(0, 10);
          const name = String(item.hebrew || item.title || "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !name) continue;
          const list = byDate.get(ymd) || [];
          if (!list.includes(name)) list.push(name);
          byDate.set(ymd, list);
        }
        israelHolidayYears.set(year, byDate);
      })
      .catch(() => {
        israelHolidayYears.set(year, new Map());
      })
      .finally(() => {
        israelHolidayLoading.delete(year);
        if (viewMode === "month" && calYear === year) renderCalendar();
      });
  }

  function renderCalendar() {
    if (!el.calGrid || !el.calTitle) return;
    loadIsraelHolidays(calYear);
    const monthName = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(calYear, calMonth, 1));
    const byDate = new Map();
    for (const r of visibleRows()) {
      const d = String(r.eventDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }
    for (const list of byDate.values()) {
      list.sort((a, b) => String(a.eventTime || "").localeCompare(String(b.eventTime || "")));
    }
    const monthCount = [...byDate.entries()].reduce((n, [ymd, list]) => {
      return ymd.startsWith(padYmd(calYear, calMonth + 1, 1).slice(0, 7)) ? n + list.length : n;
    }, 0);
    el.calTitle.textContent = monthCount ? `${monthName} · ${monthCount} event${monthCount === 1 ? "" : "s"}` : monthName;
    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const today = todayYmd();
    const cells = [];
    for (let i = 0; i < firstDow; i += 1) cells.push({ outside: true });
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ ymd: padYmd(calYear, calMonth + 1, day), day });
    }
    while (cells.length % 7) cells.push({ outside: true });
    el.calGrid.innerHTML = cells
      .map((cell) => {
        if (cell.outside) return `<div class="admin-events__cal-cell admin-events__cal-cell--empty"></div>`;
        const ymd = String(cell.ymd || "");
        const events = byDate.get(ymd) || [];
        const holidays = holidaysOn(ymd);
        const dow = weekdayFromYmd(ymd);
        const cls = [
          "admin-events__cal-cell",
          ymd === today ? "admin-events__cal-cell--today" : "",
          ymd === calSelected ? "admin-events__cal-cell--selected" : "",
          dow === 6 ? "admin-events__cal-cell--closed" : "",
          events.length ? "admin-events__cal-cell--busy" : "",
          holidays.length ? "admin-events__cal-cell--holiday" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const holidayChips = holidays
          .slice(0, 2)
          .map(
            (name) =>
              `<span class="admin-events__cal-holiday" lang="he" dir="rtl" title="${shared.esc(name)}">${shared.esc(name)}</span>`,
          )
          .join("");
        const shown = events.slice(0, holidays.length ? 2 : 3);
        const extra = events.length - shown.length;
        const chips = shown
          .map((r) => {
            const st = statusMeta(String(r.status || ""));
            const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "Event";
            return `<span class="admin-events__cal-chip ${st.cls}" title="${shared.esc(`${timeLabel(String(r.eventTime || ""))} · ${name}`)}">${shared.esc(timeLabel(String(r.eventTime || "")))} ${shared.esc(String(r.firstName || name))}</span>`;
          })
          .join("");
        return `<button type="button" class="${cls}" data-events-cal-ymd="${shared.esc(ymd)}">
          <span class="admin-events__cal-num">${cell.day}</span>
          <span class="admin-events__cal-chips">${holidayChips}${chips}${extra > 0 ? `<span class="admin-events__cal-more">+${extra}</span>` : ""}</span>
        </button>`;
      })
      .join("");
    el.calGrid.querySelectorAll("[data-events-cal-ymd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        calSelected = String(btn.getAttribute("data-events-cal-ymd") || "");
        renderCalendar();
      });
    });
    renderCalDay(byDate.get(calSelected) || []);
  }

  /** @param {Record<string, unknown>[]} list */
  function renderCalDay(list) {
    if (!el.calDay) return;
    if (!calSelected) {
      el.calDay.hidden = true;
      el.calDay.innerHTML = "";
      return;
    }
    el.calDay.hidden = false;
    const holidays = holidaysOn(calSelected);
    const holidayLine = holidays.length
      ? `<p class="admin-events__cal-holiday-note" lang="he" dir="rtl">${holidays.map((name) => shared.esc(name)).join(" · ")}</p>`
      : "";
    if (!list.length) {
      el.calDay.innerHTML = `<h4 class="admin-events__cal-day-title">${shared.esc(dateOnlyLabel(calSelected))}</h4>${holidayLine}<p class="admin-sms__hint">No reservations this day.</p>`;
      return;
    }
    el.calDay.innerHTML = `<h4 class="admin-events__cal-day-title">${shared.esc(dateOnlyLabel(calSelected))}</h4>${holidayLine}
      ${list
        .map((r) => {
          const st = statusMeta(String(r.status || ""));
          const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "—";
          return `<div class="admin-events__cal-item">
            <div>
              <strong>${shared.esc(timeLabel(String(r.eventTime || "")))}</strong>
              · ${shared.esc(name)}
              · ${shared.esc(roomLabel(String(r.room || "")))}
              · ${shared.esc(String(r.guests || "—"))} guests
              <span class="admin-events__pill ${st.cls}">${shared.esc(st.label)}</span>
              ${notesPreviewHtml(r)}
            </div>
            <div class="admin-events__actions">${reservationActionsHtml(r)}</div>
          </div>`;
        })
        .join("")}`;
    bindReservationActions(el.calDay);
  }

  function renderViews() {
    const month = viewMode === "month";
    if (el.cal) el.cal.hidden = !month;
    if (el.tableWrap) el.tableWrap.hidden = month;
    const sortWrap = root.querySelector("[data-events-table-sort-wrap]");
    if (sortWrap) sortWrap.hidden = month;
    renderTable();
    if (month) renderCalendar();
  }

  function setView(next) {
    viewMode = next === "month" ? "month" : "table";
    root.querySelectorAll("[data-events-view]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-events-view") === viewMode);
    });
    const sortWrap = root.querySelector("[data-events-table-sort-wrap]");
    if (sortWrap) sortWrap.hidden = viewMode !== "table";
    if (viewMode === "month") jumpCalToRelevantMonth();
    renderViews();
  }

  function setTableSort(next) {
    tableSort = next === "created" ? "created" : "event";
    root.querySelectorAll("[data-events-sort]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-events-sort") === tableSort);
    });
    if (viewMode === "table") renderTable();
  }

  function setFilter(next) {
    filter = next;
    root.querySelectorAll("[data-events-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-events-filter") === next);
    });
    if (viewMode === "month") jumpCalToRelevantMonth();
    renderViews();
  }

  function setArchiveScope(next) {
    archiveScope = next === "archived" ? "archived" : next === "all" ? "all" : "active";
    root.querySelectorAll("[data-events-archive]").forEach((btn) => {
      if (btn.matches("[data-events-archive-form], [data-events-archive-dialog], [data-events-archive-who], [data-events-archive-error], [data-events-archive-close]")) {
        return;
      }
      btn.classList.toggle("is-active", btn.getAttribute("data-events-archive") === archiveScope);
    });
    if (viewMode === "month") jumpCalToRelevantMonth();
    renderViews();
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
        `<tr><td colspan="7">${shared.esc("No event forms yet. New /privateevents inquiries appear here after submit.")}</td></tr>`;
      return;
    }
    el.formsTbody.innerHTML = formRows
      .map((r) => {
        const id = String(r.id || "");
        const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "—";
        const contact = [r.email, r.phone].filter(Boolean).join(" · ") || "—";
        const preferred = r.eventDate
          ? whenLabel(String(r.eventDate || ""), String(r.eventTime || ""))
          : r.eventTime
            ? shared.esc(String(r.eventTime))
            : "—";
        const offer = r.offer && typeof r.offer === "object" ? /** @type {Record<string, unknown>} */ (r.offer) : null;
        let offerCell = "—";
        if (offer) {
          const st = String(offer.status || "");
          const hasDetails = Boolean(offer.sentDetailsAt);
          const hasBook = Boolean(offer.sentBookAt);
          const pill =
            st === "sent"
              ? "admin-events__pill--ok"
              : st === "used"
                ? "admin-events__pill--muted"
                : "admin-events__pill--needs";
          let label = "Link sent";
          if (st === "used") label = "Deposit paid";
          else if (st === "expired") label = "Expired";
          else if (hasDetails && hasBook) label = "Details + booking";
          else if (hasBook) label = "Booking sent";
          else if (hasDetails) label = "Details sent";
          const sched = offer.schedule && typeof offer.schedule === "object" ? offer.schedule : null;
          const scheduleLine = sched
            ? [
                Number(sched.beforeMinutes) > 0 ? `Before ${durationLabel(Number(sched.beforeMinutes))}` : "",
                `${String(sched.sessionLabel || "Workout")} ${durationLabel(Number(sched.sessionMinutes) || 60)}`,
                Number(sched.afterMinutes) > 0 ? `After ${durationLabel(Number(sched.afterMinutes))}` : "",
              ].filter(Boolean).join(" · ")
            : "";
          const cleaningLine = Number(offer.cleaningCents || 0) > 0 ? `Cleaning ${money(Number(offer.cleaningCents))}` : "";
          offerCell = `<span class="admin-events__pill ${pill}">${shared.esc(label)}</span>${scheduleLine ? `<div class="admin-events__sub">${shared.esc(scheduleLine)}</div>` : ""}${cleaningLine ? `<div class="admin-events__sub">${shared.esc(cleaningLine)}</div>` : ""}`;
        }
        const bookLabel = offer && offer.sentBookAt ? "Resend booking" : "Send booking link";
        return `<tr>
          <td>${shared.esc(submittedLabel(String(r.createdAt || "")))}</td>
          <td>${preferred}</td>
          <td>${shared.esc(name)}</td>
          <td>${shared.esc(contact)}</td>
          <td class="admin-events__msg">${shared.esc(String(r.message || "—"))}</td>
          <td>${offerCell}</td>
          <td><div class="admin-events__actions">
            <button type="button" class="btn btn--small" data-events-offer="${shared.esc(id)}">${shared.esc(bookLabel)}</button>
          </div></td>
        </tr>`;
      })
      .join("");
    el.formsTbody.querySelectorAll("[data-events-offer]").forEach((btn) => {
      btn.addEventListener("click", () => openOfferDialog(String(btn.getAttribute("data-events-offer") || "")));
    });
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

  /** @param {number} minutes */
  function durationLabel(minutes) {
    if (minutes === 0) return "None";
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
    return `${hours} hours`;
  }

  /** @param {HTMLSelectElement | null} select @param {{ includeNone?: boolean, selected?: unknown }} opts */
  function fillDurationSelect(select, opts) {
    if (!select) return;
    const includeNone = opts.includeNone === true;
    const keep = String(opts.selected == null || opts.selected === "" ? (includeNone ? "30" : "60") : opts.selected);
    const values = includeNone ? [0] : [];
    for (let m = 30; m <= 480; m += 30) values.push(m);
    select.innerHTML = values
      .map((m) => `<option value="${m}"${String(m) === keep ? " selected" : ""}>${shared.esc(durationLabel(m))}</option>`)
      .join("");
    if (![...select.options].some((o) => o.value === keep)) select.value = includeNone ? "30" : "60";
  }

  /**
   * @param {HTMLSelectElement | null} beforeEl
   * @param {HTMLSelectElement | null} sessionEl
   * @param {HTMLSelectElement | null} afterEl
   * @param {HTMLSelectElement | null} labelEl
   */
  function scheduleFromFields(beforeEl, sessionEl, afterEl, labelEl) {
    return {
      beforeMinutes: Number(beforeEl?.value || 30),
      sessionMinutes: Number(sessionEl?.value || 60),
      afterMinutes: Number(afterEl?.value || 30),
      sessionLabel: labelEl?.value || "Workout",
    };
  }

  function currentOfferSchedule() {
    return scheduleFromFields(el.offerBeforeMin, el.offerSessionMin, el.offerAfterMin, el.offerSessionLabel);
  }

  function currentAddSchedule() {
    return scheduleFromFields(el.addBeforeMin, el.addSessionMin, el.addAfterMin, el.addSessionLabel);
  }

  function currentEditSchedule() {
    return scheduleFromFields(el.editBeforeMin, el.editSessionMin, el.editAfterMin, el.editSessionLabel);
  }

  /**
   * @param {Element | null} previewEl
   * @param {string} start
   * @param {{ beforeMinutes: number, sessionMinutes: number, afterMinutes: number, sessionLabel: string }} sched
   */
  function writeSchedulePreview(previewEl, start, sched) {
    if (!previewEl) return;
    if (!start) {
      previewEl.textContent = "Pick a start time to preview the schedule.";
      return;
    }
    const parts = [];
    if (sched.beforeMinutes > 0) {
      parts.push(`Before ${clockFromHhmm(addMinutesHhmm(start, -sched.beforeMinutes))}–${clockFromHhmm(start)}`);
    }
    const sessionEnd = addMinutesHhmm(start, sched.sessionMinutes);
    parts.push(`${sched.sessionLabel} ${clockFromHhmm(start)}–${clockFromHhmm(sessionEnd)}`);
    if (sched.afterMinutes > 0) {
      parts.push(`After ${clockFromHhmm(sessionEnd)}–${clockFromHhmm(addMinutesHhmm(sessionEnd, sched.afterMinutes))}`);
    }
    previewEl.textContent = parts.join(" · ");
  }

  function refreshOfferSchedulePreview() {
    const sched = currentOfferSchedule();
    if (el.offerTimeHint) {
      el.offerTimeHint.textContent =
        sched.beforeMinutes > 0
          ? `Arrival is ${durationLabel(sched.beforeMinutes).toLowerCase()} before this start. Friday starts by 4:00 PM. Saturday is closed.`
          : "The session begins at this start time. Friday starts by 4:00 PM. Saturday is closed.";
    }
    writeSchedulePreview(el.offerSchedPreview, el.offerTime?.value || "", sched);
  }

  function refreshAddSchedulePreview() {
    writeSchedulePreview(el.addSchedPreview, el.addTime?.value || "", currentAddSchedule());
  }

  function refreshEditSchedulePreview() {
    writeSchedulePreview(el.editSchedPreview, el.editTime?.value || "", currentEditSchedule());
  }

  /** @param {string} hhmm @param {number} delta */
  function addMinutesHhmm(hhmm, delta) {
    const [h, mi] = String(hhmm || "00:00")
      .split(":")
      .map((n) => parseInt(n, 10));
    const total = ((((h || 0) * 60 + (mi || 0) + delta) % (24 * 60)) + 24 * 60) % (24 * 60);
    const nh = Math.floor(total / 60);
    const nm = total % 60;
    return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
  }

  /** @param {string} hhmm */
  function clockFromHhmm(hhmm) {
    const [h, mi] = String(hhmm || "00:00")
      .split(":")
      .map((n) => parseInt(n, 10));
    return clockLabel(Number.isFinite(h) ? h : 0, Number.isFinite(mi) ? mi : 0);
  }

  /** @param {HTMLElement | null} wrap @param {HTMLInputElement | null} input @param {boolean} on */
  function setCleaningVisible(wrap, input, on) {
    if (wrap) wrap.hidden = !on;
    if (input) input.disabled = !on;
  }

  function setOfferCleaningVisible(on) {
    setCleaningVisible(el.offerCleaningWrap, el.offerCleaningUsd, on);
  }

  /**
   * @param {HTMLSelectElement | null} beforeEl
   * @param {HTMLSelectElement | null} sessionEl
   * @param {HTMLSelectElement | null} afterEl
   * @param {HTMLSelectElement | null} labelEl
   * @param {unknown} prev
   */
  function applyScheduleFields(beforeEl, sessionEl, afterEl, labelEl, prev) {
    const sched = prev && typeof prev === "object" ? /** @type {Record<string, unknown>} */ (prev) : {};
    fillDurationSelect(beforeEl, { includeNone: true, selected: sched.beforeMinutes == null ? 30 : sched.beforeMinutes });
    fillDurationSelect(sessionEl, { includeNone: false, selected: sched.sessionMinutes == null ? 60 : sched.sessionMinutes });
    fillDurationSelect(afterEl, { includeNone: true, selected: sched.afterMinutes == null ? 30 : sched.afterMinutes });
    if (labelEl) {
      const label = String(sched.sessionLabel || "Workout");
      if (![...labelEl.options].some((o) => o.value === label)) {
        const opt = document.createElement("option");
        opt.value = label;
        opt.textContent = label;
        labelEl.appendChild(opt);
      }
      labelEl.value = label;
    }
  }

  function applyOfferSchedule(prev) {
    applyScheduleFields(el.offerBeforeMin, el.offerSessionMin, el.offerAfterMin, el.offerSessionLabel, prev);
    refreshOfferSchedulePreview();
  }

  function applyAddSchedule(prev) {
    applyScheduleFields(el.addBeforeMin, el.addSessionMin, el.addAfterMin, el.addSessionLabel, prev);
    refreshAddSchedulePreview();
  }

  function applyEditSchedule(prev) {
    applyScheduleFields(el.editBeforeMin, el.editSessionMin, el.editAfterMin, el.editSessionLabel, prev);
    refreshEditSchedulePreview();
  }

  /** @param {HTMLSelectElement | null} select @param {string} [selected] @param {string} [ymd] */
  function fillTimeSelect(select, selected, ymd) {
    if (!select) return;
    const friday = weekdayFromYmd(ymd || "") === 5;
    const keep = selected || select.value || "";
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
    select.innerHTML = opts.join("");
    if (friday && keep) {
      const [hh, mm] = keep.split(":").map((n) => parseInt(n, 10));
      if (hh * 60 + mm > 16 * 60) select.value = "16:00";
    }
  }

  /** @param {unknown} cents @param {string} fallback */
  function usdFromCents(cents, fallback) {
    const n = Number(cents);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    const usd = n / 100;
    return Number.isInteger(usd) ? String(usd) : String(Math.round(usd * 100) / 100);
  }

  /** @param {string} id */
  function openOfferDialog(id) {
    const row = formRows.find((r) => String(r.id) === id);
    if (!row) return;
    offerInquiryId = id;
    lastOfferUrl = "";
    const prev = row.offer && typeof row.offer === "object" ? /** @type {Record<string, unknown>} */ (row.offer) : null;
    const name = `${prev?.firstName || row.firstName || ""} ${prev?.lastName || row.lastName || ""}`.trim() || String(prev?.email || row.email || "this inquiry");
    if (el.offerWho) {
      el.offerWho.hidden = false;
      el.offerWho.textContent = prev
        ? `Last booking settings for ${name} are loaded. Change anything and send the deposit link.`
        : `Send ${name} a booking link to pay the deposit. Package details are already on /privateevents. Prices default to $550 / $200.`;
    }
    if (el.offerFirst) el.offerFirst.value = String(prev?.firstName || row.firstName || "");
    if (el.offerLast) el.offerLast.value = String(prev?.lastName || row.lastName || "");
    if (el.offerEmail) el.offerEmail.value = String(prev?.email || row.email || "");
    if (el.offerPhone) el.offerPhone.value = String(prev?.phone || row.phone || "");
    const eventDate = String(prev?.eventDate || row.eventDate || "");
    const eventTime = String(prev?.eventTime || row.eventTime || "");
    if (el.offerDate) {
      el.offerDate.value = eventDate;
      el.offerDate.min = new Date().toISOString().slice(0, 10);
    }
    fillTimeSelect(el.offerTime, eventTime, eventDate || el.offerDate?.value || "");
    if (el.offerPackage) el.offerPackage.value = usdFromCents(prev?.packageCents, "550");
    if (el.offerDeposit) el.offerDeposit.value = usdFromCents(prev?.depositCents, "200");
    const cleaningOn = Number(prev?.cleaningCents || 0) > 0;
    if (el.offerCleaning) el.offerCleaning.checked = cleaningOn;
    if (el.offerCleaningUsd) el.offerCleaningUsd.value = cleaningOn ? usdFromCents(prev?.cleaningCents, "") : "";
    setOfferCleaningVisible(cleaningOn);
    applyOfferSchedule(prev?.schedule);
    if (el.offerGuests) el.offerGuests.value = prev?.guests ? String(prev.guests) : "";
    if (el.offerRoom) el.offerRoom.value = String(prev?.room || "auto");
    if (el.offerLockWhen) el.offerLockWhen.checked = prev ? prev.lockDateTime !== false : true;
    if (el.offerLockParty) el.offerLockParty.checked = prev?.lockGuestsRoom === true;
    if (el.offerEditName) el.offerEditName.checked = prev ? prev.lockName !== true : true;
    if (el.offerEditEmail) el.offerEditEmail.checked = prev ? prev.lockEmail !== true : true;
    if (el.offerEditPhone) el.offerEditPhone.checked = prev ? prev.lockPhone !== true : true;
    if (el.offerSendEmail) el.offerSendEmail.checked = true;
    if (el.offerSuccess) {
      el.offerSuccess.hidden = true;
      el.offerSuccess.textContent = "";
    }
    if (el.offerLink) {
      el.offerLink.hidden = true;
      el.offerLink.textContent = "";
    }
    if (el.offerCopy) el.offerCopy.hidden = true;
    shared.showError(el.offerErr, "");
    if (el.offerDialog && typeof el.offerDialog.showModal === "function") {
      el.offerDialog.showModal();
      el.offerDate?.focus();
    }
  }

  function closeOfferDialog() {
    offerInquiryId = "";
    lastOfferUrl = "";
    if (el.offerDialog && typeof el.offerDialog.close === "function") el.offerDialog.close();
  }

  /** @param {string} kind */
  async function submitOffer(kind) {
    if (busy) return;
    const email = (el.offerEmail?.value || "").trim();
    const eventDate = el.offerDate?.value || "";
    const eventTime = el.offerTime?.value || "";
    if (!email) {
      shared.showError(el.offerErr, "Email is required.");
      return;
    }
    if (weekdayFromYmd(eventDate) === 6) {
      shared.showError(el.offerErr, "We’re closed on Saturdays. Pick Sunday through Friday.");
      return;
    }
    const guests = (el.offerGuests?.value || "").trim();
    if (el.offerLockParty?.checked && !guests) {
      shared.showError(el.offerErr, "Enter a guest count to lock guests and room.");
      return;
    }
    const sendingDetails = kind === "details";
    busy = true;
    setStatus(sendingDetails ? "Sending details…" : "Sending booking link…");
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inquiryId: offerInquiryId,
          kind: sendingDetails ? "details" : "book",
          firstName: el.offerFirst?.value || "",
          lastName: el.offerLast?.value || "",
          email,
          phone: el.offerPhone?.value || "",
          eventDate,
          eventTime,
          packageUsd: el.offerPackage?.value || "550",
          depositUsd: el.offerDeposit?.value || "200",
          addCleaning: el.offerCleaning?.checked === true,
          cleaningUsd: el.offerCleaning?.checked ? el.offerCleaningUsd?.value || "" : "",
          schedule: currentOfferSchedule(),
          guests,
          room: el.offerRoom?.value || "auto",
          lockDateTime: el.offerLockWhen?.checked !== false,
          lockGuestsRoom: el.offerLockParty?.checked === true,
          allowEditName: el.offerEditName?.checked !== false,
          allowEditEmail: el.offerEditEmail?.checked !== false,
          allowEditPhone: el.offerEditPhone?.checked !== false,
          sendEmail: el.offerSendEmail?.checked !== false,
        }),
      });
      lastOfferUrl = String(data.url || "");
      shared.showError(el.offerErr, "");
      if (el.offerLink && lastOfferUrl) {
        el.offerLink.hidden = false;
        el.offerLink.textContent = lastOfferUrl;
      }
      if (el.offerCopy) {
        el.offerCopy.hidden = !lastOfferUrl;
        el.offerCopy.textContent = "Copy link";
      }
      if (lastOfferUrl) {
        const copied = await copyTextToClipboard(lastOfferUrl);
        if (copied && el.offerCopy) el.offerCopy.textContent = "Copied";
      }
      await loadForms();
      const mailed = data.emailOk === true;
      const skipped = el.offerSendEmail?.checked === false;
      const successMsg = skipped
        ? sendingDetails
          ? "Details link ready — copy it for WhatsApp."
          : "Booking link ready — copy it for WhatsApp."
        : mailed
          ? sendingDetails
            ? `Details emailed to ${email}.`
            : `Booking link emailed to ${email}.`
          : lastOfferUrl
            ? "Link ready. Email did not send — copy it instead."
            : "Offer saved.";
      if (el.offerSuccess) {
        el.offerSuccess.hidden = false;
        el.offerSuccess.textContent = successMsg;
        el.offerSuccess.classList.toggle("admin-events__offer-success--warn", !skipped && !mailed);
      }
      if (el.offerWho) el.offerWho.hidden = true;
      setStatus(successMsg);
    } catch (e) {
      shared.showError(el.offerErr, e instanceof Error ? e.message : "Could not create the link");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} text @param {HTMLElement | null} [dialogHost] */
  async function copyTextToClipboard(text, dialogHost) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* fall through — dialogs often block clipboard without a focused node */
      }
    }
    const host = dialogHost || el.addDialog || el.offerDialog || document.body;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
    host.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  async function copyOfferLink() {
    const url = lastOfferUrl || String(el.offerLink?.textContent || "").trim();
    if (!url) {
      shared.showError(el.offerErr, "Send a booking link first, then copy.");
      return;
    }
    const ok = await copyTextToClipboard(url);
    if (ok) {
      shared.showError(el.offerErr, "");
      if (el.offerLink) {
        el.offerLink.hidden = false;
        el.offerLink.textContent = url;
      }
      if (el.offerCopy) el.offerCopy.textContent = "Copied";
      setStatus("Link copied.");
      window.setTimeout(() => {
        if (el.offerCopy) el.offerCopy.textContent = "Copy link";
      }, 2000);
      return;
    }
    shared.showError(el.offerErr, "Could not copy automatically. The link is selected below — use Ctrl+C / ⌘C.");
    if (el.offerLink) {
      el.offerLink.hidden = false;
      el.offerLink.textContent = url;
      const range = document.createRange();
      range.selectNodeContents(el.offerLink);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function openAddDialog() {
    if (el.addForm) el.addForm.reset();
    if (el.addPackage) el.addPackage.value = "550";
    if (el.addDeposit) el.addDeposit.value = "200";
    if (el.addDepositPaid) el.addDepositPaid.checked = false;
    if (el.addRoom) el.addRoom.value = "auto";
    if (el.addStyling) el.addStyling.checked = false;
    if (el.addNeedsConfirm) el.addNeedsConfirm.checked = false;
    if (el.addRemainingPaid) el.addRemainingPaid.checked = false;
    if (el.addSendEmail) el.addSendEmail.checked = false;
    if (el.addLockWhen) el.addLockWhen.checked = true;
    if (el.addLockParty) el.addLockParty.checked = true;
    if (el.addSendBook) el.addSendBook.checked = true;
    if (el.addNotes) el.addNotes.value = "";
    if (el.addCleaning) el.addCleaning.checked = false;
    if (el.addCleaningUsd) el.addCleaningUsd.value = "";
    setCleaningVisible(el.addCleaningWrap, el.addCleaningUsd, false);
    fillTimeSelect(el.addTime, "16:00", el.addDate?.value || "");
    applyAddSchedule(null);
    lastAddOfferUrl = "";
    lastAddReservationId = "";
    if (el.addSuccess) {
      el.addSuccess.hidden = true;
      el.addSuccess.textContent = "";
    }
    if (el.addLink) el.addLink.value = "";
    if (el.addCopy) el.addCopy.textContent = "Copy link";
    shared.showError(el.addErr, "");
    refreshAddPriceSum();
    if (el.addDialog && typeof el.addDialog.showModal === "function") {
      el.addDialog.showModal();
      el.addFirst?.focus();
    }
  }

  function closeAddDialog() {
    if (el.addDialog && typeof el.addDialog.close === "function") el.addDialog.close();
  }

  /** @param {HTMLInputElement | HTMLSelectElement | null} field @param {boolean} locked */
  function setFieldLocked(field, locked) {
    if (!field) return;
    field.disabled = locked;
  }

  /** @param {string} offerId */
  function offerUrlFromId(offerId) {
    const id = String(offerId || "").trim();
    if (!id) return "";
    return `${window.location.origin}/event-info?o=${encodeURIComponent(id)}&book=1`;
  }

  /** @param {Record<string, unknown> | undefined} row */
  function editBookingLinkBlockedMessage(row) {
    if (!row) return "Could not load this event.";
    if (row.remainingPaid === true) return "Remaining balance is already paid — no payment link needed.";
    if (row.status === "canceled") return "This event is canceled.";
    if (row.status === "expired") return "This event is expired.";
    if (row.canSendBooking === false) return "A card is already on file or this event cannot receive a payment link.";
    return "";
  }

  /** @param {Record<string, unknown> | undefined} row */
  function refreshEditShareUi(row) {
    const blocked = editBookingLinkBlockedMessage(row);
    const canLink = row?.canSendBooking === true;
    if (el.editShareHint) {
      el.editShareHint.textContent = blocked
        ? blocked
        : "Saves your edits, then creates a payment or card-save link — no email sent.";
    }
    if (el.editCopy) {
      el.editCopy.disabled = !canLink;
      el.editCopy.textContent = "Copy link";
    }
    if (el.editBook) el.editBook.disabled = !canLink;
  }

  /** @returns {{ ok: true } | { ok: false }} */
  function validateEditForm() {
    const firstName = (el.editFirst?.value || "").trim();
    const lastName = (el.editLast?.value || "").trim();
    const email = (el.editEmail?.value || "").trim();
    const eventDate = el.editDate?.value || "";
    const guests = (el.editGuests?.value || "").trim();
    if (!firstName || !lastName) {
      shared.showError(el.editErr, "First and last name are required.");
      return { ok: false };
    }
    if (!email) {
      shared.showError(el.editErr, "Email is required.");
      return { ok: false };
    }
    if (weekdayFromYmd(eventDate) === 6) {
      shared.showError(el.editErr, "We’re closed on Saturdays. Pick Sunday through Friday.");
      return { ok: false };
    }
    if (!guests) {
      shared.showError(el.editErr, "Enter a guest count.");
      return { ok: false };
    }
    return { ok: true };
  }

  /** @param {string} id @param {Record<string, unknown>} row */
  function buildEditUpdateBody(id, row) {
    return {
      id,
      firstName: (el.editFirst?.value || "").trim(),
      lastName: (el.editLast?.value || "").trim(),
      email: (el.editEmail?.value || "").trim(),
      phone: el.editPhone?.value || "",
      eventDate: el.editDate?.value || "",
      eventTime: el.editTime?.value || "",
      guests: el.editGuests?.value || "",
      room: el.editRoom?.value || row.room || "reformer",
      packageUsd: el.editPackage?.value || usdFromCents(row.packageCents, "550"),
      depositUsd: el.editDeposit?.value || usdFromCents(row.depositCents, "200"),
      depositPaid: el.editDepositPaid?.checked === true,
      styling: el.editStyling?.checked === true,
      remainingPaid: el.editRemainingPaid?.checked === true,
      staffNotes: el.editNotes?.value || "",
      addCleaning: el.editCleaning?.checked === true,
      cleaningUsd: el.editCleaning?.checked ? el.editCleaningUsd?.value || "" : "",
      schedule: currentEditSchedule(),
    };
  }

  /** @returns {Promise<boolean>} */
  async function saveEditReservation() {
    const id = editId;
    const row = rows.find((r) => String(r.id) === id);
    if (!id || !row) return false;
    if (!validateEditForm().ok) return false;
    await shared.adminFetch(token(), "/api/admin/events/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildEditUpdateBody(id, row)),
    });
    await loadList();
    shared.showError(el.editErr, "");
    return true;
  }

  /**
   * @param {{ sendEmail: boolean, autoCopy?: boolean }} opts
   * @returns {Promise<boolean>}
   */
  async function createEditBookingLink(opts) {
    if (busy) return false;
    let row = rows.find((r) => String(r.id) === editId);
    const blocked = editBookingLinkBlockedMessage(row);
    if (blocked) {
      shared.showError(el.editErr, blocked);
      return false;
    }
    busy = true;
    setStatus(opts.sendEmail ? "Sending booking link…" : "Creating booking link…");
    try {
      if (!(await saveEditReservation())) {
        setStatus("");
        return false;
      }
      row = rows.find((r) => String(r.id) === editId);
      if (!row || row.canSendBooking !== true) {
        shared.showError(el.editErr, editBookingLinkBlockedMessage(row));
        setStatus("");
        return false;
      }
      const data = await shared.adminFetch(token(), "/api/admin/events/send-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editId, sendEmail: opts.sendEmail }),
      });
      const url = String(data.url || "");
      lastEditOfferUrl = url;
      if (el.editLink) el.editLink.value = url;
      if (opts.autoCopy && url) {
        const copied = await copyTextToClipboard(url, el.editDialog);
        if (el.editCopy) el.editCopy.textContent = copied ? "Copied" : "Copy link";
      } else if (el.editCopy) {
        el.editCopy.textContent = "Copy link";
      }
      refreshEditShareUi(row);
      const name = `${el.editFirst?.value || ""} ${el.editLast?.value || ""}`.trim();
      const email = (el.editEmail?.value || "").trim();
      const mailed = data.emailOk === true;
      const successMsg = opts.sendEmail
        ? mailed
          ? `Booking link emailed to ${email || name}.`
          : url
            ? "Link ready. Email did not send — copy it instead."
            : "Offer saved."
        : url
          ? "Payment link ready — copied for WhatsApp. No email sent."
          : "Offer saved.";
      if (el.editSuccess) {
        el.editSuccess.hidden = false;
        el.editSuccess.textContent = successMsg;
        el.editSuccess.classList.toggle("admin-events__offer-success--warn", opts.sendEmail && !mailed);
      }
      setStatus(successMsg);
      return true;
    } catch (e) {
      shared.showError(el.editErr, e instanceof Error ? e.message : "Could not create the booking link");
      setStatus("");
      return false;
    } finally {
      busy = false;
    }
  }

  async function copyEditBookingLink() {
    if (busy) return;
    const created = await createEditBookingLink({ sendEmail: false, autoCopy: true });
    if (!created) return;
    window.setTimeout(() => {
      if (el.editCopy) el.editCopy.textContent = "Copy link";
    }, 2000);
  }

  async function sendEditBookingLink() {
    const row = rows.find((r) => String(r.id) === editId);
    const name = `${el.editFirst?.value || ""} ${el.editLast?.value || ""}`.trim() || editId;
    const email = (el.editEmail?.value || "").trim();
    const again = row?.bookingLinkSent === true;
    if (!window.confirm(`${again ? "Resend" : "Send"} the booking link to ${name}${email ? ` (${email})` : ""}?`)) {
      return;
    }
    await createEditBookingLink({ sendEmail: true, autoCopy: false });
  }

  /** @param {string} id */
  function openEditDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    if (!row || row.canEdit === false) return;
    const name = `${row.firstName || ""} ${row.lastName || ""}`.trim() || id;
    editId = id;
    if (el.editWho) {
      el.editWho.textContent = `Editing ${name}. Save does not email the client. Use Move date to notify a date change.`;
    }
    if (el.editFirst) el.editFirst.value = String(row.firstName || "");
    if (el.editLast) el.editLast.value = String(row.lastName || "");
    if (el.editEmail) el.editEmail.value = String(row.email || "");
    if (el.editPhone) el.editPhone.value = String(row.phone || "");
    if (el.editDate) el.editDate.value = String(row.eventDate || "");
    if (el.editGuests) el.editGuests.value = String(row.guests || "");
    if (el.editRoom) el.editRoom.value = String(row.room || "reformer");
    if (el.editPackage) el.editPackage.value = usdFromCents(row.packageCents, "550");
    if (el.editDeposit) el.editDeposit.value = usdFromCents(row.depositCents, "200");
    if (el.editStyling) el.editStyling.checked = row.styling === true;
    if (el.editRemainingPaid) el.editRemainingPaid.checked = row.remainingPaid === true;
    if (el.editDepositPaid) el.editDepositPaid.checked = row.depositPaid === true;
    if (el.editNotes) el.editNotes.value = String(row.staffNotes || "");
    const cleaningOn = Number(row.cleaningCents) > 0;
    if (el.editCleaning) el.editCleaning.checked = cleaningOn;
    if (el.editCleaningUsd) el.editCleaningUsd.value = cleaningOn ? usdFromCents(row.cleaningCents, "") : "";
    setCleaningVisible(el.editCleaningWrap, el.editCleaningUsd, cleaningOn);
    const lockPricing = row.canEditPricing === false;
    const lockDeposit = row.canEditDeposit === false;
    const lockPaid = row.canEditRemainingPaid === false;
    const lockDepositPaid = row.canEditDepositPaid === false;
    setFieldLocked(el.editPackage, lockPricing);
    setFieldLocked(el.editDeposit, lockDeposit);
    if (el.editStyling) el.editStyling.disabled = lockPricing;
    if (el.editRemainingPaid) el.editRemainingPaid.disabled = lockPaid;
    if (el.editDepositPaid) el.editDepositPaid.disabled = lockDepositPaid;
    if (el.editPricingHint) {
      el.editPricingHint.textContent = lockPricing
        ? "Package, deposit, styling, and cleaning stay locked after the remaining balance is marked paid."
        : lockDeposit
          ? "Deposit is the Stripe payment and cannot be changed. Package, styling, and cleaning still update remaining."
          : "Remaining = package + styling + cleaning − deposit.";
    }
    if (el.editCleaning) el.editCleaning.disabled = lockPricing;
    if (el.editCleaningUsd && lockPricing) el.editCleaningUsd.disabled = true;
    fillTimeSelect(el.editTime, String(row.eventTime || ""), String(row.eventDate || ""));
    applyEditSchedule(row.schedule);
    lastEditOfferUrl = row.canSendBooking === true && row.offerId ? offerUrlFromId(String(row.offerId)) : "";
    if (el.editLink) el.editLink.value = lastEditOfferUrl;
    if (el.editCopy) el.editCopy.textContent = "Copy link";
    if (el.editSuccess) {
      el.editSuccess.hidden = true;
      el.editSuccess.textContent = "";
    }
    refreshEditShareUi(row);
    shared.showError(el.editErr, "");
    refreshEditPriceSum();
    if (el.editDialog && typeof el.editDialog.showModal === "function") {
      el.editDialog.showModal();
      el.editFirst?.focus();
    }
  }

  function closeEditDialog() {
    editId = "";
    lastEditOfferUrl = "";
    if (el.editDialog && typeof el.editDialog.close === "function") el.editDialog.close();
  }

  /** @param {SubmitEvent} ev */
  async function submitEdit(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = editId;
    const row = rows.find((r) => String(r.id) === id);
    if (!id || !row) return;
    busy = true;
    setStatus("Saving event…");
    try {
      if (!(await saveEditReservation())) {
        setStatus("");
        return;
      }
      const firstName = (el.editFirst?.value || "").trim();
      const lastName = (el.editLast?.value || "").trim();
      closeEditDialog();
      shared.showError(el.mainErr, "");
      setStatus(`Updated ${firstName} ${lastName}. No email sent.`);
    } catch (e) {
      shared.showError(el.editErr, e instanceof Error ? e.message : "Could not save the event");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @returns {string} */
  function readAddOfferEmail() {
    return (el.addEmail?.value || "").trim();
  }

  /** @returns {{ ok: true, email: string, eventDate: string, eventTime: string, guests: string, firstName: string, lastName: string } | { ok: false }} */
  function validateAddBookingForm() {
    const firstName = (el.addFirst?.value || "").trim();
    const lastName = (el.addLast?.value || "").trim();
    const email = readAddOfferEmail();
    const eventDate = el.addDate?.value || "";
    const eventTime = el.addTime?.value || "";
    const guests = (el.addGuests?.value || "").trim();
    if (!firstName || !lastName) {
      shared.showError(el.addErr, "First and last name are required.");
      return { ok: false };
    }
    if (!email) {
      shared.showError(el.addErr, "Email is required.");
      return { ok: false };
    }
    if (!eventDate || !eventTime) {
      shared.showError(el.addErr, "Pick a date and start time.");
      return { ok: false };
    }
    if (!guests) {
      shared.showError(el.addErr, "Enter a guest count.");
      return { ok: false };
    }
    if (weekdayFromYmd(eventDate) === 6) {
      shared.showError(el.addErr, "We’re closed on Saturdays. Pick Sunday through Friday.");
      return { ok: false };
    }
    if (el.addLockParty?.checked && !guests) {
      shared.showError(el.addErr, "Enter a guest count to lock guests and room.");
      return { ok: false };
    }
    return { ok: true, email, eventDate, eventTime, guests, firstName, lastName };
  }

  /** @returns {Record<string, unknown>} */
  function buildAddManualPayload() {
    const valid = validateAddBookingForm();
    if (!valid.ok) return {};
    const depositPaid = el.addDepositPaid?.checked === true;
    return {
      awaitingDeposit: !depositPaid,
      firstName: valid.firstName,
      lastName: valid.lastName,
      email: valid.email,
      phone: el.addPhone?.value || "",
      eventDate: valid.eventDate,
      eventTime: valid.eventTime,
      guests: valid.guests,
      room: el.addRoom?.value || "auto",
      packageUsd: el.addPackage?.value || "550",
      depositUsd: el.addDeposit?.value || "200",
      depositPaid,
      styling: el.addStyling?.checked === true,
      needsConfirm: depositPaid ? el.addNeedsConfirm?.checked === true : false,
      remainingPaid: el.addRemainingPaid?.checked === true,
      sendEmail: false,
      staffNotes: el.addNotes?.value || "",
      addCleaning: el.addCleaning?.checked === true,
      cleaningUsd: el.addCleaning?.checked ? el.addCleaningUsd?.value || "" : "",
      schedule: currentAddSchedule(),
    };
  }

  /** @param {string} url */
  function showAddOfferLink(url) {
    lastAddOfferUrl = url;
    if (el.addLink) el.addLink.value = url;
  }

  /**
   * @param {{ sendEmail: boolean, autoCopy?: boolean }} opts
   * @returns {Promise<boolean>}
   */
  async function createAddBookingLink(opts) {
    if (busy) return false;
    const valid = validateAddBookingForm();
    if (!valid.ok) return false;
    busy = true;
    setStatus(opts.sendEmail ? "Sending booking link…" : "Creating booking link…");
    try {
      let reservationId = lastAddReservationId;
      if (!reservationId) {
        const manualPayload = buildAddManualPayload();
        if (!manualPayload.firstName) return false;
        const manual = await shared.adminFetch(token(), "/api/admin/events/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(manualPayload),
        });
        reservationId = String(manual.reservation?.id || "").trim();
        if (!reservationId) {
          throw new Error("Reservation was not created.");
        }
        lastAddReservationId = reservationId;
      }
      const data = await shared.adminFetch(token(), "/api/admin/events/send-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: reservationId,
          sendEmail: opts.sendEmail,
        }),
      });
      const url = String(data.url || "");
      showAddOfferLink(url);
      shared.showError(el.addErr, "");
      if (opts.autoCopy && url) {
        const copied = await copyTextToClipboard(url, el.addDialog);
        if (el.addCopy) el.addCopy.textContent = copied ? "Copied" : "Copy link";
      } else if (el.addCopy) {
        el.addCopy.textContent = "Copy link";
      }
      await loadList();
      const mailed = data.emailOk === true;
      const who = `${valid.firstName} ${valid.lastName}`.trim();
      const successMsg = opts.sendEmail
        ? mailed
          ? `${who} added to Reservations. Booking link emailed to ${valid.email}.`
          : url
            ? `${who} added to Reservations. Link ready — email did not send.`
            : `${who} added to Reservations.`
        : url
          ? `${who} added to Reservations. Payment link copied — no email sent.`
          : `${who} added to Reservations.`;
      if (el.addSuccess) {
        el.addSuccess.hidden = false;
        el.addSuccess.textContent = successMsg;
        el.addSuccess.classList.toggle("admin-events__offer-success--warn", opts.sendEmail && !mailed);
      }
      setStatus(successMsg);
      return true;
    } catch (e) {
      shared.showError(el.addErr, e instanceof Error ? e.message : "Could not create the booking link");
      setStatus("");
      return false;
    } finally {
      busy = false;
    }
  }

  async function submitAddBookingLink() {
    await createAddBookingLink({
      sendEmail: el.addSendBook?.checked !== false,
      autoCopy: el.addSendBook?.checked === false,
    });
  }

  async function copyAddBookingLink() {
    if (busy) return;
    let url = lastAddOfferUrl || String(el.addLink?.value || "").trim();
    if (!url) {
      const created = await createAddBookingLink({ sendEmail: false, autoCopy: true });
      if (!created) return;
      url = lastAddOfferUrl;
      if (!url) return;
      window.setTimeout(() => {
        if (el.addCopy) el.addCopy.textContent = "Copy link";
      }, 2000);
      return;
    }
    const ok = await copyTextToClipboard(url, el.addDialog);
    if (ok) {
      shared.showError(el.addErr, "");
      if (el.addLink) el.addLink.value = url;
      if (el.addCopy) el.addCopy.textContent = "Copied";
      setStatus("Link copied.");
      window.setTimeout(() => {
        if (el.addCopy) el.addCopy.textContent = "Copy link";
      }, 2000);
      return;
    }
    shared.showError(el.addErr, "Could not copy automatically. The link is selected — use Ctrl+C / ⌘C.");
    if (el.addLink) {
      el.addLink.value = url;
      el.addLink.focus();
      el.addLink.select();
    }
  }

  /** @param {SubmitEvent} ev */
  async function submitAdd(ev) {
    ev.preventDefault();
    if (busy) return;
    const firstName = (el.addFirst?.value || "").trim();
    const lastName = (el.addLast?.value || "").trim();
    const email = (el.addEmail?.value || "").trim();
    const eventDate = el.addDate?.value || "";
    const eventTime = el.addTime?.value || "";
    const guests = (el.addGuests?.value || "").trim();
    if (!firstName || !lastName) {
      shared.showError(el.addErr, "First and last name are required.");
      return;
    }
    if (!email) {
      shared.showError(el.addErr, "Email is required.");
      return;
    }
    if (weekdayFromYmd(eventDate) === 6) {
      shared.showError(el.addErr, "We’re closed on Saturdays. Pick Sunday through Friday.");
      return;
    }
    if (!guests) {
      shared.showError(el.addErr, "Enter a guest count.");
      return;
    }
    busy = true;
    setStatus("Adding event…");
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone: el.addPhone?.value || "",
          eventDate,
          eventTime,
          guests,
          room: el.addRoom?.value || "auto",
          packageUsd: el.addPackage?.value || "550",
          depositUsd: el.addDeposit?.value || "200",
          depositPaid: el.addDepositPaid?.checked === true,
          styling: el.addStyling?.checked === true,
          needsConfirm: el.addNeedsConfirm?.checked === true,
          remainingPaid: el.addRemainingPaid?.checked === true,
          sendEmail: el.addSendEmail?.checked === true,
          staffNotes: el.addNotes?.value || "",
          addCleaning: el.addCleaning?.checked === true,
          cleaningUsd: el.addCleaning?.checked ? el.addCleaningUsd?.value || "" : "",
          schedule: currentAddSchedule(),
        }),
      });
      closeAddDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      const mailed = data.emailOk === true;
      const askedMail = el.addSendEmail?.checked === true;
      setStatus(
        askedMail
          ? mailed
            ? `Added ${firstName} ${lastName} and emailed confirmation.`
            : `Added ${firstName} ${lastName}. Email did not send.`
          : `Added ${firstName} ${lastName} to Reservations. No email sent.`,
      );
    } catch (e) {
      shared.showError(el.addErr, e instanceof Error ? e.message : "Could not add the event");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  async function loadList() {
    const data = await shared.adminFetch(token(), "/api/admin/events/list");
    rows = Array.isArray(data.reservations) ? data.reservations : [];
    renderSummary(data.summary && typeof data.summary === "object" ? data.summary : {});
    renderViews();
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
  async function sendReservationDetails(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const email = row ? String(row.email || "") : "";
    if (!window.confirm(`Email event details to ${name}${email ? ` (${email})` : ""}?`)) {
      return;
    }
    busy = true;
    setStatus("Sending event details…");
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/send-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(
        data.emailOk === true
          ? `Event details emailed to ${email || name}.`
          : `Could not email event details${data.emailError ? `: ${data.emailError}` : "."}`,
      );
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Could not send event details");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id */
  async function sendReservationBooking(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const email = row ? String(row.email || "") : "";
    const again = row?.bookingLinkSent === true;
    if (!window.confirm(`${again ? "Resend" : "Send"} the deposit booking link to ${name}${email ? ` (${email})` : ""}?`)) {
      return;
    }
    busy = true;
    setStatus(again ? "Resending booking link…" : "Sending booking link…");
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/send-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadList();
      shared.showError(el.mainErr, "");
      const url = String(data.url || "");
      if (url) {
        const copied = await copyTextToClipboard(url);
        setStatus(
          data.emailOk === true
            ? `Booking link emailed to ${email || name}.${copied ? " Link copied." : ""}`
            : `Link ready${copied ? " and copied" : ""}. Email did not send.`,
        );
      } else {
        setStatus(data.emailOk === true ? `Booking link emailed to ${email || name}.` : "Could not send the booking link.");
      }
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Could not send the booking link");
      setStatus("");
    } finally {
      busy = false;
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

  /** @param {string} id @param {HTMLButtonElement} [btn] */
  async function chargeRemaining(id, btn) {
    if (busy) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const dollars = money(Number(row?.remainingCents) || 0);
    if (btn) btn.disabled = true;
    const confirmed = window.confirm(`Charge the remaining ${dollars} to ${name}'s saved card?`);
    if (!confirmed) {
      if (btn) btn.disabled = false;
      return;
    }
    busy = true;
    setChargeRemainingButtonLoading(btn, true);
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
      if (btn?.isConnected) setChargeRemainingButtonLoading(btn, false);
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
    const shouldEmail =
      row?.emailsSent === true || row?.confirmEmailSent === true || row?.paidOnline === true;
    if (el.cancelSendEmail) el.cancelSendEmail.checked = shouldEmail;
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

  /** @param {string} id */
  function openDeleteDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    if (!row?.canDelete) {
      shared.showError(el.mainErr, String(row?.deleteBlockedReason || "This reservation cannot be deleted."));
      return;
    }
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    deleteId = id;
    if (el.deleteWho) {
      el.deleteWho.textContent = `Delete ${name} — ${whenLabel(String(row?.eventDate || ""), String(row?.eventTime || ""))}.`;
    }
    if (el.deleteHint) {
      const blocked = String(row?.deleteBlockedReason || "");
      if (blocked.includes("Archive")) {
        el.deleteHint.hidden = false;
        el.deleteHint.textContent = blocked;
      } else {
        el.deleteHint.hidden = true;
        el.deleteHint.textContent = "";
      }
    }
    if (el.deleteConfirm) el.deleteConfirm.checked = false;
    shared.showError(el.deleteErr, "");
    if (el.deleteDialog && typeof el.deleteDialog.showModal === "function") {
      el.deleteDialog.showModal();
      el.deleteConfirm?.focus();
    }
  }

  function closeDeleteDialog() {
    deleteId = "";
    if (el.deleteDialog && typeof el.deleteDialog.close === "function") el.deleteDialog.close();
  }

  /** @param {string} id */
  function openArchiveDialog(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    if (!row?.canArchive) {
      shared.showError(el.mainErr, String(row?.archiveBlockedReason || "This reservation cannot be archived."));
      return;
    }
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    archiveId = id;
    if (el.archiveWho) {
      el.archiveWho.textContent = `Archive ${name} — ${whenLabel(String(row?.eventDate || ""), String(row?.eventTime || ""))}.`;
    }
    shared.showError(el.archiveErr, "");
    if (el.archiveDialog && typeof el.archiveDialog.showModal === "function") {
      el.archiveDialog.showModal();
    }
  }

  function closeArchiveDialog() {
    archiveId = "";
    if (el.archiveDialog && typeof el.archiveDialog.close === "function") el.archiveDialog.close();
  }

  /** @param {SubmitEvent} ev */
  async function submitArchive(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = archiveId;
    if (!id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    busy = true;
    shared.showError(el.archiveErr, "");
    try {
      await shared.adminFetch(token(), "/api/admin/events/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      closeArchiveDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Archived ${name}.`);
    } catch (e) {
      shared.showError(el.archiveErr, e instanceof Error ? e.message : "Archive failed");
    } finally {
      busy = false;
    }
  }

  /** @param {string} id */
  async function restoreRow(id) {
    if (busy || !id) return;
    const row = rows.find((r) => String(r.id) === id);
    if (!row?.canRestore) {
      shared.showError(el.mainErr, "This reservation cannot be restored.");
      return;
    }
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    if (!window.confirm(`Restore ${name} to Active?`)) return;
    busy = true;
    setStatus("Restoring…");
    try {
      await shared.adminFetch(token(), "/api/admin/events/unarchive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      archiveScope = "active";
      root.querySelectorAll("[data-events-archive]").forEach((btn) => {
        if (btn.closest("dialog")) return;
        btn.classList.toggle("is-active", btn.getAttribute("data-events-archive") === "active");
      });
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Restored ${name} to Active.`);
    } catch (e) {
      shared.showError(el.mainErr, e instanceof Error ? e.message : "Restore failed");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  /** @param {SubmitEvent} ev */
  async function submitDelete(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = deleteId;
    if (!id || el.deleteConfirm?.checked !== true) {
      shared.showError(el.deleteErr, "Check the box to confirm permanent delete.");
      return;
    }
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    busy = true;
    shared.showError(el.deleteErr, "");
    try {
      await shared.adminFetch(token(), "/api/admin/events/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, confirmDelete: true }),
      });
      closeDeleteDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      setStatus(`Deleted ${name} permanently.`);
    } catch (e) {
      shared.showError(el.deleteErr, e instanceof Error ? e.message : "Delete failed");
    } finally {
      busy = false;
    }
  }

  /** @param {SubmitEvent} ev */
  async function submitCancel(ev) {
    ev.preventDefault();
    if (busy) return;
    const id = cancelId;
    const note = (el.cancelNote?.value || "").trim();
    const sendEmail = el.cancelSendEmail?.checked !== false;
    if (!id) return;
    const row = rows.find((r) => String(r.id) === id);
    const name = row ? `${row.firstName || ""} ${row.lastName || ""}`.trim() : id;
    const confirmMsg = sendEmail
      ? `Cancel the event for ${name}? This emails the client. Refund the deposit in Stripe if it applies.`
      : `Cancel the event for ${name} without emailing the client?`;
    if (!window.confirm(confirmMsg)) {
      return;
    }
    busy = true;
    setStatus("Canceling…");
    try {
      const data = await shared.adminFetch(token(), "/api/admin/events/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, note, sendEmail }),
      });
      closeCancelDialog();
      await loadList();
      shared.showError(el.mainErr, "");
      const mailed = data.emailOk === true;
      setStatus(
        sendEmail
          ? mailed
            ? `Canceled ${name} and emailed the client.`
            : `Canceled ${name}. Email did not send.`
          : `Canceled ${name}. No email sent.`,
      );
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
  el.addOpen?.addEventListener("click", () => openAddDialog());
  el.addDate?.addEventListener("change", () => {
    fillTimeSelect(el.addTime, el.addTime?.value || "", el.addDate?.value || "");
    refreshAddSchedulePreview();
  });
  el.addTime?.addEventListener("change", refreshAddSchedulePreview);
  [el.addBeforeMin, el.addSessionMin, el.addAfterMin, el.addSessionLabel].forEach((node) =>
    node?.addEventListener("change", refreshAddSchedulePreview),
  );
  el.addSchedReset?.addEventListener("click", () => applyAddSchedule(null));
  el.addCleaning?.addEventListener("change", () => {
    setCleaningVisible(el.addCleaningWrap, el.addCleaningUsd, el.addCleaning?.checked === true);
    refreshAddPriceSum();
  });
  [
    el.addPackage,
    el.addDeposit,
    el.addDepositPaid,
    el.addStyling,
    el.addCleaningUsd,
    el.addRoom,
    el.addGuests,
  ].forEach((node) => {
    node?.addEventListener("input", refreshAddPriceSum);
    node?.addEventListener("change", refreshAddPriceSum);
  });
  el.addForm?.addEventListener("submit", (ev) => void submitAdd(ev));
  el.addBook?.addEventListener("click", () => void submitAddBookingLink());
  el.addCopy?.addEventListener("click", () => void copyAddBookingLink());
  el.addClose?.addEventListener("click", () => closeAddDialog());
  el.addDialog?.addEventListener("close", () => {
    lastAddOfferUrl = "";
    lastAddReservationId = "";
    shared.showError(el.addErr, "");
  });
  el.editDate?.addEventListener("change", () => {
    fillTimeSelect(el.editTime, el.editTime?.value || "", el.editDate?.value || "");
    refreshEditSchedulePreview();
  });
  el.editTime?.addEventListener("change", refreshEditSchedulePreview);
  [el.editBeforeMin, el.editSessionMin, el.editAfterMin, el.editSessionLabel].forEach((node) =>
    node?.addEventListener("change", refreshEditSchedulePreview),
  );
  el.editSchedReset?.addEventListener("click", () => applyEditSchedule(null));
  el.editCleaning?.addEventListener("change", () => {
    if (el.editCleaningUsd?.disabled && el.editCleaning?.checked !== true) return;
    setCleaningVisible(el.editCleaningWrap, el.editCleaningUsd, el.editCleaning?.checked === true);
    refreshEditPriceSum();
  });
  [
    el.editPackage,
    el.editDeposit,
    el.editDepositPaid,
    el.editStyling,
    el.editCleaningUsd,
    el.editRoom,
    el.editGuests,
  ].forEach((node) => {
    node?.addEventListener("input", refreshEditPriceSum);
    node?.addEventListener("change", refreshEditPriceSum);
  });
  el.editForm?.addEventListener("submit", (ev) => void submitEdit(ev));
  el.editCopy?.addEventListener("click", () => void copyEditBookingLink());
  el.editBook?.addEventListener("click", () => void sendEditBookingLink());
  el.editClose?.addEventListener("click", () => closeEditDialog());
  el.editDialog?.addEventListener("close", () => {
    editId = "";
    lastEditOfferUrl = "";
    shared.showError(el.editErr, "");
  });
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
  root.querySelectorAll("[data-events-archive]").forEach((btn) => {
    if (btn.closest("dialog")) return;
    btn.addEventListener("click", () =>
      setArchiveScope(String(btn.getAttribute("data-events-archive") || "active")),
    );
  });
  root.querySelectorAll("[data-events-view]").forEach((btn) => {
    btn.addEventListener("click", () => setView(String(btn.getAttribute("data-events-view") || "table")));
  });
  root.querySelectorAll("[data-events-sort]").forEach((btn) => {
    btn.addEventListener("click", () => setTableSort(String(btn.getAttribute("data-events-sort") || "event")));
  });
  el.calPrev?.addEventListener("click", () => {
    calMonth -= 1;
    if (calMonth < 0) {
      calMonth = 11;
      calYear -= 1;
    }
    renderCalendar();
  });
  el.calNext?.addEventListener("click", () => {
    calMonth += 1;
    if (calMonth > 11) {
      calMonth = 0;
      calYear += 1;
    }
    renderCalendar();
  });
  el.calToday?.addEventListener("click", () => {
    const n = new Date();
    calYear = n.getFullYear();
    calMonth = n.getMonth();
    calSelected = todayYmd();
    renderCalendar();
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
  el.notesClose?.addEventListener("click", () => closeNotesDialog());
  el.logClose?.addEventListener("click", () => closeLogDialog());
  el.notesDialog?.addEventListener("close", () => {
    if (el.notesWho) el.notesWho.textContent = "";
    if (el.notesBody) el.notesBody.textContent = "";
  });
  el.cancelForm?.addEventListener("submit", (ev) => void submitCancel(ev));
  el.cancelClose?.addEventListener("click", () => closeCancelDialog());
  el.cancelDialog?.addEventListener("close", () => {
    cancelId = "";
    shared.showError(el.cancelErr, "");
  });
  el.deleteForm?.addEventListener("submit", (ev) => void submitDelete(ev));
  el.deleteClose?.addEventListener("click", () => closeDeleteDialog());
  el.deleteDialog?.addEventListener("close", () => {
    deleteId = "";
    shared.showError(el.deleteErr, "");
  });
  el.archiveForm?.addEventListener("submit", (ev) => void submitArchive(ev));
  el.archiveClose?.addEventListener("click", () => closeArchiveDialog());
  el.archiveDialog?.addEventListener("close", () => {
    archiveId = "";
    shared.showError(el.archiveErr, "");
  });
  el.offerDate?.addEventListener("change", () => {
    fillTimeSelect(el.offerTime, el.offerTime?.value || "", el.offerDate?.value || "");
    refreshOfferSchedulePreview();
  });
  el.offerTime?.addEventListener("change", refreshOfferSchedulePreview);
  [el.offerBeforeMin, el.offerSessionMin, el.offerAfterMin, el.offerSessionLabel].forEach((node) =>
    node?.addEventListener("change", refreshOfferSchedulePreview),
  );
  el.offerSchedReset?.addEventListener("click", () => applyOfferSchedule(null));
  el.offerCleaning?.addEventListener("change", () => setOfferCleaningVisible(el.offerCleaning?.checked === true));
  el.offerForm?.addEventListener("submit", (ev) => ev.preventDefault());
  el.offerSendBtns.forEach((btn) => {
    btn.addEventListener("click", () => void submitOffer(String(btn.getAttribute("data-events-offer-kind") || "book")));
  });
  el.offerCopy?.addEventListener("click", () => void copyOfferLink());
  el.offerClose?.addEventListener("click", () => closeOfferDialog());
  el.offerDialog?.addEventListener("close", () => {
    offerInquiryId = "";
    shared.showError(el.offerErr, "");
  });

  const saved = shared.getToken();
  if (saved && el.tokenInput) {
    el.tokenInput.value = saved;
    void unlock();
  }
})();
