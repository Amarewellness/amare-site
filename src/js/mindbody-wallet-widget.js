/**
 * Shared Mindbody “class credits” widget — punch-card segments + `/member/summary` shape.
 * Used by `/classes-api` and `/member`. Exposes `globalThis.mbWalletRenderInto`.
 */
(function (g) {
  "use strict";

  /** @param {Record<string, unknown>} row */
  function walletPick(row, /** @type {string[]} */ keys) {
    for (const k of keys) {
      if (row[k] != null && row[k] !== "") return row[k];
    }
    return null;
  }

  /** @param {unknown} obj */
  function walletFirstArray(obj, /** @type {string[]} */ keys) {
    if (!obj || typeof obj !== "object") return [];
    const o = /** @type {Record<string, unknown>} */ (obj);
    for (const k of keys) {
      const v = o[k];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  /** @param {Record<string, unknown>} r */
  function walletClientServiceExpired(r) {
    const exp = walletPick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
    if (exp == null || exp === "") return false;
    const d = new Date(String(exp));
    if (Number.isNaN(d.getTime())) return false;
    const today = new Date();
    const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return expDay < todayDay;
  }

  /** @param {Record<string, unknown>} r */
  function walletClientServiceRemaining(r) {
    const remRaw = walletPick(r, ["Remaining", "remaining"]);
    if (typeof remRaw === "number") return remRaw;
    if (remRaw != null && Number.isFinite(Number(remRaw))) return Number(remRaw);
    return null;
  }

  /**
   * @param {unknown} row
   * @returns {boolean}
   */
  function walletPassesActiveService(row) {
    if (!row || typeof row !== "object") return false;
    const r = /** @type {Record<string, unknown>} */ (row);
    if (walletClientServiceExpired(r)) return false;
    const rem = walletClientServiceRemaining(r);
    if (rem === null) return false;
    return rem > 0;
  }

  /** @param {unknown} v @returns {number | null} */
  function walletPositiveIntOrNull(v) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
    if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) return Math.round(Number(v));
    return null;
  }

  /**
   * Infer original session count from titles like "10 pack - 6 months".
   * @param {unknown} title
   */
  function walletInferSessionsFromTitle(title) {
    if (typeof title !== "string") return null;
    const s = title.trim();
    if (!s) return null;
    /** @type {RegExp[]} */
    const ordered = [
      /\b(\d+)\s*[-]?\s*pack\b/i,
      /\b(\d+)\s*(?:class(?:es)?|sessions?|visits?)\b/i,
    ];
    for (const re of ordered) {
      const m = re.exec(s);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 500) return n;
    }
    return null;
  }

  /** @param {Record<string, unknown>} r */
  function walletPackMeta(r) {
    const remaining = walletClientServiceRemaining(r);
    if (remaining === null || remaining <= 0) return null;

    const nameRaw = walletPick(r, ["Name", "ProgramName", "serviceName"]);
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Package";

    const deductedRaw = walletPick(r, ["NumberDeducted", "numberDeducted", "Visited", "visited"]);
    const deducted =
      typeof deductedRaw === "number"
        ? deductedRaw
        : deductedRaw != null && Number.isFinite(Number(deductedRaw))
          ? Number(deductedRaw)
          : null;

    const totalRaw = walletPick(r, [
      "TotalPurchased",
      "totalPurchased",
      "PurchasedCount",
      "SessionCount",
      "TotalCount",
      "OriginalTotal",
      "originalTotal",
      "Count",
      "count",
      "NumberOfSessions",
      "numberOfSessions",
    ]);
    const apiTotal = walletPositiveIntOrNull(totalRaw);

    let total =
      deducted != null && Number.isFinite(deducted) && deducted >= 0
        ? remaining + Math.round(deducted)
        : null;
    if (total != null && (!Number.isFinite(total) || total < remaining)) total = null;

    const fromTitle = walletInferSessionsFromTitle(name);
    if (total === null && fromTitle != null && fromTitle >= remaining) total = fromTitle;

    if (total === null && apiTotal != null && apiTotal >= remaining) {
      if (fromTitle != null && fromTitle === remaining && apiTotal !== fromTitle) total = fromTitle;
      else total = apiTotal;
    }

    if (total === null) total = remaining;

    if (total < remaining) total = remaining;

    return { name, remaining, total };
  }

  /**
   * @param {Record<string, unknown>} sumPayload
   */
  function scheduleWalletViewModel(sumPayload) {
    const clientId = sumPayload.clientId;
    if (clientId == null) {
      return {
        kind: "message",
        variant: "warn",
        text: "We couldn’t match your Mindbody login to this studio’s client record, so credits aren’t shown here.",
      };
    }

    const rawServices = sumPayload.clientServices;
    const servicesArr = walletFirstArray(rawServices, ["ClientServices", "Services", "clientServices"]).filter(
      (x) => x && typeof x === "object",
    );
    /** @type {Record<string, unknown>[]} */
    const actives = servicesArr.map((x) => /** @type {Record<string, unknown>} */ (x)).filter(walletPassesActiveService);
    actives.sort((a, b) => (walletClientServiceRemaining(b) ?? -1) - (walletClientServiceRemaining(a) ?? -1));

    /** @type {ReturnType<typeof walletPackMeta>[]} */
    const metas = [];
    for (const row of actives) {
      const m = walletPackMeta(row);
      if (m) metas.push(m);
    }

    const top = metas.slice(0, 2);
    const moreCount = Math.max(0, metas.length - top.length);

    if (top.length) {
      return { kind: "packs", packs: top, moreCount };
    }

    const memRoot = sumPayload.memberships;
    const mems = walletFirstArray(memRoot, [
      "ClientMemberships",
      "Memberships",
      "memberships",
      "ActiveClientMemberships",
      "ActiveMemberships",
      "activeMemberships",
    ]).filter((x) => x && typeof x === "object");
    /** @type {Record<string, unknown>[]} */
    const memRows = mems.map((x) => /** @type {Record<string, unknown>} */ (x));
    const activeMem = memRows.find((m) => {
      const a = m.Active ?? m.active;
      return a === true || a === "true" || a === 1;
    });
    if (activeMem) {
      const mn = walletPick(activeMem, ["MembershipName", "Name", "name", "ProgramName", "Description"]);
      const label = typeof mn === "string" && mn.trim() ? mn.trim() : "Membership";
      return { kind: "membership", membershipName: label };
    }

    return {
      kind: "message",
      variant: "info",
      text: "No class packages with visits left. Add a package from Pricing or at the front desk.",
    };
  }

  /** Max punch segments on screen; larger packs scale proportionally. */
  const WALLET_SEG_DISPLAY_MAX = 42;

  /**
   * @param {number} remaining
   * @param {number} total
   */
  function walletPunchSlotLayout(remaining, total) {
    const t = Math.max(1, Math.round(total));
    const r = Math.max(0, Math.round(remaining));
    if (t <= WALLET_SEG_DISPLAY_MAX) {
      return { slotCount: t, filled: Math.min(r, t) };
    }
    const slotCount = WALLET_SEG_DISPLAY_MAX;
    const filled = Math.max(0, Math.min(slotCount, Math.round((r / t) * slotCount)));
    return { slotCount, filled };
  }

  /**
   * @param {HTMLElement} card
   * @param {{ remaining: number; total: number }} pack
   */
  function appendScheduleWalletPunchRow(card, pack) {
    const tr = Math.max(1, Math.round(pack.total));
    const rem = Math.max(0, Math.round(pack.remaining));
    const { slotCount, filled } = walletPunchSlotLayout(rem, tr);

    const segments = document.createElement("div");
    segments.className = "mb-schedule-wallet__segments";
    segments.style.setProperty("--mb-wallet-seg-n", String(slotCount));
    segments.setAttribute("role", "progressbar");
    segments.setAttribute("aria-valuemin", "0");
    segments.setAttribute("aria-valuemax", String(tr));
    segments.setAttribute("aria-valuenow", String(rem));
    segments.setAttribute("aria-valuetext", `${rem} of ${tr} visits remaining`);

    for (let i = 0; i < slotCount; i++) {
      const seg = document.createElement("span");
      seg.className =
        i < filled ? "mb-schedule-wallet__seg mb-schedule-wallet__seg--on" : "mb-schedule-wallet__seg mb-schedule-wallet__seg--off";
      seg.setAttribute("aria-hidden", "true");
      segments.append(seg);
    }

    card.append(segments);
  }

  /**
   * @param {HTMLElement} wrap
   * @param {{ name: string; remaining: number; total: number }} pack
   * @param {{ secondary?: boolean }} opts
   */
  function appendScheduleWalletPackCard(wrap, pack, opts) {
    const secondary = !!(opts && opts.secondary);
    const card = document.createElement("div");
    card.className = secondary ? "mb-schedule-wallet__card mb-schedule-wallet__card--secondary" : "mb-schedule-wallet__card";

    const nameEl = document.createElement("div");
    nameEl.className = "mb-schedule-wallet__name";
    nameEl.textContent = pack.name;

    const meta = document.createElement("div");
    meta.className = "mb-schedule-wallet__meta";
    const tr = Math.max(1, Math.round(pack.total));
    const rem = Math.max(0, Math.round(pack.remaining));
    const strong = document.createElement("strong");
    strong.textContent = `${rem}`;
    meta.append(strong, ` of ${tr} visits left`);

    card.append(nameEl, meta);
    appendScheduleWalletPunchRow(card, { ...pack, remaining: rem, total: tr });
    wrap.append(card);
  }

  /** @param {HTMLElement} root @param {string} text @param {{ warn?: boolean }} opts */
  function appendScheduleWalletNotice(root, text, opts) {
    const warn = !!(opts && opts.warn);
    if (warn) root.classList.add("mb-schedule-wallet--warn");
    const p = document.createElement("p");
    p.className = "mb-schedule-wallet__notice";
    p.textContent = text;
    root.append(p);
  }

  /**
   * @param {HTMLElement|null} mount
   * @param {Record<string, unknown>|null} sumPayload
   * @param {"ok" | "absent" | "error"} mode
   */
  function mbWalletRenderInto(mount, sumPayload, mode) {
    if (!mount) return;
    mount.classList.remove("mb-schedule-wallet--warn");
    mount.replaceChildren();
    mount.classList.add("mb-schedule-wallet");

    if (mode === "absent") {
      mount.hidden = true;
      return;
    }
    if (mode === "error" || !sumPayload || typeof sumPayload !== "object") {
      mount.hidden = false;
      appendScheduleWalletNotice(
        mount,
        "Couldn’t load package balance. Try refreshing the page.",
        { warn: true },
      );
      return;
    }

    const vm = scheduleWalletViewModel(sumPayload);
    mount.hidden = false;

    if (vm.kind === "message") {
      appendScheduleWalletNotice(mount, vm.text, { warn: vm.variant === "warn" });
      return;
    }

    if (vm.kind === "membership") {
      const inner = document.createElement("div");
      inner.className = "mb-schedule-wallet__inner";
      inner.setAttribute("role", "region");
      inner.setAttribute("aria-label", "Your membership");
      const head = document.createElement("div");
      head.className = "mb-schedule-wallet__membership-head";
      const eyebrow = document.createElement("div");
      eyebrow.className = "mb-schedule-wallet__eyebrow";
      eyebrow.textContent = "Membership";
      const badge = document.createElement("span");
      badge.className = "mb-schedule-wallet__membership-badge";
      badge.textContent = "Active";
      head.append(eyebrow, badge);

      const nameEl = document.createElement("div");
      nameEl.className = "mb-schedule-wallet__name";
      nameEl.textContent = vm.membershipName;

      const meta = document.createElement("div");
      meta.className = "mb-schedule-wallet__meta";
      meta.textContent = "Unlimited or recurring access — book classes per your plan.";

      const track = document.createElement("div");
      track.className = "mb-schedule-wallet__track";
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", "100");
      track.setAttribute("aria-valuetext", `${vm.membershipName} membership active`);

      const fill = document.createElement("div");
      fill.className = "mb-schedule-wallet__fill mb-schedule-wallet__fill--pulse";
      track.append(fill);

      inner.append(head, nameEl, meta, track);
      mount.append(inner);
      return;
    }

    const inner = document.createElement("div");
    inner.className = "mb-schedule-wallet__inner";
    inner.setAttribute("role", "region");
    inner.setAttribute("aria-label", "Your class visit credits");

    const eyebrow = document.createElement("div");
    eyebrow.className = "mb-schedule-wallet__eyebrow";
    eyebrow.textContent = "Class credits";

    inner.append(eyebrow);

    vm.packs.forEach((pack, idx) => {
      appendScheduleWalletPackCard(inner, pack, { secondary: idx > 0 });
    });

    if (vm.moreCount > 0) {
      const more = document.createElement("p");
      more.className = "mb-schedule-wallet__more";
      more.textContent =
        mount.getAttribute("data-mb-wallet-context") === "member"
          ? `+ ${vm.moreCount} more package${vm.moreCount === 1 ? "" : "s"} with visits — scroll to Services & packages below for the full list.`
          : `+ ${vm.moreCount} more package${vm.moreCount === 1 ? "" : "s"} with visits · see your member profile for the full list.`;
      inner.append(more);
    }

    mount.append(inner);
  }

  g.mbWalletRenderInto = mbWalletRenderInto;
})(typeof globalThis !== "undefined" ? globalThis : window);
