/**
 * Mindbody member dashboard — requires `mb_sess` (see `/api/mindbody/member/summary`).
 */
(function () {
  const root = document.querySelector("[data-mb-member-root]");
  if (!root) return;

  /** Align visit times with Mindbody studio wall clock (`classes-schedule.js` ET). */
  const STUDIO_TZ = "America/New_York";

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

  /** @param {Record<string, unknown>[]} visits */
  function renderUpcoming(target, visits) {
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
        const canCancel = vid != null && cid != null;
        const btn = canCancel
          ? `<button type="button" class="btn btn--ghost mb-member-cancel" data-mb-class-id="${cid}" data-mb-visit-id="${vid}">Cancel</button>`
          : "—";
        return `<tr><td>${whenStr}</td><td>${escapeHtml(visitClassLabel(v))}</td><td>${btn}</td></tr>`;
      })
      .join("");
    target.innerHTML = `<table class="mb-member-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
    target.querySelectorAll(".mb-member-cancel").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const classId = btn.getAttribute("data-mb-class-id");
        const visitId = btn.getAttribute("data-mb-visit-id");
        if (!classId || !visitId) return;
        if (!window.confirm("Cancel this reservation? Studio cancellation rules still apply.")) return;
        btn.setAttribute("disabled", "true");
        try {
          const res = await fetch(mbApiPath("/api/mindbody/class/cancel"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ classId: parseInt(classId, 10), visitId: parseInt(visitId, 10) }),
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
              `Could not cancel (${res.status})`;
            window.alert(typeof msg === "string" ? msg : JSON.stringify(j));
            btn.removeAttribute("disabled");
            return;
          }
          void refresh();
        } catch (e) {
          window.alert(String(e?.message || e));
          btn.removeAttribute("disabled");
        }
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
    if (el.signin) el.signin.setAttribute("href", mbApiPath(`/api/mindbody/oauth/start${retParam}`));

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

    if (!sessOk) {
      show("gate");
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
    renderUpcoming(el.upcoming, upcoming);
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
          { label: "Active", render: (r) => escapeHtml(String(pick(r, ["Active", "active"]) ?? "—")) },
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
          { label: "Active", render: (r) => escapeHtml(String(pick(r, ["Active", "active"]) ?? "—")) },
          { label: "End", render: (r) => formatDate(pick(r, ["ExpirationDate", "EndDate", "end"])) },
        ];

    renderTable(el.memberships, mems, memCols);

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
