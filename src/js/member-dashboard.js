/**
 * Member dashboard reads `/api/mindbody/member/summary`.
 * Authorization: existing `mb_sess` or AMARÉ `amare_sess` + linked Studio association.
 * Cancel / Bring-a-Friend mutations stay on `mb_sess`.
 */
(function () {
  const root = document.querySelector("[data-mb-member-root]");
  if (!root) return;

  /** Align visit times with Mindbody studio wall clock (`classes-schedule.js` ET). */
  const STUDIO_TZ = "America/New_York";
  const LATE_CANCEL_HOURS = 12;

  /** @param {Date | null | undefined} start */
  function isWithinLateCancelWindow(start) {
    if (!start || Number.isNaN(start.getTime())) return false;
    const msUntilStart = start.getTime() - Date.now();
    return msUntilStart < LATE_CANCEL_HOURS * 60 * 60 * 1000;
  }

  /**
   * @param {HTMLButtonElement} btn
   * @param {string} loadingClass
   * @param {() => void | Promise<void>} fn
   */
  async function withButtonLoading(btn, loadingClass, fn) {
    if (btn.disabled) return;
    const prevText = btn.textContent || "";
    btn.disabled = true;
    btn.classList.add(loadingClass);
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Loading…";
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.classList.remove(loadingClass);
      btn.removeAttribute("aria-busy");
      btn.textContent = prevText;
    }
  }

  /** @param {string | null | undefined} isoLike */
  function mindbodyInstantToUtcMs(isoLike) {
    if (isoLike == null || typeof isoLike !== "string") return NaN;
    const raw = isoLike.trim();
    if (!raw) return NaN;
    if (/[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw)) {
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
          timeZone: STUDIO_TZ,
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
    let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: STUDIO_TZ,
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

  /** @param {Record<string, unknown>} v */
  function visitStartStudioMs(v) {
    const direct = pick(v, [
      "StartDateTime",
      "startDateTime",
      "StartDate",
      "visitStartDateTime",
      "scheduledDateTime",
    ]);
    if (direct != null && direct !== "") {
      const ms = mindbodyInstantToUtcMs(String(direct));
      if (Number.isFinite(ms)) return ms;
    }
    const cls = v.Class || v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const fromClass = pick(c, ["StartDateTime", "startDateTime"]);
      if (fromClass != null && fromClass !== "") {
        const ms = mindbodyInstantToUtcMs(String(fromClass));
        if (Number.isFinite(ms)) return ms;
      }
    }
    return null;
  }

  function mbApiPrefix() {
    const holder = root.closest("[data-mb-proxy]");
    const raw =
      holder && typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
    return raw.replace(/\/$/, "");
  }

  function mbApiPath(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}${p}` : p;
  }

  /**
   * @param {unknown} data
   * @returns {Map<number, Array<{ guestFirstName: string, guestLastInitial: string, whenMs: number }>>}
   */
  function guestBadgeLookupFromBafStatus(data) {
    /** @type {Map<number, Array<{ guestFirstName: string, guestLastInitial: string, whenMs: number }>>} */
    const map = new Map();
    if (!data || typeof data !== "object") return map;

    /** @param {number | null} classId @param {string} startIso @param {unknown} attached */
    function add(classId, startIso, attached) {
      if (classId == null || !attached || typeof attached !== "object") return;
      const a = /** @type {Record<string, unknown>} */ (attached);
      if (a.status !== "confirmed") return;
      const fn = String(a.guestFirstName || "").trim();
      const li = String(a.guestLastInitial || "").trim();
      if (!fn && !li) return;
      const whenMs = mindbodyInstantToUtcMs(String(startIso || ""));
      if (!Number.isFinite(whenMs)) return;
      const list = map.get(classId) || [];
      list.push({ guestFirstName: fn, guestLastInitial: li, whenMs });
      map.set(classId, list);
    }

    const list = Array.isArray(
      /** @type {Record<string, unknown>} */ (data).upcomingBookedClasses,
    )
      ? /** @type {Record<string, unknown>} */ (data).upcomingBookedClasses
      : [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (row);
      add(Number(r.classId), String(r.startDateTime || ""), r.guestAttached);
    }

    const st = /** @type {Record<string, unknown>} */ (data).status;
    const usedFor = /** @type {Record<string, unknown>} */ (data).usedFor;
    if (st === "used" && usedFor && typeof usedFor === "object") {
      add(Number(usedFor.classId), String(usedFor.classStartDateTime || ""), {
        guestFirstName: usedFor.guestFirstName,
        guestLastInitial: usedFor.guestLastInitial,
        status: "confirmed",
      });
    }
    return map;
  }

  /** @param {Map<number, Array<{ guestFirstName: string, guestLastInitial: string, whenMs: number }>>} lookup @param {number | null} classId @param {number | null} whenMs */
  function guestBadgeForVisit(lookup, classId, whenMs) {
    if (!lookup || classId == null || whenMs == null) return null;
    const rows = lookup.get(classId);
    if (!rows || !rows.length) return null;
    for (const row of rows) {
      if (Math.abs(row.whenMs - whenMs) <= 60_000) return row;
    }
    return null;
  }

  /** @param {{ guestFirstName: string, guestLastInitial: string }} badge */
  function guestBadgeMarkup(badge) {
    const label = `Guest: ${String(badge.guestFirstName || "").trim()} ${String(badge.guestLastInitial || "").trim()}`.trim();
    return `<span class="mb-schedule-guest-badge">${escapeHtml(label)}</span>`;
  }

  const el = {
    loading: root.querySelector("[data-mb-loading]"),
    gate: root.querySelector("[data-mb-gate]"),
    err: root.querySelector("[data-mb-err]"),
    content: root.querySelector("[data-mb-content]"),
    profile: root.querySelector("[data-mb-profile]"),
    upcoming: root.querySelector("[data-mb-upcoming]"),
    completed: root.querySelector("[data-mb-completed]"),
    services: root.querySelector("[data-mb-services]"),
    svcFilter: /** @type {HTMLInputElement|null} */ (root.querySelector("[data-mb-svc-show-all]")),
    memberships: root.querySelector("[data-mb-memberships]"),
    balances: root.querySelector("[data-mb-balances]"),
    purchases: root.querySelector("[data-mb-purchases]"),
    warn: root.querySelector("[data-mb-warn]"),
    signin: root.querySelector("[data-mb-signin]"),
    refreshBtn: root.querySelector("[data-mb-summary-refresh]"),
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function show(which) {
    if (el.loading) el.loading.hidden = which !== "loading";
    if (el.gate) el.gate.hidden = which !== "gate";
    if (el.err) el.err.hidden = which !== "err";
    if (el.content) el.content.hidden = which !== "content";
  }

  function sessionLoggedIn(j) {
    if (!j || typeof j !== "object") return false;
    if (j.authenticated === false || j.loggedIn === false) return false;
    return !!(j.authenticated || j.loggedIn || j.email || j.name || j.sub);
  }

  function firstArray(obj, keys) {
    if (!obj || typeof obj !== "object") return [];
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  /**
   * Mindbody `/client/clientaccountbalances` often nests balances under `Clients[].Accounts`.
   * @param {unknown} balancesRoot
   */
  function flattenBalanceRows(balancesRoot) {
    if (!balancesRoot || typeof balancesRoot !== "object") return [];
    /** @type {unknown[]} */
    let rows = firstArray(balancesRoot, [
      "AccountBalances",
      "Balances",
      "ClientBalances",
      "BalancesDetails",
      "Clients",
      "clients",
    ]);

    if (rows.length === 1 && rows[0] && typeof rows[0] === "object") {
      const o = /** @type {Record<string, unknown>} */ (rows[0]);
      if (Array.isArray(o.Accounts) && o.Accounts.length) return o.Accounts;
      if (Array.isArray(o.ClientAccountBalances) && o.ClientAccountBalances.length)
        return o.ClientAccountBalances;
      if (Array.isArray(o.Balances) && o.Balances.length) return o.Balances;
    }

    return rows.filter((r) => {
      if (!r || typeof r !== "object") return false;
      const row = /** @type {Record<string, unknown>} */ (r);
      if ("Accounts" in row || Array.isArray(row.Balances)) return false;
      return (
        pick(row, ["Description", "Type", "name"]) != null ||
        pick(row, ["AccountBalance", "Balance", "amount", "CurrentBalance"]) != null
      );
    });
  }

  function formatDate(v) {
    if (v == null || v === "") return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(v));
    return escapeHtml(d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  }

  const MONTHLY_MEMBERSHIP_PRODUCT_IDS = new Set([100129, 100130, 100056, 100133, 100134, 100135]);

  /** Naive Mindbody `YYYY-MM-DDTHH:mm:ss` stays that calendar day (no UTC shift). */
  function studioCalendarDay(raw) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim();
    if (!s) return null;
    const ymd = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    if (ymd && !/[zZ]/.test(s) && !/[+-]\d{2}:?\d{2}\s*$/.test(s)) return ymd[1];
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return y && m && day ? `${y}-${m}-${day}` : null;
  }

  function studioTodayDay() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return y && m && day ? `${y}-${m}-${day}` : null;
  }

  function isRecognizedMonthlyMembershipRow(row) {
    const pid = Number(pick(row, ["ProductId", "productId", "ServiceId", "serviceId"]));
    if (Number.isFinite(pid) && MONTHLY_MEMBERSHIP_PRODUCT_IDS.has(pid)) return true;
    const name = String(
      pick(row, ["MembershipName", "Name", "name", "ProgramName", "Description"]) || "",
    ).toLowerCase();
    if (!name) return false;
    return (
      (/\bmonthly\b/.test(name) || /\brecurring\b/.test(name)) &&
      (/\bunlimited\b/.test(name) || /\b8\b/.test(name) || /\b5\b/.test(name))
    );
  }

  function membershipDateWindowActive(row) {
    const start = studioCalendarDay(pick(row, ["ActiveDate", "activeDate"]));
    const end = studioCalendarDay(pick(row, ["ExpirationDate", "EndDate", "end", "expirationDate"]));
    const today = studioTodayDay();
    if (!start || !end || !today) return null;
    return today >= start && today <= end;
  }

  function renderMembershipActive(row) {
    if (isRecognizedMonthlyMembershipRow(row)) {
      const active = membershipDateWindowActive(row);
      if (active === true) return "Active";
      if (active === false) return "Inactive";
      return "—";
    }
    return escapeHtml(String(pick(row, ["Active", "active"]) ?? "—"));
  }

  function renderDl(target, rows) {
    if (!target) return;
    target.innerHTML = rows
      .filter(([_, v]) => v != null && v !== "")
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`)
      .join("");
  }

  function renderTable(target, rows, columns) {
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = `<p class="mb-member__empty">No rows returned.</p>`;
      return;
    }
    const th = columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join("");
    const tr = rows
      .map((row) => {
        const tds = columns.map((c) => `<td>${c.render(row)}</td>`).join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");
    target.innerHTML = `<table class="mb-member-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  /** @param {Record<string, unknown>} row */
  function pick(row, keys) {
    for (const k of keys) {
      if (row[k] != null && row[k] !== "") return row[k];
    }
    return null;
  }

  /** @param {Record<string, unknown>} r */
  function formatPackVisitsRemaining(r) {
    const remRaw = pick(r, ["Remaining", "remaining"]);
    const rem =
      typeof remRaw === "number"
        ? remRaw
        : remRaw != null && Number.isFinite(Number(remRaw))
          ? Number(remRaw)
          : null;
    const deductedRaw = pick(r, ["NumberDeducted", "numberDeducted", "Visited", "visited"]);
    const deducted =
      typeof deductedRaw === "number"
        ? deductedRaw
        : deductedRaw != null && Number.isFinite(Number(deductedRaw))
          ? Number(deductedRaw)
          : null;
    const totalRaw = pick(r, [
      "TotalPurchased",
      "totalPurchased",
      "PurchasedCount",
      "SessionCount",
      "TotalCount",
      "OriginalTotal",
      "originalTotal",
    ]);
    let total =
      typeof totalRaw === "number"
        ? totalRaw
        : totalRaw != null && Number.isFinite(Number(totalRaw))
          ? Number(totalRaw)
          : null;
    if (
      total == null &&
      rem != null &&
      Number.isFinite(rem) &&
      deducted != null &&
      Number.isFinite(deducted) &&
      rem >= 0 &&
      deducted >= 0
    ) {
      total = rem + deducted;
    }
    if (rem != null && Number.isFinite(rem) && total != null && Number.isFinite(total) && total > 0) {
      return escapeHtml(`${rem} / ${total}`);
    }
    if (rem != null && Number.isFinite(rem)) return escapeHtml(String(rem));
    return escapeHtml("—");
  }

  /** Full `ClientServices` list from last successful summary load. */
  /** @type {unknown[]} */
  let cachedServiceRows = [];
  let svcFilterListenerWired = false;

  /** @param {Record<string, unknown>} r */
  function isClientServiceExpired(r) {
    const exp = pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
    if (exp == null || exp === "") return false;
    const d = new Date(String(exp));
    if (Number.isNaN(d.getTime())) return false;
    const today = new Date();
    const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return expDay < todayDay;
  }

  /** @param {Record<string, unknown>} r */
  function clientServiceRemainingNum(r) {
    const remRaw = pick(r, ["Remaining", "remaining"]);
    if (typeof remRaw === "number") return remRaw;
    if (remRaw != null && Number.isFinite(Number(remRaw))) return Number(remRaw);
    return null;
  }

  /**
   * Default view: not past expiration and has visits left (Remaining &gt; 0 when known).
   * @param {unknown} row
   */
  function passesActiveServiceFilter(row, showAll) {
    if (showAll) return true;
    if (!row || typeof row !== "object") return false;
    const r = /** @type {Record<string, unknown>} */ (row);
    if (isClientServiceExpired(r)) return false;
    const rem = clientServiceRemainingNum(r);
    if (rem !== null && rem <= 0) return false;
    return true;
  }

  function wireServiceFilterOnce() {
    if (svcFilterListenerWired || !el.svcFilter) return;
    svcFilterListenerWired = true;
    el.svcFilter.addEventListener("change", () => {
      renderServicesPackagesSection();
    });
  }

  function renderServicesPackagesSection() {
    if (!el.services) return;
    const showAll = !!(el.svcFilter && el.svcFilter.checked);
    const filtered = cachedServiceRows.filter((row) => passesActiveServiceFilter(row, showAll));

    const svcCols = [
      {
        label: "Service / series",
        render: (r) => escapeHtml(String(pick(r, ["Name", "ProgramName", "serviceName"]) || "—")),
      },
      { label: "Visits left", render: (r) => formatPackVisitsRemaining(r) },
      { label: "Expires", render: (r) => formatDate(pick(r, ["ExpirationDate", "expirationDate", "End"])) },
    ];

    if (!filtered.length && cachedServiceRows.length && !showAll) {
      el.services.innerHTML = `<p class="mb-member__empty">${escapeHtml(
        'No active packages (visits left and not expired). Enable "Show expired & empty" to list every row from Mindbody, including 0 visits.',
      )}</p>`;
      return;
    }
    renderTable(el.services, filtered, svcCols);
  }

  /** @param {Record<string, unknown>} v */
  function visitStartMs(v) {
    const direct = pick(v, [
      "StartDateTime",
      "startDateTime",
      "StartDate",
      "startDate",
      "ClassDate",
      "classDate",
      "VisitDate",
      "visitDate",
      "AppointmentStartDate",
      "VisitStartDateTime",
      "visitStartDateTime",
      "scheduledDateTime",
    ]);
    if (direct != null && direct !== "") {
      const ms = new Date(String(direct)).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
    const cls = v.Class || v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const fromClass = pick(c, ["StartDateTime", "startDateTime", "StartDate", "scheduledDateTime"]);
      if (fromClass != null && fromClass !== "") {
        const ms = new Date(String(fromClass)).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
      const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
      if (sched && typeof sched === "object") {
        const s = /** @type {Record<string, unknown>} */ (sched);
        const raw = pick(s, [
          "StartDateTime",
          "startDateTime",
          "ScheduleStartTime",
          "EndDateTime",
          "scheduledDateTime",
        ]);
        if (raw != null && raw !== "") {
          const ms = new Date(String(raw)).getTime();
          if (!Number.isNaN(ms)) return ms;
        }
      }
    }
    return null;
  }

  /** @param {Record<string, unknown>} v */
  function visitClassLabel(v) {
    const flat = pick(v, ["Name", "name", "ServiceName", "serviceName"]);
    if (typeof flat === "string" && flat.trim()) return flat.trim();
    const cls = v.Class || v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const cd = c.ClassDescription || c.classDescription;
      if (cd && typeof cd === "object") {
        const n = /** @type {Record<string, unknown>} */ (cd).Name || /** @type {Record<string, unknown>} */ (cd).name;
        if (typeof n === "string" && n.trim()) return n.trim();
      }
    }
    return "Class";
  }

  /** @param {Record<string, unknown>} v */
  function visitClassId(v) {
    const cls = v.Class || v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const id = c.Id ?? c.id;
      if (id != null && Number.isFinite(Number(id))) return Number(id);
      const sched =
        c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
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
  function visitRowId(v) {
    const raw = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
    return null;
  }

  /** @param {Record<string, unknown>} v */
  function visitIsSignedIn(v) {
    return v.SignedIn === true || v.signedIn === true;
  }

  /**
   * Prefer Mindbody `SignedIn` over `AppointmentStatus` when they disagree
   * (e.g. manual sign-in after auto no-show still leaves AppointmentStatus as NoShow).
   * @param {Record<string, unknown>} v
   */
  function visitStatusLabel(v) {
    /** @type {string[]} */
    const parts = [];
    if (visitIsSignedIn(v)) {
      parts.push("Signed in");
    } else {
      const st = pick(v, ["AppointmentStatus", "appointmentStatus"]);
      if (typeof st === "string" && st.trim()) parts.push(st.trim());
    }
    if (v.LateCancelled === true) parts.push("Late cancel");
    if (v.Missed === true) parts.push("Missed");
    return parts.length ? parts.join(" · ") : "—";
  }

  const VISITS_ROOT_KEYS = ["Visits", "ClientVisits", "visits", "VisitDetails", "ScheduledVisits"];

  /** @param {unknown} cv */
  function visitsArrayFromClientVisits(cv) {
    if (!cv || typeof cv !== "object") return [];
    const o = /** @type {Record<string, unknown>} */ (cv);
    let a = firstArray(o, VISITS_ROOT_KEYS);
    if (a.length) return a;
    const pr = o.PaginationResponse;
    if (pr && typeof pr === "object")
      a = firstArray(/** @type {Record<string, unknown>} */ (pr), VISITS_ROOT_KEYS);
    return a;
  }

  /** @param {{ clientVisits?: unknown }} data */
  function visitsFromPayload(data) {
    return visitsArrayFromClientVisits(data.clientVisits);
  }

  /** @param {unknown[]} visitRows */
  function partitionVisitsByTime(visitRows) {
    const now = Date.now();
    /** @type {Record<string, unknown>[]} */
    const upcoming = [];
    /** @type {Record<string, unknown>[]} */
    const completed = [];
    for (const item of visitRows) {
      if (!item || typeof item !== "object") continue;
      const v = /** @type {Record<string, unknown>} */ (item);
      const ms = visitStartMs(v);
      if (ms == null) continue;
      if (ms > now) upcoming.push(v);
      else completed.push(v);
    }
    upcoming.sort((a, b) => (visitStartMs(a) || 0) - (visitStartMs(b) || 0));
    completed.sort((a, b) => (visitStartMs(b) || 0) - (visitStartMs(a) || 0));
    return { upcoming, completed };
  }

  /** @param {Record<string, unknown>[]} visits */
  function renderCompleted(target, visits) {
    if (!target) return;
    if (!visits.length) {
      target.innerHTML = `<p class="mb-member__empty">No completed visits.</p>`;
      return;
    }
    const th = `<th scope="col">When</th><th scope="col">Class</th><th scope="col">Status</th>`;
    const tr = visits
      .map((v) => {
        const when = visitStartMs(v);
        const whenStr = when
          ? escapeHtml(
              new Date(when).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: STUDIO_TZ,
              }),
            )
          : "—";
        return `<tr><td>${whenStr}</td><td>${escapeHtml(visitClassLabel(v))}</td><td>${escapeHtml(visitStatusLabel(v))}</td></tr>`;
      })
      .join("");
    target.innerHTML = `<table class="mb-member-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  /** @param {number} classId */
  async function fetchGuestCancelPreflight(classId) {
    try {
      const res = await fetch(
        mbApiPath(`/api/mindbody/class/cancel?preflight=1&classId=${encodeURIComponent(String(classId))}`),
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j || typeof j !== "object") return { hasGuest: false };
      return j;
    } catch {
      return { hasGuest: false };
    }
  }

  /**
   * @param {number} classId
   * @param {string | undefined} period
   */
  async function cancelGuestOnlyViaApi(classId, period) {
    /** @type {Record<string, unknown>} */
    const body = { classId, cancelGuestOnly: true, confirmRemoveGuest: true };
    if (period) body.period = period;
    const res = await fetch(mbApiPath("/api/mindbody/class/cancel"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      const msg =
        (j.mindbody &&
          typeof j.mindbody === "object" &&
          /** @type {{ Message?: string; Error?: { Message?: string } }} */ (j.mindbody).Message) ||
        /** @type {{ Error?: { Message?: string } }} */ (j.mindbody)?.Error?.Message ||
        j.detail ||
        j.error ||
        `Could not remove guest (${res.status})`;
      return { ok: false, message: typeof msg === "string" ? msg : JSON.stringify(j) };
    }
    const message =
      j.guestPassReturned === true
        ? "Your guest was removed. Your class stays booked and your Bring a Friend Pass is available again for this period."
        : "Your guest was removed. Your class stays booked.";
    return { ok: true, message };
  }

  /** @param {Record<string, unknown>} guestPreflight @param {boolean} withinLateWindow */
  function guestPassCancelHint(guestPreflight, withinLateWindow) {
    const willRestore =
      guestPreflight.guestPassWillRestore === true
        ? true
        : guestPreflight.guestPassWillRestore === false
          ? false
          : !withinLateWindow;
    return willRestore
      ? "Your Bring a Friend Pass will be available again for this period."
      : "Your Bring a Friend Pass for this period will remain used.";
  }

  /**
   * @param {number} cid
   * @param {Record<string, unknown>} guestPreflight
   */
  async function confirmRemoveGuestOnly(cid, guestPreflight) {
    const guestPeriod =
      guestPreflight && typeof guestPreflight.period === "string" ? guestPreflight.period : undefined;
    const gf = String(guestPreflight.guestFirstName || "Your guest");
    const gl = String(guestPreflight.guestLastInitial || "");
    const ok = window.confirm(
      `Remove your guest only?\n\n${gf} ${gl} will be cancelled. Your class stays booked.\nYour Bring a Friend Pass will be available again for this period.\n\nRemove guest?`,
    );
    if (!ok) return { ok: false, cancelled: true };
    return cancelGuestOnlyViaApi(cid, guestPeriod);
  }

  /** @param {Record<string, unknown>[]} visits @param {Map<number, Array<{ guestFirstName: string, guestLastInitial: string, whenMs: number }>>} [guestBadgeLookup] */
  function renderUpcoming(target, visits, mutationAuthorized, guestBadgeLookup) {
    if (!target) return;
    if (!visits.length) {
      target.innerHTML = `<p class="mb-member__empty">No upcoming visits in this date range (checking about the next year).</p>`;
      return;
    }
    const th = `<th scope="col">When</th><th scope="col">Class</th><th scope="col"></th>`;
    const tr = visits
      .map((v) => {
        const vid = visitRowId(v);
        const cid = visitClassId(v);
        const when = visitStartMs(v);
        const whenStr = when
          ? escapeHtml(
              new Date(when).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: STUDIO_TZ,
              }),
            )
          : "—";
        const whenStudio = visitStartStudioMs(v) ?? when;
        const guestBadge = guestBadgeForVisit(guestBadgeLookup || new Map(), cid, whenStudio);
        const classCell = `${escapeHtml(visitClassLabel(v))}${guestBadge ? guestBadgeMarkup(guestBadge) : ""}`;
        const canCancel = mutationAuthorized === true && vid != null && cid != null;
        const canRemoveGuestOnly =
          canCancel &&
          guestBadge != null &&
          whenStudio != null &&
          !isWithinLateCancelWindow(new Date(whenStudio));
        const removeGuestBtn = canRemoveGuestOnly
          ? `<button type="button" class="btn btn--ghost mb-member-remove-guest" data-mb-class-id="${cid}">Remove guest</button>`
          : "";
        const cancelBtn = canCancel
          ? `<button type="button" class="btn btn--ghost mb-member-cancel mb-schedule-slot__cancel" data-mb-class-id="${cid}" data-mb-visit-id="${vid}">Cancel</button>`
          : "";
        const actionsCell = canCancel ? `${removeGuestBtn}${cancelBtn}` : "—";
        return `<tr><td>${whenStr}</td><td>${classCell}</td><td>${actionsCell}</td></tr>`;
      })
      .join("");
    target.innerHTML = `<table class="mb-member-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;

    target.querySelectorAll(".mb-member-remove-guest").forEach((btn) => {
      btn.addEventListener("click", () => {
        const classId = btn.getAttribute("data-mb-class-id");
        if (!classId) return;
        const cid = parseInt(classId, 10);
        void withButtonLoading(/** @type {HTMLButtonElement} */ (btn), "mb-member-remove-guest--loading", async () => {
          const guestPreflight = await fetchGuestCancelPreflight(cid);
          if (guestPreflight.canRemoveGuestOnly !== true && guestPreflight.guestPassWillRestore !== true) {
            window.alert("Guest can only be removed more than 12 hours before class start.");
            return;
          }
          const result = await confirmRemoveGuestOnly(cid, guestPreflight);
          if (result.cancelled) return;
          if (result.ok) {
            window.alert(result.message);
            void refresh();
          } else {
            window.alert(result.message);
          }
        });
      });
    });

    target.querySelectorAll(".mb-member-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const classId = btn.getAttribute("data-mb-class-id");
        const visitId = btn.getAttribute("data-mb-visit-id");
        if (!classId || !visitId) return;
        const cid = parseInt(classId, 10);
        const vid = parseInt(visitId, 10);
        void withButtonLoading(/** @type {HTMLButtonElement} */ (btn), "mb-member-cancel--loading", async () => {
          const guestPreflight = await fetchGuestCancelPreflight(cid);
          const hasGuest = guestPreflight.hasGuest === true;
          const guestPeriod =
            guestPreflight && typeof guestPreflight.period === "string" ? guestPreflight.period : undefined;
          const canRemoveGuestOnly =
            hasGuest &&
            (guestPreflight.canRemoveGuestOnly === true || guestPreflight.guestPassWillRestore === true);
          if (hasGuest) {
            const gf = String(guestPreflight.guestFirstName || "Your guest");
            const gl = String(guestPreflight.guestLastInitial || "");
            const passHint = guestPassCancelHint(guestPreflight, false);
            const tip = canRemoveGuestOnly
              ? "\n\nTip: use Remove guest to keep your spot and get your pass back."
              : "";
            const ok = window.confirm(
              `Cancel your class and your guest?\n\nCanceling this class will also cancel ${gf} ${gl}'s spot.\n${passHint}${tip}\n\nCancel both bookings?`,
            );
            if (!ok) return;
          } else if (!window.confirm("Cancel this reservation? Studio cancellation rules still apply.")) {
            return;
          }
          btn.disabled = true;
          btn.textContent = "Cancelling…";
          try {
            /** @type {Record<string, unknown>} */
            const body = { classId: cid, visitId: vid };
            if (hasGuest) {
              body.confirmCancelGuest = true;
              if (guestPeriod) body.period = guestPeriod;
            }
            const res = await fetch(mbApiPath("/api/mindbody/class/cancel"), {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify(body),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || j.ok === false) {
              if (j.error === "guest_cancel_confirmation_required") {
                window.alert("This class has a guest booking. Please try again or cancel from the class schedule.");
                return;
              }
              const msg =
                (j.mindbody &&
                  typeof j.mindbody === "object" &&
                  /** @type {{ Message?: string; Error?: { Message?: string } }} */ (j.mindbody).Message) ||
                /** @type {{ Error?: { Message?: string } }} */ (j.mindbody)?.Error?.Message ||
                j.detail ||
                j.error ||
                `Could not cancel (${res.status})`;
              window.alert(typeof msg === "string" ? msg : JSON.stringify(j));
              return;
            }
            if (j.guestPassReturned === true) {
              window.alert("Your class was cancelled and your Bring a Friend Pass is available again for this period.");
            } else if (j.guestAlsoCancelled === true) {
              window.alert("Your class was cancelled and your guest was notified.");
            }
            void refresh();
          } catch (e) {
            window.alert(String(e?.message || e));
          }
        });
      });
    });
  }

  async function refresh() {
    const rb = el.refreshBtn;
    if (rb) {
      rb.disabled = true;
      rb.setAttribute("aria-busy", "true");
    }
    try {
      show("loading");

      if (typeof globalThis.mbWalletRenderInto === "function") {
        const wm = document.getElementById("mb-member-wallet-mount");
        if (wm) globalThis.mbWalletRenderInto(wm, null, "absent");
      }

    function oauthReturnPath() {
      let p = window.location.pathname || "/";
      if (p === "/member.html") p = "/member";
      return p + (window.location.search || "");
    }
    const ret = encodeURIComponent(oauthReturnPath());
    const retParam = `?return=${ret}`;
    const uiOn = document.body.getAttribute("data-amare-auth-ui") === "1";
    if (el.signin) {
      el.signin.setAttribute(
        "href",
        uiOn ? `/login?return=${ret}` : mbApiPath(`/api/mindbody/oauth/start${retParam}`),
      );
    }

    let sessOk = false;
    try {
      const sres = await fetch(mbApiPath("/api/mindbody/oauth/session"), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const stxt = await sres.text();
      let sj = null;
      try {
        sj = stxt ? JSON.parse(stxt) : null;
      } catch {
        sj = null;
      }
      sessOk = sres.ok && sessionLoggedIn(sj);
    } catch (_) {
      sessOk = false;
    }

    /** @type {{ signedIn?: boolean, studioAccess?: string } | null} */
    let amareAccess = null;
    try {
      const accessRes = await fetch("/api/amare/auth/member-access", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      amareAccess = accessRes.ok ? await accessRes.json() : null;
    } catch {
      amareAccess = null;
    }

    const studioAccess = amareAccess && typeof amareAccess.studioAccess === "string" ? amareAccess.studioAccess : "none";
    const amareSignedIn = amareAccess && amareAccess.signedIn === true;
    const amareLinked = amareSignedIn && studioAccess === "linked";
    const studioOperations = amareAccess && amareAccess.studioOperations === true;
    const mutationAuthorized = sessOk || (amareLinked && studioOperations);

    if (studioAccess === "conflict") {
      show("err");
      if (el.err) {
        el.err.innerHTML =
          "<p>This browser has two different studio accounts. Sign out and continue with one account. We will not mix credits or visits.</p>";
      }
      return;
    }

    if (!sessOk && !amareLinked) {
      show("gate");
      const gateCopy = root.querySelector("[data-mb-gate-copy]");
      if (gateCopy && amareSignedIn && studioAccess === "verified_pending_link") {
        gateCopy.textContent = "You’re signed in to AMARÉ. Confirm this studio profile to see your credits, packages, and visits.";
        let promote = root.querySelector("[data-amare-promote-link]");
        if (!promote) {
          promote = document.createElement("button");
          promote.type = "button";
          promote.className = "btn btn--cream";
          promote.setAttribute("data-amare-promote-link", "");
          promote.textContent = "Continue with this studio profile";
          gateCopy.insertAdjacentElement("afterend", promote);
          promote.addEventListener("click", async () => {
            promote.setAttribute("disabled", "true");
            try {
              const res = await fetch("/api/amare/auth/association/link", {
                method: "POST",
                credentials: "same-origin",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ explicitPromote: true }),
              });
              if (res.ok) {
                void refresh();
                return;
              }
            } catch {
              /* keep gate */
            }
            promote.removeAttribute("disabled");
          });
        }
      } else if (gateCopy && amareSignedIn && studioAccess === "needs_profile") {
        gateCopy.textContent = "Let’s finish setting up your AMARÉ profile.";
        const signin = root.querySelector("[data-mb-signin]");
        if (signin) {
          signin.setAttribute("href", `/login?return=${encodeURIComponent("/member")}`);
          signin.textContent = "Complete your AMARÉ profile";
        }
      } else if (gateCopy && amareSignedIn && studioAccess === "search_unavailable") {
        gateCopy.textContent = "We couldn’t finish checking your studio profile right now. Please try again.";
        const signin = root.querySelector("[data-mb-signin]");
        if (signin) {
          signin.setAttribute("href", `/login?return=${encodeURIComponent("/member")}`);
          signin.textContent = "Try again";
        }
      } else if (gateCopy && amareSignedIn) {
        gateCopy.textContent =
          "You’re signed in to AMARÉ. Studio credits, packages, and visits need a linked studio profile.";
        const signin = root.querySelector("[data-mb-signin]");
        if (signin) {
          signin.setAttribute("href", `/login?return=${encodeURIComponent("/member")}`);
          signin.textContent = "Finish linking";
        }
      } else {
        const signin = root.querySelector("[data-mb-signin]");
        if (signin) {
          signin.setAttribute("href", `/login?return=${encodeURIComponent("/member")}`);
          signin.textContent = "Sign in";
        }
      }
      return;
    }

    const logoutHref = mbApiPath(`/api/mindbody/oauth/logout${retParam}`);
    let data;
    try {
      const res = await fetch(mbApiPath("/api/mindbody/member/summary"), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const txt = await res.text();
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        show("err");
        if (el.err)
          el.err.innerHTML = `<p>${escapeHtml(
            `Server returned invalid JSON (${res.status}). Check the dev server terminal. If MINDBODY_SESSION_SECRET was missing, restart after adding it to .env.`,
          )}</p>`;
        return;
      }
      if (!res.ok) {
        show("err");
        if (!el.err) return;
        if (data?.error === "session_conflict" || res.status === 409) {
          el.err.innerHTML =
            "<p>This browser has two different studio accounts. Sign out and continue with one account. We will not mix credits or visits.</p>";
          return;
        }
        const detail = typeof data.detail === "string" ? data.detail : "";
        const invalidGrant =
          detail.includes("invalid_grant") || String(data.error || "").includes("invalid_grant");
        const refreshDead = data.error === "token_refresh_failed" && invalidGrant;
        if (refreshDead) {
          el.err.innerHTML = `<p>Mindbody rejected the saved session (${escapeHtml(detail)}). <a href="${escapeHtml(logoutHref)}">Sign out</a> and sign in again.</p>`;
        } else {
          el.err.innerHTML = `<p>${escapeHtml(data?.detail || data?.error || `Could not load account (${res.status}).`)}</p>`;
          if (
            data?.error === "oauth_handler_exception" &&
            typeof data.detail === "string" &&
            data.detail.includes("MINDBODY_SESSION_SECRET")
          ) {
            el.err.innerHTML += `<p class="mb-member__hint">${escapeHtml(
              "Add MINDBODY_SESSION_SECRET to .env and restart dev.",
            )}</p>`;
          }
        }
        return;
      }
    } catch (e) {
      show("err");
      if (el.err)
        el.err.innerHTML = `<p>${escapeHtml(String(e?.message || "Network error"))}</p>`;
      return;
    }

    if (!data.ok) {
      show("err");
      if (el.err) el.err.innerHTML = `<p>${escapeHtml(data?.error || "Unknown error")}</p>`;
      return;
    }

    const sessionName = data.profile?.sessionName;
    const sessionEmail = data.profile?.sessionEmail;

    show("content");
    document.dispatchEvent(new CustomEvent("mb-member-summary-loaded", { detail: data }));

    if (typeof globalThis.mbWalletRenderInto === "function") {
      const wm = document.getElementById("mb-member-wallet-mount");
      if (wm) globalThis.mbWalletRenderInto(wm, /** @type {Record<string, unknown>} */ (data), "ok");
    }

    if (data.clientId == null) {
      if (el.warn) {
        el.warn.hidden = false;
        let msg =
          "We could not match your Mindbody login to a client record for this studio. Use the same email as in Mindbody, or ask the desk to verify your account.";
        const w = data.warnings;
        if (Array.isArray(w) && w.includes("hint_production_site_id")) {
          msg +=
            " Backend tip: MINDBODY_SITE_ID is sandbox (-99) by default; set it to your Amare studio’s production Site ID in .env and restart—the Public API scopes clients to that site.";
        }
        el.warn.textContent = msg;
      }
      renderDl(el.profile, [
        ["Signed in", sessionEmail || sessionName || "—"],
        ["Client ID", "—"],
      ]);
      const empty = `<p class="mb-member__empty">No data — client profile not linked.</p>`;
      if (el.upcoming) el.upcoming.innerHTML = empty;
      if (el.completed) el.completed.innerHTML = empty;
      cachedServiceRows = [];
      if (el.services) el.services.innerHTML = empty;
      if (el.memberships) el.memberships.innerHTML = empty;
      if (el.balances) el.balances.innerHTML = empty;
      if (el.purchases) el.purchases.innerHTML = empty;
      return;
    }

    if (el.warn) el.warn.hidden = true;

    const prof = data.profile?.client;
    const name =
      [pick(prof || {}, ["FirstName", "firstName"]), pick(prof || {}, ["LastName", "lastName"])]
        .filter(Boolean)
        .join(" ")
        .trim() || null;

    renderDl(el.profile, [
      ["Name", name || sessionName || "—"],
      ["Email", pick(prof || {}, ["Email", "email"]) || sessionEmail || "—"],
      ["Mobile", pick(prof || {}, ["MobilePhone", "HomePhone", "phone"]) || "—"],
      ["Client ID", data.clientId != null ? escapeHtml(String(data.clientId)) : "—"],
    ]);

    const visitRows = visitsFromPayload(data);
    const { upcoming, completed } = partitionVisitsByTime(visitRows);

    /** @type {Map<number, Array<{ guestFirstName: string, guestLastInitial: string, whenMs: number }>>} */
    let guestBadgeLookup = new Map();
    if (mutationAuthorized) {
      try {
        const bafRes = await fetch(mbApiPath("/api/mindbody/member/bring-a-friend/status"), {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (bafRes.ok) {
          guestBadgeLookup = guestBadgeLookupFromBafStatus(await bafRes.json().catch(() => null));
        }
      } catch {
        guestBadgeLookup = new Map();
      }
    }

    renderUpcoming(el.upcoming, upcoming, mutationAuthorized, guestBadgeLookup);
    renderCompleted(el.completed, completed);

    const services = firstArray(data.clientServices, ["ClientServices", "Services", "clientServices"]);
    cachedServiceRows = services;
    wireServiceFilterOnce();
    renderServicesPackagesSection();

    const mems = firstArray(data.memberships, [
      "ClientMemberships",
      "Memberships",
      "memberships",
      "ActiveClientMemberships",
      "ActiveMemberships",
      "activeMemberships",
    ]);

    /**
     * Stripe-side commitment overlay (§ 9.18). Mindbody's `End` is the
     * 1-month service expiration / next renewal date — but Monthly plans
     * carry a 3-month minimum commitment that lives only in our store.
     * Surface it as a separate `Commitment until` column.
     */
    const stripeCommitments = Array.isArray(data.stripeSubscriptionCommitments)
      ? data.stripeSubscriptionCommitments
      : [];

    const commitmentByMembershipTypeId = new Map();
    for (const c of stripeCommitments) {
      if (c && c.mindbodyMembershipTypeId != null) {
        commitmentByMembershipTypeId.set(Number(c.mindbodyMembershipTypeId), c);
      }
    }

    function findCommitmentForMembershipRow(row) {
      const mtId = pick(row, [
        "MembershipId",
        "MembershipID",
        "MembershipTypeId",
        "ProgramId",
        "Id",
      ]);
      if (mtId != null) {
        const n = Number(mtId);
        if (Number.isFinite(n) && commitmentByMembershipTypeId.has(n)) {
          return commitmentByMembershipTypeId.get(n);
        }
      }
      if (stripeCommitments.length === 1 && commitmentByMembershipTypeId.size === 0) {
        return stripeCommitments[0];
      }
      return null;
    }

    const anyCommitmentMatch = mems.some((m) => findCommitmentForMembershipRow(m) != null);

    function renderCommitmentCell(r) {
      const c = findCommitmentForMembershipRow(r);
      if (!c) return "—";
      const end = c.commitmentEndDate;
      if (!end) return "—";
      const endMs = Date.parse(end);
      const months =
        typeof c.minimumCommitmentMonths === "number" ? c.minimumCommitmentMonths : null;
      if (Number.isFinite(endMs) && endMs <= Date.now()) {
        return `<span title="${escapeHtml(end)}">Commitment fulfilled</span>`;
      }
      const dateLabel = formatDate(end);
      if (months && months > 0) {
        return `<span title="${escapeHtml(`${months}-month minimum commitment`)}">${dateLabel}</span>`;
      }
      return dateLabel;
    }

    const memCols = anyCommitmentMatch
      ? [
          {
            label: "Membership",
            render: (r) =>
              escapeHtml(
                String(
                  pick(r, ["MembershipName", "Name", "name", "ProgramName", "Description"]) ||
                    "—",
                ),
              ),
          },
          { label: "Active", render: (r) => renderMembershipActive(r) },
          { label: "Renews on", render: (r) => formatDate(pick(r, ["ExpirationDate", "EndDate", "end"])) },
          { label: "Commitment until", render: renderCommitmentCell },
        ]
      : [
          {
            label: "Membership",
            render: (r) =>
              escapeHtml(
                String(
                  pick(r, ["MembershipName", "Name", "name", "ProgramName", "Description"]) ||
                    "—",
                ),
              ),
          },
          { label: "Active", render: (r) => renderMembershipActive(r) },
          { label: "End", render: (r) => formatDate(pick(r, ["ExpirationDate", "EndDate", "end"])) },
        ];

    renderTable(el.memberships, mems, memCols);

    if (el.balances) {
      const bals = flattenBalanceRows(data.balances);
      renderTable(el.balances, bals, [
        {
          label: "Description",
          render: (r) => {
            const d = pick(r, ["Description", "Type", "name", "ServiceCategoryName"]);
            const label =
              typeof d === "string" && d.trim()
                ? String(d)
                : pick(r, ["AccountBalance", "Balance", "amount", "CurrentBalance"]) != null
                  ? "Account balance"
                  : "—";
            return escapeHtml(label);
          },
        },
        {
          label: "Amount",
          render: (r) =>
            escapeHtml(String(pick(r, ["AccountBalance", "Balance", "amount", "CurrentBalance"]) ?? "—")),
        },
      ]);
    }

    const purchRoot = data.purchases && typeof data.purchases === "object" ? data.purchases : {};
    /** @type {unknown[]} */
    let purchases = firstArray(purchRoot, [
      "Purchases",
      "Sales",
      "purchases",
      "ClientPurchases",
      "PurchaseHistory",
      "PurchasedItems",
    ]);
    if (!purchases.length && Array.isArray(purchRoot.Items)) purchases = /** @type {unknown[]} */ (purchRoot.Items);
    if (
      !purchases.length &&
      purchRoot.SaleDetails &&
      Array.isArray(/** @type {Record<string, unknown>} */ (purchRoot).SaleDetails)
    ) {
      purchases = /** @type {unknown[]} */ (/** @type {Record<string,unknown>} */ (purchRoot).SaleDetails);
    }
    const prMeta =
      purchRoot.PaginationResponse && typeof purchRoot.PaginationResponse === "object"
        ? /** @type {Record<string, unknown>} */ (purchRoot.PaginationResponse)
        : null;
    const purchaseTotal =
      prMeta && typeof prMeta.TotalResults === "number" ? prMeta.TotalResults : null;

    const purchaseCols = [
      {
        label: "Date",
        render: (r) =>
          formatDate(
            pick(r, ["SaleDate", "SaleDateTime", "PurchaseDate", "CreatedDate", "VisitDate"]),
          ),
      },
      {
        label: "Description",
        render: (r) =>
          escapeHtml(
            String(pick(r, ["Description", "ItemDescription", "name", "ItemName"]) || "—"),
          ),
      },
      {
        label: "Total",
        render: (r) =>
          escapeHtml(
            String(pick(r, ["TotalAmount", "GrandTotal", "total", "Price", "UnitPrice"]) ?? "—"),
          ),
      },
    ];

    if (!purchases.length && purchaseTotal === 0 && el.purchases) {
      el.purchases.innerHTML = `<p class="mb-member__empty">${escapeHtml(
        `Mindbody "client purchases" returned 0 rows for this profile (see JSON TotalResults: 0). That is separate from the "Services & packages" list above and may differ from the branded Mindbody app wallet.`,
      )}</p>`;
    } else {
      renderTable(el.purchases, purchases, purchaseCols);
    }

    if (el.warn && Array.isArray(data.warnings) && data.warnings.length) {
      const extra = data.warnings.filter((w) => w !== "could_not_resolve_client");
      if (extra.length) {
        el.warn.hidden = false;
        el.warn.textContent = `Note: ${extra.join("; ")}`;
      }
    }
    } finally {
      if (rb) {
        rb.disabled = false;
        rb.removeAttribute("aria-busy");
      }
    }
  }

  (function setupScheduleTabs() {
    const strip = root.querySelector("[data-mb-schedule-tabs]");
    if (!strip) return;
    const tabs = strip.querySelectorAll("[data-mb-sched-tab]");
    const panes = root.querySelectorAll("[data-mb-sched-pane]");
    for (const btn of tabs) {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-mb-sched-tab");
        if (!key) return;
        for (const b of tabs) {
          const on = b.getAttribute("data-mb-sched-tab") === key;
          b.classList.toggle("mb-member-tab--active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        }
        for (const pane of panes) {
          const p = pane.getAttribute("data-mb-sched-pane");
          /** @type {HTMLElement} */ (pane).hidden = p !== key;
        }
      });
    }
  })();

  if (el.refreshBtn) {
    el.refreshBtn.addEventListener("click", () => void refresh());
  }

  void refresh();
})();
