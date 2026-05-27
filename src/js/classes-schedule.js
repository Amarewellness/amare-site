/* Mindbody GET /public/v6/class/classes — day strip inside .mb-frame, one day list at a time (ET).
 * Class descriptions come from each row's embedded `ClassDescription.Description` (same data as
 * Get Class Descriptions, without a second API call). Booking templates: MINDBODY_BOOK_URL_TEMPLATE (see docs/MINDBODY.md).
 */
(function () {
  const TZ = "America/New_York";
  const DAY_STRIP_LEN = 14;
  /** Qualitative urgency — thresholds vary by room size (see `isFewSpotsClass`). */
  const POPULAR_OCCUPANCY_LARGE = 0.7;
  /** Small room (Reformer-sized): few spots ≤ this capacity tier. */
  const CAPACITY_TIER_SMALL = 9;
  /** Mid room tier upper bound (inclusive). */
  const CAPACITY_TIER_MID = 13;
  /** Few spots left — max remaining spots by tier (small / mid). */
  const FEW_SPOTS_MAX_SMALL = 3;
  const FEW_SPOTS_MAX_MID = 5;
  /** Popular — min remaining spots above the few-spots window. */
  const POPULAR_MIN_SPOTS_SMALL = 4;
  const POPULAR_MIN_SPOTS_MID = 6;
  /** Popular — min booked count by tier. */
  const POPULAR_MIN_BOOKED_SMALL = 5;
  const POPULAR_MIN_BOOKED_MID = 6;
  /** Prime time window (ET, weekdays): inclusive 5:30 PM – 7:30 PM class start. */
  const PRIME_TIME_START_MIN = 17 * 60 + 30;
  const PRIME_TIME_END_MIN = 19 * 60 + 30;
  /** Prime time also requires meaningful demand — avoids badge on every evening row. */
  const PRIME_TIME_MIN_BOOKED = 3;

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

  /** @param {string} html */
  function plainTextFromHtml(html) {
    if (!html.trim()) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * Mindbody class descriptions arrive as HTML from Get Classes (`ClassDescription.Description`).
   * Strip executable content; keep basic formatting tags only.
   * @param {string} html
   */
  function sanitizeClassDescriptionHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed, link, meta, form").forEach((el) => {
      el.remove();
    });
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        if (n.startsWith("on") || n === "srcdoc") el.removeAttribute(attr.name);
        else if (n === "href" && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    });
    return doc.body.innerHTML.trim();
  }

  /** @param {MBClass} cls */
  function classDetailsHtml(cls) {
    const cd = classDescFromCls(cls);
    if (!cd || typeof cd !== "object") return "";
    /** @type {Record<string, unknown>} */
    const o = cd;
    const rawDesc = typeof o.Description === "string" ? o.Description : "";
    if (!plainTextFromHtml(rawDesc)) return "";
    return sanitizeClassDescriptionHtml(rawDesc);
  }

  /**
   * @param {HTMLElement} body
   * @param {string} detailsHtml
   */
  function appendClassDetailsToggle(body, detailsHtml) {
    const panelId = `mb-slot-details-${Math.random().toString(36).slice(2, 10)}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mb-schedule-slot__details-toggle";
    toggle.textContent = "Show details";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", panelId);

    const panel = document.createElement("div");
    panel.id = panelId;
    panel.className = "mb-schedule-slot__details";
    panel.hidden = true;
    panel.innerHTML = detailsHtml;

    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      panel.hidden = open;
      toggle.textContent = open ? "Show details" : "Hide details";
    });

    body.append(toggle, panel);
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
   * Studio's late-cancellation window (matches the value configured in Mindbody
   * Manager → Settings → Studio Setup → Late Cancellation Settings, currently 12
   * hours). The actual decision is still Mindbody's — we only use this client-side
   * value to (a) pre-warn the user before they confirm, and (b) decide which
   * "after-cancel" copy to show when Mindbody's response did not include
   * `LateCancelled`. Update both numbers if studio policy changes.
   */
  const LATE_CANCEL_HOURS = 12;

  /** @param {Date | null | undefined} start */
  function isWithinLateCancelWindow(start) {
    if (!start || !Number.isFinite(start.getTime())) return false;
    const msUntilStart = start.getTime() - Date.now();
    if (msUntilStart <= 0) return true;
    return msUntilStart < LATE_CANCEL_HOURS * 60 * 60 * 1000;
  }

  /** @param {MBClass} cls */
  function shouldShowJoinWaitlist(cls) {
    const wl = cls.IsWaitlistAvailable === true || cls.isWaitlistAvailable === true;
    if (!wl) return false;
    const avail = cls.IsAvailable ?? cls.isAvailable;
    if (avail === false) return true;
    if (avail === true) return false;
    return true;
  }

  /** @param {MBClass} cls @param {string[]} keys */
  function numFieldFromCls(cls, keys) {
    for (const k of keys) {
      const v = cls[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  }

  /**
   * Remaining spots from cached schedule (staff-authenticated Get Classes).
   * Prefers MaxCapacity − TotalBooked; falls back to WebCapacity − booked.
   * @param {MBClass} cls
   * @returns {number | null}
   */
  function spotsRemainingFromCls(cls) {
    const maxCap = numFieldFromCls(cls, ["MaxCapacity", "maxCapacity"]);
    const totalBooked = numFieldFromCls(cls, ["TotalBooked", "totalBooked"]);
    if (maxCap != null && totalBooked != null) {
      return Math.max(0, Math.trunc(maxCap - totalBooked));
    }

    const webCap = numFieldFromCls(cls, ["WebCapacity", "webCapacity"]);
    if (webCap == null) return null;
    const webBooked = numFieldFromCls(cls, ["WebBooked", "webBooked"]);
    const booked = webBooked ?? totalBooked ?? 0;
    return Math.max(0, Math.trunc(webCap - booked));
  }

  /** @param {MBClass} cls */
  function bookedCountFromCls(cls) {
    return numFieldFromCls(cls, ["TotalBooked", "totalBooked"]) ?? 0;
  }

  /** @param {MBClass} cls */
  function maxCapacityFromCls(cls) {
    const maxCap = numFieldFromCls(cls, ["MaxCapacity", "maxCapacity"]);
    if (maxCap != null && maxCap > 0) return Math.trunc(maxCap);
    const webCap = numFieldFromCls(cls, ["WebCapacity", "webCapacity"]);
    if (webCap != null && webCap > 0) return Math.trunc(webCap);
    return null;
  }

  /**
   * @param {MBClass} cls
   * @returns {{ capacity: number | null; booked: number; spots: number | null; occupancy: number | null }}
   */
  function classCapacitySnapshot(cls) {
    const capacity = maxCapacityFromCls(cls);
    const booked = bookedCountFromCls(cls);
    const spots = spotsRemainingFromCls(cls);
    const occupancy =
      capacity != null && capacity > 0 ? booked / capacity : null;
    return { capacity, booked, spots, occupancy };
  }

  /** @param {MBClass} cls */
  function isFewSpotsClass(cls) {
    const { capacity, spots } = classCapacitySnapshot(cls);
    if (spots == null || spots <= 0 || capacity == null || capacity <= 0) return false;

    if (capacity <= CAPACITY_TIER_SMALL) return spots <= FEW_SPOTS_MAX_SMALL;
    if (capacity <= CAPACITY_TIER_MID) return spots <= FEW_SPOTS_MAX_MID;
    const fewSpotsCeiling = Math.max(1, Math.floor(capacity * 0.2));
    return spots <= fewSpotsCeiling;
  }

  /** @param {MBClass} cls */
  function isPopularClass(cls) {
    const { capacity, booked, spots, occupancy } = classCapacitySnapshot(cls);
    if (capacity == null || capacity <= 0 || spots == null) return false;

    if (capacity <= CAPACITY_TIER_SMALL) {
      return booked >= POPULAR_MIN_BOOKED_SMALL && spots >= POPULAR_MIN_SPOTS_SMALL;
    }
    if (capacity <= CAPACITY_TIER_MID) {
      return booked >= POPULAR_MIN_BOOKED_MID && spots >= POPULAR_MIN_SPOTS_MID;
    }
    return occupancy != null && occupancy >= POPULAR_OCCUPANCY_LARGE;
  }

  /** @param {Date} start */
  function minutesSinceMidnightEt(start) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(start);
    /** @type {Record<string, string>} */
    const m = {};
    for (const p of parts) {
      if (p.type !== "literal") m[p.type] = p.value;
    }
    const hour = parseInt(m.hour ?? "0", 10);
    const minute = parseInt(m.minute ?? "0", 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  }

  /** @param {Date} start */
  function isWeekdayEt(start) {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(start);
    return day !== "Sat" && day !== "Sun";
  }

  /** @param {MBClass} cls */
  function isPrimeTimeClass(cls) {
    const start = parseIso(classStartIsoFromCls(cls));
    if (!start || !isWeekdayEt(start)) return false;
    const mins = minutesSinceMidnightEt(start);
    if (mins == null) return false;
    if (mins < PRIME_TIME_START_MIN || mins > PRIME_TIME_END_MIN) return false;
    return bookedCountFromCls(cls) >= PRIME_TIME_MIN_BOOKED;
  }

  /** Class display name only — intro-friendly is driven by title, not description copy. */
  function classNameBlob(cls) {
    return classTitle(classDescFromCls(cls)).toLowerCase();
  }

  /** @param {MBClass} cls */
  function isIntroFriendlyClass(cls) {
    const name = classNameBlob(cls);
    if (/\b(intermediate|advanced|intensive|kangoo)\b/.test(name)) return false;

    // All Mat classes are intro-friendly; heated/burn/sculpt/spicy in the title do not disqualify.
    if (/\bmat\b/.test(name)) return true;

    if (
      !/\b(all\s+levels|beginner|beginners|foundations|intro|introduction)\b/.test(name)
    ) {
      return false;
    }
    if (/\b(heated|burn|sculpt|spicy)\b/.test(name)) return false;
    return true;
  }

  /**
   * @typedef {{ label: string; type: "few-spots" | "popular" | "prime-time" | "intro-friendly" }} ClassBadge
   */

  /**
   * Urgency / demand badge — at most one of few-spots, popular, or prime-time.
   * @param {MBClass} cls
   * @param {{ elapsed: boolean; isEnrolled: boolean; onWaitlist: boolean; showJoinWaitlist: boolean }} state
   * @returns {ClassBadge | null}
   */
  function getClassPrimaryBadge(cls, state) {
    if (state.elapsed || state.isEnrolled || state.onWaitlist || state.showJoinWaitlist) return null;

    const avail = cls.IsAvailable ?? cls.isAvailable;

    if (avail !== false && isFewSpotsClass(cls)) {
      return { label: "Few spots left", type: "few-spots" };
    }

    if (avail !== false && isPopularClass(cls)) {
      return { label: "Popular", type: "popular" };
    }

    if (isPrimeTimeClass(cls)) {
      return { label: "Prime time", type: "prime-time" };
    }

    return null;
  }

  /**
   * Primary badge (if any) plus Intro friendly when the class title qualifies — max two badges.
   * @param {MBClass} cls
   * @param {{ elapsed: boolean; isEnrolled: boolean; onWaitlist: boolean; showJoinWaitlist: boolean }} state
   * @returns {ClassBadge[]}
   */
  function getClassBadges(cls, state) {
    if (state.elapsed || state.isEnrolled || state.onWaitlist || state.showJoinWaitlist) {
      return [];
    }

    /** @type {ClassBadge[]} */
    const badges = [];
    const primary = getClassPrimaryBadge(cls, state);
    if (primary) badges.push(primary);
    if (isIntroFriendlyClass(cls)) {
      badges.push({ label: "Intro friendly", type: "intro-friendly" });
    }
    return badges;
  }

  /** @param {ClassBadge["type"]} type */
  function classBadgeTitle(type) {
    if (type === "few-spots") {
      return "This class is nearly full. Spots shown here may lag live bookings by a few minutes.";
    }
    if (type === "popular") return "Strong booking demand for this class size.";
    if (type === "prime-time") return "A busy weekday evening slot — booking ahead is recommended.";
    if (type === "intro-friendly") return "Welcoming if you're new or easing back in.";
    return "";
  }

  /**
   * @param {HTMLElement} actions
   * @param {MBClass} cls
   * @param {{ elapsed: boolean; isEnrolled: boolean; onWaitlist: boolean; showJoinWaitlist: boolean }} state
   */
  function appendClassBadge(actions, cls, state) {
    for (const badge of getClassBadges(cls, state)) {
      const el = document.createElement("span");
      el.className = `mb-schedule-slot__badge mb-schedule-slot__badge--${badge.type}`;
      el.textContent = badge.label;
      const title = classBadgeTitle(badge.type);
      if (title) el.title = title;
      actions.append(el);
    }
  }

  /** @param {Record<string, unknown>} v */
  function visitRowIsWaitlist(v) {
    for (const k of ["Waitlist", "waitlist", "OnWaitlist", "onWaitlist", "IsWaitlist", "isWaitlist"]) {
      const f = v[k];
      if (f === true || f === 1 || f === "true" || f === "1") return true;
    }
    const action = String(v.Action ?? v.action ?? v.VisitType ?? v.visitType ?? "").toLowerCase();
    return /\bwaitlist\b/.test(action);
  }

  /**
   * @param {HTMLElement} slot
   * @param {MBClass} cls
   * @param {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string; signupUrl?: string }} cfg
   * @param {(c: MBClass) => void} onBookClick
   * @param {(c: MBClass, visitId: number) => void} onCancelClick
   * @param {(c: MBClass) => void} onJoinWaitlistClick
   * @param {(c: MBClass, waitlistEntryId: number) => void} onLeaveWaitlistClick
   */
  function renderSlot(
    slot,
    cls,
    cfg,
    onBookClick,
    onCancelClick,
    onJoinWaitlistClick,
    onLeaveWaitlistClick,
  ) {
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
    /**
     * Badges per row: one urgency badge (few-spots / popular / prime-time) plus optional Intro friendly.
     */
    meta.textContent = parts.join(" · ");

    body.append(title, meta);
    const detailsHtml = classDetailsHtml(cls);
    if (detailsHtml) appendClassDetailsToggle(body, detailsHtml);

    const actions = document.createElement("div");
    actions.className = "mb-schedule-slot__actions";

    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const visitForCancel = cid != null ? enrollVisitByClassId.get(cid) : undefined;
    const isEnrolled = oauthLoggedIn && visitForCancel != null;
    const waitlistEntryForLeave =
      !isEnrolled && cid != null ? waitlistEntryByClassId.get(cid) : undefined;
    const onWaitlist = oauthLoggedIn && waitlistEntryForLeave != null;
    const showJoinWaitlist =
      oauthLoggedIn && !isEnrolled && !onWaitlist && shouldShowJoinWaitlist(cls);

    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = oauthLoggedIn
      ? "btn mb-schedule-slot__book mb-schedule-slot__book--api"
      : "btn mb-schedule-slot__book";
    if (elapsed) primary.classList.add("mb-schedule-slot__book--elapsed");

    if (isEnrolled) {
      primary.textContent = "Book";
      primary.disabled = true;
      primary.title = "You’re already booked into this class — use Cancel booking to release your spot.";
    } else if (onWaitlist) {
      primary.textContent = "Leave waitlist";
      primary.disabled = cid == null || elapsed;
      primary.title = elapsed
        ? "This class has already started (schedule time · Eastern)."
        : "Leave the waitlist for this class.";
      primary.addEventListener("click", () => {
        if (waitlistEntryForLeave != null) onLeaveWaitlistClick(cls, waitlistEntryForLeave);
      });
    } else if (showJoinWaitlist) {
      primary.textContent = "Join waitlist";
      primary.disabled = cid == null || elapsed;
      primary.title = elapsed
        ? "This class has already started (schedule time · Eastern)."
        : "Join the waitlist — we’ll email you if a spot opens.";
      primary.addEventListener("click", () => onJoinWaitlistClick(cls));
    } else {
      primary.textContent = "Book";
      primary.disabled = cid == null || elapsed;
      primary.title = elapsed
        ? "This class has already started (schedule time · Eastern)."
        : cid == null
          ? "This session has no class id from Mindbody."
          : oauthLoggedIn
            ? "Confirm and book this class with your Mindbody account."
            : "Sign in or complete signup in Mindbody to book.";
      primary.addEventListener("click", () => onBookClick(cls));
    }

    appendClassBadge(actions, cls, {
      elapsed,
      isEnrolled,
      onWaitlist,
      showJoinWaitlist,
    });
    actions.append(primary);

    if (isEnrolled && visitForCancel != null) {
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
  const walletRootEl = /** @type {HTMLElement|null} */ (document.getElementById("mb-schedule-wallet"));

  /** Class credits punch widget — `@/js/mindbody-wallet-widget.js` */
  function scheduleWalletBars(mode, /** @type {Record<string, unknown> | null} */ payload) {
    const rw = typeof globalThis.mbWalletRenderInto === "function" ? globalThis.mbWalletRenderInto : null;
    if (!walletRootEl || !rw) return;
    rw(walletRootEl, payload, mode);
    document.dispatchEvent(
      new CustomEvent("mb-schedule-member-summary-loaded", {
        detail: { ok: mode === "ok", mode },
      }),
    );
  }

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

  /** Default monthly contract rows if build embed is missing (parity with `pricing-api.js`). */
  const DEFAULT_MONTHLY_CONTRACT_FALLBACK = [
    { name: "Recurring 5", contractProductId: 101, checkoutServiceId: 100129, price: 125 },
    { name: "Recurring 8", contractProductId: 102, checkoutServiceId: 100130, price: 179 },
    { name: "Unlimited", contractProductId: 100, checkoutServiceId: 100056, price: 229 },
  ];

  /** @type {{ siteId: string; bookUrlTemplate: string; bookingWidgetHref: string; signupUrl?: string; classicStudioId?: string; packageSaleType?: string; contractSaleType?: string; monthlyProductIds?: string[]; saleLocationId?: string; monthlyContractFallback?: unknown[] }} */
  let cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
    if (!cfg.siteId) cfg.siteId = "-99";
    if (!cfg.bookUrlTemplate) cfg.bookUrlTemplate = "";
    if (!cfg.bookingWidgetHref) cfg.bookingWidgetHref = "classes.html";
    if (typeof cfg.signupUrl !== "string") cfg.signupUrl = "";
    if (typeof cfg.classicStudioId !== "string") cfg.classicStudioId = "";
    if (typeof cfg.packageSaleType !== "string") cfg.packageSaleType = "43";
    if (typeof cfg.contractSaleType !== "string") cfg.contractSaleType = "40";
    if (!Array.isArray(cfg.monthlyProductIds)) cfg.monthlyProductIds = ["100", "101", "102"];
    if (typeof cfg.saleLocationId !== "string" || !String(cfg.saleLocationId).trim())
      cfg.saleLocationId = "1";
    if (!Array.isArray(cfg.monthlyContractFallback)) cfg.monthlyContractFallback = DEFAULT_MONTHLY_CONTRACT_FALLBACK;
  } catch {
    cfg = {
      siteId: "-99",
      bookUrlTemplate: "",
      bookingWidgetHref: "classes.html",
      signupUrl: "",
      classicStudioId: "",
      packageSaleType: "43",
      contractSaleType: "40",
      monthlyProductIds: ["100", "101", "102"],
      saleLocationId: "1",
      monthlyContractFallback: DEFAULT_MONTHLY_CONTRACT_FALLBACK,
    };
  }

  /**
   * Stripe Express Checkout SKU map (from `mb-stripe-onetime-config`, injected by build.mjs).
   * Used by the booking-fail dialog to route the buyer to Express (Apple Pay / Google Pay /
   * card / Link) instead of Mindbody Classic for SKUs that are eligible. Recurring memberships
   * and any SKU not in `expressEnabledSkus` continue to fall through to the existing Classic
   * checkout flow (one-time SKUs are eligible; subscriptions need `mindbody-sale-purchase-contract`
   * which Stripe Express doesn't support).
   *
   * @type {{ enabled: boolean; apiPath: string; expressEnabledServiceIds: number[]; expressEnabledSkus: { localSku: string; displayName: string; mindbodyServiceId: number | null }[] }}
   */
  let stripeOneTimeCfg = {
    enabled: false,
    apiPath: "/api/stripe/checkout/create-session",
    expressEnabledServiceIds: [],
    expressEnabledSkus: [],
  };
  try {
    const sEl = document.getElementById("mb-stripe-onetime-config");
    if (sEl?.textContent) {
      const parsed = JSON.parse(sEl.textContent);
      if (parsed && typeof parsed === "object") stripeOneTimeCfg = { ...stripeOneTimeCfg, ...parsed };
    }
  } catch {
    /* keep defaults — Express won't be offered, falls back to Classic. */
  }
  const stripeExpressEnabledServiceIdSet = new Set(
    (stripeOneTimeCfg.expressEnabledServiceIds || []).filter(
      (n) => typeof n === "number" && Number.isFinite(n),
    ),
  );

  /**
   * Resolve a checkout-row sale to a Stripe Express Checkout SKU when the row's Mindbody
   * service id is on the express-enabled list. Returns null for ineligible rows (recurring
   * memberships, SKUs not yet enabled for Express, or when the express feature is off).
   *
   * @param {number | null | undefined} sid Mindbody service id (`mindbodyCheckoutServiceIdFromSaleRow`).
   * @returns {{ localSku: string; displayName: string } | null}
   */
  function expressMatchForServiceId(sid) {
    if (!stripeOneTimeCfg.enabled) return null;
    if (typeof sid !== "number" || !Number.isFinite(sid) || sid <= 0) return null;
    if (!stripeExpressEnabledServiceIdSet.has(sid)) return null;
    const match = (stripeOneTimeCfg.expressEnabledSkus || []).find(
      (e) => e && typeof e === "object" && e.mindbodyServiceId === sid,
    );
    if (!match || !match.localSku) return null;
    return { localSku: match.localSku, displayName: match.displayName || "" };
  }

  /** @param {string} path */
  function expressApiUrl(path) {
    return apiOrigin !== "" ? `${apiOrigin}${path}` : path;
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
  /** From `/oauth/session` — false when Consumer is not studio-associated (can have credits but no self-serve BOOK). */
  let oauthBookingAllowed = true;
  /** `ready` | `not_associated` | `ambiguous_studio_client` | `apple_relay_email` | … from `/oauth/session`. */
  let oauthLinkStatus = "";

  /** Display label from `/oauth/session` (mirrors strip copy). */
  let oauthWho = "";

  /** Class id (Mindbody class instance) → visit id for upcoming enrollment; filled from member summary when signed in. */
  let enrollVisitByClassId = new Map();

  /** Class id → waitlist entry id; filled from member summary when signed in. */
  let waitlistEntryByClassId = new Map();

  /**
   * Background member-summary load tracking.
   *
   * `/api/mindbody/member/summary` is uncached (`Cache-Control: no-store`) and routinely takes
   * 1–2 s — it fans out to multiple Mindbody Public API calls. Awaiting it before rendering
   * the schedule (the original PR-1 flow) negated the entire benefit of CDN-caching
   * `/api/mindbody/class/classes`: logged-in members still saw "Loading classes…" for the full
   * summary round-trip. The fix is to render the schedule immediately and fetch the summary in
   * the background, then re-render once it lands so any classes the member already booked flip
   * from "Book" → "Cancel".
   *
   * `loadEpoch` increments on every `load()` call. The in-flight summary's epoch is captured
   * at fetch start and compared on resolve — stale results from a previous `load()` (e.g. user
   * hit "Refresh schedule" mid-summary, or another book/cancel triggered a reload) are
   * discarded so they cannot clobber state from a newer load.
   *
   * `memberSummaryAbortCtrl` is aborted by every new `load()` so the previous in-flight
   * Mindbody fan-out is dropped — important on slow networks where stacking 2–3 summary
   * requests would needlessly burn quota.
   */
  let loadEpoch = 0;
  /** @type {AbortController | null} */
  let memberSummaryAbortCtrl = null;

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

  /** Intro “Sign up here” → Mindbody OAuth (`/api/mindbody/oauth/start`), or `MINDBODY_CONSUMER_SIGNUP_URL` when set — not `classes.html`. */
  const signupLinkEl = /** @type {HTMLAnchorElement | null} */ (document.getElementById("mb-schedule-signup-link"));
  if (signupLinkEl) {
    const su = (cfg.signupUrl || "").trim();
    if (su) {
      signupLinkEl.href = su;
      signupLinkEl.target = "_blank";
      signupLinkEl.rel = "noopener noreferrer";
    } else {
      signupLinkEl.href = oauthStartHref();
      signupLinkEl.removeAttribute("target");
      signupLinkEl.removeAttribute("rel");
    }
  }

  /**
   * “Buy” from schedule modal → Pricing page auto-opens checkout for this `serviceId` when signed in.
   * Consumed by `pricing-api.js` (`mb_pending_signup_sale_service`).
   */
  const MB_PENDING_PRICING_CHECKOUT_SERVICE = "mb_pending_signup_sale_service";

  function pricingApiPageHref() {
    try {
      if (typeof window === "undefined") return "/pricing.html";
      return "/pricing.html" + (window.location.search || "");
    } catch {
      return "/pricing.html";
    }
  }

  /** @param {unknown} data */
  function servicesRowsFromSaleServicesPayloadMindbody(data) {
    if (!data || typeof data !== "object") return [];
    const d = /** @type {Record<string, unknown>} */ (data);
    /** @param {unknown} obj */
    function fromKnownKeys(obj) {
      if (!obj || typeof obj !== "object") return [];
      const o = /** @type {Record<string, unknown>} */ (obj);
      for (const key of ["Services", "services"]) {
        const v = o[key];
        if (Array.isArray(v)) {
          return v
            .filter((row) => row != null && typeof row === "object")
            .map((row) => /** @type {Record<string, unknown>} */ (row));
        }
      }
      return [];
    }
    let rows = fromKnownKeys(d);
    if (rows.length) return rows;
    const pr = d.PaginationResponse ?? d.paginationResponse;
    return fromKnownKeys(pr);
  }

  /** @param {Record<string, unknown>} row */
  function onlineUsdFromSaleRow(row) {
    const candidates = ["OnlinePrice", "onlinePrice", "Price", "price", "CurrentPrice", "RetailPrice", "retailPrice"];
    for (const k of candidates) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      if (typeof v === "string" && v.trim()) {
        const n = Number.parseFloat(v.trim());
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  }

  /** @param {Record<string, unknown>} row */
  function mindbodyCheckoutServiceIdFromSaleRow(row) {
    const sid = row.Id ?? row.ID ?? row.ServiceId ?? row.serviceId;
    if (typeof sid === "number" && Number.isFinite(sid) && sid > 0) return sid;
    if (typeof sid === "string" && /^\d+$/.test(sid.trim())) return parseInt(sid.trim(), 10);
    return NaN;
  }

  /** @param {Record<string, unknown>} row */
  function displayNameFromSaleRow(row) {
    const program = row.Program ?? row.program;
    if (program && typeof program === "object") {
      const p = /** @type {Record<string, unknown>} */ (program);
      const pn = typeof p.Name === "string" && p.Name.trim() ? p.Name.trim() : "";
      if (pn) return pn;
    }
    const nm = typeof row.Name === "string" ? row.Name.trim() : "";
    return nm || "Service";
  }

  async function fetchSellOnlineServiceCatalogRows() {
    const base =
      apiOrigin !== "" ? `${apiOrigin}/api/mindbody/sale/services` : `/api/mindbody/sale/services`;
    const qs = "?SellOnline=true&Limit=200";
    const res = await fetch(base + qs, {
      credentials: "omit",
      headers: ngrokBypassHeaders({ Accept: "application/json" }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return [];
    return servicesRowsFromSaleServicesPayloadMindbody(j);
  }

  /** @param {unknown} data */
  function rowsFromContractsPayloadBooking(data) {
    if (!data || typeof data !== "object") return [];
    const d = /** @type {Record<string, unknown>} */ (data);
    for (const key of ["Contracts", "contracts"]) {
      const v = d[key];
      if (Array.isArray(v)) return /** @type {Record<string, unknown>[]} */ (v);
    }
    return [];
  }

  /**
   * Map a `/sale/contracts` row into `/sale/services`-like fields (mirrors `pricing-api.js` `normalizeContractRow`).
   * @param {unknown} c
   * @returns {Record<string, unknown> | null}
   */
  function normalizeContractRowForBookingFail(c) {
    const r = /** @type {Record<string, unknown>} */ (c);
    const items = Array.isArray(r.ContractItems) ? r.ContractItems : [];
    const first = items[0] && typeof items[0] === "object" ? /** @type {Record<string, unknown>} */ (items[0]) : null;
    const optIdRaw = first?.Id ?? first?.ID ?? null;
    let optId = null;
    if (typeof optIdRaw === "string" && /^\d+$/.test(optIdRaw.trim())) optId = parseInt(optIdRaw.trim(), 10);
    else if (typeof optIdRaw === "number" && Number.isFinite(optIdRaw) && optIdRaw > 0) optId = optIdRaw;

    const cidRaw = r.Id ?? r.id;
    let contractSaleId = null;
    if (typeof cidRaw === "number" && Number.isFinite(cidRaw) && cidRaw > 0) contractSaleId = cidRaw;
    else if (typeof cidRaw === "string" && /^\d+$/.test(cidRaw.trim())) contractSaleId = parseInt(cidRaw.trim(), 10);

    if (optId == null || contractSaleId == null) return null;

    let price =
      typeof r.RecurringPaymentAmountTotal === "number" && Number.isFinite(r.RecurringPaymentAmountTotal)
        ? r.RecurringPaymentAmountTotal
        : typeof r.FirstPaymentAmountTotal === "number" && Number.isFinite(r.FirstPaymentAmountTotal)
          ? r.FirstPaymentAmountTotal
          : first && typeof first.Price === "number" && Number.isFinite(first.Price)
            ? /** @type {number} */ (first.Price)
            : null;

    const assignMem =
      typeof r.AssignsMembershipName === "string" && r.AssignsMembershipName.trim()
        ? r.AssignsMembershipName.trim()
        : "";
    const rawName = String(r.Name ?? r.name ?? "").trim();
    const label = assignMem || rawName || "Membership";
    const name = label.charAt(0).toUpperCase() + label.slice(1);

    const preservedMt = Array.isArray(r.MembershipTerms)
      ? r.MembershipTerms
      : Array.isArray(r.membershipTerms)
        ? r.membershipTerms
        : [];

    const tac =
      typeof r.TermsAndConditions === "string" && r.TermsAndConditions.trim()
        ? r.TermsAndConditions.trim()
        : typeof r.termsAndConditions === "string" && r.termsAndConditions.trim()
          ? r.termsAndConditions.trim()
          : typeof r.ContractTermsAndConditions === "string" && r.ContractTermsAndConditions.trim()
            ? r.ContractTermsAndConditions.trim()
            : "";

    /** @type {Record<string, unknown>} */
    const out = {
      Name: name,
      Id: optId,
      ProductId: contractSaleId,
      OnlinePrice: price,
      Price: price,
      Description: typeof r.Description === "string" ? r.Description : "",
      ShortDescription:
        typeof r.ShortDescription === "string"
          ? r.ShortDescription
          : typeof first?.Description === "string"
            ? /** @type {string} */ (first.Description)
            : "",
      MembershipTerms: preservedMt.length ? preservedMt : [{ __fromMindbodyContract: true }],
      __mbContract: true,
    };
    if (tac) out.TermsAndConditions = tac;
    else if (typeof r.Agreement === "string" && r.Agreement.trim()) out.TermsAndConditions = r.Agreement.trim();

    return out;
  }

  /** Static fallback when `GET /sale/contracts` fails or returns no sell-online rows (same shape as `pricing-api.js`). */
  function fallbackMonthlyContractRowsFromScheduleCfg() {
    /** @type {Record<string, unknown>[]} */
    const out = [];
    for (const raw of /** @type {unknown[]} */ (cfg.monthlyContractFallback || [])) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const name = String(r.name ?? r.Name ?? "").trim();
      const pid = Number(r.contractProductId ?? r.contractProductID ?? r.ProductId);
      const sid = Number(r.checkoutServiceId ?? r.CheckoutServiceId ?? r.Id);
      const price = Number(r.price ?? r.Price);
      if (!name || !Number.isFinite(pid) || !Number.isFinite(sid)) continue;
      /** @type {Record<string, unknown>} */
      const row = {
        Name: name,
        ProductId: pid,
        Id: sid,
        MembershipTerms: [{ __fromPricingFallbackRow: true }],
        __mbContract: true,
        __pricingFallback: true,
      };
      if (Number.isFinite(price)) {
        row.OnlinePrice = price;
        row.Price = price;
      }
      out.push(row);
    }
    return out;
  }

  async function fetchUnifiedContractsCatalogRows() {
    const loc = encodeURIComponent(String(cfg.saleLocationId ?? "1").trim() || "1");
    const base = apiOrigin !== "" ? `${apiOrigin}/api/mindbody/sale/contracts` : `/api/mindbody/sale/contracts`;
    const qs = `Limit=100&Offset=0&request.locationId=${loc}&request.soldOnline=true`;
    /** @type {Record<string, unknown>[]} */
    let unified = [];
    try {
      const res = await fetch(`${base}?${qs}`, {
        credentials: "omit",
        headers: ngrokBypassHeaders({ Accept: "application/json" }),
      });
      const txt = await res.text();
      let data = null;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = null;
      }
      if (res.ok && data) {
        unified = rowsFromContractsPayloadBooking(data)
          .map((row) => normalizeContractRowForBookingFail(row))
          .filter((x) => x != null);
      }
    } catch {
      unified = [];
    }
    if (!unified.length) unified = fallbackMonthlyContractRowsFromScheduleCfg();
    return unified;
  }

  /**
   * Services first, then `/sale/contracts` rows — skip duplicates by pricing-option keys (same as `pricing-api.js` `mergeMonthlyRows` bump order).
   * @param {Record<string, unknown>[]} serviceRows
   * @param {Record<string, unknown>[]} contractUnified
   */
  function mergeServiceRowsWithContractsForBooking(serviceRows, contractUnified) {
    const seen = new Set();
    /** @type {Record<string, unknown>[]} */
    const combined = [];
    /** @param {Record<string, unknown>} row */
    function bump(row) {
      const ids = rowPricingOptionIdsFromSaleRow(row);
      const key = ids.length ? [...ids].sort().join("|") : `n:${displayNameFromSaleRow(row).toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      combined.push(row);
    }
    for (const row of serviceRows) bump(row);
    for (const row of contractUnified) bump(row);
    return combined;
  }

  /** Numeric ids on a **sale/services** row for monthly contract allowlist (matches `pricing-api.js` `rowPricingOptionIds`). */
  function rowPricingOptionIdsFromSaleRow(/** @type {Record<string, unknown>} */ row) {
    /** @type {string[]} */
    const out = [];
    for (const k of ["ProductId", "productId", "ProductID", "Id", "ID", "ServiceId", "ServiceID"]) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out.push(String(Math.trunc(v)));
      else if (typeof v === "string" && /^\d+$/.test(v.trim())) out.push(v.trim());
    }
    return [...new Set(out)];
  }

  /** @param {Record<string, unknown>} row */
  function matchesMonthlyProductAllowlist(row) {
    const allow = Array.isArray(cfg.monthlyProductIds) ? cfg.monthlyProductIds : [];
    if (!allow.length) return false;
    const set = new Set(allow.map(String));
    for (const id of rowPricingOptionIdsFromSaleRow(row)) {
      if (set.has(id)) return true;
    }
    return false;
  }

  /**
   * `stype=40` (contract) vs `43` (package) classic link — heuristic aligned with `pricing-api.js` `guessContract`.
   * @param {Record<string, unknown>} row
   */
  function guessContractFromSaleServicesRow(row) {
    if (matchesMonthlyProductAllowlist(row)) return true;
    const mt = row.MembershipTerms ?? row.membershipTerms;
    if (Array.isArray(mt) && mt.length > 0) return true;
    const bits = [
      displayNameFromSaleRow(row),
      typeof row.Description === "string" ? row.Description : "",
      typeof row.ShortDescription === "string" ? row.ShortDescription : "",
    ];
    const prog = row.Program ?? row.program;
    if (prog && typeof prog === "object") {
      const p = /** @type {Record<string, unknown>} */ (prog);
      bits.push(String(p.Name ?? p.name ?? ""));
    }
    const blob = bits.join(" ").toLowerCase();
    if (
      /\b(recurring|unlimited|monthly|membership|subscription|autopay|auto-?pay|month\s*to\s*month|month-to-month|contract\s+plan|studio\s+membership)\b/.test(
        blob,
      )
    )
      return true;
    if (/\b\d+\s+classes?\s+(each\s+)?(per\s+)?month\b/.test(blob)) return true;
    if (/\bunlimited\s+(monthly\s+)?classes?\b/.test(blob)) return true;
    const ft = String(row.FrequencyType ?? row.frequencyType ?? row.Frequency ?? "").toLowerCase();
    if (ft && /\b(month|week|year|billing)/.test(ft)) return true;
    const nameOnly = displayNameFromSaleRow(row);
    return /\b(monthly|membership|recurring|subscription|unlimited|per\s*month)\b/i.test(nameOnly);
  }

  /** Mindbody Classic `prodid` — prefers **ProductId**, else service **Id** (same as `pricing-api.js` `productOrServiceId`). */
  function classicProductOrServiceIdFromSaleRow(/** @type {Record<string, unknown>} */ row) {
    const pid = row.ProductId ?? row.productId ?? row.ProductID;
    const sid = row.Id ?? row.ID ?? row.ServiceId ?? row.ServiceID;
    if (typeof pid === "number" && Number.isFinite(pid)) return pid;
    if (typeof pid === "string" && /^\d+$/.test(pid)) return pid;
    if (typeof sid === "number" && Number.isFinite(sid)) return sid;
    if (typeof sid === "string" && /^\d+$/.test(sid)) return sid;
    return null;
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {string | null}
   */
  function mindbodyClassicBuyHrefFromSaleRow(row) {
    const studio = (cfg.classicStudioId || "").trim();
    const prod = classicProductOrServiceIdFromSaleRow(row);
    if (!studio || prod == null) return null;
    const contract = guessContractFromSaleServicesRow(row);
    const stypePkg = cfg.packageSaleType || "43";
    const stypeContract = cfg.contractSaleType || "40";
    const stype = contract ? stypeContract : stypePkg;
    return (
      `https://clients.mindbodyonline.com/classic/ws?studioid=${encodeURIComponent(studio)}` +
      `&stype=${encodeURIComponent(stype)}&prodid=${encodeURIComponent(String(prod))}`
    );
  }

  /**
   * After “no credits” booking failure — lists sell-online SKUs in the modal.
   * Buy opens Mindbody Classic in a **new tab** when a classic link exists (no `stored-cards` probe on schedule).
   * @param {HTMLElement} mount
   */
  async function hydrateBookingFailPackages(mount) {
    mount.replaceChildren();
    const ld = document.createElement("p");
    ld.className = "mb-book-dialog__signup-packages-loading";
    ld.textContent = "Loading packages…";
    mount.append(ld);
    /** @type {Record<string, unknown>[]} */
    let rows = [];
    try {
      const [svcRows, contractRows] = await Promise.all([
        fetchSellOnlineServiceCatalogRows(),
        fetchUnifiedContractsCatalogRows(),
      ]);
      rows = mergeServiceRowsWithContractsForBooking(svcRows, contractRows);
    } catch {
      mount.replaceChildren();
      const p = document.createElement("p");
      p.className = "mb-book-dialog__signup-packages-err";
      p.textContent = "Packages didn’t load. Open Pricing from the footer link.";
      mount.append(p);
      return;
    }
    mount.replaceChildren();

    const sellable = [];
    for (const raw of rows) {
      const row = raw;
      const so = row.SellOnline ?? row.sellOnline;
      if (so === false) continue;
      const sid = mindbodyCheckoutServiceIdFromSaleRow(row);
      if (!Number.isFinite(sid) || sid <= 0) continue;
      const priceUsd = onlineUsdFromSaleRow(row);
      const baseName = displayNameFromSaleRow(row);
      const name = row.__mbContract === true ? `${baseName} · membership` : baseName;
      sellable.push({ sid, name, priceUsd, row });
    }

    sellable.sort((a, b) => {
      const dx = (a.priceUsd ?? 99999) - (b.priceUsd ?? 99999);
      if (dx !== 0) return dx;
      return a.name.localeCompare(b.name);
    });
    const capped = sellable.slice(0, 48);

    if (!capped.length) {
      const p = document.createElement("p");
      p.className = "mb-book-dialog__signup-packages-empty";
      p.textContent = "No online packages or memberships loaded here. Try the Pricing link below.";
      mount.append(p);
      return;
    }

    const intro = document.createElement("p");
    intro.className = "mb-book-dialog__signup-packages-intro";
    intro.textContent =
      "Pick a package, then Buy. Most items continue to Express checkout (Apple Pay, Google Pay or card). Memberships open Mindbody’s classic checkout in a new tab.";
    mount.append(intro);

    capped.forEach((item) => {
      const wrap = document.createElement("div");
      wrap.className = "mb-book-dialog__signup-package-row";

      const label = document.createElement("span");
      label.className = "mb-book-dialog__signup-package-row__label";

      let priceLbl = "";
      if (typeof item.priceUsd === "number" && item.priceUsd > 0)
        priceLbl = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(item.priceUsd);
      label.textContent = priceLbl ? `${item.name} · ${priceLbl}` : item.name;

      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "btn btn--cream mb-book-dialog__signup-package-buy";
      buy.textContent = "Buy";

      /**
       * Express-eligible SKU? Resolved from the same `mb-stripe-onetime-config` that drives
       * `/pricing` — that's the single source of truth for which one-time SKUs are wired
       * to Stripe Checkout. Recurring memberships return null and fall through to the
       * Classic flow below (no change in behaviour for those).
       */
      const expressMatch = expressMatchForServiceId(item.sid);

      buy.addEventListener("click", () => {
        if (buy.disabled) return;
        buy.disabled = true;
        buy.setAttribute("aria-busy", "true");
        buy.classList.add("mb-book-dialog__signup-package-buy--loading");
        buy.textContent = "Opening…";

        if (expressMatch) {
          /**
           * Same-tab redirect — matches the `/pricing` Express flow and avoids a new tab
           * here (the booking-fail dialog goes away on navigation, but the buyer's intent
           * is to complete the purchase; `/checkout/success` lands them back on a page
           * with a clear "book your class" CTA). Mindbody Classic still opens in a new
           * tab below because it's a third-party domain with awkward back-navigation.
           */
          void runExpressCheckout(item, expressMatch, buy);
          return;
        }

        try {
          try {
            sessionStorage.setItem(
              MB_PENDING_PRICING_CHECKOUT_SERVICE,
              JSON.stringify({ serviceId: item.sid, name: item.name, ts: Date.now() }),
            );
          } catch {
            /* tab storage blocked */
          }
          const hosted = mindbodyClassicBuyHrefFromSaleRow(item.row);
          const useHosted = !!hosted;
          if (useHosted && hosted) {
            const nw = window.open(hosted, "_blank", "noopener,noreferrer");
            buy.disabled = false;
            buy.removeAttribute("aria-busy");
            buy.classList.remove("mb-book-dialog__signup-package-buy--loading");
            buy.textContent = "Buy";
            if (!nw) window.location.assign(hosted);
            return;
          }
          window.location.assign(pricingApiPageHref());
        } catch {
          buy.disabled = false;
          buy.removeAttribute("aria-busy");
          buy.classList.remove("mb-book-dialog__signup-package-buy--loading");
          buy.textContent = "Buy";
        }
      });

      wrap.append(label, buy);
      mount.append(wrap);
    });
  }

  /**
   * POST `/api/stripe/checkout/create-session` for a booking-fail Express purchase, then
   * top-level redirect this tab to the hosted Stripe URL. The buyer is signed in to
   * Mindbody (otherwise they wouldn't have hit a "no credits" booking error), so the
   * server resolves their `clientId` from `mb_sess` and prefills the Stripe Customer with
   * their Mindbody contact (email/name/phone). We don't need to collect anything here.
   *
   * On error, we degrade to either Mindbody Classic in a new tab (when a studio link
   * exists) or an inline error message on the Buy button. We deliberately keep Classic
   * on a new tab — it's a third-party domain (`clients.mindbodyonline.com`) with awkward
   * back-navigation, and that's the existing behaviour for memberships in this same dialog
   * that we don't want to regress.
   *
   * @param {{ sid: number; name: string; priceUsd: number | null; row: Record<string, unknown> }} item
   * @param {{ localSku: string; displayName: string }} expressMatch
   * @param {HTMLButtonElement} buy
   */
  async function runExpressCheckout(item, expressMatch, buy) {
    /** @param {string | null} msg */
    function resetBuy(msg) {
      buy.disabled = false;
      buy.removeAttribute("aria-busy");
      buy.classList.remove("mb-book-dialog__signup-package-buy--loading");
      buy.textContent = msg || "Buy";
    }

    let res;
    try {
      res = await fetch(expressApiUrl(stripeOneTimeCfg.apiPath || "/api/stripe/checkout/create-session"), {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({
          localSku: expressMatch.localSku,
          ctaLocation: "classes_booking_fail_packages",
          pageLocation: (window.location.href || "").slice(0, 200),
        }),
      });
    } catch {
      resetBuy("Try again");
      return;
    }

    let txt = "";
    try {
      txt = await res.text();
    } catch {
      txt = "";
    }
    /** @type {unknown} */
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      json = null;
    }
    const obj = json && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : null;

    if (!res.ok || !obj || obj.ok !== true || typeof obj.url !== "string" || !obj.url) {
      const errCode = obj && typeof obj.error === "string" ? obj.error : "unknown";
      /**
       * Recoverable errors that mean "Express isn't possible right now": fall back to the
       * Mindbody Classic flow so the buyer still has a path forward without retyping. For
       * `ncs_already_used` we just surface the message inline — opening Classic for an NCS
       * the buyer already redeemed would just take them to another rejection.
       */
      if (errCode === "ncs_already_used") {
        resetBuy("Already redeemed");
        return;
      }
      const hosted = mindbodyClassicBuyHrefFromSaleRow(item.row);
      if (hosted) {
        const nw = window.open(hosted, "_blank", "noopener,noreferrer");
        if (!nw) window.location.assign(hosted);
        resetBuy(null);
        return;
      }
      resetBuy("Try again");
      return;
    }

    /** Top-level redirect — Stripe hosted Checkout shows Apple Pay / Google Pay / card / Link. */
    window.location.assign(String(obj.url));
  }

  function memberSummaryUrl() {
    return apiOrigin !== ""
      ? `${apiOrigin}/api/mindbody/member/summary`
      : `/api/mindbody/member/summary`;
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
      if (visitRowIsWaitlist(v)) continue;
      const ms = visitStartMsFromRow(v);
      if (ms == null || ms <= now) continue;
      const cid = visitClassIdFromRow(v);
      const vid = visitRowIdFromRow(v);
      if (cid != null && vid != null) map.set(cid, vid);
    }
    return map;
  }

  /** @param {{ waitlistByClassId?: unknown }} summaryPayload */
  function buildWaitlistEntryMap(summaryPayload) {
    /** @type {Map<number, number>} */
    const map = new Map();
    if (!summaryPayload || typeof summaryPayload !== "object") return map;
    const raw = summaryPayload.waitlistByClassId;
    if (!raw || typeof raw !== "object") return map;
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
      const cid = parseInt(k, 10);
      if (!Number.isFinite(cid) || cid <= 0) continue;
      if (!v || typeof v !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (v);
      const eidRaw = row.waitlistEntryId ?? row.WaitlistEntryId;
      const eid =
        typeof eidRaw === "number"
          ? eidRaw
          : typeof eidRaw === "string"
            ? parseInt(eidRaw, 10)
            : NaN;
      if (Number.isFinite(eid) && eid > 0) map.set(cid, eid);
    }
    return map;
  }

  /**
   * @param {Map<number, number>} apiMap
   * @param {Map<number, number>} prevMap
   */
  function mergeWaitlistEntryMaps(apiMap, prevMap) {
    const merged = new Map(apiMap);
    for (const [cid, eid] of prevMap) {
      if (!merged.has(cid)) merged.set(cid, eid);
    }
    return merged;
  }

  /**
   * Prefer Mindbody's enrollment map but keep optimistic rows until the summary catches up
   * (visit appears slightly later on `/member/summary`). Prevents flickering Book ↔ Cancel.
   *
   * @param {Map<number, number>} apiMap
   * @param {Map<number, number>} prevMap
   */
  function mergeEnrollmentVisitMaps(apiMap, prevMap) {
    const merged = new Map(apiMap);
    for (const [cid, vid] of prevMap) {
      if (!merged.has(cid)) merged.set(cid, vid);
    }
    return merged;
  }

  /** Re-fetch wallet + visits without reloading the schedule (after book/cancel). */
  function refreshWalletFromMemberSummary() {
    if (!oauthLoggedIn) return;
    loadMemberSummaryInBackground(loadEpoch);
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
    /**
     * Drop classes whose start has already passed so the class-type dropdown only offers
     * titles that are actually still bookable in the body. Without this an option like
     * "Hot Pilates 7am" would linger on the menu after 7 a.m. and selecting it would
     * produce an empty list.
     */
    const nowMs = Date.now();
    const titles = [
      ...new Set(
        allRows
          .filter(
            (r) => r.dk === selectedDayKey && r.isoMs > nowMs && passesSecondaryFilters(r, merged),
          )
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
      renderSlot(
        li,
        entry.cls,
        cfg,
        openBookFlow,
        openCancelReservationFlow,
        openJoinWaitlistFlow,
        openLeaveWaitlistFlow,
      );
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
    /**
     * Hide classes whose scheduled start has already passed (studio wall time =
     * `America/New_York`). They were previously rendered in a disabled grey state, but UX
     * research after launch said empty/grey rows just make the list feel cluttered. The
     * per-class `scheduleTodayBookTickerId` (fires every 55 s while today is selected)
     * re-runs `renderAll` so a class that crosses its start time silently disappears from
     * the list — no manual refresh needed.
     *
     * Filter is applied BEFORE `rebuildDayStrip` and the quick-class-select so the per-day
     * count badge and the class-type chips reflect only upcoming sessions. Otherwise today's
     * pill would say "5 classes" while the body listed 2.
     *
     * Only relevant for today's bucket; future days never have past `isoMs`, and past days
     * aren't fetched at all (`buildQuery` starts at today 00:00 ET).
     */
    const nowMs = Date.now();
    const secondaryFiltered = allRows.filter(
      (r) => passesSecondaryFilters(r, sec) && r.isoMs > nowMs,
    );

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
    /**
     * Keep the ticker running for today even if `forDay` is currently empty: the next class
     * may still be later today, and at the next tick a new class might appear / a borderline
     * class might cross the start threshold and get hidden. Without this, an empty late-day
     * list would never refresh on its own.
     */
    if (selectedDayKey === todayEtKey) {
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

  /** @returns {Promise<{ ok: boolean; message: string; lateCancelled?: boolean | null; noLongerAvailable?: boolean; guestAlsoCancelled?: boolean; guestPassReturned?: boolean }>} */
  async function cancelBookingViaApi(classId, visitId, opts) {
    const fetchUrl =
      apiOrigin !== "" ? `${apiOrigin}/api/mindbody/class/cancel` : `/api/mindbody/class/cancel`;
    /** @type {Record<string, unknown>} */
    const payload = { classId, visitId };
    if (opts?.confirmCancelGuest) {
      payload.confirmCancelGuest = true;
      if (opts.period) payload.period = opts.period;
    }
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify(payload),
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
        if (j.error === "guest_cancel_confirmation_required") {
          return { ok: false, message: msg, needsGuestConfirm: true, guestPreflight: j };
        }
        if (classNoLongerAvailable(msg)) {
          return {
            ok: false,
            noLongerAvailable: true,
            message:
              "This class is no longer available. Please refresh the schedule and choose another class.",
          };
        }
        return { ok: false, message: msg };
      }
      const lateCancelledRaw = j && typeof j === "object" ? j.lateCancelled : undefined;
      const lateCancelled =
        typeof lateCancelledRaw === "boolean" ? lateCancelledRaw : null;
      let message = "Your reservation was removed.";
      if (j.guestAlsoCancelled === true) {
        message =
          j.lateCancelled === true
            ? "Your class and your guest's spot were cancelled inside the studio's late-cancel window. Your monthly Bring a Friend Pass will not be returned."
            : "Your class was cancelled and your guest was notified. Your monthly Bring a Friend Pass will not be returned.";
      }
      return {
        ok: true,
        message,
        lateCancelled,
        guestAlsoCancelled: j.guestAlsoCancelled === true,
        guestPassReturned: j.guestPassReturned === false ? false : undefined,
      };
    } catch (e) {
      return { ok: false, message: String(/** @type {{ message?: string }} */ (e)?.message ?? e) };
    }
  }

  /**
   * Detect Mindbody errors that mean "the class the user clicked Book on is gone or unbookable" —
   * usually because the cached `/api/mindbody/class/classes` snapshot at the Netlify edge is up
   * to `s-maxage` (15 min in PR-1, 12 h after PR-2) older than reality. The booking action
   * itself always hits live Mindbody (`/public/v6/class/addclienttoclass`), so wrong booking is
   * impossible — the only fallout is the user seeing a now-stale row. When this matches we
   * suppress the raw Mindbody error and show a friendly dialog with a "Refresh schedule" CTA
   * that calls `reloadScheduleKeepingSelectedDay({ forceFresh: true })` to bypass the cache.
   *
   * Heuristics, in priority order: capacity exhaustion, cancellation, time elapsed, identity gone.
   * Kept as a single regex bundle (case-insensitive) because Mindbody's `Error.Message` text
   * varies slightly across sites and we'd rather over-trigger this friendly path than fall back
   * to a confusing raw API error.
   *
   * @param {string} raw
   */
  function classNoLongerAvailable(raw) {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return false;
    return (
      /\bclass\s+is\s+full\b/.test(s) ||
      /\bno\s+(?:more\s+)?(?:spots?|seats?|openings?)\b/.test(s) ||
      /\b(?:max(?:imum)?\s+)?capacity\b/.test(s) ||
      /\bcancel(?:l)?ed\b/.test(s) ||
      /\bno\s+longer\s+available\b/.test(s) ||
      /\balready\s+started\b/.test(s) ||
      /\bclass\s+has\s+(?:already\s+)?(?:started|ended|passed)\b/.test(s) ||
      /\bclass\s+not\s+found\b/.test(s) ||
      /\binvalid\s+class\s+id\b/.test(s)
    );
  }

  /**
   * Mindbody often returns terse API errors — map known cases to actionable studio copy.
   * @param {string} raw
   * @returns {{ friendly: string; suggestPackages: boolean }}
   */
  function interpretClassBookFailureMessage(raw) {
    const s = (raw || "").trim();
    if (!s) return { friendly: "Booking didn’t complete.", suggestPackages: false };
    if (/\binvalid_grant\b/i.test(s)) {
      return {
        friendly:
          "Sign-in expired or Mindbody hasn’t synced yet. New client or no credits? Pick a package below and pay in Mindbody; faster checkout here works once your card is on file.",
        suggestPackages: true,
      };
    }
    if (/\bno\s+available\s+payments?\b/i.test(s) || /\bhas\s+no\s+available\s+payments?\b/i.test(s)) {
      return {
        friendly:
          "You don’t have class credits or a package that applies to this class. Buy a drop-in, class pack, or membership first — then come back and book.",
        suggestPackages: true,
      };
    }
    return { friendly: s, suggestPackages: false };
  }

  /**
   * @param {number} classId
   * @param {{ waitlist?: boolean }} [options]
   */
  async function bookClassViaApi(classId, options) {
    const waitlist = options && options.waitlist === true;
    const fetchUrl =
      apiOrigin !== "" ? `${apiOrigin}/api/mindbody/class/book` : `/api/mindbody/class/book`;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify(waitlist ? { classId, waitlist: true } : { classId }),
      });
      const txt = await res.text();
      /** @type {Record<string, unknown>} */
      let j = {};
      try {
        j = txt ? JSON.parse(txt) : {};
      } catch {
        j = {};
      }

      /**
       * Identity user signed in but unresolvable to a Studio Client. We surface a
       * dedicated CTA in the dialog (sign in with email instead of Apple/Google).
       * Copy covers both returning members (wrong SSO / mismatched email) and first‑time
       * buyers—we point to Pricing rather than activating `suggestPackages` embeds,
       * so repeat clients aren't pushed to duplicate purchases when they only need email sign-in.
       */
      if (res.status === 400 && j && j.error === "client_not_linked") {
        const isAppleRelay = j.appleRelay === true;
        return {
          ok: false,
          clientNotLinked: { appleRelay: isAppleRelay },
          message: isAppleRelay
            ? "We couldn't find your AMARÉ profile linked to this Apple sign-in. If you've already booked or bought passes with us, sign out and sign in with your studio email + password—the one on file with us, not Apple's hidden relay. New to AMARÉ? Buy a drop-in or package on Pricing first using your email; that creates your profile here—then come back and book."
            : "We couldn't link your Mindbody sign-in to your AMARÉ studio profile yet. Already have a package with us? Sign out and sign in again using your studio email + password so we can match your account. Haven't purchased with us yet? Buy a drop-in or package on our Pricing page first—use the same email you'll use to sign in—then book your class here.",
        };
      }

      if (res.status === 401) {
        return {
          ok: false,
          suggestPackages: true,
          message:
            "Sign-in expired or Mindbody doesn’t allow this booking yet. New client or no credits? Pick a package below and complete payment in Mindbody — once your card is saved there, quicker checkout opens on this site.",
        };
      }

      if (res.status === 403 && j && j.error === "studio_not_linked") {
        const msg =
          typeof j.message === "string" && j.message.trim()
            ? j.message.trim()
            : "Your Mindbody account is connected, but it is not fully linked to AMARÉ yet. Please contact the studio and we can connect your account or book the class for you.";
        return { ok: false, studioNotLinked: true, message: msg };
      }

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
        if (classNoLongerAvailable(msg)) {
          const classFull = /\bfull\b|\bcapacity\b/i.test(msg);
          return {
            ok: false,
            noLongerAvailable: true,
            classFull,
            message: classFull
              ? "This class is full. Please choose another time."
              : "This class is no longer available. Please refresh the schedule and choose another class.",
          };
        }
        const { friendly, suggestPackages } = interpretClassBookFailureMessage(msg);
        if (waitlist && suggestPackages) {
          return {
            ok: false,
            message:
              "You'll need an active package or membership to join the waitlist.",
            suggestPackages: true,
          };
        }
        return suggestPackages ? { ok: false, message: friendly, suggestPackages } : { ok: false, message: friendly };
      }
      const visitIdRaw = j && typeof j === "object" ? j.visitId : null;
      const visitId =
        !waitlist &&
        typeof visitIdRaw === "number" &&
        Number.isFinite(visitIdRaw) &&
        visitIdRaw > 0
          ? visitIdRaw
          : null;
      const wlIdRaw = j && typeof j === "object" ? j.waitlistEntryId : null;
      const waitlistEntryId =
        waitlist &&
        typeof wlIdRaw === "number" &&
        Number.isFinite(wlIdRaw) &&
        wlIdRaw > 0
          ? wlIdRaw
          : null;
      return {
        ok: true,
        message: waitlist
          ? "You're on the waitlist. We'll email you if a spot opens."
          : "Booked. Check your email for Mindbody confirmation.",
        visitId,
        waitlistEntryId,
        onWaitlist: waitlist,
      };
    } catch (e) {
      return { ok: false, message: String(/** @type {{ message?: string }} */ (e)?.message ?? e) };
    }
  }

  /**
   * Apply a local enrollment delta (book or cancel) without round-tripping the schedule
   * + member summary APIs. Saves ~3-4s of perceived latency when the new "Cancel
   * booking" badge would otherwise replace "Book" only after the next `load()`.
   *
   * Pass `visitId` to mark the user as enrolled (Mindbody returns it from
   * `addclienttoclass`); pass `null` to mark them as no-longer-enrolled (after a
   * successful `removeclientfromclass`). Falls back to a full reload when the visit
   * id is missing on book — the local map can't expose a "Cancel booking" button
   * without it.
   *
   * @param {number} classId
   * @param {number | null} visitId
   */
  function applyLocalEnrollmentChange(classId, visitId) {
    if (visitId != null && visitId > 0) {
      enrollVisitByClassId.set(classId, visitId);
      waitlistEntryByClassId.delete(classId);
    } else if (visitId === null) {
      enrollVisitByClassId.delete(classId);
    }
    try {
      renderAll();
    } catch {
      /* renderAll throws would mean the DOM is detached; ignore. */
    }
  }

  /**
   * @param {number} classId
   * @param {number | null} waitlistEntryId
   */
  function applyLocalWaitlistChange(classId, waitlistEntryId) {
    if (waitlistEntryId != null && waitlistEntryId > 0) {
      waitlistEntryByClassId.set(classId, waitlistEntryId);
    } else if (waitlistEntryId === null) {
      waitlistEntryByClassId.delete(classId);
    }
    try {
      renderAll();
    } catch {
      /* detached DOM */
    }
  }

  /** @param {number} waitlistEntryId */
  async function removeFromWaitlistViaApi(waitlistEntryId) {
    const fetchUrl =
      apiOrigin !== ""
        ? `${apiOrigin}/api/mindbody/class/waitlist/remove`
        : `/api/mindbody/class/waitlist/remove`;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify({ waitlistEntryId }),
      });
      const j = await res.json().catch(() => (/** @type {Record<string, unknown>} */ ({})));
      if (!res.ok || j.ok === false) {
        const msg =
          typeof j.message === "string" && j.message.trim()
            ? j.message
            : "Could not leave the waitlist.";
        return { ok: false, message: msg };
      }
      const alreadyRemoved = j.alreadyRemoved === true;
      return {
        ok: true,
        alreadyRemoved,
        message:
          typeof j.message === "string" && j.message.trim()
            ? j.message
            : alreadyRemoved
              ? "You're no longer on the waitlist for this class."
              : "Removed from the waitlist.",
      };
    } catch (e) {
      return { ok: false, message: String(/** @type {{ message?: string }} */ (e)?.message ?? e) };
    }
  }

  /**
   * Re-fetch schedule after book/cancel without jumping the day strip back to "today".
   *
   * Pass `{ forceFresh: true }` whenever the reason for reloading is "the cached schedule is
   * known to be wrong" — book/cancel succeeded against live Mindbody, or Mindbody rejected
   * a booking as no-longer-available (cache shows a class that is now full/cancelled/past).
   * That appends `&_t=<ts>` to the schedule URL, which gives Netlify Edge a fresh cache key
   * and pulls a live response. Without it, the same visitor would keep seeing the stale row
   * for up to `s-maxage` (15 min in PR-1).
   *
   * @param {{ forceFresh?: boolean }} [extra]
   */
  function reloadScheduleKeepingSelectedDay(extra) {
    const dk = typeof selectedDayKey === "string" ? selectedDayKey.trim() : "";
    /** @type {{ preserveDayKey?: string; forceFresh?: boolean }} */
    const opts = {};
    if (dk) opts.preserveDayKey = dk;
    if (extra && extra.forceFresh === true) opts.forceFresh = true;
    // Brief defer so Set-Cookie from book/cancel can land before `load()` calls
    // `/api/mindbody/oauth/session`; parallel refresh / rotation races can otherwise 401 and clear mb_sess.
    window.setTimeout(() => {
      void load(opts).catch(() => window.location.reload());
    }, 100);
  }

  /** @param {MBClass} cls */
  function openJoinWaitlistFlow(cls) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const startPass = parseIso(classStartIsoFromCls(cls));
    if (classStartHasPassed(startPass) || cid == null) return;

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (!window.confirm("Join the waitlist for this class? We'll email you if a spot opens.")) return;
      void bookClassViaApi(cid, { waitlist: true }).then((r) => {
        if (r.ok) {
          if (typeof r.waitlistEntryId === "number" && r.waitlistEntryId > 0) {
            applyLocalWaitlistChange(cid, r.waitlistEntryId);
            refreshWalletFromMemberSummary();
          } else {
            reloadScheduleKeepingSelectedDay({ forceFresh: true });
          }
          window.alert(r.message);
        } else if (r.suggestPackages) {
          window.alert([r.message, "", "Open Pricing on this site: /pricing"].join("\n"));
        } else window.alert(r.message);
      });
      return;
    }

    appendBookModalSummary(bookDlgBody, cls);
    bookDlgTitle.textContent = "Join the waitlist?";
    bookDlgActions.replaceChildren();

    const hint = document.createElement("p");
    hint.className = "mb-book-dialog__hint form-sent-dialog__text";
    hint.textContent = "We'll email you if a spot opens.";

    const dismissWl = document.createElement("button");
    dismissWl.type = "button";
    dismissWl.className = "btn btn--ghost";
    dismissWl.textContent = "Close";
    dismissWl.addEventListener("click", () => bookDlg.close());

    const confirmWl = document.createElement("button");
    confirmWl.type = "button";
    confirmWl.className = "btn btn--cream";
    confirmWl.textContent = "Join waitlist";
    confirmWl.addEventListener("click", async () => {
      if (cid == null) return;
      dismissWl.disabled = true;
      confirmWl.disabled = true;
      confirmWl.textContent = "Joining…";
      const result = await bookClassViaApi(cid, { waitlist: true });
      if (result.ok) refreshWalletFromMemberSummary();
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent = result.ok ? "You're on the waitlist" : "Couldn't join waitlist";
      bookDlgBody.append(
        (() => {
          const fb = document.createElement("p");
          fb.className = "mb-book-dialog__result";
          fb.textContent = result.message;
          if (!result.ok && result.suggestPackages) {
            const wrap = document.createElement("div");
            wrap.className = "mb-book-dialog__booking-fail-extras";
            wrap.append(fb);
            const ttl = document.createElement("p");
            ttl.className = "mb-book-dialog__signup-packages-title";
            ttl.textContent = "Packages & memberships · buy online";
            const packsMount = document.createElement("div");
            packsMount.className =
              "mb-book-dialog__signup-packages mb-book-dialog__signup-packages--in-book-fail";
            wrap.append(ttl, packsMount);
            void hydrateBookingFailPackages(packsMount);
            return wrap;
          }
          return fb;
        })(),
      );
      bookDlgActions.replaceChildren();
      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn btn--cream mb-book-dialog__ok";
      done.textContent = "Done";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok && cid != null) {
          if (typeof result.waitlistEntryId === "number" && result.waitlistEntryId > 0) {
            applyLocalWaitlistChange(cid, result.waitlistEntryId);
          } else {
            reloadScheduleKeepingSelectedDay({ forceFresh: true });
          }
        }
      });
      bookDlgActions.append(done);
    });

    const row = document.createElement("div");
    row.className = "mb-book-dialog__cta-row";
    row.append(dismissWl, confirmWl);
    bookDlgActions.append(hint, row);
    bookDlg.showModal();
  }

  /** @param {MBClass} cls @param {number} waitlistEntryId */
  function openLeaveWaitlistFlow(cls, waitlistEntryId) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const eid =
      typeof waitlistEntryId === "number"
        ? waitlistEntryId
        : typeof waitlistEntryId === "string"
          ? parseInt(waitlistEntryId, 10)
          : NaN;
    if (cid == null || !Number.isFinite(eid) || eid <= 0) return;

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (!window.confirm("Leave the waitlist for this class?")) return;
      void removeFromWaitlistViaApi(eid).then((r) => {
        if (r.ok) {
          applyLocalWaitlistChange(cid, null);
          refreshWalletFromMemberSummary();
        }
        window.alert(r.message);
      });
      return;
    }

    appendBookModalSummary(bookDlgBody, cls);
    bookDlgTitle.textContent = "Leave the waitlist?";
    bookDlgActions.replaceChildren();

    const rowLeave = document.createElement("div");
    rowLeave.className = "mb-book-dialog__cta-row";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn--ghost";
    keep.textContent = "Keep my spot on the waitlist";
    keep.addEventListener("click", () => bookDlg.close());

    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "btn btn--cream";
    leave.textContent = "Leave waitlist";
    leave.addEventListener("click", async () => {
      keep.disabled = true;
      leave.disabled = true;
      leave.textContent = "Leaving…";
      const result = await removeFromWaitlistViaApi(eid);
      if (result.ok) refreshWalletFromMemberSummary();
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent = result.ok ? "Left the waitlist" : "Couldn't leave waitlist";
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
      done.textContent = "Done";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok) applyLocalWaitlistChange(cid, null);
      });
      bookDlgActions.append(done);
    });

    rowLeave.append(keep, leave);
    bookDlgActions.append(rowLeave);
    bookDlg.showModal();
  }

  const STUDIO_NOT_LINKED_MSG =
    "Your Mindbody account is connected, but it is not fully linked to AMARÉ yet. Please contact us and we can connect your account or book the class for you.";

  const AMBIGUOUS_STUDIO_CLIENT_MSG =
    "We found more than one AMARÉ profile that matches your sign-in. Please contact the studio so we can link the correct account before you book online.";

  const APPLE_RELAY_EMAIL_MSG =
    "Sign in with Apple is using a private relay email, so we could not match your AMARÉ profile automatically. Please contact the studio with the email on your account, or sign in with the same email you use at AMARÉ.";

  function oauthBookBlockedMessage() {
    if (oauthLinkStatus === "ambiguous_studio_client") return AMBIGUOUS_STUDIO_CLIENT_MSG;
    if (oauthLinkStatus === "apple_relay_email") return APPLE_RELAY_EMAIL_MSG;
    return STUDIO_NOT_LINKED_MSG;
  }

  /**
   * @param {HTMLElement} mount
   */
  function appendStudioNotLinkedCtas(mount) {
    const row = document.createElement("div");
    row.className = "mb-book-dialog__cta-row";
    const contact = document.createElement("a");
    contact.className = "btn btn--cream";
    contact.href = "/contact";
    contact.textContent = "Contact studio";
    const signOut = document.createElement("a");
    signOut.className = "btn btn--ghost";
    signOut.href = "/api/mindbody/oauth/logout?return=/classes";
    signOut.textContent = "Sign out and try again";
    row.append(contact, signOut);
    mount.append(row);
  }

  /** Book button: modal when `<dialog>` is present; otherwise legacy link / alerts. */
  function openBookFlow(cls) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const startPass = parseIso(classStartIsoFromCls(cls));
    if (classStartHasPassed(startPass)) return;

    const fallbackWidget = bookingHref(cfg, cls);

    if (oauthLoggedIn && !oauthBookingAllowed) {
      const blockedMsg = oauthBookBlockedMessage();
      if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
        window.alert(blockedMsg);
        return;
      }
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent =
        oauthLinkStatus === "ambiguous_studio_client"
          ? "Multiple studio profiles found"
          : oauthLinkStatus === "apple_relay_email"
            ? "Email could not be matched"
            : "Account not linked yet";
      bookDlgActions.replaceChildren();
      const hint = document.createElement("p");
      hint.className = "mb-book-dialog__hint form-sent-dialog__text";
      hint.textContent = blockedMsg;
      bookDlgActions.append(hint);
      appendStudioNotLinkedCtas(bookDlgActions);
      bookDlg.showModal();
      return;
    }

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (oauthLoggedIn && cid != null) {
        void bookClassViaApi(cid).then((r) => {
          if (r.ok) {
            if (typeof r.visitId === "number" && r.visitId > 0) {
              applyLocalEnrollmentChange(cid, r.visitId);
              refreshWalletFromMemberSummary();
            } else {
              reloadScheduleKeepingSelectedDay({ forceFresh: true });
            }
          } else if (r.noLongerAvailable === true) {
            if (shouldShowJoinWaitlist(cls)) {
              if (window.confirm("This class is currently full. Would you like to join the waitlist?")) {
                openJoinWaitlistFlow(cls);
              }
            } else {
              window.alert(r.message);
            }
            reloadScheduleKeepingSelectedDay({ forceFresh: true });
          } else if (r.studioNotLinked) {
            window.alert(r.message || oauthBookBlockedMessage());
          } else if ("suggestPackages" in r && r.suggestPackages) {
            const lines = [r.message, "", "Open Pricing on this site: /pricing"];
            window.alert(lines.join("\n"));
          } else window.alert(r.message);
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
        "Sign in with Mindbody to book this class on our site. New to Mindbody online? Their next screens will guide you — same email you'd use here.";

      const row = document.createElement("div");
      row.className = "mb-book-dialog__cta-row mb-book-dialog__guest-cta-row";

      const signIn = document.createElement("a");
      signIn.className = "btn btn--cream mb-book-dialog__guest-sign-in";
      signIn.href = oauthStartHref();
      signIn.textContent = "Sign in with Mindbody";

      row.append(signIn);

      bookDlgActions.append(hint, row);

      const altSignupUrl = (cfg.signupUrl || "").trim();
      if (altSignupUrl) {
        const alt = document.createElement("p");
        alt.className = "mb-book-dialog__signup-alt link-quiet-wrap";
        const altA = document.createElement("a");
        altA.className = "link-quiet";
        altA.href = altSignupUrl;
        altA.target = "_blank";
        altA.rel = "noopener noreferrer";
        altA.textContent = "Prefer Mindbody’s signup page? Open in new tab.";
        alt.append(altA);
        bookDlgActions.append(alt);
      }

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
      if (result.ok) refreshWalletFromMemberSummary();
      appendBookModalSummary(bookDlgBody, cls);
      const offerWaitlist =
        !result.ok && result.noLongerAvailable === true && shouldShowJoinWaitlist(cls);
      if (offerWaitlist) {
        result.message = "This class is currently full. Would you like to join the waitlist?";
      }
      bookDlgTitle.textContent = result.ok
        ? "You’re booked"
        : offerWaitlist
          ? "This class is full"
          : result.noLongerAvailable === true
            ? "This class is no longer available"
            : "Booking didn’t complete";
      bookDlgBody.append(
        (() => {
          const fb = document.createElement("p");
          fb.className = "mb-book-dialog__result";
          fb.textContent = result.message;
          if (!result.ok && result.studioNotLinked) {
            const wrap = document.createElement("div");
            wrap.className = "mb-book-dialog__booking-fail-extras";
            wrap.append(fb);
            const tip = document.createElement("p");
            tip.className = "mb-book-dialog__hint form-sent-dialog__text";
            tip.textContent = result.message || oauthBookBlockedMessage();
            wrap.append(tip);
            appendStudioNotLinkedCtas(wrap);
            return wrap;
          }
          if (!result.ok && result.clientNotLinked) {
            /**
             * Mindbody Identity is signed in but the consumer-token resolution chain
             * failed to map them to a Studio Client (no email match, no name match
             * after our staff-token fallback). The fix is on the user side: sign in
             * again with the studio email + password directly, not via Apple/Google
             * SSO. We force `prompt=login` so Mindbody re-shows the credentials
             * screen even if their SSO cookie is still warm, and we hint the email
             * we *do* know to prefill the form.
             */
            const wrap = document.createElement("div");
            wrap.className = "mb-book-dialog__booking-fail-extras";
            wrap.append(fb);
            const tip = document.createElement("p");
            tip.className = "mb-book-dialog__hint form-sent-dialog__text";
            tip.textContent = result.clientNotLinked.appleRelay
              ? "Apple Hide My Email creates a private address (xxx@privaterelay.appleid.com) we can't match to your AMARÉ profile. Use your real studio email + password instead, just for sign-in."
              : "Signing in with the email + password from your AMARÉ studio account lets us pull up your packages and book this class.";
            const ctaRow = document.createElement("div");
            ctaRow.className = "mb-book-dialog__cta-row";
            const signInBtn = document.createElement("a");
            signInBtn.className = "btn btn--cream";
            const baseStart = oauthStartHref();
            const sep = baseStart.includes("?") ? "&" : "?";
            const parenEmail = (oauthWho.match(/\(([^)]+)\)/)?.[1] || "").trim();
            const bareEmail = parenEmail
              ? ""
              : ((oauthWho.match(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/)?.[0] || "").trim());
            const knownEmail = parenEmail || bareEmail;
            /** Don't pre-fill the proxy address — it'd just send the user back to the same dead end. */
            const hint =
              knownEmail && !/@privaterelay\.appleid\.com$/i.test(knownEmail)
                ? `&login_hint=${encodeURIComponent(knownEmail)}`
                : "";
            signInBtn.href = `${baseStart}${sep}prompt=login${hint}`;
            signInBtn.textContent = "Sign in with email instead";
            ctaRow.append(signInBtn);
            wrap.append(tip, ctaRow);
            return wrap;
          }
          if (!result.ok && result.suggestPackages) {
            const wrap = document.createElement("div");
            wrap.className = "mb-book-dialog__booking-fail-extras";
            wrap.append(fb);
            const ttl = document.createElement("p");
            ttl.className = "mb-book-dialog__signup-packages-title";
            ttl.textContent = "Packages & memberships · buy online";
            const packsMount = document.createElement("div");
            packsMount.className =
              "mb-book-dialog__signup-packages mb-book-dialog__signup-packages--in-book-fail";
            const packFoot = document.createElement("p");
            packFoot.className = "mb-book-dialog__booking-fail-packlink form-sent-dialog__text";
            const aOv = document.createElement("a");
            aOv.className = "link-quiet";
            aOv.href = "/pricing.html";
            aOv.textContent = "Static pricing overview";
            packFoot.append(document.createTextNode("Prefer the full Pricing layout? "));
            packFoot.append(aOv);
            packFoot.append(document.createTextNode("."));
            wrap.append(ttl, packsMount, packFoot);
            void hydrateBookingFailPackages(packsMount);
            return wrap;
          }
          return fb;
        })(),
      );
      bookDlgActions.replaceChildren();
      /**
       * For `noLongerAvailable`, the primary CTA is "Refresh schedule" because the only useful
       * next action is reloading the cached schedule (bypassing the Netlify edge cache via the
       * `_t` query param). Retrying the same `classId` cannot succeed — Mindbody is the live
       * authority and it just rejected the booking — so the "Try again" row is suppressed in
       * this branch.
       */
      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn btn--cream mb-book-dialog__ok";
      done.textContent = result.ok
        ? "Done"
        : offerWaitlist
          ? "Close"
          : result.noLongerAvailable === true
            ? "Refresh schedule"
            : "Close";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok) {
          if (cid != null && typeof result.visitId === "number" && result.visitId > 0) {
            applyLocalEnrollmentChange(cid, result.visitId);
          } else {
            reloadScheduleKeepingSelectedDay({ forceFresh: true });
          }
        } else if (result.noLongerAvailable === true && !offerWaitlist) {
          reloadScheduleKeepingSelectedDay({ forceFresh: true });
        }
      });
      bookDlgActions.append(done);
      if (offerWaitlist) {
        const wlRow = document.createElement("div");
        wlRow.className = "mb-book-dialog__cta-row";
        const joinWl = document.createElement("button");
        joinWl.type = "button";
        joinWl.className = "btn btn--cream";
        joinWl.textContent = "Join waitlist";
        joinWl.addEventListener("click", () => {
          bookDlg.close();
          openJoinWaitlistFlow(cls);
        });
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "btn btn--ghost";
        refresh.textContent = "Refresh schedule";
        refresh.addEventListener("click", () => {
          bookDlg.close();
          reloadScheduleKeepingSelectedDay({ forceFresh: true });
        });
        wlRow.append(joinWl, refresh);
        bookDlgActions.append(wlRow);
      }
      if (!result.ok && !result.clientNotLinked && result.noLongerAvailable !== true) {
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

  /** @param {number} classId */
  async function fetchGuestCancelPreflight(classId) {
    const fetchUrl =
      apiOrigin !== ""
        ? `${apiOrigin}/api/mindbody/class/cancel?preflight=1&classId=${encodeURIComponent(String(classId))}`
        : `/api/mindbody/class/cancel?preflight=1&classId=${encodeURIComponent(String(classId))}`;
    try {
      const res = await fetch(fetchUrl, {
        credentials: "include",
        headers: ngrokBypassHeaders({ Accept: "application/json" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j || typeof j !== "object") return { hasGuest: false };
      return j;
    } catch {
      return { hasGuest: false };
    }
  }

  /** Release a spot (`/api/mindbody/class/cancel`). Uses visit id from member summary enrollment map. */
  async function openCancelReservationFlow(cls, visitId) {
    const cid = typeof cls.Id === "number" ? cls.Id : typeof cls.id === "number" ? cls.id : null;
    const vid =
      typeof visitId === "number" ? visitId : typeof visitId === "string" ? parseInt(visitId, 10) : NaN;
    if (cid == null || !Number.isFinite(vid) || vid <= 0) return;

    const guestPreflight = await fetchGuestCancelPreflight(cid);
    const hasGuest = guestPreflight.hasGuest === true;
    const guestPeriod =
      guestPreflight && typeof guestPreflight.period === "string" ? guestPreflight.period : undefined;

    const startForLateCheck = parseIso(classStartIsoFromCls(cls));
    const withinLateWindow = isWithinLateCancelWindow(startForLateCheck);

    if (!useBookDialog || !bookDlg || !bookDlgBody || !bookDlgActions || !bookDlgTitle) {
      if (hasGuest) {
        const gf = String(guestPreflight.guestFirstName || "Your guest");
        const gl = String(guestPreflight.guestLastInitial || "");
        const ok = window.confirm(
          `Cancel your class and your guest?\n\nCanceling this class will also cancel ${gf} ${gl}'s spot.\nYour Bring a Friend Pass for this period will remain used.\n\nCancel both bookings?`,
        );
        if (!ok) return;
        void cancelBookingViaApi(cid, vid, { confirmCancelGuest: true, period: guestPeriod }).then((r) => {
          if (r.ok) {
            applyLocalEnrollmentChange(cid, null);
            refreshWalletFromMemberSummary();
            window.alert(r.message);
          } else window.alert(r.message);
        });
        return;
      }
      const promptMsg = withinLateWindow
        ? `Heads up: within our ${LATE_CANCEL_HOURS}-hour window. Cancelling now uses your class credit. If you can still make it, your spot is saved.\n\nCancel anyway?`
        : "Remove your spot in this class?";
      if (!window.confirm(promptMsg)) return;
      void cancelBookingViaApi(cid, vid).then((r) => {
        if (r.ok) {
          applyLocalEnrollmentChange(cid, null);
          refreshWalletFromMemberSummary();
          /** Mindbody is the source of truth — fall back to local clock check only when it didn't say. */
          const wasLate = r.lateCancelled === true || (r.lateCancelled == null && withinLateWindow);
          if (wasLate) {
            window.alert(
              "Booking cancelled. Thanks for the heads-up — your class credit is used per our 12-hour policy, and you've freed the spot for someone else. ❤",
            );
          }
        } else if (r.noLongerAvailable === true) {
          window.alert(r.message);
          reloadScheduleKeepingSelectedDay({ forceFresh: true });
        } else window.alert(r.message);
      });
      return;
    }

    appendBookModalSummary(bookDlgBody, cls);
    bookDlgTitle.textContent = hasGuest
      ? "Cancel your class and your guest?"
      : "Remove your spot in this class?";
    bookDlgActions.replaceChildren();

    if (hasGuest) {
      const guestWarn = document.createElement("p");
      guestWarn.className = "mb-book-dialog__hint mb-book-dialog__late-warning form-sent-dialog__text";
      guestWarn.textContent =
        "Canceling this class will also cancel your guest's spot. Your Bring a Friend Pass for this period will remain used.";
      bookDlgBody.append(guestWarn);
    }

    if (withinLateWindow) {
      const warning = document.createElement("p");
      warning.className = "mb-book-dialog__hint mb-book-dialog__late-warning form-sent-dialog__text";
      warning.textContent = `Heads up: within our ${LATE_CANCEL_HOURS}-hour window. Cancelling now uses your class credit. If you can still make it, your spot is saved.`;
      bookDlgBody.append(warning);
    }

    const row = document.createElement("div");
    row.className = "mb-book-dialog__cta-row";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn--ghost";
    keep.textContent = hasGuest ? "Keep Booking" : "Keep reservation";
    keep.addEventListener("click", () => bookDlg.close());

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--cream";
    remove.textContent = hasGuest ? "Cancel Both Bookings" : "Confirm cancel";
    remove.addEventListener("click", async () => {
      keep.disabled = true;
      remove.disabled = true;
      remove.textContent = "Cancelling…";
      const result = await cancelBookingViaApi(cid, vid, hasGuest ? { confirmCancelGuest: true, period: guestPeriod } : undefined);
      if (result.ok) refreshWalletFromMemberSummary();
      appendBookModalSummary(bookDlgBody, cls);
      bookDlgTitle.textContent = result.ok
        ? "Booking cancelled"
        : result.noLongerAvailable === true
          ? "This class is no longer available"
          : "Cancellation didn’t complete";
      /**
       * Use Mindbody's authoritative `LateCancelled` when the response surfaces it
       * (handles edge cases like the studio temporarily widening / narrowing the
       * window without a redeploy). Fall back to our own clock check otherwise.
       */
      const lateAck =
        result.ok &&
        (result.lateCancelled === true ||
          (result.lateCancelled == null && withinLateWindow));
      bookDlgBody.append(
        (() => {
          const fb = document.createElement("p");
          fb.className = "mb-book-dialog__result";
          fb.textContent = result.message;
          if (lateAck) {
            const wrap = document.createElement("div");
            wrap.append(fb);
            const thanks = document.createElement("p");
            thanks.className = "mb-book-dialog__hint mb-book-dialog__late-thanks form-sent-dialog__text";
            thanks.textContent =
              "Thanks for the heads-up — your class credit is used per our 12-hour policy, and you've freed the spot for someone else. ❤";
            wrap.append(thanks);
            return wrap;
          }
          return fb;
        })(),
      );
      bookDlgActions.replaceChildren();
      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn btn--cream mb-book-dialog__ok";
      done.textContent = result.ok
        ? "Done"
        : result.noLongerAvailable === true
          ? "Refresh schedule"
          : "Close";
      done.addEventListener("click", () => {
        bookDlg.close();
        if (result.ok) {
          applyLocalEnrollmentChange(cid, null);
        } else if (result.noLongerAvailable === true) {
          reloadScheduleKeepingSelectedDay({ forceFresh: true });
        }
      });
      bookDlgActions.append(done);
      if (!result.ok && result.noLongerAvailable !== true) {
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

  /**
   * Fetch `/api/mindbody/member/summary` in the background and update the wallet + rows when
   * it lands. Called by `load()` after the schedule is already rendered, so this never blocks
   * the schedule's first paint.
   *
   * Epoch gating: `expectedEpoch` is the value of `loadEpoch` captured by the `load()` call
   * that initiated this fetch. If a newer `load()` runs before the fetch resolves (e.g. user
   * hit "Refresh schedule" again), `expectedEpoch !== loadEpoch` and we silently drop the
   * result — the newer load will fire its own summary fetch.
   *
   * Abort: the previous in-flight controller is replaced atomically by `load()` itself,
   * which calls `memberSummaryAbortCtrl.abort()` before incrementing the epoch. The local
   * `signal.aborted` short-circuit further protects us if we resolve after an abort but
   * before the rejection handler fires.
   *
   * @param {number} expectedEpoch
   */
  function loadMemberSummaryInBackground(expectedEpoch) {
    const ctrl = new AbortController();
    memberSummaryAbortCtrl = ctrl;
    const timeoutId = setTimeout(() => {
      try { ctrl.abort(); } catch { /* already aborted */ }
    }, 20000);

    const summaryOpts = {
      credentials: "include",
      headers: ngrokBypassHeaders({ Accept: "application/json" }),
      signal: ctrl.signal,
    };

    fetch(memberSummaryUrl(), summaryOpts)
      .then(async (sumRes) => {
        if (expectedEpoch !== loadEpoch || ctrl.signal.aborted) return;
        if (!sumRes.ok) {
          scheduleWalletBars("error", null);
          return;
        }
        const sumPayload = await sumRes.json().catch(() => null);
        if (expectedEpoch !== loadEpoch || ctrl.signal.aborted) return;
        if (!sumPayload || typeof sumPayload !== "object") {
          scheduleWalletBars("error", null);
          return;
        }
        const sp = /** @type {Record<string, unknown>} */ (sumPayload);
        enrollVisitByClassId = mergeEnrollmentVisitMaps(
          buildEnrollmentVisitMap(/** @type {{ clientVisits?: unknown }} */ (sp)),
          enrollVisitByClassId,
        );
        waitlistEntryByClassId = mergeWaitlistEntryMaps(
          buildWaitlistEntryMap(sp),
          waitlistEntryByClassId,
        );
        scheduleWalletBars("ok", sp);
        /**
         * Re-render so any class the member has already booked flips its CTA from
         * "Book" to "Cancel". `renderAll()` is idempotent: it rebuilds the day strip,
         * quick-class chips, and the currently-selected day's rows. The previously rendered
         * Book buttons are replaced with Cancel buttons for booked classes.
         */
        renderAll();
      })
      .catch(() => {
        if (expectedEpoch !== loadEpoch || ctrl.signal.aborted) return;
        scheduleWalletBars("error", null);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (memberSummaryAbortCtrl === ctrl) memberSummaryAbortCtrl = null;
      });
  }

  async function load(/** @type {{ preserveDayKey?: string; forceFresh?: boolean } | undefined} */ opts) {
    if (!url) return;

    /**
     * Bump the epoch and cancel any in-flight member-summary fetch from a previous `load()`
     * call. Without this, e.g. a user that triggers "Refresh schedule" while the prior
     * summary is still loading would have the old (now-stale) summary clobber `renderAll()`
     * a second time, and the new load would race against it. The captured `currentEpoch`
     * flows into `loadMemberSummaryInBackground()` and gates every state mutation.
     */
    const currentEpoch = ++loadEpoch;
    if (memberSummaryAbortCtrl) {
      try { memberSummaryAbortCtrl.abort(); } catch { /* already aborted */ }
      memberSummaryAbortCtrl = null;
    }

    statusEl.textContent = "Loading classes…";
    statusEl.classList.remove("mb-schedule-api__status--error");
    oauthLoggedIn = false;
    oauthBookingAllowed = true;
    oauthLinkStatus = "";
    oauthWho = "";
    enrollVisitByClassId = new Map();
    waitlistEntryByClassId = new Map();

    /**
     * `forceFresh` appends a unique `_t` query param so the Netlify Edge cache sees a new key
     * and bypasses the cached schedule. Used after a successful book/cancel and from the
     * "Refresh schedule" CTA when Mindbody rejects a booking as no-longer-available (the
     * cached schedule may still be showing a class that is full / cancelled / past).
     */
    const loadUrl = (opts && opts.forceFresh === true)
      ? `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}`
      : url;

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
        fetch(loadUrl, fetchOpts),
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
            oauthBookingAllowed = j.bookingAllowed !== false;
            oauthLinkStatus =
              typeof j.linkStatus === "string" && j.linkStatus.trim() ? j.linkStatus.trim() : "";
          } else {
            oauthWho = "";
            oauthBookingAllowed = true;
            oauthLinkStatus = "";
          }
        } catch {
          oauthLoggedIn = false;
          oauthWho = "";
          oauthLinkStatus = "";
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

      /**
       * Reset the enrollment map BEFORE rendering. Logged-in members will get the populated
       * map filled by `loadMemberSummaryInBackground()` a moment later, at which point
       * `renderAll()` is called a second time and "Book" rows for already-booked classes
       * flip to "Cancel". An empty map here just means we briefly show "Book" instead of
       * "Cancel" for those rows — strictly better than blocking the entire schedule on the
       * uncached member-summary call.
       */
      enrollVisitByClassId = new Map();
      if (!oauthLoggedIn) {
        scheduleWalletBars("absent", null);
      } else {
        /**
         * Show the skeleton card immediately so the user can see something is happening in
         * the wallet area while the schedule below is fully interactive.
         */
        scheduleWalletBars("loading", null);
      }

      if (allRows.length === 0) {
        calendarEl.hidden = true;
        statusEl.textContent = "No classes in this window.";
        contentEl.innerHTML = "";
        filtersEl.hidden = true;
        /**
         * Still try to populate the wallet for logged-in members even when this query window
         * has no classes — they may want to see their balance to decide what to do next.
         */
        if (oauthLoggedIn) loadMemberSummaryInBackground(currentEpoch);
        return;
      }

      stripKeys = stripKeysFromTodayEt();
      const preserve =
        opts && typeof opts.preserveDayKey === "string" ? opts.preserveDayKey.trim() : "";
      selectedDayKey =
        preserve && stripKeys.includes(preserve) ? preserve : stripKeys[0] || "";

      fillFilterOptions(allRows);
      filtersEl.hidden = false;
      calendarEl.hidden = false;

      wireFilters();
      renderAll();

      /**
       * Schedule is now visible and interactive. Fetch the member summary in the background.
       * When it lands (and this `load()` invocation is still the latest — see `loadEpoch`),
       * it will populate the wallet and re-render the rows so any classes the member already
       * booked flip from "Book" → "Cancel".
       */
      if (oauthLoggedIn) loadMemberSummaryInBackground(currentEpoch);
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
