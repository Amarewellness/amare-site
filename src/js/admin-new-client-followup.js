/**
 * Admin UI — upload Mindbody Series Expirations report + dry-run New Client SMS follow-up.
 * Token kept in sessionStorage for the tab only (not localStorage).
 */
(function adminNewClientFollowup() {
  const shared = window.AmareFollowUpAdmin || {};
  const getTokenFn = shared.getToken || (() => (sessionStorage.getItem("amare_ncs_admin_token") || "").trim());
  const setTokenFn =
    shared.setToken ||
    ((t) => {
      sessionStorage.setItem("amare_ncs_admin_token", t.trim());
    });
  const adminFetchFn =
    shared.adminFetch ||
    (async (token, url, init) => {
      const headers = new Headers(init?.headers || {});
      headers.set("x-admin-token", token);
      const res = await fetch(url, { ...init, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      return data;
    });
  const showErrorFn =
    shared.showError ||
    ((el, msg) => {
      if (!el) return;
      el.textContent = msg || "";
      el.hidden = !msg;
    });
  const formatCountMapFn = shared.formatCountMap || ((map) => Object.entries(map || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "—");
  const escFn =
    shared.esc ||
    ((s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"));
  const recommendedActionFn = shared.recommendedActionNewClient || (() => "—");
  const contactPhoneFn =
    shared.contactPhone ||
    ((row) => {
      if (!row || typeof row !== "object") return "—";
      const r = /** @type {Record<string, unknown>} */ (row);
      const phone = String(r.phone || "").trim();
      if (phone) return phone;
      const last4 = String(r.phoneLast4 || "").trim();
      return last4 ? `…${last4}` : "—";
    });
  const contactEmailFn =
    shared.contactEmail ||
    ((row) => {
      if (!row || typeof row !== "object") return "—";
      const r = /** @type {Record<string, unknown>} */ (row);
      const email = String(r.email || "").trim();
      if (email) return email;
      return String(r.emailDomain || "").trim() || "—";
    });

  const STATUS_URL = "/api/admin/new-client-sms/seed-report/status";
  const RUN_URL = "/api/admin/new-client-sms/run";

  /** @type {HTMLElement | null} */
  const root = document.querySelector("[data-admin-sms-root]");
  if (!root) return;

  /** @type {HTMLInputElement | null} */
  const tokenInput = root.querySelector("[data-admin-token-input]");
  /** @type {HTMLElement | null} */
  const authPanel = root.querySelector("[data-admin-auth-panel]");
  /** @type {HTMLElement | null} */
  const mainPanel = root.querySelector("[data-admin-main]");
  /** @type {HTMLElement | null} */
  const authError = root.querySelector("[data-admin-auth-error]");
  /** @type {HTMLInputElement | null} */
  const fileInput = root.querySelector("[data-admin-file-input]");
  /** @type {HTMLButtonElement | null} */
  const uploadBtn = root.querySelector("[data-admin-upload-run]");
  /** @type {HTMLButtonElement | null} */
  const runSavedBtn = root.querySelector("[data-admin-run-saved]");
  /** @type {HTMLElement | null} */
  const runStatus = root.querySelector("[data-admin-run-status]");
  /** @type {HTMLElement | null} */
  const runError = root.querySelector("[data-admin-run-error]");
  /** @type {HTMLElement | null} */
  const resultsPanel = root.querySelector("[data-admin-results]");
  /** @type {HTMLElement | null} */
  const summaryDl = root.querySelector("[data-admin-summary]");
  /** @type {HTMLTableSectionElement | null} */
  const candidatesBody = root.querySelector("[data-admin-candidates-body]");
  /** @type {HTMLElement | null} */
  const noCandidates = root.querySelector("[data-admin-no-candidates]");
  /** @type {HTMLElement | null} */
  const unmatchedWarn = root.querySelector("[data-admin-unmatched-warn]");

  /** @returns {string} */
  function getToken() {
    return getTokenFn();
  }

  /** @param {string} token */
  function setToken(token) {
    setTokenFn(token);
  }

  /** @param {HTMLElement | null} el @param {string} msg */
  function showError(el, msg) {
    showErrorFn(el, msg);
  }

  /** @param {boolean} busy @param {string} [msg] */
  function setBusy(busy, msg) {
    if (uploadBtn) uploadBtn.disabled = busy || !(fileInput?.files?.length);
    if (runSavedBtn) runSavedBtn.disabled = busy;
    if (runStatus) {
      runStatus.textContent = msg || "";
      runStatus.hidden = !msg;
    }
  }

  /** @param {string} token @param {string} url @param {RequestInit} [init] */
  async function adminFetch(token, url, init) {
    return adminFetchFn(token, url, init);
  }

  /** @param {number | null | undefined} n */
  function fmtNum(n) {
    return n == null || Number.isNaN(n) ? "—" : String(n);
  }

  /** @param {string | null | undefined} iso */
  function fmtUploadedAt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  /** @param {number | null | undefined} bytes */
  function fmtBytes(bytes) {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** @param {Record<string, unknown>} status */
  function renderSeedStatus(status) {
    const exists = status.exists === true;
    const set = (sel, text) => {
      const el = root.querySelector(sel);
      if (el) el.textContent = text;
    };
    set("[data-seed-exists]", exists ? "Saved report on file" : "No saved report yet");
    set("[data-seed-uploaded-at]", exists ? fmtUploadedAt(String(status.uploadedAt || "")) : "—");
    set("[data-seed-filename]", exists ? String(status.filename || "(not recorded)") : "—");
    set("[data-seed-size]", exists ? fmtBytes(Number(status.size)) : "—");
    set("[data-seed-rows]", exists ? fmtNum(Number(status.totalRows)) : "—");
    set("[data-seed-ncs-rows]", exists ? fmtNum(Number(status.ncsRows)) : "—");
    const range = status.reportDateRange;
    if (range && typeof range === "object") {
      const r = /** @type {{ min?: string; max?: string }} */ (range);
      const label =
        r.min && r.max ? (r.min === r.max ? r.min : `${r.min} – ${r.max}`) : r.min || r.max || "—";
      set("[data-seed-date-range]", label);
    } else {
      set("[data-seed-date-range]", "—");
    }
  }

  /** @param {string} token */
  async function refreshSeedStatus(token) {
    try {
      const status = await adminFetch(token, STATUS_URL);
      renderSeedStatus(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderSeedStatus({ exists: false });
      if (msg.includes("404") || msg === "HTTP 404") {
        showError(
          runError,
          "Status API not found — restart npm run dev (local) or deploy latest code (production). Upload & run still works.",
        );
      }
    }
  }

  /** @param {Record<string, number>} map */
  function formatCountMap(map) {
    return formatCountMapFn(map);
  }

  /** @param {unknown[]} candidates */
  function countBySegment(candidates) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const raw of candidates) {
      if (!raw || typeof raw !== "object") continue;
      const seg = String(/** @type {Record<string, unknown>} */ (raw).segment || "unknown");
      out[seg] = (out[seg] || 0) + 1;
    }
    return out;
  }

  /** @param {unknown[]} candidates */
  function countSmsConsent(candidates) {
    /** @type {Record<string, number>} */
    const out = { explicit_opt_in: 0, explicit_opt_out: 0, unknown: 0 };
    for (const raw of candidates) {
      if (!raw || typeof raw !== "object") continue;
      const c = String(/** @type {Record<string, unknown>} */ (raw).smsConsent || "unknown");
      if (c in out) out[c] += 1;
      else out.unknown += 1;
    }
    return out;
  }

  /** @param {unknown[]} candidates */
  function countBlockReasons(candidates) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const raw of candidates) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const key = r.blockReason
        ? String(r.blockReason)
        : r.wouldSend
          ? "(none — would send if live)"
          : "(none)";
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }

  /** @param {string} s */
  function esc(s) {
    return escFn(s);
  }

  /** @param {string | null | undefined} iso */
  function fmtExpiration(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /** @param {Record<string, unknown>} body */
  function renderResults(body) {
    if (!resultsPanel || !summaryDl) return;

    const ss = /** @type {Record<string, unknown>} */ (body.seedSources || {});
    const candidates = Array.isArray(body.report?.candidates) ? body.report.candidates : [];
    const unmatched = Number(ss.mindbodySeriesExpirationUnmatched ?? 0);
    const ambiguous = Number(ss.mindbodySeriesExpirationAmbiguous ?? 0);

    const rows = [
      ["Total report rows", fmtNum(Number(ss.mindbodySeriesExpirationRows ?? 0))],
      ["NCS rows", fmtNum(Number(ss.mindbodySeriesExpirationNcsRows ?? 0))],
      ["Matched", fmtNum(Number(ss.mindbodySeriesExpirationMatched ?? 0))],
      ["Unmatched", fmtNum(unmatched)],
      ["Ambiguous", fmtNum(ambiguous)],
      ["Evaluated clients", fmtNum(Number(body.evaluatedClients ?? 0))],
      [
        "ClientServices batch",
        body.clientservicesBatchLoaded != null
          ? `${body.clientservicesBatchLoaded}/${body.clientservicesBatchRequested ?? "?"} clients loaded (${body.clientservicesBatchCalls ?? 0} API call(s))`
          : "—",
      ],
      ["Candidates", fmtNum(Number(body.candidates ?? candidates.length))],
      ["Candidates by segment", formatCountMap(countBySegment(candidates))],
      ["SMS consent", formatCountMap(countSmsConsent(candidates))],
      ["Block reasons", formatCountMap(countBlockReasons(candidates))],
      ["SMS sent", fmtNum(Number(body.sent ?? 0))],
      ["Dry-run", body.dryRun === true ? "Yes" : "No"],
      ["Duration", body.durationMs != null ? `${body.durationMs} ms` : "—"],
    ];

    summaryDl.innerHTML = rows
      .map(([dt, dd]) => `<div><dt>${esc(dt)}</dt><dd>${esc(dd)}</dd></div>`)
      .join("");

    if (unmatchedWarn) {
      unmatchedWarn.hidden = unmatched + ambiguous <= 0;
    }

    if (candidatesBody) {
      candidatesBody.innerHTML = candidates
        .map((raw) => {
          if (!raw || typeof raw !== "object") return "";
          const r = /** @type {Record<string, unknown>} */ (raw);
          const name = r.csvClientName ? String(r.csvClientName) : "—";
          const message = r.messageBody ? String(r.messageBody) : "";
          const wouldSend = r.wouldSend === true ? "yes" : "no";
          const action = r.recommendedAction ? String(r.recommendedAction) : recommendedActionFn(r);
          return `<tr class="admin-sms__row-main">
            <td>${esc(name)}</td>
            <td>${esc(r.mindbodyClientId)}</td>
            <td>${esc(r.segment)}</td>
            <td>${esc(r.remainingVisits)}</td>
            <td>${esc(fmtExpiration(String(r.expirationDate || "")))}</td>
            <td>${esc(r.daysToExpiry)}</td>
            <td>${esc(r.smsConsent)}</td>
            <td>${esc(wouldSend)}</td>
            <td>${esc(r.blockReason || "—")}</td>
            <td class="admin-sms__contact admin-sms__contact--phone">${esc(contactPhoneFn(r))}</td>
            <td class="admin-sms__contact admin-sms__contact--email">${esc(contactEmailFn(r))}</td>
            <td class="admin-sms__action">${esc(action)}</td>
          </tr>
          <tr class="admin-sms__row-message">
            <td colspan="12">
              <div class="admin-sms__message-block">
                <div class="admin-sms__message-head">
                  <span class="admin-sms__message-label">SMS preview (dry-run — not sent)</span>
                  <button type="button" class="btn btn--ghost admin-sms__copy-btn" data-copy-sms>Copy message</button>
                </div>
                <pre class="admin-sms__message-text">${message ? esc(message) : "—"}</pre>
              </div>
            </td>
          </tr>`;
        })
        .join("");
    }

    if (noCandidates) noCandidates.hidden = candidates.length > 0;
    resultsPanel.hidden = false;
    resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** @param {string} token @param {RequestInit} init */
  async function runDryRun(token, init) {
    showError(runError, "");
    setBusy(true, "Running dry-run…");
    try {
      const body = await adminFetch(token, RUN_URL, init);
      renderResults(body);
      await refreshSeedStatus(token);
      const emailNote =
        body.adminEmail?.ok === true
          ? " Internal report email sent."
          : body.adminEmail?.skipped
            ? ""
            : "";
      setBusy(false, `Done.${emailNote}`);
    } catch (err) {
      setBusy(false, "");
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("504") || msg === "HTTP 504") {
        showError(
          runError,
          "Request timed out (504). Upload the Series Expirations .xls first — do not use Run from saved until a report is saved.",
        );
      } else {
        showError(runError, msg);
      }
    }
  }

  /** @param {string} token */
  function unlock(token) {
    if (authPanel && !root.hasAttribute("data-admin-external-auth")) authPanel.hidden = true;
    if (mainPanel) mainPanel.hidden = false;
    showError(authError, "");
    void refreshSeedStatus(token).catch((err) => {
      showError(runError, err instanceof Error ? err.message : String(err));
    });
  }

  if (typeof window !== "undefined") {
    window.AmareFollowUpAdmin = window.AmareFollowUpAdmin || {};
    window.AmareFollowUpAdmin.unlockNewClientPanel = unlock;
    window.AmareFollowUpAdmin.refreshNewClientSeedStatus = refreshSeedStatus;
  }

  root.querySelector("[data-admin-token-unlock]")?.addEventListener("click", () => {
    const resolve = shared.resolveAdminSession;
    if (typeof resolve !== "function") {
      const token = (tokenInput?.value || "").trim();
      if (token.length < 16) {
        showError(authError, "Enter a valid admin token (16+ characters).");
        return;
      }
      setToken(token);
      unlock(token);
      return;
    }
    void resolve(root)
      .then((token) => {
        setToken(token);
        unlock(token);
      })
      .catch((e) => showError(authError, e instanceof Error ? e.message : "Login failed"));
  });

  fileInput?.addEventListener("change", () => {
    if (uploadBtn) uploadBtn.disabled = !(fileInput.files?.length);
  });

  uploadBtn?.addEventListener("click", () => {
    const token = getToken();
    const file = fileInput?.files?.[0];
    if (!token || !file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      void runDryRun(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seriesExpirationReport: text,
          persistSeedReport: true,
          filename: file.name,
        }),
      });
    };
    reader.onerror = () => showError(runError, "Could not read the selected file.");
    reader.readAsText(file);
  });

  runSavedBtn?.addEventListener("click", () => {
    const token = getToken();
    if (!token) return;
    void runDryRun(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useSavedReport: true }),
    });
  });

  candidatesBody?.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest("[data-copy-sms]");
    if (!btn) return;
    const pre = btn.closest(".admin-sms__message-block")?.querySelector(".admin-sms__message-text");
    const text = pre?.textContent?.trim();
    if (!text || text === "—") return;
    void navigator.clipboard.writeText(text).then(() => {
      if (btn instanceof HTMLButtonElement) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1500);
      }
    });
  });

  const saved = getToken();
  if (saved.length >= 16) {
    if (tokenInput) tokenInput.value = saved;
    if (root.hasAttribute("data-admin-external-auth")) {
      unlock(saved);
    } else {
      unlock(saved);
    }
  } else if (authPanel && !root.hasAttribute("data-admin-external-auth")) {
    authPanel.hidden = false;
  }
})();
