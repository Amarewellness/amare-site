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

  /**
   * Username/password → ADMIN_DEBUG_TOKEN, or the token field as-is.
   * @param {ParentNode} root
   * @returns {Promise<string>}
   */
  async function resolveAdminSession(root) {
    const username = (root.querySelector("[data-admin-username]")?.value || "").trim();
    const password = root.querySelector("[data-admin-password]")?.value || "";
    const tokenField = root.querySelector(
      "[data-admin-token-input], [data-events-token-input], [data-dashboard-token-input], [data-coupons-token-input], [data-staff-schedule-token-input]",
    );
    const typedToken = (tokenField && "value" in tokenField ? String(tokenField.value) : "").trim();
    if (username || password) {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof data.message === "string" ? data.message : "Login failed";
        throw new Error(msg);
      }
      const token = typeof data.token === "string" ? data.token.trim() : "";
      if (token.length < 16) throw new Error("Login failed");
      return token;
    }
    if (typedToken.length >= 16) return typedToken;
    throw new Error("Enter username and password, or the admin token.");
  }

  /** @param {string} token @param {string} url @param {RequestInit} [init] */
  async function adminFetch(token, url, init) {
    const headers = new Headers(init?.headers || {});
    headers.set("x-admin-token", token);
    const res = await fetch(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = typeof data.message === "string" ? data.message : "";
      const err = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
      const hint = typeof data.hint === "string" ? data.hint : "";
      throw new Error(msg || (hint ? `${err}: ${hint}` : err));
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

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.matches("[data-admin-username], [data-admin-password]")) return;
    ev.preventDefault();
    const panel = t.closest(".admin-sms__panel");
    const btn = panel?.querySelector(
      "[data-events-token-unlock], [data-dashboard-token-unlock], [data-admin-token-unlock], [data-coupons-token-unlock], [data-staff-schedule-token-unlock]",
    );
    if (btn instanceof HTMLButtonElement) btn.click();
  });

  window.AmareFollowUpAdmin = {
    TOKEN_KEY,
    getToken,
    setToken,
    resolveAdminSession,
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
