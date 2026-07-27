/**
 * Appends active Partner Benefits (admin catalog) to the static Member benefits
 * grid on `/pricing`. Studio perks stay in `pricing.html`; this loads the
 * redeemable partner perks from `GET /api/benefits/public/list`.
 */
(function pricingPartnerBenefits() {
  const root = document.getElementById("mb-pricing-root");
  if (!root) return;

  const grid = root.querySelector("[data-pricing-partner-benefits-mount]");
  if (!grid) return;

  const PARTNER_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v8H4v-8"/><path d="M12 22V12"/><path d="M12 12H7.5a2.5 2.5 0 0 1 0-5C9 7 12 12 12 12s3-5 4.5-5a2.5 2.5 0 0 1 0 5H12z"/></svg>';

  function mbApiPath(path) {
    const raw = typeof root.dataset.mbProxy === "string" ? root.dataset.mbProxy.trim() : "";
    const prefix = raw.replace(/\/$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    return prefix ? `${prefix}${p}` : p;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeAssetUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    if (raw.startsWith("//")) return `https:${raw}`;
    return raw;
  }

  /** @param {Record<string, unknown>} benefit */
  function renderIcon(benefit) {
    const logoUrl = normalizeAssetUrl(benefit.logoUrl);
    if (logoUrl) {
      return `<span class="member-benefits__icon member-benefits__icon--logo" aria-hidden="true"><img src="${esc(logoUrl)}" alt="" width="32" height="32" loading="lazy" decoding="async" /></span>`;
    }
    return `<span class="member-benefits__icon" aria-hidden="true">${PARTNER_ICON}</span>`;
  }

  /** @param {Record<string, unknown>} benefit */
  function defaultDescription(benefit) {
    if (benefit.frequency === "campaign") {
      return "Limited-time partner perk for monthly members.";
    }
    return "Included with your monthly membership.";
  }

  /** @param {Record<string, unknown>} benefit */
  function renderItem(benefit) {
    const title = String(benefit.title || "Partner perk").trim();
    const partner = String(benefit.partnerDisplayName || "").trim();
    const description = String(benefit.description || "").trim() || defaultDescription(benefit);
    const partnerLine = partner
      ? `<p class="member-benefits__partner">AMARÉ × ${esc(partner)}</p>`
      : "";

    return `<li class="member-benefits__item member-benefits__item--partner">
      ${renderIcon(benefit)}
      <h4 class="member-benefits__name">${esc(title)}</h4>
      ${partnerLine}
      <p class="member-benefits__desc">${esc(description)}</p>
    </li>`;
  }

  async function loadPartnerBenefits() {
    try {
      const res = await fetch(mbApiPath("/api/benefits/public/list"));
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.benefits) || !data.benefits.length) return;

      const frag = document.createDocumentFragment();
      for (const benefit of data.benefits) {
        const tpl = document.createElement("template");
        tpl.innerHTML = renderItem(benefit).trim();
        const node = tpl.content.firstElementChild;
        if (node) frag.appendChild(node);
      }
      grid.appendChild(frag);
    } catch {
      /* non-critical enhancement */
    }
  }

  loadPartnerBenefits();
})();
