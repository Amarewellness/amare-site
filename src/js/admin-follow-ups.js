/**
 * AMARÉ Follow-Up Dashboard — tabs, combined run, Low Credits panel.
 */
(function adminFollowUpsDashboard() {
  const root = document.querySelector("[data-admin-dashboard-root]");
  if (!root) return;

  const shared = window.AmareFollowUpAdmin;
  if (!shared) return;

  const RUN_ALL_URL = "/api/admin/follow-ups/run";
  const SEND_REPORT_URL = "/api/admin/follow-ups/send-report";
  const LOW_CREDITS_URL = "/api/admin/follow-ups/low-credits/run";
  const ACTIONS_URL = "/api/admin/follow-ups/actions";

  const authPanel = root.querySelector("[data-dashboard-auth-panel]");
  const mainPanel = root.querySelector("[data-dashboard-main]");
  const tokenInput = root.querySelector("[data-dashboard-token-input]");
  const authError = root.querySelector("[data-dashboard-auth-error]");
  const runStatus = root.querySelector("[data-dashboard-run-status]");
  const runError = root.querySelector("[data-dashboard-run-error]");

  /** @type {Record<string, unknown> | null} */
  let lastNewClient = null;
  /** @type {Record<string, unknown> | null} */
  let lastLowCredits = null;

  /** @param {boolean} busy @param {string} [msg] */
  function setDashboardBusy(busy, msg) {
    root.querySelector("[data-dashboard-run-all]")?.toggleAttribute("disabled", busy);
    root.querySelector("[data-dashboard-send-email]")?.toggleAttribute("disabled", busy);
    if (runStatus) {
      runStatus.textContent = msg || "";
      runStatus.hidden = !msg;
    }
  }

  function activateTab(tabId) {
    root.querySelectorAll("[data-dashboard-tab]").forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      btn.classList.toggle("is-active", btn.dataset.dashboardTab === tabId);
    });
    root.querySelectorAll("[data-dashboard-panel]").forEach((panel) => {
      if (!(panel instanceof HTMLElement)) return;
      const on = panel.dataset.dashboardPanel === tabId;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
  }

  root.querySelectorAll("[data-dashboard-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn instanceof HTMLButtonElement && !btn.disabled && btn.dataset.dashboardTab) {
        activateTab(btn.dataset.dashboardTab);
      }
    });
  });

  function unlockDashboard(token) {
    shared.setToken(token);
    if (authPanel) authPanel.hidden = true;
    if (mainPanel) mainPanel.hidden = false;
    shared.showError(authError, "");
    if (window.AmareFollowUpAdmin?.unlockNewClientPanel) {
      window.AmareFollowUpAdmin.unlockNewClientPanel(token);
    }
  }

  root.querySelector("[data-dashboard-token-unlock]")?.addEventListener("click", () => {
    void shared
      .resolveAdminSession(root)
      .then((token) => unlockDashboard(token))
      .catch((e) => shared.showError(authError, e instanceof Error ? e.message : "Login failed"));
  });

  root.querySelector("[data-dashboard-run-all]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    shared.showError(runError, "");
    setDashboardBusy(true, "Running all reports…");
    shared
      .adminFetch(token, RUN_ALL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categories: ["new_client", "low_credits"],
          useSavedReport: true,
          sendTeamEmail: true,
        }),
      })
      .then((body) => {
        lastNewClient = body.newClient || null;
        lastLowCredits = body.lowCredits || null;
        if (lastLowCredits) renderLowCredits(lastLowCredits);
        const emailNote = body.adminEmail?.ok ? " Team email sent." : "";
        setDashboardBusy(false, `Done.${emailNote}`);
      })
      .catch((err) => {
        setDashboardBusy(false, "");
        shared.showError(runError, err instanceof Error ? err.message : String(err));
      });
  });

  root.querySelector("[data-dashboard-send-email]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    if (!lastNewClient && !lastLowCredits) {
      shared.showError(runError, "Run reports first, then send team email.");
      return;
    }
    shared.showError(runError, "");
    setDashboardBusy(true, "Sending team email…");
    shared
      .adminFetch(token, SEND_REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newClient: lastNewClient, lowCredits: lastLowCredits }),
      })
      .then((body) => {
        setDashboardBusy(false, body.adminEmail?.ok ? "Team email sent." : "Email skipped or failed.");
      })
      .catch((err) => {
        setDashboardBusy(false, "");
        shared.showError(runError, err instanceof Error ? err.message : String(err));
      });
  });

  /** @param {string | null | undefined} iso */
  function fmtExpiration(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /** @param {Record<string, unknown>} body */
  function renderLowCredits(body) {
    const panel = root.querySelector("[data-low-credits-results]");
    const summary = root.querySelector("[data-low-credits-summary]");
    const tbody = root.querySelector("[data-low-credits-body]");
    const empty = root.querySelector("[data-low-credits-empty]");
    const exportBtn = root.querySelector("[data-low-credits-export]");
    const ss = /** @type {Record<string, unknown>} */ (body.seedSources || {});
    const candidates = Array.isArray(body.report?.candidates) ? body.report.candidates : [];

    if (summary) {
      summary.innerHTML = [
        ["Report rows", ss.mindbodySeriesExpirationRows ?? "—"],
        ["Low-credit pack rows", ss.lowCreditPackRows ?? "—"],
        ["Matched", ss.lowCreditPackMatched ?? "—"],
        ["Candidates", body.candidates ?? candidates.length],
        ["Duration", body.durationMs != null ? `${body.durationMs} ms` : "—"],
      ]
        .map(([dt, dd]) => `<div><dt>${shared.esc(dt)}</dt><dd>${shared.esc(dd)}</dd></div>`)
        .join("");
    }

    if (tbody) {
      tbody.innerHTML = candidates
        .map((raw) => {
          if (!raw || typeof raw !== "object") return "";
          const r = /** @type {Record<string, unknown>} */ (raw);
          const message = r.messageBody ? String(r.messageBody) : "";
          const action = r.recommendedAction ? String(r.recommendedAction) : shared.recommendedActionLowCredits(r);
          return `<tr class="admin-sms__row-main">
            <td>${shared.esc(r.csvClientName)}</td>
            <td>${shared.esc(r.mindbodyClientId)}</td>
            <td>${shared.esc(r.packName)}</td>
            <td>${shared.esc(r.remainingVisits)}</td>
            <td>${shared.esc(fmtExpiration(String(r.expirationDate || "")))}</td>
            <td>${shared.esc(r.smsConsent)}</td>
            <td class="admin-sms__contact admin-sms__contact--phone">${shared.esc(shared.contactPhone(r))}</td>
            <td class="admin-sms__contact admin-sms__contact--email">${shared.esc(shared.contactEmail(r))}</td>
            <td class="admin-sms__action">${shared.esc(action)}</td>
            <td class="admin-sms__row-actions">
              <button type="button" class="btn btn--ghost btn--small" data-copy-sms>Copy message</button>
              <button type="button" class="btn btn--ghost btn--small" data-action="contacted" data-client-id="${shared.esc(r.mindbodyClientId)}">Contacted</button>
              <button type="button" class="btn btn--ghost btn--small" data-action="snoozed" data-client-id="${shared.esc(r.mindbodyClientId)}">Snooze 7d</button>
              <button type="button" class="btn btn--ghost btn--small" data-action="hidden" data-client-id="${shared.esc(r.mindbodyClientId)}">Hide</button>
            </td>
          </tr>
          <tr class="admin-sms__row-message">
            <td colspan="10">
              <div class="admin-sms__message-block">
                <pre class="admin-sms__message-text">${message ? shared.esc(message) : "—"}</pre>
              </div>
            </td>
          </tr>`;
        })
        .join("");
    }

    if (empty) empty.hidden = candidates.length > 0;
    if (panel) {
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (exportBtn instanceof HTMLButtonElement) exportBtn.disabled = candidates.length === 0;
  }

  root.querySelector("[data-low-credits-run]")?.addEventListener("click", () => {
    const token = shared.getToken();
    if (!token) return;
    const statusEl = root.querySelector("[data-low-credits-status]");
    const errEl = root.querySelector("[data-low-credits-error]");
    shared.showError(errEl, "");
    if (statusEl) {
      statusEl.textContent = "Running…";
      statusEl.hidden = false;
    }
    shared
      .adminFetch(token, LOW_CREDITS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useSavedReport: true }),
      })
      .then((body) => {
        lastLowCredits = body;
        renderLowCredits(body);
        if (statusEl) statusEl.textContent = "Done.";
      })
      .catch((err) => {
        if (statusEl) statusEl.hidden = true;
        shared.showError(errEl, err instanceof Error ? err.message : String(err));
      });
  });

  root.querySelector("[data-low-credits-export]")?.addEventListener("click", () => {
    const candidates = lastLowCredits?.report?.candidates;
    if (!Array.isArray(candidates) || !candidates.length) return;
    const csv = shared.candidatesToCsv(candidates, [
      "csvClientName",
      "mindbodyClientId",
      "packName",
      "remainingVisits",
      "expirationDate",
      "smsConsent",
      "phone",
      "email",
      "recommendedAction",
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `amare-low-credits-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  root.querySelector("[data-low-credits-body]")?.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const token = shared.getToken();
    if (!token) return;

    const copyBtn = target.closest("[data-copy-sms]");
    if (copyBtn) {
      const pre = copyBtn.closest("tr")?.nextElementSibling?.querySelector(".admin-sms__message-text");
      const text = pre?.textContent?.trim();
      if (text && text !== "—") void navigator.clipboard.writeText(text);
      return;
    }

    const actionBtn = target.closest("[data-action]");
    if (!(actionBtn instanceof HTMLElement)) return;
    const action = actionBtn.dataset.action;
    const clientId = Number(actionBtn.dataset.clientId);
    if (!action || !Number.isFinite(clientId)) return;
    void shared
      .adminFetch(token, ACTIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "low_credits",
          mindbodyClientId: clientId,
          action,
          snoozeDays: action === "snoozed" ? 7 : undefined,
        }),
      })
      .then(() => {
        actionBtn.textContent = "Saved";
      })
      .catch(() => {
        actionBtn.textContent = "Failed";
      });
  });

  const saved = shared.getToken();
  if (saved.length >= 16) {
    if (tokenInput) tokenInput.value = saved;
    unlockDashboard(saved);
  }
})();
