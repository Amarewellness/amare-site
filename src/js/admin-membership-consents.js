/**
 * Membership consent admin — read-only list, detail, PDF download.
 */
(function membershipConsentAdmin() {
  const root = document.querySelector("[data-membership-consent-admin-root]");
  if (!root) return;
  const shared = window.AmareFollowUpAdmin;
  if (!shared) return;

  const API = "/api/admin/membership-consents";
  const authPanel = root.querySelector("[data-mc-auth-panel]");
  const mainPanel = root.querySelector("[data-mc-main]");
  const authError = root.querySelector("[data-mc-auth-error]");
  const statusEl = root.querySelector("[data-mc-status]");
  const errorEl = root.querySelector("[data-mc-error]");
  const tbody = root.querySelector("[data-mc-tbody]");
  const pageInfo = root.querySelector("[data-mc-page-info]");
  const prevBtn = root.querySelector("[data-mc-prev]");
  const nextBtn = root.querySelector("[data-mc-next]");
  const detailDialog = root.querySelector("[data-mc-detail-dialog]");
  const detailMeta = root.querySelector("[data-mc-detail-meta]");
  const detailTerms = root.querySelector("[data-mc-detail-terms]");
  const detailDisclaimer = root.querySelector("[data-mc-detail-disclaimer]");
  const detailWarn = root.querySelector("[data-mc-detail-warn]");
  const detailPdfBtn = root.querySelector("[data-mc-detail-pdf]");

  let page = 1;
  /** @type {string | null} */
  let activeConsentId = null;

  /** @param {HTMLElement | null} el @param {string} msg */
  function setMsg(el, msg) {
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  function readFilters() {
    const params = new URLSearchParams();
    const q = (root.querySelector("[data-mc-q]")?.value || "").trim();
    const email = (root.querySelector("[data-mc-email]")?.value || "").trim();
    const name = (root.querySelector("[data-mc-name]")?.value || "").trim();
    const client = (root.querySelector("[data-mc-client]")?.value || "").trim();
    const consent = (root.querySelector("[data-mc-consent]")?.value || "").trim();
    const stripe = (root.querySelector("[data-mc-stripe]")?.value || "").trim();
    if (q) params.set("q", q);
    if (email) params.set("email", email);
    if (name) params.set("name", name);
    if (client) params.set("mindbodyClientId", client);
    if (consent) params.set("consentId", consent);
    if (stripe) params.set("stripeSubscriptionId", stripe);
    params.set("page", String(page));
    params.set("limit", "25");
    return params;
  }

  function applyUrlPrefill() {
    const qs = new URLSearchParams(window.location.search);
    const client = qs.get("mindbodyClientId") || qs.get("mindbody_client_id");
    const consent = qs.get("consentId");
    const stripe = qs.get("stripeSubscriptionId");
    if (client && root.querySelector("[data-mc-client]")) {
      /** @type {HTMLInputElement} */ (root.querySelector("[data-mc-client]")).value = client;
    }
    if (consent && root.querySelector("[data-mc-consent]")) {
      /** @type {HTMLInputElement} */ (root.querySelector("[data-mc-consent]")).value = consent;
    }
    if (stripe && root.querySelector("[data-mc-stripe]")) {
      /** @type {HTMLInputElement} */ (root.querySelector("[data-mc-stripe]")).value = stripe;
    }
  }

  /** @param {string} label */
  function evidenceBadge(label) {
    const map = {
      STRONG_RECORD: "Strong",
      PARTIAL_RECORD: "Partial",
      NO_AMARE_RECORD: "No AMARÉ record",
    };
    const text = map[label] || label;
    const cls =
      label === "STRONG_RECORD"
        ? "admin-sms__flag admin-sms__flag--issued"
        : label === "PARTIAL_RECORD"
          ? "admin-sms__flag admin-sms__flag--manual_review"
          : "admin-sms__flag admin-sms__flag--failed";
    return `<span class="${cls}">${text}</span>`;
  }

  /** @param {string} app */
  function applicabilityNote(app) {
    if (app === "NO_AMARE_CONSENT_RECORD") return "No AMARÉ consent record";
    if (app === "NOT_APPLICABLE") return "Not applicable";
    return "Consent found";
  }

  /** @param {Record<string, unknown>[]} items */
  function renderTable(items) {
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="admin-sms__hint">No matching consent records.</td></tr>';
      return;
    }
    tbody.innerHTML = items
      .map((row) => {
        const id = String(row.consentId || "");
        const accepted = row.acceptedAt ? String(row.acceptedAt).replace("T", " ").slice(0, 19) : "—";
        return (
          `<tr>` +
          `<td>${escapeHtml(String(row.clientName || "—"))}</td>` +
          `<td>${escapeHtml(String(row.email || "—"))}</td>` +
          `<td>${escapeHtml(String(row.planLabel || "—"))}</td>` +
          `<td>${escapeHtml(accepted)}</td>` +
          `<td><code>${escapeHtml(String(row.termsVersion || "—"))}</code></td>` +
          `<td>${escapeHtml(String(row.purchaseStatus || "—"))}</td>` +
          `<td>${evidenceBadge(String(row.evidenceLabel || ""))}<br /><span class="admin-sms__hint">${escapeHtml(applicabilityNote(String(row.applicability || "")))}</span></td>` +
          `<td>${escapeHtml(String(row.source || "—"))}</td>` +
          `<td>` +
          `<button type="button" class="btn btn--ghost" data-mc-view="${escapeHtml(id)}">View</button> ` +
          `<button type="button" class="btn btn--ghost" data-mc-pdf="${escapeHtml(id)}">PDF</button>` +
          `</td>` +
          `</tr>`
        );
      })
      .join("");
  }

  /** @param {string} s */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadList() {
    const token = shared.getToken();
    if (!token) return;
    setMsg(errorEl, "");
    setMsg(statusEl, "Loading…");
    const params = readFilters();
    shared
      .adminFetch(token, `${API}/list?${params.toString()}`)
      .then((body) => {
        const items = Array.isArray(body.items) ? body.items : [];
        renderTable(items);
        const total = Number(body.total) || 0;
        const totalPages = Number(body.totalPages) || 1;
        if (pageInfo) {
          pageInfo.textContent = `Page ${body.page || page} of ${totalPages} · ${total} record${total === 1 ? "" : "s"}`;
        }
        if (prevBtn) prevBtn.disabled = page <= 1;
        if (nextBtn) nextBtn.disabled = page >= totalPages;
        setMsg(statusEl, "");
      })
      .catch((err) => {
        renderTable([]);
        setMsg(statusEl, "");
        setMsg(errorEl, err instanceof Error ? err.message : String(err));
      });
  }

  /** @param {string} consentId */
  function openDetail(consentId) {
    const token = shared.getToken();
    if (!token || !detailDialog) return;
    activeConsentId = consentId;
    setMsg(detailWarn, "");
    shared
      .adminFetch(token, `${API}/detail?consentId=${encodeURIComponent(consentId)}`)
      .then((body) => {
        const d = body.detail || {};
        const hv = body.hashVerification || {};
        if (detailMeta) {
          detailMeta.innerHTML =
            metaRow("Client", d.clientName) +
            metaRow("Email", d.email) +
            metaRow("Mindbody client id", d.mindbodyClientId) +
            metaRow("Membership", d.membershipLabel) +
            metaRow("Local SKU", d.localSku) +
            metaRow("Accepted at", d.acceptedAt) +
            metaRow("Terms version", d.termsVersion) +
            metaRow("Terms SHA-256", d.termsSha256) +
            metaRow("Agreement accepted", d.agreementAccepted ? "Yes" : "No") +
            metaRow("Billing authorized", d.billingAuthorized ? "Yes" : "No") +
            metaRow("Purchase status", d.purchaseStatus) +
            metaRow("Stripe subscription", d.stripeSubscriptionId) +
            metaRow("Stripe checkout session", d.stripeCheckoutSessionId) +
            metaRow("Source", d.source) +
            (d.clientIp ? metaRow("IP (stored)", d.clientIp) : "") +
            (d.userAgent ? metaRow("User agent (stored)", d.userAgent) : "");
        }
        if (detailTerms) detailTerms.textContent = d.termsPlainText || "(No snapshot stored.)";
        if (detailDisclaimer) {
          detailDisclaimer.textContent =
            d.termsDisclaimer ||
            "This is the terms snapshot stored at the time of acceptance.";
        }
        if (!hv.ok && hv.reason) {
          setMsg(
            detailWarn,
            `Hash verification warning (${hv.reason}): stored and recomputed SHA-256 do not match. Review before relying on this record.`,
          );
        }
        detailDialog.showModal();
      })
      .catch((err) => setMsg(errorEl, err instanceof Error ? err.message : String(err)));
  }

  /** @param {unknown} label @param {unknown} value */
  function metaRow(label, value) {
    const v = value == null || value === "" ? "—" : String(value);
    return `<div><dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(v)}</dd></div>`;
  }

  /** @param {string} consentId */
  async function downloadPdf(consentId) {
    const token = shared.getToken();
    if (!token) return;
    setMsg(errorEl, "");
    try {
      const res = await fetch(`${API}/pdf?consentId=${encodeURIComponent(consentId)}`, {
        headers: { "x-admin-token": token },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg =
          typeof data.message === "string"
            ? data.message
            : typeof data.error === "string"
              ? data.error
              : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `amare-membership-consent-${consentId.slice(0, 24)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(errorEl, e instanceof Error ? e.message : String(e));
    }
  }

  function unlock(token) {
    shared.setToken(token);
    if (authPanel) authPanel.hidden = true;
    if (mainPanel) mainPanel.hidden = false;
    shared.showError(authError, "");
    applyUrlPrefill();
    loadList();
  }

  const unlockBtn = root.querySelector("[data-mc-unlock]");
  unlockBtn?.addEventListener("click", () => {
    void (async () => {
      try {
        const token = await shared.resolveAdminSession(root);
        unlock(token);
      } catch (e) {
        shared.showError(authError, e instanceof Error ? e.message : "Login failed");
      }
    })();
  });

  root.querySelector("[data-mc-search]")?.addEventListener("click", () => {
    page = 1;
    loadList();
  });
  root.querySelector("[data-mc-clear]")?.addEventListener("click", () => {
    root.querySelectorAll("input[data-mc-q],input[data-mc-email],input[data-mc-name],input[data-mc-client],input[data-mc-consent],input[data-mc-stripe]").forEach((el) => {
      /** @type {HTMLInputElement} */ (el).value = "";
    });
    page = 1;
    loadList();
  });
  prevBtn?.addEventListener("click", () => {
    if (page > 1) {
      page -= 1;
      loadList();
    }
  });
  nextBtn?.addEventListener("click", () => {
    page += 1;
    loadList();
  });

  tbody?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const view = t.getAttribute("data-mc-view");
    const pdf = t.getAttribute("data-mc-pdf");
    if (view) openDetail(view);
    else if (pdf) void downloadPdf(pdf);
  });

  detailPdfBtn?.addEventListener("click", () => {
    if (activeConsentId) void downloadPdf(activeConsentId);
  });

  const existing = shared.getToken();
  if (existing.length >= 16) unlock(existing);
})();
