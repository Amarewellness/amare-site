/**
 * Shared helpers for AMARÉ internal follow-up admin pages.
 */
(function amareFollowUpShared() {
  const TOKEN_KEY = "amare_followup_admin_token";
  const LEGACY_TOKEN_KEY = "amare_ncs_admin_token";

  /** @returns {string} */
  function getToken() {
    return (
      (sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(LEGACY_TOKEN_KEY) || "").trim()
    );
  }

  /** @param {string} token */
  function setToken(token) {
    const t = token.trim();
    sessionStorage.setItem(TOKEN_KEY, t);
    sessionStorage.setItem(LEGACY_TOKEN_KEY, t);
  }

  /** @param {string} token @param {string} url @param {RequestInit} [init] */
  async function adminFetch(token, url, init) {
    const headers = new Headers(init?.headers || {});
    headers.set("x-admin-token", token);
    const res = await fetch(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
      const hint = typeof data.hint === "string" ? data.hint : "";
      throw new Error(hint ? `${err}: ${hint}` : err);
    }
    return data;
  }

  /** @param {HTMLElement | null} el @param {string} msg */
  function showError(el, msg) {
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  /** @param {Record<string, number>} map */
  function formatCountMap(map) {
    const entries = Object.entries(map || {});
    if (!entries.length) return "—";
    return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
  }

  /** @param {string} s */
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {unknown} row */
  function recommendedActionNewClient(row) {
    if (!row || typeof row !== "object") return "Review in Mindbody before outreach.";
    const r = /** @type {Record<string, unknown>} */ (row);
    const consent = String(r.smsConsent || "unknown");
    const segment = String(r.segment || "");
    if (consent === "explicit_opt_out") {
      return "Do not send marketing SMS. Use approved channel / in-studio / phone / email follow-up.";
    }
    if (segment === "one_remaining") {
      return "Review and follow up. Encourage final intro class + membership next step.";
    }
    if (segment === "expiring_soon") {
      return "Review and remind client to use remaining visits before expiration.";
    }
    if (consent === "explicit_opt_in" && r.wouldSend === true) {
      return "Eligible for SMS in future. For now, review manually.";
    }
    return "Review segment/eligibility before outreach.";
  }

  /** @param {unknown} row */
  function recommendedActionLowCredits(row) {
    if (!row || typeof row !== "object") {
      return "Recommend membership if weekly attendance, or pack renewal for flexibility.";
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (String(r.smsConsent || "") === "explicit_opt_out") {
      return "Do not send marketing SMS. Use approved channel / in-studio / phone / email follow-up.";
    }
    return "Client is close to the end of their pack. Recommend membership if they attend weekly, or pack renewal if they need flexibility.";
  }

  /** @param {unknown} row */
  function recommendedActionClassPass(row) {
    if (!row || typeof row !== "object") {
      return "Repeat ClassPass visitor — review for membership conversion.";
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (String(r.smsConsent || "") === "explicit_opt_out") {
      return "Do not send marketing SMS. Use approved channel / in-studio / phone / email follow-up.";
    }
    return "Repeat ClassPass visitor — good membership conversion candidate. Recommend direct booking + membership if they attend weekly.";
  }

  /** @param {unknown} row */
  function contactPhone(row) {
    if (!row || typeof row !== "object") return "—";
    const r = /** @type {Record<string, unknown>} */ (row);
    const phone = String(r.phone || "").trim();
    if (phone) return phone;
    const last4 = String(r.phoneLast4 || "").trim();
    return last4 ? `…${last4}` : "—";
  }

  /** @param {unknown} row */
  function contactEmail(row) {
    if (!row || typeof row !== "object") return "—";
    const r = /** @type {Record<string, unknown>} */ (row);
    const email = String(r.email || "").trim();
    if (email) return email;
    const domain = String(r.emailDomain || "").trim();
    return domain || "—";
  }

  /** @param {unknown[]} candidates @param {string[]} headers */
  function candidatesToCsv(candidates, headers) {
    const lines = [headers.join(",")];
    for (const raw of candidates) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      lines.push(
        headers
          .map((h) => {
            const v = r[h] ?? "";
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(","),
      );
    }
    return lines.join("\n");
  }

  window.AmareFollowUpAdmin = {
    TOKEN_KEY,
    getToken,
    setToken,
    adminFetch,
    showError,
    formatCountMap,
    esc,
    recommendedActionNewClient,
    recommendedActionLowCredits,
    recommendedActionClassPass,
    contactPhone,
    contactEmail,
    candidatesToCsv,
  };
})();
