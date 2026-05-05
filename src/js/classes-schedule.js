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

  /**
   * Mindbody often returns ISO-like timestamps without Z/offset; ECMAScript treats those as **local browser time**.
   * Class times are wall-clock in the studio TZ (`America/New_York`), so parse them explicitly in that zone.
   */
  function mindbodyInstantToUtcMs(isoLike) {
    if (isoLike == null || typeof isoLike !== "string") return NaN;
    const raw = isoLike.trim();
    if (!raw) return NaN;
    const hasExplicitTz = /[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw);
    if (hasExplicitTz) {
      const t = Date.parse(raw);
      return Number.isNaN(t) ? NaN : t;
    }
    const mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
    if (!mm) {
      const t = Date.parse(raw);
      return Number.isNaN(t) ? NaN : t;
    }
    const y = +mm[1],
      mo = +mm[2],
      d = +mm[3],
      h = +mm[4],
      mi = +mm[5];
    const se = mm[6] != null ? +mm[6] : 0;
    try {
      if (typeof Temporal !== "undefined") {
        const z = Temporal.ZonedDateTime.from({
          timeZone: TZ,
          calendar: "iso8601",
          year: y,
          month: mo,
          day: d,
          hour: h,
          minute: mi,
          second: se,
          millisecond: 0,
        });
        return z.epochMilliseconds;
      }
    } catch {
      /* fall through */
    }
    return naiveEtWallIterateToUtcMs(y, mo, d, h, mi, se);
  }

  /** Fallback when `Temporal` is missing: refine UTC guess until ET wall time matches. */
  function naiveEtWallIterateToUtcMs(y, mo, d, h, mi, se) {
    let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 48; i++) {
      const parts = fmt.formatToParts(new Date(t));
      const num = (typ) => parseInt(parts.find((p) => p.type === typ)?.value || "0", 10);
      const yy = num("year"),
        MM = num("month"),
        dd = num("day"),
        HH = num("hour"),
        mmm = num("minute"),
        ss = num("second");
      if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
      t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
      if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
    }
    return NaN;
  }

  function parseIso(iso) {
    const ms = mindbodyInstantToUtcMs(iso);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
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
   * @param {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string; signupUrl?: string }} bookCfg
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
   * Whether the class start instant is in the past (same moment for every viewer).
   * Start times are parsed as studio wall time (`America/New_York`) so the instant matches Mindbody schedule.
   * @param {Date|null} start
   */
  function classStartHasPassed(start) {
    if (!start || !Number.isFinite(start.getTime())) return false;
    return Date.now() >= start.getTime();
  }

  /**
   * @param {HTMLElement} slot
   * @param {MBClass} cls
   * @param {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string; signupUrl?: string }} cfg
   * @param {(c: MBClass) => void} onBookClick
   * @param {(c: MBClass, visitId: number) => void} onCancelClick
   */
  function renderSlot(slot, cls, cfg, onBookClick, onCancelClick) {
    const startIso = classStartIsoFromCls(cls);
    const start = parseIso(startIso);
    const elapsed = classStartHasPassed(start);
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

    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const visitForCancel = cid != null ? enrollVisitByClassId.get(cid) : undefined;
    const isEnrolled = oauthLoggedIn && visitForCancel != null;

    const bookPrimary = document.createElement("button");
    bookPrimary.type = "button";
    bookPrimary.className = oauthLoggedIn ? "btn mb-schedule-slot__book mb-schedule-slot__book--api" : "btn mb-schedule-slot__book";
    if (elapsed) bookPrimary.classList.add("mb-schedule-slot__book--elapsed");
    bookPrimary.textContent = "Book";
    bookPrimary.disabled = cid == null || isEnrolled || elapsed;
    bookPrimary.title = isEnrolled
      ? "You’re already booked into this class — use Cancel booking to release your spot."
      : elapsed
        ? "This class has already started (schedule time · Eastern)."
        : cid == null
          ? "This session has no class id from Mindbody."
          : oauthLoggedIn
            ? "Confirm and book this class with your Mindbody account."
            : "Sign in or complete signup in Mindbody to book.";
    bookPrimary.addEventListener("click", () => {
      onBookClick(cls);
    });
    actions.append(bookPrimary);

    if (isEnrolled) {
      const cancelBook = document.createElement("button");
      cancelBook.type = "button";
      cancelBook.className = "btn btn--ghost mb-schedule-slot__cancel";
      cancelBook.textContent = "Cancel booking";
      cancelBook.title = "Remove your reservation. Studio cancellation rules still apply.";
      cancelBook.addEventListener("click", () => {
        onCancelClick(cls, visitForCancel);
      });
      actions.append(cancelBook);
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
    function addRoughDaysEtYmd(ymd, days) {
      const ms = mindbodyInstantToUtcMs(`${ymd}T12:00:00`);
      if (!Number.isFinite(ms)) return ymd;
      return daySortKeyFmt().format(new Date(ms + days * 86400000));
    }

    const todayEt = daySortKeyFmt().format(new Date());
    const endEt =
      typeof Temporal !== "undefined"
        ? Temporal.PlainDate.from(todayEt).add({ days: DAY_STRIP_LEN - 1 }).toString()
        : addRoughDaysEtYmd(todayEt, DAY_STRIP_LEN - 1);

    const startMs = mindbodyInstantToUtcMs(`${todayEt}T00:00:00`);
    let endMs = mindbodyInstantToUtcMs(`${endEt}T23:59:59`);
    let startIso;
    let endIso;
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      startIso = new Date(startMs).toISOString();
      endIso = new Date(endMs + 999).toISOString();
    } else {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + DAY_STRIP_LEN);
      end.setUTCHours(23, 59, 59, 999);
      startIso = start.toISOString();
      endIso = end.toISOString();
    }

    const p = new URLSearchParams();
    p.set("StartDateTime", startIso);
    p.set("EndDateTime", endIso);
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
  const dayStripPrev = document.getElementById("mb-day-strip-prev");
  const dayStripNext = document.getElementById("mb-day-strip-next");
  const classTypeComboEl = document.getElementById("mb-class-type-combo");
  const classTypeTriggerEl = document.getElementById("mb-class-type-trigger");
  const classTypeTriggerTextEl = /** @type {HTMLElement|null} */ (
    classTypeTriggerEl?.querySelector(".mb-schedule-classselect-trigger__text") ?? null
  );
  const classTypeListboxEl = document.getElementById("mb-class-type-listbox");
  const fltExpand = document.getElementById("mb-flt-expand");
  const fltExtra = document.getElementById("mb-flt-extra");

  const fltTime = /** @type {HTMLSelectElement|null} */ (document.getElementById("mb-flt-time"));
  const fltInstr = /** @type {HTMLSelectElement|null} */ (document.getElementById("mb-flt-instructor"));
  const fltQ = /** @type {HTMLInputElement|null} */ (document.getElementById("mb-flt-q"));
  const fltReset = document.getElementById("mb-flt-reset");

  const bookDlg = /** @type {HTMLDialogElement|null} */ (document.getElementById("mb-book-dialog"));
  const bookDlgBody = document.getElementById("mb-book-dialog-body");
  const bookDlgActions = document.getElementById("mb-book-dialog-actions");
  const bookDlgTitle = /** @type {HTMLElement|null} */ (document.getElementById("mb-book-dialog-title"));
  const bookDlgX = /** @type {HTMLElement|null} */ (
    bookDlg?.querySelector(".mb-book-dialog__x") ?? null
  );

  if (
    !root ||
    !statusEl ||
    !contentEl ||
    !surface ||
    !cfgEl ||
    !filtersEl ||
    !calendarEl ||
    !dayStripEl ||
    !dayStripPrev ||
    !dayStripNext ||
    !classTypeComboEl ||
    !classTypeTriggerEl ||
    !classTypeTriggerTextEl ||
    !classTypeListboxEl ||
    !fltExpand ||
    !fltExtra ||
    !fltTime ||
    !fltInstr ||
    !fltQ ||
    !fltReset
  ) {
    return;
  }

  /** @type {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string; signupUrl?: string }} */
  let cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
    if (!cfg.siteId) cfg.siteId = "-99";
    if (!cfg.bookUrlTemplate) cfg.bookUrlTemplate = "";
    if (!cfg.bookingWidgetHref) cfg.bookingWidgetHref = "classes.html";
    if (typeof cfg.signupUrl !== "string") cfg.signupUrl = "";
  } catch {
    cfg = { siteId: "-99", bookUrlTemplate: "", bookingWidgetHref: "classes.html", signupUrl: "" };
  }

  const useBookDialog = !!(bookDlg && bookDlgBody && bookDlgActions && bookDlgTitle && bookDlgX);

  /** @type {string[]} */
  let stripKeys = [];
  /** @type {string} */
  let selectedDayKey = "";

  /** Re-evaluate BOOK enabled state while viewing “today” in Eastern (sessions can cross start time without reload). */
  let scheduleTodayBookTickerId = /** @type {ReturnType<typeof setInterval>|null} */ (null);

  /** @type {NormRow[]} */
  let allRows = [];

  /** Selected class title for chips (same day scope); empty = All */
  let quickClassTitle = "";

  /** Signed in via Mindbody OAuth (`mb_sess`) — enables API book buttons. */
  let oauthLoggedIn = false;

  /** Display label from `/oauth/session` (mirrors strip copy). */
  let oauthWho = "";

  /** Class id (Mindbody class instance) → visit id for upcoming enrollment; filled from member summary when signed in. */
  let enrollVisitByClassId = new Map();

  /** Empty `data-mb-proxy` ⇒ same-origin `/api/mindbody/...` (Netlify prod or `npm run dev`). */
  const proxyBase =
    typeof root.dataset.mbProxy === "string" ? root.dataset.mbProxy.trim() : "";
  const apiOrigin = proxyBase.replace(/\/$/, "");

  /** Ngrok Free can return an HTML interstitial (still HTTP 200) unless this header is set. */
  function ngrokBypassHeaders(/** @type {Record<string, string>} */ extra = {}) {
    const out = { ...extra };
    let host = "";
    try {
      if (typeof window === "undefined") return out;
      host = apiOrigin ? new URL(apiOrigin, window.location.href).hostname : window.location.hostname;
    } catch {
      host = "";
    }
    if (host.includes("ngrok")) out["ngrok-skip-browser-warning"] = "true";
    return out;
  }

  function oauthReturnPath() {
    let path = window.location.pathname || "/";
    if (path === "/member.html") path = "/member";
    return path + (window.location.search || "");
  }

  /** @returns {string} Absolute or same-site URL for OAuth start (matches `mindbody-auth.js`). */
  function oauthStartHref() {
    const q = `/api/mindbody/oauth/start?return=${encodeURIComponent(oauthReturnPath())}`;
    return apiOrigin !== "" ? `${apiOrigin}${q}` : q;
  }

  function memberSummaryUrl() {
    return apiOrigin !== ""
      ? `${apiOrigin}/api/mindbody/member/summary`
      : `/api/mindbody/member/summary`;
  }

  /** Sign-up / new-client destination: optional env URL, otherwise Mindbody widget page. */
  function consumerSignupHref() {
    const u = (cfg.signupUrl || "").trim();
    if (u) return u;
    const w = cfg.bookingWidgetHref || "classes.html";
    if (/^https?:\/\//i.test(w)) return w;
    return new URL(w, window.location.href).href;
  }

  /** @param {Record<string, unknown>} row */
  function visitPickRow(row, /** @type {string[]} */ keys) {
    for (const k of keys) {
      if (row[k] != null && row[k] !== "") return row[k];
    }
    return null;
  }

  /** @param {unknown} obj */
  function firstVisitArray(obj, /** @type {string[]} */ keys) {
    if (!obj || typeof obj !== "object") return [];
    const o = /** @type {Record<string, unknown>} */ (obj);
    for (const k of keys) {
      const v = o[k];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  const VISITS_GROUP_KEYS = ["Visits", "ClientVisits", "visits", "VisitDetails", "ScheduledVisits"];

  /** @param {unknown} cv */
  function visitsArrayFromClientVisits(cv) {
    if (!cv || typeof cv !== "object") return [];
    const o = /** @type {Record<string, unknown>} */ (cv);
    let a = firstVisitArray(o, VISITS_GROUP_KEYS);
    if (a.length) return a;
    const pr = o.PaginationResponse;
    if (pr && typeof pr === "object")
      a = firstVisitArray(/** @type {Record<string, unknown>} */ (pr), VISITS_GROUP_KEYS);
    return a;
  }

  /** @param {Record<string, unknown>} v */
  function visitStartMsFromRow(v) {
    const direct = visitPickRow(v, [
      "StartDateTime",
      "startDateTime",
      "StartDate",
      "visitStartDateTime",
      "AppointmentStartDate",
      "VisitStartDateTime",
      "scheduledDateTime",
    ]);
    if (direct != null && direct !== "") {
      const ms = new Date(String(direct)).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
    const cls = v.Class ?? v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const fromClass = visitPickRow(c, ["StartDateTime", "startDateTime"]);
      if (fromClass != null && fromClass !== "") {
        const ms = new Date(String(fromClass)).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
      const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
      if (sched && typeof sched === "object") {
        const s = /** @type {Record<string, unknown>} */ (sched);
        const raw = visitPickRow(s, ["StartDateTime", "startDateTime"]);
        if (raw != null && raw !== "") {
          const ms = new Date(String(raw)).getTime();
          if (!Number.isNaN(ms)) return ms;
        }
      }
    }
    return null;
  }

  /** @param {Record<string, unknown>} v */
  function visitClassIdFromRow(v) {
    const cls = v.Class ?? v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const id = c.Id ?? c.id;
      if (id != null && Number.isFinite(Number(id))) return Number(id);
      const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
      if (sched && typeof sched === "object") {
        const cid =
          /** @type {Record<string, unknown>} */ (sched).ClassId ??
          /** @type {Record<string, unknown>} */ (sched).classId;
        if (cid != null && Number.isFinite(Number(cid))) return Number(cid);
      }
    }
    const raw = v.ClassId ?? v.classId;
    if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
    return null;
  }

  /** @param {Record<string, unknown>} v */
  function visitRowIdFromRow(v) {
    const raw = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
    return null;
  }

  /** Upcoming enrolled class instance id → visit id (Mindbody `/class/removeclientfromclass`). */
  function buildEnrollmentVisitMap(/** @type {{ clientVisits?: unknown }} */ summaryPayload) {
    /** @type {Map<number, number>} */
    const map = new Map();
    if (!summaryPayload || typeof summaryPayload !== "object") return map;
    const rows = visitsArrayFromClientVisits(summaryPayload.clientVisits);
    const now = Date.now();
    for (const item of rows) {
      if (!item || typeof item !== "object") continue;
      const v = /** @type {Record<string, unknown>} */ (item);
      const ms = visitStartMsFromRow(v);
      if (ms == null || ms <= now) continue;
      const cid = visitClassIdFromRow(v);
      const vid = visitRowIdFromRow(v);
      if (cid != null && vid != null) map.set(cid, vid);
    }
    return map;
  }

  /** @param {HTMLElement} container */
  function appendBookModalSummary(container, cls) {
    container.replaceChildren();
    const startIso = classStartIsoFromCls(cls);
    const start = parseIso(startIso);
    const endIso = endIsoFromCls(cls);
    const end = endIso ? parseIso(endIso) : null;
    const lead = document.createElement("p");
    lead.className = "mb-book-dialog__lead";
    lead.textContent = classTitle(classDescFromCls(cls));
    const sub = document.createElement("p");
    sub.className = "mb-book-dialog__sub";
    const bits = [];
    if (start) bits.push(formatUtcMsSafe(timeFmt, start.getTime(), ""));
    if (start && end) {
      const mins = Math.round((end.getTime() - start.getTime()) / 60000);
      if (mins > 0) bits.push(`${mins} min`);
    }
    bits.push(staffLabel(staffFromCls(cls)));
    sub.textContent = bits.join(" · ");
    container.append(lead, sub);
  }

  const url =
    apiOrigin !== ""
      ? `${apiOrigin}/api/mindbody/class/classes?` + buildQuery()
      : `/api/mindbody/class/classes?` + buildQuery();

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

  /** Class-type combobox (styled list); native `<select>` panels can’t be themed. */
  let classTypeDropdownOpen = false;

  function closeClassTypeDropdown() {
    if (!classTypeListboxEl || !classTypeTriggerEl || !classTypeComboEl) return;
    classTypeDropdownOpen = false;
    classTypeListboxEl.hidden = true;
    classTypeTriggerEl.setAttribute("aria-expanded", "false");
    classTypeComboEl.classList.remove("is-open");
  }

  function openClassTypeDropdown() {
    if (!classTypeListboxEl || !classTypeTriggerEl || !classTypeComboEl) return;
    classTypeDropdownOpen = true;
    classTypeListboxEl.hidden = false;
    classTypeTriggerEl.setAttribute("aria-expanded", "true");
    classTypeComboEl.classList.add("is-open");
  }

  /** @param {string} value */
  function selectClassTypeAndRender(value) {
    if (quickClassTitle === value) {
      closeClassTypeDropdown();
      classTypeTriggerEl?.focus();
      return;
    }
    quickClassTitle = value;
    closeClassTypeDropdown();
    classTypeTriggerEl?.focus();
    renderAll();
  }

  /** Class-type dropdown under day strip — titles available on selected day given expanded-only filters */
  function rebuildQuickClassSelect() {
    closeClassTypeDropdown();
    const merged = { ...readExpandedOnly(), classTitle: "" };
    const titles = [
      ...new Set(
        allRows
          .filter((r) => r.dk === selectedDayKey && passesSecondaryFilters(r, merged))
          .map((r) => classTitle(classDescFromCls(r.cls))),
      ),
    ].sort((a, b) => a.localeCompare(b));

    const effective =
      quickClassTitle && titles.includes(quickClassTitle) ? quickClassTitle : "";
    if (quickClassTitle !== effective) quickClassTitle = effective;

    classTypeTriggerTextEl.textContent = effective ? effective : "All classes";

    classTypeListboxEl.replaceChildren();

    /** @param {string} value @param {string} label */
    function appendOption(value, label) {
      const li = document.createElement("li");
      li.className = "mb-schedule-classselect-option";
      li.setAttribute("role", "option");
      li.setAttribute("data-value", value);
      li.tabIndex = -1;
      li.textContent = label;
      li.setAttribute("aria-selected", value === effective ? "true" : "false");
      classTypeListboxEl.append(li);
    }

    appendOption("", "All classes");
    titles.forEach((t) => appendOption(t, t));
  }

  let classTypeComboWired = false;
  function wireClassTypeCombo() {
    if (classTypeComboWired || !classTypeTriggerEl || !classTypeListboxEl || !classTypeComboEl) return;
    classTypeComboWired = true;

    function optionEls() {
      return /** @type {HTMLElement[]} */ ([...classTypeListboxEl.querySelectorAll("li.mb-schedule-classselect-option")]);
    }

    /** @param {number} delta */
    function moveListboxFocus(delta) {
      const items = optionEls();
      if (!items.length) return;
      let i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (i < 0) i = Math.max(0, items.findIndex((el) => el.getAttribute("aria-selected") === "true"));
      i = Math.min(items.length - 1, Math.max(0, i + delta));
      items[i].focus();
    }

    document.addEventListener("click", (e) => {
      if (!classTypeDropdownOpen) return;
      const t = /** @type {Node|null} */ (e.target instanceof Node ? e.target : null);
      if (t && classTypeComboEl.contains(t)) return;
      closeClassTypeDropdown();
    });

    classTypeListboxEl.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const li = /** @type {HTMLElement|null} */ (t?.closest("li.mb-schedule-classselect-option"));
      if (!li || !classTypeListboxEl.contains(li)) return;
      e.preventDefault();
      selectClassTypeAndRender(li.getAttribute("data-value") || "");
    });

    classTypeListboxEl.addEventListener("keydown", (e) => {
      if (!classTypeDropdownOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeClassTypeDropdown();
        classTypeTriggerEl.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveListboxFocus(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveListboxFocus(-1);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        optionEls()[0]?.focus();
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        const items = optionEls();
        items[items.length - 1]?.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const active = /** @type {HTMLElement|null} */ (
          document.activeElement?.closest("li.mb-schedule-classselect-option")
        );
        if (active) selectClassTypeAndRender(active.getAttribute("data-value") || "");
      }
    });

    classTypeTriggerEl.addEventListener("click", () => {
      if (classTypeDropdownOpen) closeClassTypeDropdown();
      else openClassTypeDropdown();
      if (classTypeDropdownOpen) {
        const pick =
          /** @type {HTMLElement|null} */ (
            classTypeListboxEl.querySelector('li.mb-schedule-classselect-option[aria-selected="true"]')
          ) || /** @type {HTMLElement|null} */ (
            classTypeListboxEl.querySelector("li.mb-schedule-classselect-option")
          );
        requestAnimationFrame(() => pick?.focus());
      }
    });

    classTypeTriggerEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && classTypeDropdownOpen) {
        e.preventDefault();
        closeClassTypeDropdown();
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && !classTypeDropdownOpen) {
        e.preventDefault();
        openClassTypeDropdown();
        const pick =
          /** @type {HTMLElement|null} */ (
            classTypeListboxEl.querySelector('li.mb-schedule-classselect-option[aria-selected="true"]')
          ) || /** @type {HTMLElement|null} */ (
            classTypeListboxEl.querySelector("li.mb-schedule-classselect-option")
          );
        requestAnimationFrame(() => pick?.focus());
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && classTypeDropdownOpen) {
        e.preventDefault();
        closeClassTypeDropdown();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !classTypeDropdownOpen) {
        e.preventDefault();
        openClassTypeDropdown();
        const items = classTypeListboxEl.querySelectorAll("li.mb-schedule-classselect-option");
        if (e.key === "ArrowDown" && items.length) (/** @type {HTMLElement} */ (items[0])).focus();
        if (e.key === "ArrowUp" && items.length)
          (/** @type {HTMLElement} */ (items[items.length - 1])).focus();
      }
    });
  }
  wireClassTypeCombo();

  /** @param {NormRow[]} filtered */
  function countsByDay(filtered) {
    /** @type {Record<string, number>} */
    const m = {};
    filtered.forEach((r) => {
      m[r.dk] = (m[r.dk] || 0) + 1;
    });
    return m;
  }

  function syncDayStripArrowState() {
    if (!dayStripEl || !dayStripPrev || !dayStripNext) return;
    const { scrollLeft, scrollWidth, clientWidth } = dayStripEl;
    const eps = 4;
    if (scrollWidth <= clientWidth + eps) {
      dayStripPrev.disabled = true;
      dayStripNext.disabled = true;
      return;
    }
    dayStripPrev.disabled = scrollLeft <= eps;
    dayStripNext.disabled = scrollLeft + clientWidth >= scrollWidth - eps;
  }

  let dayStripNavWired = false;
  function wireDayStripNav() {
    if (dayStripNavWired || !dayStripEl || !dayStripPrev || !dayStripNext) return;
    dayStripNavWired = true;
    const stepPx = () => Math.max(220, Math.round(dayStripEl.clientWidth * 0.68));
    dayStripPrev.addEventListener("click", () => {
      dayStripEl.scrollBy({ left: -stepPx(), behavior: "smooth" });
    });
    dayStripNext.addEventListener("click", () => {
      dayStripEl.scrollBy({ left: stepPx(), behavior: "smooth" });
    });
    dayStripEl.addEventListener("scroll", () => requestAnimationFrame(syncDayStripArrowState), {
      passive: true,
    });
    window.addEventListener("resize", () => requestAnimationFrame(syncDayStripArrowState));
  }

  wireDayStripNav();

  /** True if signed-in member has an upcoming enrollment on this ET calendar day (matches schedule rows). */
  function etDayKeyHasMemberBooking(dk) {
    if (!oauthLoggedIn || enrollVisitByClassId.size === 0 || !dk) return false;
    for (const row of allRows) {
      if (row.dk !== dk) continue;
      const cid =
        typeof row.cls.Id === "number"
          ? row.cls.Id
          : typeof row.cls.id === "number"
            ? row.cls.id
            : null;
      if (cid != null && enrollVisitByClassId.has(cid)) return true;
    }
    return false;
  }

  function rebuildDayStrip(secondaryFiltered) {
    dayStripEl.innerHTML = "";
    const counts = countsByDay(secondaryFiltered);
    const todayKeyEt = dateKeyEt(Date.now());

    stripKeys.forEach((dk) => {
      const ms = midMsForEtYmd(dk);
      const w =
        dk === todayKeyEt ? "Today" : formatUtcMsSafe(pillLine1Fmt, ms, "DAY");
      const md = formatUtcMsSafe(pillMmDdFmt, ms, "—");
      const n = counts[dk] || 0;
      const hasMyBooking = etDayKeyHasMemberBooking(dk);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mb-schedule-daypill";
      btn.setAttribute("role", "tab");
      btn.dataset.dayKey = dk;
      btn.setAttribute("aria-selected", dk === selectedDayKey ? "true" : "false");
      if (dk === selectedDayKey) btn.classList.add("is-selected");
      if (dk === todayKeyEt) btn.classList.add("is-today");
      if (n === 0) btn.classList.add("mb-schedule-daypill--quiet");
      if (hasMyBooking) {
        btn.classList.add("mb-schedule-daypill--has-booking");
        btn.setAttribute("aria-label", `${w}, ${md}. You have a booking this day`);
      }

      const line1 = document.createElement("span");
      line1.className =
        "mb-schedule-daypill__abbr" +
        (dk === todayKeyEt ? " mb-schedule-daypill__abbr--today" : "");
      line1.textContent = w;
      const line2 = document.createElement("span");
      line2.className = "mb-schedule-daypill__md";
      line2.textContent = md;

      btn.append(line1, line2);
      btn.addEventListener("click", () => selectDayAndRender(dk));
      dayStripEl.append(btn);
    });
    requestAnimationFrame(() => {
      const sel = dayStripEl.querySelector(".mb-schedule-daypill.is-selected");
      if (sel) sel.scrollIntoView({ block: "nearest", inline: "nearest" });
      syncDayStripArrowState();
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
      renderSlot(li, entry.cls, cfg, openBookFlow, openCancelReservationFlow);
      ul.append(li);
    });
    contentEl.append(ul);
  }

  /** @param {NormRow[]} secondaryFiltered already passes secondary filters */
  function renderAll() {
    if (scheduleTodayBookTickerId != null) {
      clearInterval(scheduleTodayBookTickerId);
      scheduleTodayBookTickerId = null;
    }

    sanitizeQuickClassTitle();

    const sec = readSecondaryFilters();
    const secondaryFiltered = allRows.filter((r) => passesSecondaryFilters(r, sec));

    rebuildDayStrip(secondaryFiltered);
    rebuildQuickClassSelect();

    if (secondaryFiltered.length === 0 && allRows.length > 0) {
      contentEl.innerHTML =
        `<p class="mb-schedule-api__empty"><strong>No classes match filters.</strong> Clear filters.</p>`;
      updateCounts(sec, "no-rows-after-filter");
      return;
    }

    const forDay = secondaryFiltered.filter((r) => r.dk === selectedDayKey);

    renderClassesForDay(forDay);
    updateCounts(sec, "normal", forDay.length);

    const todayEtKey = dateKeyEt(Date.now());
    if (selectedDayKey === todayEtKey && forDay.length > 0) {
      scheduleTodayBookTickerId = window.setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (dateKeyEt(Date.now()) !== selectedDayKey) {
          clearInterval(scheduleTodayBookTickerId);
          scheduleTodayBookTickerId = null;
          return;
        }
        renderAll();
      }, 55000);
    }
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

    /** @type {(Text|HTMLSpanElement)[]} */
    const statusParts = [];

    if (head) {
      const dayLine =
        shownOnDay !== undefined && shownOnDay > 0 ? head : `${head} · No matching sessions`;
      statusParts.push(document.createTextNode(dayLine));
    }

    if (activeFilters > 0) {
      const filtTag = document.createElement("span");
      filtTag.className = "mb-schedule-api__filter-badge";
      filtTag.textContent = `${activeFilters} filter${activeFilters === 1 ? "" : "s"} active`;
      statusParts.push(filtTag);
    }

    statusParts.forEach((node, i) => {
      if (i > 0) statusEl.append(document.createTextNode(" · "));
      statusEl.append(node);
    });
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

  /** @returns {Promise<{ ok: boolean; message: string }>} */
  async function cancelBookingViaApi(classId, visitId) {
    const fetchUrl =
      apiOrigin !== "" ? `${apiOrigin}/api/mindbody/class/cancel` : `/api/mindbody/class/cancel`;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify({ classId, visitId }),
      });
      const j = await res.json().catch(() => (/** @type {Record<string, unknown>} */ ({})));
      if (!res.ok || j.ok === false) {
        const mb =
          j.mindbody && typeof j.mindbody === "object"
            ? /** @type {Record<string, unknown>} */ (j.mindbody)
            : null;
        let msg = "Could not cancel this booking.";
        if (mb && typeof mb === "object") {
          const inner =
            mb.Error && typeof mb.Error === "object"
              ? /** @type {{ Message?: string }} */ (mb.Error)
              : null;
          if (inner?.Message) msg = inner.Message;
          else if (typeof mb.Message === "string") msg = mb.Message;
        }
        if (typeof j.detail === "string") msg = j.detail;
        return { ok: false, message: msg };
      }
      return { ok: true, message: "Your reservation was removed." };
    } catch (e) {
      return { ok: false, message: String(/** @type {{ message?: string }} */ (e)?.message ?? e) };
    }
  }

  /** @returns {Promise<{ ok: boolean; message: string }>} */
  async function bookClassViaApi(classId) {
    const fetchUrl =
      apiOrigin !== "" ? `${apiOrigin}/api/mindbody/class/book` : `/api/mindbody/class/book`;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
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
        return { ok: false, message: msg };
      }
      return { ok: true, message: "Booked. Check your email for Mindbody confirmation." };
    } catch (e) {
      return { ok: false, message: String(/** @type {{ message?: string }} */ (e)?.message ?? e) };
    }
  }

  /** Book button: modal when `<dialog>` is present; otherwise legacy link / alerts. */
  function openBookFlow(cls) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const startPass = parseIso(classStartIsoFromCls(cls));
    if (classStartHasPassed(startPass)) return;

    const fallbackWidget = bookingHref(cfg, cls);

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (oauthLoggedIn && cid != null) {
        void bookClassViaApi(cid).then((r) => {
          if (r.ok) window.location.reload();
          else window.alert(r.message);
        });
        return;
      }
      window.open(fallbackWidget, "_blank", "noopener,noreferrer");
      return;
    }

    appendBookModalSummary(bookDlgBody, cls);
    bookDlgTitle.textContent = "Book this class";
    bookDlgActions.replaceChildren();

    if (!oauthLoggedIn) {
      const hint = document.createElement("p");
      hint.className = "mb-book-dialog__hint form-sent-dialog__text";
      hint.textContent =
        "Sign in with your Mindbody member account to book here with API. New clients: open Mindbody to create an account and purchase visits, then sign in.";
      bookDlgActions.append(hint);

      const row = document.createElement("div");
      row.className = "mb-book-dialog__cta-row";

      const signIn = document.createElement("a");
      signIn.className = "btn btn--cream";
      signIn.href = oauthStartHref();
      signIn.textContent = "Sign in with Mindbody";

      const signUp = document.createElement("a");
      signUp.className = "btn btn--ghost";
      signUp.href = consumerSignupHref();
      signUp.target = "_blank";
      signUp.rel = "noopener noreferrer";
      signUp.textContent = (cfg.signupUrl || "").trim()
        ? "Create account — Mindbody"
        : "Sign up — open booking widget";

      row.append(signIn, signUp);
      bookDlgActions.append(row);

      const quiet = document.createElement("p");
      quiet.className = "mb-book-dialog__quiet";
      const qLink = document.createElement("a");
      qLink.className = "link-quiet";
      qLink.href = fallbackWidget;
      qLink.target = "_blank";
      qLink.rel = "noopener noreferrer";
      qLink.textContent = "Book in a new tab (no account on this step)";
      quiet.append(qLink);
      bookDlgActions.append(quiet);

      bookDlg.showModal();
      return;
    }

    const whoEl = document.createElement("p");
    whoEl.className = "mb-book-dialog__account form-sent-dialog__text";
    whoEl.textContent = oauthWho ? `Signed in as ${oauthWho}` : "Signed in.";
    bookDlgActions.append(whoEl);

    const row = document.createElement("div");
    row.className = "mb-book-dialog__cta-row";

    const dismissDlg = document.createElement("button");
    dismissDlg.type = "button";
    dismissDlg.className = "btn btn--ghost";
    dismissDlg.textContent = "Close";
    dismissDlg.addEventListener("click", () => {
      bookDlg.close();
    });

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "btn btn--cream";
    confirm.textContent = "Confirm booking";
    confirm.disabled = cid == null;
    confirm.addEventListener("click", async () => {
      if (cid == null) return;
      dismissDlg.disabled = true;
      confirm.disabled = true;
      confirm.textContent = "Booking…";
      const result = await bookClassViaApi(cid);
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent = result.ok ? "You’re booked" : "Booking didn’t complete";
      bookDlgBody.append(
        (() => {
          const fb = document.createElement("p");
          fb.className = "mb-book-dialog__result";
          fb.textContent = result.message;
          return fb;
        })(),
      );
      bookDlgActions.replaceChildren();
      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn btn--cream mb-book-dialog__ok";
      done.textContent = result.ok ? "Done" : "Close";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok) window.location.reload();
      });
      bookDlgActions.append(done);
      if (!result.ok) {
        const retryRow = document.createElement("div");
        retryRow.className = "mb-book-dialog__cta-row";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn btn--ghost";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => openBookFlow(cls));
        retryRow.append(retry);
        bookDlgActions.append(retryRow);
      }
    });

    row.append(dismissDlg, confirm);
    bookDlgActions.append(row);

    bookDlg.showModal();
  }

  /** Release a spot (`/api/mindbody/class/cancel`). Uses visit id from member summary enrollment map. */
  function openCancelReservationFlow(cls, visitId) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const vid =
      typeof visitId === "number" ? visitId : typeof visitId === "string" ? parseInt(visitId, 10) : NaN;
    if (cid == null || !Number.isFinite(vid) || vid <= 0) return;

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (!window.confirm("Cancel this reservation? Studio cancellation rules still apply.")) return;
      void cancelBookingViaApi(cid, vid).then((r) => {
        if (r.ok) window.location.reload();
        else window.alert(r.message);
      });
      return;
    }

    appendBookModalSummary(bookDlgBody, cls);
    bookDlgTitle.textContent = "Cancel booking";
    bookDlgActions.replaceChildren();

    const hint = document.createElement("p");
    hint.className = "mb-book-dialog__hint form-sent-dialog__text";
    hint.textContent =
      "Remove your spot in this class? Late-cancel and no-show rules from the studio still apply.";
    bookDlgActions.append(hint);

    const row = document.createElement("div");
    row.className = "mb-book-dialog__cta-row";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn--ghost";
    keep.textContent = "Keep reservation";
    keep.addEventListener("click", () => bookDlg.close());

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--cream";
    remove.textContent = "Confirm cancel";
    remove.addEventListener("click", async () => {
      keep.disabled = true;
      remove.disabled = true;
      remove.textContent = "Cancelling…";
      const result = await cancelBookingViaApi(cid, vid);
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent = result.ok ? "Booking cancelled" : "Cancellation didn’t complete";
      bookDlgBody.append(
        (() => {
          const fb = document.createElement("p");
          fb.className = "mb-book-dialog__result";
          fb.textContent = result.message;
          return fb;
        })(),
      );
      bookDlgActions.replaceChildren();
      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn btn--cream mb-book-dialog__ok";
      done.textContent = result.ok ? "Done" : "Close";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok) window.location.reload();
      });
      bookDlgActions.append(done);
      if (!result.ok) {
        const retryRow = document.createElement("div");
        retryRow.className = "mb-book-dialog__cta-row";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn btn--ghost";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => openCancelReservationFlow(cls, vid));
        retryRow.append(retry);
        bookDlgActions.append(retryRow);
      }
    });

    row.append(keep, remove);
    bookDlgActions.append(row);
    bookDlg.showModal();
  }

  if (useBookDialog && bookDlg && bookDlgX) {
    bookDlgX.addEventListener("click", () => bookDlg.close());
    bookDlg.addEventListener("click", (ev) => {
      if (ev.target === bookDlg) bookDlg.close();
    });
  }

  async function load() {
    if (!url) return;

    statusEl.textContent = "Loading classes…";
    statusEl.classList.remove("mb-schedule-api__status--error");
    oauthLoggedIn = false;
    oauthWho = "";
    enrollVisitByClassId = new Map();

    /** @type {RequestInit} */
    const fetchOpts = {
      credentials: "omit",
      mode: "cors",
      headers: ngrokBypassHeaders({ Accept: "application/json" }),
    };
    /** @type {RequestInit} */
    const sessionOpts = {
      credentials: "include",
      headers: ngrokBypassHeaders({ Accept: "application/json" }),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      const sig = AbortSignal.timeout(28000);
      fetchOpts.signal = sig;
      sessionOpts.signal = sig;
    }

    const sessionUrl =
      apiOrigin !== ""
        ? `${apiOrigin}/api/mindbody/oauth/session`
        : `/api/mindbody/oauth/session`;

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
          if (oauthLoggedIn && sj && typeof sj === "object") {
            const j = /** @type {Record<string, unknown>} */ (sj);
            const gn = typeof j.given_name === "string" ? j.given_name : "";
            const fn = typeof j.family_name === "string" ? j.family_name : "";
            const nm =
              (typeof j.name === "string" && j.name.trim()
                ? j.name.trim()
                : typeof j.displayName === "string" && j.displayName.trim()
                  ? j.displayName.trim()
                  : `${gn} ${fn}`.trim()) || "";
            const em = typeof j.email === "string" ? j.email : "";
            oauthWho = em && nm ? `${nm} (${em})` : em || nm || "Member";
          } else {
            oauthWho = "";
          }
        } catch {
          oauthLoggedIn = false;
          oauthWho = "";
        }
      } else {
        oauthWho = "";
      }
    } catch {
      surface.setAttribute("aria-busy", "false");
      calendarEl.hidden = true;
      filtersEl.hidden = true;
      statusEl.classList.add("mb-schedule-api__status--error");
      statusEl.textContent =
        "Could not reach the schedule API (`/api/mindbody/...`). For local dev run `npm run dev` (unified server), or set SCHEDULE_PROXY_BASE and run a proxy on that host.";
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
      const sample = text.slice(0, 280);
      const looksHtml = /^\s*</.test(text) || /\bngrok\b/i.test(sample);
      const hint = looksHtml
        ? " Response looks like HTML (ngrok warning page, or `/api` not routed)—see Network tab."
        : "";
      statusEl.textContent = `Invalid JSON from proxy (HTTP ${res.status}).${hint}`;
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

      enrollVisitByClassId = new Map();
      if (oauthLoggedIn && allRows.length > 0) {
        try {
          const summaryOpts = {
            credentials: "include",
            headers: ngrokBypassHeaders({ Accept: "application/json" }),
          };
          if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
            Object.assign(summaryOpts, { signal: AbortSignal.timeout(20000) });
          }
          const sumRes = await fetch(memberSummaryUrl(), summaryOpts);
          if (sumRes.ok) {
            const sumPayload = await sumRes.json().catch(() => null);
            if (sumPayload && typeof sumPayload === "object") {
              enrollVisitByClassId = buildEnrollmentVisitMap(
                /** @type {{ clientVisits?: unknown }} */ (sumPayload),
              );
            }
          }
        } catch {
          /* schedule still renders; Cancel booking may be unavailable until refresh */
        }
      }

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
})();
