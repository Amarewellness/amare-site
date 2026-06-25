(function () {
  const root = document.getElementById("mb-schedule-root");
  if (!root) return;

  const CACHE_KEY = "amare_benefits_badge_v4";
  const DISMISS_KEY = "amare_benefits_dismissed_ids";
  const CACHE_TTL_MS = 5 * 60 * 1000;

  /** @type {HTMLElement | null} */
  let widget = null;
  /** @type {string[]} */
  let activeIds = [];
  let docListenersBound = false;

  function bindDocListeners() {
    if (docListenersBound) return;
    docListenersBound = true;
    document.addEventListener(
      "click",
      (ev) => {
        if (!widget?.classList.contains("is-open")) return;
        const t = ev.target;
        if (t instanceof Node && widget.contains(t)) return;
        closePopup();
        widget?.querySelector(".mb-benefits-float__fab")?.setAttribute("aria-expanded", "false");
      },
      true,
    );
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && widget?.classList.contains("is-open")) {
        closePopup();
        widget?.querySelector(".mb-benefits-float__fab")?.setAttribute("aria-expanded", "false");
      }
    });
  }

  function mbApiPath(path) {
    const raw = typeof root.dataset.mbProxy === "string" ? root.dataset.mbProxy.trim() : "";
    const prefix = raw.replace(/\/$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    return prefix ? `${prefix}${p}` : p;
  }

  function fetchHeaders() {
    /** @type {Record<string, string>} */
    const h = { Accept: "application/json" };
    try {
      const host = new URL(mbApiPath("/"), window.location.href).hostname;
      if (host.includes("ngrok")) h["ngrok-skip-browser-warning"] = "true";
    } catch {
      /* ignore */
    }
    return h;
  }

  /** @returns {Set<string>} */
  function readDismissedIds() {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map(String));
    } catch {
      return new Set();
    }
  }

  /** @param {string[]} ids */
  function saveDismiss(ids) {
    try {
      const set = readDismissedIds();
      for (const id of ids) set.add(String(id));
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
    } catch {
      /* ignore */
    }
  }

  /** @param {string[]} ids */
  function visibleEligibleIds(ids) {
    const dismissed = readDismissedIds();
    return ids.filter((id) => !dismissed.has(String(id)));
  }

  /** @param {Record<string, unknown>} data */
  function normalizeBadge(data) {
    const benefits = Array.isArray(data.eligibleBenefits)
      ? data.eligibleBenefits
          .map((b) =>
            b && typeof b === "object"
              ? { id: String(/** @type {Record<string, unknown>} */ (b).id || ""), title: String(/** @type {Record<string, unknown>} */ (b).title || "").trim() }
              : null,
          )
          .filter((b) => b && b.id)
      : Array.isArray(data.eligibleIds)
        ? data.eligibleIds.map((id) => ({ id: String(id), title: "" }))
        : [];

    const visible = benefits.filter((b) => visibleEligibleIds([b.id]).length);
    const visibleIds = visible.map((b) => b.id);
    const count = visible.length;

    /** @type {string | null} */
    let headline = null;
    if (count === 1) {
      const title = visible[0].title;
      headline = title
        ? `You have a new member benefit waiting: ${title}`
        : "You have a new member benefit waiting";
    } else if (count > 1) {
      headline = `You have ${count} new member benefits waiting`;
    }

    return {
      show: Boolean(data.show) && count > 0,
      eligibleCount: count,
      eligibleIds: visibleIds,
      headline,
      memberUrl: String(data.memberUrl || "/member#benefits"),
    };
  }

  /** @returns {Record<string, unknown> | null} */
  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      const ts = typeof data.ts === "number" ? data.ts : 0;
      if (!ts || Date.now() - ts > CACHE_TTL_MS) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** @param {Record<string, unknown>} payload */
  function writeCache(payload) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...payload, ts: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function removeWidget() {
    widget?.remove();
    widget = null;
    activeIds = [];
  }

  function closePopup() {
    widget?.classList.remove("is-open");
    widget?.querySelector(".mb-benefits-float__panel")?.setAttribute("hidden", "");
  }

  function openPopup() {
    if (!widget) return;
    widget.classList.add("is-open");
    const panel = widget.querySelector(".mb-benefits-float__panel");
    panel?.removeAttribute("hidden");
  }

  /** @param {Record<string, unknown>} data */
  function renderWidget(data) {
    const normalized = normalizeBadge(data);
    const ids = normalized.eligibleIds;
    if (!normalized.show || !ids.length) {
      removeWidget();
      return;
    }

    activeIds = ids;
    const headline = normalized.headline || "You have a new member benefit waiting";
    const memberUrl = normalized.memberUrl;
    const count = normalized.eligibleCount;

    if (!widget) {
      widget = document.createElement("div");
      widget.className = "mb-benefits-float";
      widget.setAttribute("role", "complementary");
      widget.setAttribute("aria-label", "Member benefits");
      document.body.appendChild(widget);
      bindDocListeners();
    }

    widget.innerHTML = `<div class="mb-benefits-float__panel" hidden id="mb-benefits-float-panel">
      <button type="button" class="mb-benefits-float__close" aria-label="Close">×</button>
      <p class="mb-benefits-float__eyebrow">Member benefit</p>
      <p class="mb-benefits-float__text">${escapeHtml(headline)}</p>
      <div class="mb-benefits-float__actions">
        <a class="btn btn--cream mb-benefits-float__cta" href="${escapeHtml(memberUrl)}">View in Member area</a>
        <button type="button" class="mb-benefits-float__dismiss">Not now</button>
      </div>
    </div>
    <button type="button" class="mb-benefits-float__fab" aria-expanded="false" aria-controls="mb-benefits-float-panel" aria-label="New member benefit — tap to view">
      <svg class="mb-benefits-float__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="8" width="18" height="13" rx="1"/>
        <path d="M12 8v13"/>
        <path d="M7.5 8a2.5 2.5 0 1 1 0-5C9.5 3 12 8 12 8s2.5-5 4.5-5a2.5 2.5 0 1 1 0 5H7.5z"/>
      </svg>
      ${count > 0 ? `<span class="mb-benefits-float__badge" aria-hidden="true">${count > 9 ? "9+" : count}</span>` : ""}
    </button>`;

    const fab = widget.querySelector(".mb-benefits-float__fab");
    const closeBtn = widget.querySelector(".mb-benefits-float__close");
    const dismissBtn = widget.querySelector(".mb-benefits-float__dismiss");

    fab?.addEventListener("click", () => {
      const open = widget?.classList.contains("is-open");
      if (open) {
        closePopup();
        fab.setAttribute("aria-expanded", "false");
      } else {
        openPopup();
        fab.setAttribute("aria-expanded", "true");
      }
    });

    closeBtn?.addEventListener("click", () => {
      closePopup();
      fab?.setAttribute("aria-expanded", "false");
    });

    dismissBtn?.addEventListener("click", () => {
      saveDismiss(activeIds);
      removeWidget();
    });
  }

  /** @param {Record<string, unknown>} data */
  function applyBadge(data) {
    renderWidget(data);
  }

  async function fetchBadge() {
    const res = await fetch(mbApiPath("/api/benefits/member/badge"), {
      credentials: "include",
      headers: fetchHeaders(),
    });
    if (res.status === 401 || res.status === 403) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return null;
    return data;
  }

  async function loadBadge() {
    const cached = readCache();
    if (cached) applyBadge(cached);

    try {
      const data = await fetchBadge();
      if (!data) {
        if (!cached) removeWidget();
        return;
      }
      writeCache(data);
      applyBadge(data);
    } catch {
      /* silent */
    }
  }

  function scheduleLoad() {
    const run = () => void loadBadge();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 1800);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleLoad, { once: true });
  } else {
    scheduleLoad();
  }
})();
