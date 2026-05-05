/**
 * Mindbody member dashboard — requires `mb_sess` (see `/api/mindbody/member/summary`).
 */
(function () {
  const root = document.querySelector("[data-mb-member-root]");
  if (!root) return;

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
    services: root.querySelector("[data-mb-services]"),
    memberships: root.querySelector("[data-mb-memberships]"),
    balances: root.querySelector("[data-mb-balances]"),
    purchases: root.querySelector("[data-mb-purchases]"),
    warn: root.querySelector("[data-mb-warn]"),
    signin: root.querySelector("[data-mb-signin]"),
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

  /** @param {Record<string, unknown>} v */
  function visitStartMs(v) {
    const t = pick(v, ["StartDateTime", "startDateTime", "StartDate", "ClassDate"]);
    if (t) {
      const ms = new Date(String(t)).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
    const cls = v.Class || v.class;
    if (cls && typeof cls === "object") {
      const c = /** @type {Record<string, unknown>} */ (cls);
      const raw = pick(c, ["StartDateTime", "startDateTime"]);
      if (raw) {
        const ms = new Date(String(raw)).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
    }
    return null;
  }

  /** @param {Record<string, unknown>} v */
  function visitClassLabel(v) {
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
      const id = /** @type {Record<string, unknown>} */ (cls).Id ?? /** @type {Record<string, unknown>} */ (cls).id;
      if (id != null && Number.isFinite(Number(id))) return Number(id);
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

  function upcomingFromPayload(data) {
    const raw = firstArray(data.clientVisits, ["Visits", "ClientVisits", "visits"]);
    const now = Date.now();
    /** @type {Record<string, unknown>[]} */
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const v = /** @type {Record<string, unknown>} */ (item);
      const ms = visitStartMs(v);
      if (ms != null && ms > now) out.push(v);
    }
    out.sort((a, b) => (visitStartMs(a) || 0) - (visitStartMs(b) || 0));
    return out;
  }

  /** @param {Record<string, unknown>[]} visits */
  function renderUpcoming(target, visits) {
    if (!target) return;
    if (!visits.length) {
      target.innerHTML = `<p class="mb-member__empty">No upcoming visits in this date range.</p>`;
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
              new Date(when).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
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
    show("loading");

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
      if (sres.ok) sessOk = sessionLoggedIn(await sres.json());
    } catch (_) {
      sessOk = false;
    }

    if (!sessOk) {
      show("gate");
      return;
    }

    let data;
    try {
      const res = await fetch(mbApiPath("/api/mindbody/member/summary"), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      data = await res.json();
      if (!res.ok) {
        show("err");
        if (el.err)
          el.err.innerHTML = `<p>${escapeHtml(data?.detail || data?.error || "Could not load account.")}</p>`;
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

    renderUpcoming(el.upcoming, upcomingFromPayload(data));

    const services = firstArray(data.clientServices, ["ClientServices", "Services", "clientServices"]);
    renderTable(el.services, services, [
      { label: "Service / series", render: (r) => escapeHtml(String(pick(r, ["Name", "ProgramName", "serviceName"]) || "—")) },
      {
        label: "Remaining",
        render: (r) => escapeHtml(String(pick(r, ["Remaining", "remaining", "Count"]) ?? "—")),
      },
      { label: "Expires", render: (r) => formatDate(pick(r, ["ExpirationDate", "expirationDate", "End"])) },
    ]);

    const mems = firstArray(data.memberships, ["ClientMemberships", "Memberships", "memberships"]);
    renderTable(el.memberships, mems, [
      { label: "Membership", render: (r) => escapeHtml(String(pick(r, ["MembershipName", "Name", "name"]) || "—")) },
      { label: "Active", render: (r) => escapeHtml(String(pick(r, ["Active", "active"]) ?? "—")) },
      { label: "End", render: (r) => formatDate(pick(r, ["ExpirationDate", "EndDate", "end"])) },
    ]);

    const bals = firstArray(data.balances, ["Clients", "Balances", "AccountBalances", "ClientBalances"]);
    renderTable(el.balances, bals, [
      { label: "Description", render: (r) => escapeHtml(String(pick(r, ["Description", "Type", "name"]) || "—")) },
      { label: "Amount", render: (r) => escapeHtml(String(pick(r, ["AccountBalance", "Balance", "amount"]) ?? "—")) },
    ]);

    const purchRoot = data.purchases && typeof data.purchases === "object" ? data.purchases : {};
    const purchases = firstArray(purchRoot, ["Purchases", "Sales", "purchases"]);
    renderTable(el.purchases, purchases, [
      { label: "Date", render: (r) => formatDate(pick(r, ["SaleDate", "PurchaseDate", "CreatedDate"])) },
      { label: "Description", render: (r) => escapeHtml(String(pick(r, ["Description", "ItemDescription", "name"]) || "—")) },
      { label: "Total", render: (r) => escapeHtml(String(pick(r, ["TotalAmount", "GrandTotal", "total"]) ?? "—")) },
    ]);

    if (el.warn && Array.isArray(data.warnings) && data.warnings.length) {
      const extra = data.warnings.filter((w) => w !== "could_not_resolve_client");
      if (extra.length) {
        el.warn.hidden = false;
        el.warn.textContent = `Note: ${extra.join("; ")}`;
      }
    }
  }

  void refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
})();
