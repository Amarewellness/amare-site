/* Mindbody GET /public/v6/class/classes — day strip inside .mb-frame, one day list at a time (ET).
 * Booking templates: MINDBODY_BOOK_URL_TEMPLATE (see docs/MINDBODY.md).
 */
(function () {
  const TZ = "America/New_York";
  const DAY_STRIP_LEN = 14;

  const dayHeadingFmt = () =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: TZ,
    });

  const daySortKeyFmt = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

  const timeFmt = () =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TZ,
    });

  const hourFmtEt = () =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: TZ,
    });

  const pillLine1Fmt = () =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: TZ,
    });

  const pillMmDdFmt = () =>
    new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      timeZone: TZ,
    });

  function parseIso(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Safe numeric UTC ms → formatter string (Intl throws on Invalid Date in some browsers). */
  function formatUtcMsSafe(fmtFactory, utcMs, fallback = "—") {
    if (typeof utcMs !== "number" || !Number.isFinite(utcMs)) return fallback;
    try {
      return fmtFactory().format(utcMs);
    } catch {
      return fallback;
    }
  }

  /** @param {number} isoMs */
  function hourEt(isoMs) {
    if (typeof isoMs !== "number" || !Number.isFinite(isoMs)) return 12;
    try {
      const parts = hourFmtEt().formatToParts(new Date(isoMs));
      const h = parts.find((p) => p.type === "hour");
      return h ? parseInt(h.value, 10) : 12;
    } catch {
      return 12;
    }
  }

  /** @param {Record<string, unknown>|null|undefined} staff */
  function staffLabel(staff) {
    if (!staff || typeof staff !== "object") return "Instructor TBA";
    const s = staff;
    for (const k of ["DisplayName", "Name"]) {
      if (typeof s[k] === "string" && /** @type {string} */ (s[k]).trim())
        return /** @type {string} */ (s[k]).trim();
    }
    const first = typeof s.FirstName === "string" ? s.FirstName : "";
    const last = typeof s.LastName === "string" ? s.LastName : "";
    const comb = `${first} ${last}`.trim();
    return comb || "Instructor";
  }

  /** PascalCase vs camelCase (proxies / serializers). */
  function classDescFromCls(cls) {
    if (!cls || typeof cls !== "object") return undefined;
    return /** @type {Record<string, unknown>} */ (cls).ClassDescription ??
      /** @type {Record<string, unknown>} */ (cls).classDescription;
  }

  function staffFromCls(cls) {
    if (!cls || typeof cls !== "object") return undefined;
    return /** @type {Record<string, unknown>} */ (cls).Staff ??
      /** @type {Record<string, unknown>} */ (cls).staff;
  }

  function classStartIsoFromCls(cls) {
    if (!cls || typeof cls !== "object") return "";
    const o = /** @type {Record<string, unknown>} */ (cls);
    const raw = o.StartDateTime ?? o.startDateTime ?? "";
    return typeof raw === "string" ? raw : "";
  }

  /** @param {unknown} cd */
  function classTitle(cd) {
    if (!cd || typeof cd !== "object") return "Class";
    /** @type {Record<string, unknown>} */
    const o = cd;
    const n = o.Name || o.Subcategory || o.Description;
    if (typeof n === "string" && n.trim()) return n.trim().replace(/<[^>]+>/g, "");
    return "Class";
  }

  /** @param {number} isoMs */
  function dateKeyEt(isoMs) {
    return daySortKeyFmt().format(new Date(isoMs));
  }

  /** @param {string} ymd yyyy-mm-dd, @param {number} delta */
  function addDaysToYmdEt(ymd, delta) {
    const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
    const ms = Date.UTC(y, m - 1, d + delta) + 43200000;
    return dateKeyEt(ms);
  }

  /** 14 successive calendar keys starting today ET */
  function stripKeysFromTodayEt() {
    const start = dateKeyEt(Date.now());
    const keys = [];
    let k = start;
    for (let i = 0; i < DAY_STRIP_LEN; i++) {
      keys.push(k);
      k = addDaysToYmdEt(k, 1);
    }
    return keys;
  }

  /** @param {string} dk */
  function midMsForEtYmd(dk) {
    const parts = dk.split("-");
    if (parts.length !== 3) return NaN;
    const [y, m, d] = parts.map((x) => parseInt(x, 10));
    if (![y, m, d].every((n) => Number.isFinite(n))) return NaN;
    const u = Date.UTC(y, m - 1, d, 17, 0, 0);
    return Number.isFinite(u) ? u : NaN;
  }

  /** @typedef {{ cls: MBClass; dk: string; isoMs: number }} NormRow */

  function endIsoFromCls(cls) {
    if (!cls || typeof cls !== "object") return "";
    const o = /** @type {Record<string, unknown>} */ (cls);
    const raw = o.EndDateTime ?? o.endDateTime ?? "";
    return typeof raw === "string" ? raw : "";
  }

  function locationFromCls(cls) {
    if (!cls || typeof cls !== "object") return undefined;
    const o = /** @type {Record<string, unknown>} */ (cls);
    const loc = o.Location ?? o.location;
    return loc && typeof loc === "object" ? /** @type {Record<string, unknown>} */ (loc) : null;
  }

  /** @typedef {Record<string, unknown>} MBClass */

  /**
   * @param {MBClass} cls
   * @param {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string }} bookCfg
   */
  function bookingHref(bookCfg, cls) {
    const t = bookCfg.bookUrlTemplate.trim();
    const locObj = locationFromCls(cls);
    const lid =
      locObj && typeof locObj.Id === "number"
        ? locObj.Id
        : locObj && typeof locObj.id === "number"
          ? locObj.id
          : "";
    const startIso = classStartIsoFromCls(cls);
    const startMs = parseIso(startIso)?.getTime() ?? 0;
    const startDateEt = startMs ? dateKeyEt(startMs) : "";

    const classId = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : "";
    const classScheduleId =
      typeof cls.ClassScheduleId === "number"
        ? cls.ClassScheduleId
        : typeof cls.classScheduleId === "number"
          ? cls.classScheduleId
          : "";

    if (!t) return bookCfg.bookingWidgetHref || "classes.html";

    let out = t;
    const map = {
      "{siteId}": String(bookCfg.siteId),
      "{classId}": String(classId),
      "{classScheduleId}": String(classScheduleId),
      "{locationId}": String(lid),
      "{startISO}": encodeURIComponent(startIso || ""),
      "{startDateEt}": startDateEt,
    };
    for (const [kk, v] of Object.entries(map)) {
      out = out.split(kk).join(v);
    }
    return out;
  }

  function matchesTimeBucket(hour, bucket) {
    if (!bucket) return true;
    if (bucket === "earlybird") return hour < 7;
    if (bucket === "morning") return hour < 12;
    if (bucket === "afternoon") return hour >= 12 && hour < 17;
    if (bucket === "evening") return hour >= 17 && hour < 21;
    if (bucket === "late") return hour >= 21;
    return true;
  }

  /**
   * @param {NormRow} row
   * @param {{
   *   timeBucket: string;
   *   instructor: string;
   *   classTitle: string;
   *   q: string;
   * }} state
   */
  function passesSecondaryFilters(row, state) {
    const { cls, isoMs } = row;

    const h = hourEt(isoMs);
    if (!matchesTimeBucket(h, state.timeBucket)) return false;

    if (state.instructor && staffLabel(staffFromCls(cls)) !== state.instructor) return false;

    const titleStr = classTitle(classDescFromCls(cls));
    if (state.classTitle && titleStr !== state.classTitle) return false;

    if (state.q) {
      const needle = state.q.trim().toLowerCase();
      if (!needle) return true;
      const inst = staffLabel(staffFromCls(cls)).toLowerCase();
      if (!(titleStr + " " + inst).toLowerCase().includes(needle)) return false;
    }

    return true;
  }

  /**
   * @param {HTMLElement} slot
   * @param {MBClass} cls
   * @param {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string }} cfg
   */
  function renderSlot(slot, cls, cfg) {
    const startIso = classStartIsoFromCls(cls);
    const start = parseIso(startIso);
    const endIso = endIsoFromCls(cls);
    const end = endIso ? parseIso(endIso) : null;

    slot.classList.add("mb-schedule-slot");
    if (cls.IsCanceled === true || cls.isCanceled === true) slot.classList.add("is-canceled");

    const leftCol = document.createElement("div");
    leftCol.className = "mb-schedule-slot__timecol";

    const timeEl = document.createElement("time");
    if (start) {
      timeEl.dateTime = startIso || "";
      timeEl.textContent = formatUtcMsSafe(timeFmt, start.getTime(), "");
    }
    leftCol.append(timeEl);

    const body = document.createElement("div");
    body.className = "mb-schedule-slot__body";

    const title = document.createElement("span");
    title.className = "mb-schedule-slot__title";
    title.textContent = classTitle(classDescFromCls(cls));

    const meta = document.createElement("span");
    meta.className = "mb-schedule-slot__meta";
    const instructor = staffLabel(staffFromCls(cls));
    const parts = [instructor];
    if (start && end) {
      const mins = Math.round((end.getTime() - start.getTime()) / 60000);
      if (mins > 0) parts.push(`${mins} min`);
    }
    const max =
      typeof cls.MaxCapacity === "number" ? cls.MaxCapacity : typeof cls.maxCapacity === "number" ? cls.maxCapacity : undefined;
    const booked =
      typeof cls.TotalBooked === "number" ? cls.TotalBooked : typeof cls.totalBooked === "number" ? cls.totalBooked : undefined;
    if (typeof max === "number" && max > 0 && typeof booked === "number") {
      const left = Math.max(0, max - booked);
      parts.push(`${left} spots (${booked}/${max})`);
    } else if (typeof booked === "number") {
      parts.push(`${booked} booked`);
    }

    meta.textContent = parts.join(" · ");

    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "mb-schedule-slot__actions";

    const widgetHref = bookingHref(cfg, cls);

    if (oauthLoggedIn && proxyBase) {
      const bookApi = document.createElement("button");
      bookApi.type = "button";
      bookApi.className = "btn mb-schedule-slot__book mb-schedule-slot__book--api";
      const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
      bookApi.disabled = cid == null;
      bookApi.textContent = "Book";
      bookApi.title = "Book this class with your signed-in Mindbody account (API).";
      bookApi.addEventListener("click", () => {
        if (cid == null) return;
        void bookClassViaApi(cid);
      });
      actions.append(bookApi);

      const fallback = document.createElement("a");
      fallback.className = "mb-schedule-slot__book-fallback link-quiet";
      fallback.href = widgetHref;
      fallback.target = "_blank";
      fallback.rel = "noopener noreferrer";
      fallback.textContent = "Open booking link";
      actions.append(fallback);
    } else {
      const book = document.createElement("a");
      book.className = "btn mb-schedule-slot__book";
      book.href = widgetHref;
      book.target = "_blank";
      book.rel = "noopener noreferrer";
      book.textContent = "Book";
      book.title = cfg.bookUrlTemplate.trim()
        ? "Opens your configured Mindbody booking URL"
        : "Opens the Mindbody widget page";
      actions.append(book);
    }

    slot.append(leftCol, body, actions);
  }

  function normalizeApiClasses(classes) {
    /** @type {NormRow[]} */
    const rows = [];

    classes.forEach((c) => {
      if (typeof c !== "object" || !c) return;
      const cls = /** @type {MBClass} */ (c);
      const iso = classStartIsoFromCls(cls);
      if (!iso) return;
      const sd = parseIso(iso);
      if (!sd) return;
      rows.push({ cls, isoMs: sd.getTime(), dk: dateKeyEt(sd.getTime()) });
    });

    rows.sort((a, b) => a.isoMs - b.isoMs);
    return rows;
  }

  /** @param {unknown} payload */
  function classesFromMindbodyPayload(payload) {
    if (!payload || typeof payload !== "object") return [];
    const d = /** @type {Record<string, unknown>} */ (payload);
    for (const key of ["Classes", "classes"]) {
      const v = d[key];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  function buildQuery() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 14);
    end.setHours(23, 59, 59, 999);

    const p = new URLSearchParams();
    p.set("StartDateTime", start.toISOString());
    p.set("EndDateTime", end.toISOString());
    p.set("HideCanceledClasses", "true");
    p.set("Limit", "500");
    return p.toString();
  }

  const root = document.getElementById("mb-schedule-root");
  const cfgEl = document.getElementById("mb-schedule-config");
  const statusEl = document.getElementById("mb-schedule-status");
  const contentEl = document.getElementById("mb-schedule-content");
  const filtersEl = document.getElementById("mb-schedule-filters");
  const calendarEl = document.getElementById("mb-schedule-calendar");
  const surface = /** @type {HTMLElement|null} */ (root?.querySelector(".mb-schedule-api__surface") ?? null);
  const dayStripEl = document.getElementById("mb-day-strip");
  const classStripEl = document.getElementById("mb-class-type-strip");
  const fltExpand = document.getElementById("mb-flt-expand");
  const fltExtra = document.getElementById("mb-flt-extra");

  const fltTime = /** @type {HTMLSelectElement|null} */ (document.getElementById("mb-flt-time"));
  const fltInstr = /** @type {HTMLSelectElement|null} */ (document.getElementById("mb-flt-instructor"));
  const fltQ = /** @type {HTMLInputElement|null} */ (document.getElementById("mb-flt-q"));
  const fltReset = document.getElementById("mb-flt-reset");

  if (
    !root ||
    !statusEl ||
    !contentEl ||
    !surface ||
    !cfgEl ||
    !filtersEl ||
    !calendarEl ||
    !dayStripEl ||
    !classStripEl ||
    !fltExpand ||
    !fltExtra ||
    !fltTime ||
    !fltInstr ||
    !fltQ ||
    !fltReset
  ) {
    return;
  }

  /** @type {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string }} */
  let cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
    if (!cfg.siteId) cfg.siteId = "-99";
    if (!cfg.bookUrlTemplate) cfg.bookUrlTemplate = "";
    if (!cfg.bookingWidgetHref) cfg.bookingWidgetHref = "classes.html";
  } catch {
    cfg = { siteId: "-99", bookUrlTemplate: "", bookingWidgetHref: "classes.html" };
  }

  /** @type {string[]} */
  let stripKeys = [];
  /** @type {string} */
  let selectedDayKey = "";

  /** @type {NormRow[]} */
  let allRows = [];

  /** Selected class title for chips (same day scope); empty = All */
  let quickClassTitle = "";

  /** Signed in via Mindbody OAuth (`mb_sess`) — enables API book buttons. */
  let oauthLoggedIn = false;

  const proxyBase =
    typeof root.dataset.mbProxy === "string" ? root.dataset.mbProxy.trim() : "";

  if (!proxyBase) {
    surface.setAttribute("aria-busy", "false");
    calendarEl.hidden = true;
    statusEl.classList.add("mb-schedule-api__status--error");
    statusEl.textContent =
      "Configure SCHEDULE_PROXY_BASE in .env and rebuild — then run npm run mindbody:proxy.";
    contentEl.innerHTML =
      '<p class="mb-wrap__intro" style="text-align:center;margin-top:2rem;"><a href="classes.html">Widget scheduling page</a></p>';
  }

  const url = proxyBase
    ? `${proxyBase.replace(/\/$/, "")}/api/mindbody/class/classes?` + buildQuery()
    : "";

  function readExpandedOnly() {
    return {
      timeBucket: fltTime.value || "",
      instructor: fltInstr.value || "",
      q: fltQ.value || "",
    };
  }

  function readSecondaryFilters() {
    return {
      ...readExpandedOnly(),
      classTitle: quickClassTitle,
    };
  }

  function sanitizeQuickClassTitle() {
    const merged = { ...readExpandedOnly(), classTitle: "" };
    const names = new Set(
      allRows
        .filter((r) => r.dk === selectedDayKey && passesSecondaryFilters(r, merged))
        .map((r) => classTitle(classDescFromCls(r.cls))),
    );
    if (quickClassTitle && !names.has(quickClassTitle)) quickClassTitle = "";
  }

  function fillFilterOptions(rows) {
    const instructors = new Set();

    rows.forEach((r) => {
      instructors.add(staffLabel(staffFromCls(r.cls)));
    });

    const curI = fltInstr.value || "";

    fltInstr.innerHTML = '<option value="">All instructors</option>';
    [...instructors].sort((a, b) => a.localeCompare(b)).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      fltInstr.append(opt);
    });
    if (instructors.has(curI)) fltInstr.value = curI;
  }

  /** Class-type chips under day strip — titles available on selected day given expanded-only filters */
  function rebuildQuickClassButtons() {
    classStripEl.innerHTML = "";
    const merged = { ...readExpandedOnly(), classTitle: "" };
    const titles = [
      ...new Set(
        allRows
          .filter((r) => r.dk === selectedDayKey && passesSecondaryFilters(r, merged))
          .map((r) => classTitle(classDescFromCls(r.cls))),
      ),
    ].sort((a, b) => a.localeCompare(b));

    /** @param {boolean} pressed */
    function applyChipAria(btn, pressed) {
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
      btn.classList.toggle("is-selected", pressed);
    }

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "mb-schedule-classchip";
    allBtn.textContent = "All";
    applyChipAria(allBtn, quickClassTitle === "");
    allBtn.addEventListener("click", () => {
      if (quickClassTitle !== "") {
        quickClassTitle = "";
        renderAll();
      }
    });
    classStripEl.append(allBtn);

    titles.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mb-schedule-classchip";
      btn.textContent = t;
      btn.title = t.length > 42 ? t : "";
      applyChipAria(btn, quickClassTitle === t);
      btn.addEventListener("click", () => {
        if (quickClassTitle !== t) {
          quickClassTitle = t;
          renderAll();
        }
      });
      classStripEl.append(btn);
    });
  }

  /** @param {NormRow[]} filtered */
  function countsByDay(filtered) {
    /** @type {Record<string, number>} */
    const m = {};
    filtered.forEach((r) => {
      m[r.dk] = (m[r.dk] || 0) + 1;
    });
    return m;
  }

  function rebuildDayStrip(secondaryFiltered) {
    dayStripEl.innerHTML = "";
    const counts = countsByDay(secondaryFiltered);
    const todayKeyEt = dateKeyEt(Date.now());

    stripKeys.forEach((dk) => {
      const ms = midMsForEtYmd(dk);
      const w = formatUtcMsSafe(pillLine1Fmt, ms, "DAY");
      const md = formatUtcMsSafe(pillMmDdFmt, ms, "—");
      const n = counts[dk] || 0;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mb-schedule-daypill";
      btn.setAttribute("role", "tab");
      btn.dataset.dayKey = dk;
      btn.setAttribute("aria-selected", dk === selectedDayKey ? "true" : "false");
      if (dk === selectedDayKey) btn.classList.add("is-selected");
      if (dk === todayKeyEt) btn.classList.add("is-today");
      if (n === 0) btn.classList.add("mb-schedule-daypill--quiet");

      const line1 = document.createElement("span");
      line1.className = "mb-schedule-daypill__abbr";
      line1.textContent = w;
      const line2 = document.createElement("span");
      line2.className = "mb-schedule-daypill__md";
      line2.textContent = md;
      const badge = document.createElement("span");
      badge.className = "mb-schedule-daypill__count";
      badge.textContent = n > 0 ? String(n) : "—";

      btn.append(line1, line2, badge);
      btn.addEventListener("click", () => selectDayAndRender(dk));
      dayStripEl.append(btn);
    });
  }

  function selectDayAndRender(dk) {
    selectedDayKey = dk;
    renderAll();
  }

  function renderClassesForDay(rowsForDay) {
    contentEl.innerHTML = "";

    if (rowsForDay.length === 0) {
      const p = document.createElement("p");
      p.className = "mb-schedule-api__empty";
      const utc = midMsForEtYmd(selectedDayKey);
      const head = formatUtcMsSafe(dayHeadingFmt, utc, selectedDayKey || "Day");
      p.innerHTML = `<strong>${head}</strong> — no sessions match current filters or this day has no classes.`;
      contentEl.append(p);
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "mb-schedule-list";
    rowsForDay.forEach((entry) => {
      const li = document.createElement("li");
      renderSlot(li, entry.cls, cfg);
      ul.append(li);
    });
    contentEl.append(ul);
  }

  /** @param {NormRow[]} secondaryFiltered already passes secondary filters */
  function renderAll() {
    sanitizeQuickClassTitle();

    const sec = readSecondaryFilters();
    const secondaryFiltered = allRows.filter((r) => passesSecondaryFilters(r, sec));

    rebuildDayStrip(secondaryFiltered);
    rebuildQuickClassButtons();

    if (secondaryFiltered.length === 0 && allRows.length > 0) {
      contentEl.innerHTML =
        `<p class="mb-schedule-api__empty"><strong>No classes match filters.</strong> Clear filters.</p>`;
      updateCounts(sec, "no-rows-after-filter");
      return;
    }

    const forDay = secondaryFiltered.filter((r) => r.dk === selectedDayKey);

    renderClassesForDay(forDay);
    updateCounts(sec, "normal", forDay.length);
  }

  /** @param {"normal"|"no-rows-after-filter"} mode */
  function updateCounts(sec, mode, shownOnDay) {
    statusEl.innerHTML = "";

    if (mode === "no-rows-after-filter") {
      statusEl.append(document.createTextNode("No sessions match filters. "));
      const book = document.createElement("a");
      book.href = cfg.bookingWidgetHref || "classes.html";
      book.textContent = "Booking widget";
      statusEl.append(book);
      return;
    }

    const head = selectedDayKey
      ? formatUtcMsSafe(dayHeadingFmt, midMsForEtYmd(selectedDayKey), selectedDayKey)
      : "";

    const activeFilters =
      (sec.timeBucket ? 1 : 0) +
      (sec.instructor ? 1 : 0) +
      (sec.classTitle ? 1 : 0) +
      (sec.q.trim() ? 1 : 0);

    if (head) {
      statusEl.append(
        document.createTextNode(
          shownOnDay !== undefined && shownOnDay > 0
            ? `${head} · ${shownOnDay} class${shownOnDay === 1 ? "" : "es"}`
            : `${head} · No matching sessions`,
        ),
      );
      statusEl.append(document.createTextNode(" · "));
    }

    if (activeFilters > 0) {
      const filtTag = document.createElement("span");
      filtTag.className = "mb-schedule-api__filter-badge";
      filtTag.textContent = `${activeFilters} filter${activeFilters === 1 ? "" : "s"} active`;
      statusEl.append(filtTag);
      statusEl.append(document.createTextNode(" · "));
    }

    statusEl.append(document.createTextNode("Booking "));
    const book = document.createElement("a");
    book.href = cfg.bookingWidgetHref || "classes.html";
    book.textContent = cfg.bookUrlTemplate.trim() ? "via widget fallback" : "via Mindbody widget";
    statusEl.append(book);
  }

  const EXPAND_LABEL_MORE = "Show more filter options";
  const EXPAND_LABEL_LESS = "Hide filter options";

  let filtersWired = false;

  function wireFilters() {
    if (filtersWired) return;
    filtersWired = true;

    fltExpand.addEventListener("click", () => {
      const willOpen = fltExtra.hidden;
      fltExtra.hidden = !willOpen;
      fltExpand.setAttribute("aria-expanded", willOpen ? "true" : "false");
      fltExpand.textContent = willOpen ? EXPAND_LABEL_LESS : EXPAND_LABEL_MORE;
    });

    const go = () => renderAll();
    [fltTime, fltInstr, fltQ].forEach((el) => {
      el.addEventListener("input", go);
      el.addEventListener("change", go);
    });
    fltReset.addEventListener("click", () => {
      quickClassTitle = "";
      fltTime.selectedIndex = 0;
      fltInstr.selectedIndex = 0;
      fltQ.value = "";
      selectedDayKey = stripKeys[0] || "";
      renderAll();
    });
  }

  /** @param {number} classId */
  async function bookClassViaApi(classId) {
    const base = proxyBase.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/mindbody/class/book`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ classId }),
      });
      const j = await res.json().catch(() => (/** @type {Record<string, unknown>} */ ({})));
      if (!res.ok || j.ok === false) {
        const mb =
          j.mindbody && typeof j.mindbody === "object"
            ? /** @type {Record<string, unknown>} */ (j.mindbody)
            : null;
        let msg = "Booking failed.";
        if (mb) {
          const inner =
            mb.Error && typeof mb.Error === "object"
              ? /** @type {{ Message?: string }} */ (mb.Error)
              : null;
          if (inner?.Message) msg = inner.Message;
          else if (typeof mb.Message === "string") msg = mb.Message;
        }
        if (typeof j.detail === "string") msg = j.detail;
        window.alert(msg);
        return;
      }
      window.alert("Booked. Check your email for Mindbody confirmation.");
      window.location.reload();
    } catch (e) {
      window.alert(String(/** @type {{ message?: string }} */ (e)?.message ?? e));
    }
  }

  async function load() {
    if (!proxyBase || !url) return;

    statusEl.textContent = "Loading classes…";
    statusEl.classList.remove("mb-schedule-api__status--error");
    oauthLoggedIn = false;

    /** @type {RequestInit} */
    const fetchOpts = { credentials: "omit", mode: "cors" };
    /** @type {RequestInit} */
    const sessionOpts = { credentials: "include", headers: { Accept: "application/json" } };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      const sig = AbortSignal.timeout(28000);
      fetchOpts.signal = sig;
      sessionOpts.signal = sig;
    }

    const sessionUrl = `${proxyBase.replace(/\/$/, "")}/api/mindbody/oauth/session`;

    /** @type {Response|undefined} */
    let res;
    try {
      const [classesRes, sessionRes] = await Promise.all([
        fetch(url, fetchOpts),
        fetch(sessionUrl, sessionOpts),
      ]);
      res = classesRes;
      if (sessionRes.ok) {
        try {
          const sj = await sessionRes.json();
          oauthLoggedIn = !!(
            sj &&
            typeof sj === "object" &&
            sj.authenticated !== false &&
            sj.loggedIn !== false &&
            (sj.authenticated || sj.loggedIn || sj.email || sj.name || sj.sub)
          );
        } catch {
          oauthLoggedIn = false;
        }
      }
    } catch {
      surface.setAttribute("aria-busy", "false");
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent =
        "Could not reach the Mindbody proxy (offline, blocked, or timeout). Run `npm run mindbody:proxy` for local dev.";
      contentEl.innerHTML = "";
      return;
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      surface.setAttribute("aria-busy", "false");
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent = "Could not read response from Mindbody proxy.";
      contentEl.innerHTML = "";
      return;
    }

    surface.setAttribute("aria-busy", "false");

    /** @type {unknown} */
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent = `Invalid JSON from proxy (HTTP ${res.status}).`;
      contentEl.innerHTML = "";
      return;
    }

    function mbErr(d) {
      if (
        typeof d !== "object" ||
        !d ||
        !("Error" in d) ||
        typeof /** @type {{ Error?: unknown }} */ (d).Error !== "object" ||
        !/** @type {{ Error?: unknown }} */ (d).Error
      ) {
        return null;
      }
      const err = /** @type {{ Message?: unknown }} */ (
        /** @type {{ Error: object }} */ (d).Error
      );
      return typeof err.Message === "string" ? err.Message : "Mindbody Error";
    }

    function apiUiErrorMessage(d) {
      const nested = mbErr(d);
      if (nested) return nested;
      if (
        typeof d === "object" &&
        d &&
        typeof /** @type {{ message?: unknown }} */ (d).message === "string"
      ) {
        const m = /** @type {{ message: string }} */ (d).message.trim();
        if (m) return m;
      }
      return null;
    }

    const errMsg = apiUiErrorMessage(data);
    if (!res.ok || errMsg) {
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent = errMsg || `Mindbody proxy failed (${res.status}).`;
      contentEl.innerHTML = "";
      return;
    }

    try {
      const classes = classesFromMindbodyPayload(data);
      allRows = normalizeApiClasses(classes);

      if (allRows.length === 0) {
        calendarEl.hidden = true;
        statusEl.textContent = "No classes in this window.";
        contentEl.innerHTML = "";
        filtersEl.hidden = true;
        return;
      }

      stripKeys = stripKeysFromTodayEt();
      selectedDayKey = stripKeys[0] || "";

      fillFilterOptions(allRows);
      filtersEl.hidden = false;
      calendarEl.hidden = false;

      wireFilters();
      renderAll();
    } catch (e) {
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      contentEl.innerHTML = "";
      allRows = [];
      stripKeys = [];
      selectedDayKey = "";
      quickClassTitle = "";
      statusEl.classList.add("mb-schedule-api__status--error");
      const hint = e instanceof Error && e.message ? e.message : "See browser console.";
      statusEl.textContent = `Could not render the schedule (${hint}).`;
    }
  }

  if (proxyBase) {
    load().catch((err) => {
      surface.setAttribute("aria-busy", "false");
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      contentEl.innerHTML = "";
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent =
        err instanceof Error && err.message
          ? `Schedule load failed: ${err.message}`
          : "Schedule load failed unexpectedly.";
    });
  }
})();
