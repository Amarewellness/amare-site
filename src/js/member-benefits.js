(function () {
  const root = document.querySelector("[data-mb-member-root]");
  if (!root) return;

  const section = root.querySelector("[data-mb-benefits-section]");
  const listEl = root.querySelector("[data-mb-benefits-list]");
  const dialog = /** @type {HTMLDialogElement|null} */ (root.querySelector("[data-mb-benefits-qr-dialog]"));
  const qrImg = /** @type {HTMLImageElement|null} */ (root.querySelector("[data-mb-benefits-qr-img]"));
  const qrTitle = root.querySelector("[data-mb-benefits-qr-title]");
  const qrSub = root.querySelector("[data-mb-benefits-qr-sub]");
  const qrValid = root.querySelector("[data-mb-benefits-qr-valid]");
  const qrLocation = root.querySelector("[data-mb-benefits-qr-location]");
  const qrLocationAddress = root.querySelector("[data-mb-benefits-qr-location-address]");
  const qrMapLink = /** @type {HTMLAnchorElement|null} */ (root.querySelector("[data-mb-benefits-qr-map-link]"));
  const qrClose = root.querySelector("[data-mb-benefits-qr-close]");

  if (!section || !listEl) return;

  const QR_CACHE_KEY = "amare_member_benefit_qr_v1";

  function mbApiPrefix() {
    const holder = root.closest("[data-mb-proxy]");
    const raw = holder && typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
    return raw.replace(/\/$/, "");
  }

  function mbApiPath(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}${p}` : p;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {string} address */
  function mapsUrl(address) {
    const a = String(address || "").trim();
    if (!a) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
  }

  /** @param {string} address */
  function renderLocationBlock(address) {
    const a = String(address || "").trim();
    if (!a) return "";
    const url = mapsUrl(a);
    const mapLink = url
      ? `<a class="mb-benefit-card__map-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open map</a>`
      : "";
    return `<div class="mb-benefit-card__field mb-benefit-card__field--location">
      <p class="mb-benefit-card__label">Redeem at</p>
      <p class="mb-benefit-card__location">${esc(a)}</p>
      ${mapLink}
    </div>`;
  }

  /** @param {string} address */
  function syncQrLocation(address) {
    const a = String(address || "").trim();
    if (!qrLocation) return;
    if (!a) {
      qrLocation.hidden = true;
      if (qrLocationAddress) qrLocationAddress.textContent = "";
      if (qrMapLink) qrMapLink.href = "#";
      return;
    }
    qrLocation.hidden = false;
    if (qrLocationAddress) qrLocationAddress.textContent = a;
    const url = mapsUrl(a);
    if (qrMapLink && url) qrMapLink.href = url;
  }

  /** @returns {Record<string, Record<string, unknown>>} */
  function readQrCacheMap() {
    try {
      const raw = sessionStorage.getItem(QR_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /** @param {Record<string, Record<string, unknown>>} map */
  function writeQrCacheMap(map) {
    try {
      sessionStorage.setItem(QR_CACHE_KEY, JSON.stringify(map));
    } catch {
      /* ignore quota */
    }
  }

  /** @param {string} benefitId @param {Record<string, unknown>} payload */
  function saveQrCache(benefitId, payload) {
    const map = readQrCacheMap();
    map[benefitId] = payload;
    writeQrCacheMap(map);
  }

  /** @param {string} benefitId */
  function clearQrCache(benefitId) {
    const map = readQrCacheMap();
    delete map[benefitId];
    writeQrCacheMap(map);
  }

  /** @param {Record<string, unknown>} benefit @param {string} qrUrl @param {string} validThrough @param {string} [periodKey] */
  function showQrModal(benefit, qrUrl, validThrough, periodKey) {
    if (!dialog) return;
    if (qrTitle) qrTitle.textContent = String(benefit.title || "Benefit");
    if (qrSub) {
      qrSub.textContent = benefit.partnerDisplayName
        ? `AMARÉ × ${benefit.partnerDisplayName}`
        : "AMARÉ";
    }
    if (qrValid) qrValid.textContent = `Valid through ${validThrough || "—"}`;
    syncQrLocation(String(benefit.locationAddress || ""));
    if (qrImg) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrUrl)}`;
      qrImg.alt = "QR code for partner benefit";
    }
    dialog.showModal();
    if (benefit.id && qrUrl) {
      saveQrCache(String(benefit.id), {
        benefitId: benefit.id,
        title: benefit.title,
        partnerDisplayName: benefit.partnerDisplayName,
        description: benefit.description,
        terms: benefit.terms,
        logoUrl: benefit.logoUrl,
        locationAddress: benefit.locationAddress,
        qrUrl,
        validThrough,
        periodKey: periodKey || benefit.periodKey || null,
      });
    }
  }

  /**
   * @param {Record<string, unknown>} benefit
   * @param {string} [periodKey]
   */
  function effectiveStatus(benefit, periodKey) {
    const status = String(benefit.memberStatus || "eligible");
    if (status === "redeemed") return "redeemed";
    if (status === "pending_token") return "pending_token";
    const cached = readQrCacheMap()[String(benefit.id || "")];
    if (cached?.qrUrl && (!periodKey || !cached.periodKey || cached.periodKey === periodKey)) {
      return "pending_token";
    }
    return status;
  }

  /** @param {Record<string, unknown>} benefit */
  function benefitPeriodKey(benefit) {
    return String(benefit.redemptionPeriodKey || benefit.periodKey || lastPeriodKey || "");
  }

  /** @param {Record<string, unknown>} benefit */
  function isCampaignBenefit(benefit) {
    const freq = benefit.frequency;
    if (freq && typeof freq === "object") {
      return String(/** @type {Record<string, unknown>} */ (freq).type || "") === "once_per_campaign";
    }
    return false;
  }

  /** @param {Record<string, unknown>} benefit */
  function renderBenefitDetails(benefit) {
    const parts = [];
    if (benefit.description) {
      parts.push(`<div class="mb-benefit-card__field">
        <p class="mb-benefit-card__label">About this perk</p>
        <p class="mb-benefit-card__desc">${esc(benefit.description)}</p>
      </div>`);
    }
    if (benefit.terms) {
      parts.push(`<div class="mb-benefit-card__field mb-benefit-card__field--terms">
        <p class="mb-benefit-card__label">Terms</p>
        <p class="mb-benefit-card__terms">${esc(benefit.terms)}</p>
      </div>`);
    }
    const locationBlock = renderLocationBlock(String(benefit.locationAddress || ""));
    if (locationBlock) parts.push(locationBlock);
    if (!parts.length) return "";
    return `<div class="mb-benefit-card__details">${parts.join("")}</div>`;
  }

  /** @param {Record<string, unknown>} benefit @param {string} [periodKey] */
  function renderCard(benefit, periodKey) {
    const pk = periodKey || benefitPeriodKey(benefit);
    const status = effectiveStatus(benefit, pk);
    const logoFixed = benefit.logoUrl
      ? `<img class="mb-benefit-card__logo" src="${esc(benefit.logoUrl)}" alt="" />`
      : `<div class="mb-benefit-card__logo" aria-hidden="true"></div>`;

    const pendingHint = isCampaignBenefit(benefit)
      ? "Save a screenshot, or tap below anytime before the perk is used."
      : "Save a screenshot, or tap below anytime this month before the perk is used.";

    let action = "";
    if (status === "eligible") {
      action = `<button type="button" class="btn btn--cream" data-mb-benefit-use="${esc(benefit.id)}">Use benefit</button>`;
    } else if (status === "pending_token") {
      action = `<p class="mb-benefit-card__meta">Your QR is ready · Valid through ${esc(benefit.validThrough || "—")}</p>
        <p class="mb-benefit-card__meta mb-benefit-card__meta--muted">${pendingHint}</p>
        <button type="button" class="btn btn--cream" data-mb-benefit-open="${esc(benefit.id)}">Open my QR</button>`;
    } else if (status === "redeemed") {
      const redeemedLine = benefit.availableAgain
        ? `Redeemed ${esc(benefit.redeemedAt || "")} · Available again ${esc(benefit.availableAgain)}`
        : `Redeemed ${esc(benefit.redeemedAt || "")} · ${esc(benefit.redeemedMessage || "One-time campaign perk")}`;
      action = `<p class="mb-benefit-card__meta mb-benefit-card__meta--muted">${redeemedLine}</p>`;
    } else if (status === "not_eligible") {
      action = `<p class="mb-benefit-card__meta mb-benefit-card__meta--muted">${esc(benefit.message || "Monthly perks are included with active monthly memberships.")}</p>`;
    }

    return `<article class="mb-benefit-card" data-mb-benefit-id="${esc(benefit.id)}">
      <div class="mb-benefit-card__head">
        ${logoFixed}
        <div>
          <h3 class="mb-benefit-card__title">${esc(benefit.title)}</h3>
          <p class="mb-benefit-card__partner">${esc(benefit.partnerDisplayName)}</p>
        </div>
      </div>
      ${renderBenefitDetails(benefit)}
      <div class="mb-benefit-card__actions">${action}</div>
    </article>`;
  }

  /** @type {Record<string, unknown>[]} */
  let lastBenefits = [];
  /** @type {string} */
  let lastPeriodKey = "";

  function renderBenefitList() {
    if (!lastBenefits.length) {
      const cached = Object.values(readQrCacheMap()).filter((c) => c && c.qrUrl);
      if (cached.length) {
        lastBenefits = cached.map((c) => ({
          id: c.benefitId,
          title: c.title,
          partnerDisplayName: c.partnerDisplayName,
          description: c.description,
          terms: c.terms,
          logoUrl: c.logoUrl,
          locationAddress: c.locationAddress,
          memberStatus: "pending_token",
          validThrough: c.validThrough,
          redemptionPeriodKey: c.periodKey,
        }));
      }
    }
    if (!lastBenefits.length) {
      listEl.innerHTML = `<p class="mb-member__hint">No partner perks are active right now. Check back soon.</p>`;
      return;
    }
    listEl.innerHTML = lastBenefits.map((b) => renderCard(b, benefitPeriodKey(b))).join("");
  }

  /** @param {string} benefitId */
  function patchBenefitPending(benefitId, validThrough) {
    lastBenefits = lastBenefits.map((b) =>
      String(b.id) === benefitId
        ? { ...b, memberStatus: "pending_token", validThrough: validThrough || b.validThrough }
        : b,
    );
    renderBenefitList();
  }

  /** @param {string} benefitId */
  async function openQr(benefitId) {
    const benefit =
      lastBenefits.find((b) => String(b.id) === benefitId) ||
      readQrCacheMap()[benefitId] ||
      { id: benefitId, title: "Benefit" };

    const pk = benefitPeriodKey(benefit);
    const cached = readQrCacheMap()[benefitId];
    if (cached?.qrUrl) {
      showQrModal(
        { ...benefit, ...cached },
        String(cached.qrUrl),
        String(cached.validThrough || benefit.validThrough || ""),
        String(cached.periodKey || pk),
      );
    }

    try {
      const res = await fetch(mbApiPath("/api/benefits/member/issue-token"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ benefitId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (cached?.qrUrl) return;
        const err =
          data.error === "not_eligible"
            ? "You are not eligible for this perk."
            : data.error === "already_redeemed_this_period"
              ? isCampaignBenefit(benefit)
                ? "You already used this campaign perk."
                : "You already used this perk this month."
              : "Could not open benefit.";
        window.alert(err);
        if (data.error === "already_redeemed_this_period") {
          clearQrCache(benefitId);
          await loadBenefits();
        }
        return;
      }
      const rk = String(data.redemptionPeriodKey || pk);
      const merged = {
        ...benefit,
        title: benefit.title || data.benefitId,
        validThrough: data.validThrough,
        redemptionPeriodKey: rk,
      };
      showQrModal(merged, data.qrUrl, data.validThrough, rk);
      patchBenefitPending(benefitId, data.validThrough);
    } catch {
      if (!cached?.qrUrl) window.alert("Could not open benefit. Check your connection.");
    }
  }

  /** @param {string} benefitId */
  async function useBenefit(benefitId) {
    await openQr(benefitId);
    await loadBenefits();
  }

  async function loadBenefits() {
    listEl.innerHTML = `<p class="mb-member__hint">Loading partner benefits…</p>`;
    try {
      const res = await fetch(mbApiPath("/api/benefits/member/list"), { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        renderBenefitList();
        if (!lastBenefits.length) {
          listEl.innerHTML = `<p class="mb-member__hint">Partner benefits unavailable right now.</p>`;
        }
        return;
      }
      lastPeriodKey = String(data.periodKey || "");
      lastBenefits = Array.isArray(data.benefits) ? data.benefits : [];

      for (const b of lastBenefits) {
        if (String(b.memberStatus) === "redeemed") clearQrCache(String(b.id));
      }

      renderBenefitList();
    } catch {
      renderBenefitList();
      if (!lastBenefits.length) {
        listEl.innerHTML = `<p class="mb-member__hint">Could not load partner benefits.</p>`;
      }
    }
  }

  listEl.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const useId = t.closest("[data-mb-benefit-use]")?.getAttribute("data-mb-benefit-use");
    const openId = t.closest("[data-mb-benefit-open]")?.getAttribute("data-mb-benefit-open");
    if (useId) void useBenefit(useId);
    if (openId) void openQr(openId);
  });

  qrClose?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  document.addEventListener("mb-member-summary-loaded", () => {
    section.hidden = false;
    void loadBenefits();
  });

  document.addEventListener("mb-auth-signed-out", () => {
    section.hidden = true;
    listEl.innerHTML = "";
    writeQrCacheMap({});
  });
})();
