(function () {
  const root = document.querySelector("[data-benefits-redeem-root]");
  if (!root) return;

  const el = {
    title: root.querySelector("[data-benefits-redeem-title]"),
    partner: root.querySelector("[data-benefits-redeem-partner]"),
    member: root.querySelector("[data-benefits-redeem-member]"),
    valid: root.querySelector("[data-benefits-redeem-valid]"),
    terms: root.querySelector("[data-benefits-redeem-terms]"),
    hint: root.querySelector("[data-benefits-redeem-hint]"),
    actions: root.querySelector("[data-benefits-redeem-actions]"),
    confirm: root.querySelector("[data-benefits-redeem-confirm]"),
    status: root.querySelector("[data-benefits-redeem-status]"),
  };

  const params = new URLSearchParams(window.location.search);
  const token = (params.get("t") || params.get("token") || "").trim();

  /** Headers for local ngrok tunnels (skip interstitial on API fetches). */
  function apiHeaders(extra) {
    const h = new Headers(extra || {});
    if (/ngrok-free\.(app|dev)/i.test(window.location.hostname)) {
      h.set("ngrok-skip-browser-warning", "true");
    }
    return h;
  }

  async function parseApiResponse(res) {
    const text = await res.text();
    try {
      return { data: JSON.parse(text), raw: text };
    } catch {
      return {
        data: {},
        raw: text,
        parseError: true,
      };
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(msg, isErr) {
    if (!el.status) return;
    el.status.textContent = msg || "";
    el.status.classList.toggle("benefits-redeem__status--err", Boolean(isErr));
  }

  function showSuccess(data) {
    if (el.title) el.title.textContent = "Redeemed ✓";
    if (el.partner) {
      el.partner.hidden = false;
      el.partner.textContent = data.partnerDisplayName || "";
    }
    if (el.member) {
      el.member.hidden = false;
      el.member.textContent = `${data.memberDisplayName || "Member"} · ${data.benefitTitle || "Benefit"}`;
    }
    if (el.valid) {
      el.valid.hidden = false;
      el.valid.textContent = data.redeemedAt ? new Date(data.redeemedAt).toLocaleString() : "";
    }
    if (el.hint) el.hint.hidden = true;
    if (el.actions) el.actions.hidden = true;
    if (el.terms) el.terms.hidden = true;
    setStatus("This benefit has been marked as used.", false);
  }

  function errorMessage(code) {
    const map = {
      missing_token: "Missing benefit link.",
      invalid_token: "Invalid or expired benefit link.",
      already_redeemed: "This benefit was already redeemed.",
      period_expired: "This QR expired. Ask the member to open a new one from Member Area.",
      benefit_not_found: "Benefit not found.",
      partner_benefits_blobs_disabled: "Partner benefits storage is off on the server.",
      partner_benefits_store_unavailable: "Partner benefits storage unavailable.",
    };
    return map[code] || "Something went wrong.";
  }

  async function load() {
    if (!token) {
      if (el.title) el.title.textContent = "Invalid link";
      setStatus(errorMessage("missing_token"), true);
      return;
    }

    try {
      const res = await fetch(`/api/benefits/redeem/validate?token=${encodeURIComponent(token)}`, {
        credentials: "omit",
        headers: apiHeaders(),
      });
      const { data, parseError } = await parseApiResponse(res);
      if (parseError || !res.ok || !data.ok) {
        if (el.title) el.title.textContent = "Unavailable";
        const code =
          typeof data.error === "string"
            ? data.error
            : parseError
              ? "api_unreachable"
              : "invalid_token";
        setStatus(
          parseError
            ? "Could not reach the benefit API (check ngrok tunnel → port 4321, then re-open QR)."
            : errorMessage(code),
          true,
        );
        return;
      }

      if (el.title) el.title.textContent = data.benefitTitle || "Member benefit";
      if (el.partner) {
        el.partner.hidden = false;
        el.partner.textContent = data.partnerDisplayName ? `AMARÉ × ${data.partnerDisplayName}` : "AMARÉ";
      }
      if (el.member) {
        el.member.hidden = false;
        el.member.textContent = `Member: ${data.memberDisplayName || "—"}`;
      }
      if (el.valid) {
        el.valid.hidden = false;
        el.valid.textContent = `Valid through ${data.validThrough || "—"}`;
      }
      if (el.terms && data.terms) {
        el.terms.hidden = false;
        el.terms.textContent = data.terms;
      }
      if (el.actions) el.actions.hidden = false;
    } catch {
      if (el.title) el.title.textContent = "Error";
      setStatus("Network error. Try again.", true);
    }
  }

  async function confirm() {
    if (!token || !el.confirm) return;
    el.confirm.disabled = true;
    setStatus("Confirming…", false);
    try {
      const res = await fetch("/api/benefits/redeem/confirm", {
        method: "POST",
        credentials: "omit",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ token }),
      });
      const { data, parseError } = await parseApiResponse(res);
      if (parseError || !res.ok || !data.ok) {
        setStatus(
          parseError
            ? "Could not reach the benefit API."
            : errorMessage(typeof data.error === "string" ? data.error : "confirm_failed"),
          true,
        );
        el.confirm.disabled = false;
        return;
      }
      showSuccess(data);
    } catch {
      setStatus("Network error. Try again.", true);
      el.confirm.disabled = false;
    }
  }

  el.confirm?.addEventListener("click", () => void confirm());
  void load();
})();
