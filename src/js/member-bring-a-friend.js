/**
 * Bring a Friend — member dashboard card + /classes wallet invite (shared logic).
 */
(function () {
  const STUDIO_TZ = "America/New_York";
  const OPEN_BTN_LABEL = "Invite a friend";

  /**
   * @param {{
   *   mode: "member" | "schedule";
   *   root: Element;
   *   card?: HTMLElement | null;
   *   hint?: HTMLElement | null;
   *   statusEl?: HTMLElement | null;
   *   openBtn?: HTMLButtonElement | null;
   *   scheduleMount?: HTMLElement | null;
   *   dlg: HTMLDialogElement;
   *   form: HTMLFormElement;
   *   classSelect: HTMLSelectElement;
   *   errEl: HTMLElement | null;
   *   consentText: HTMLElement | null;
   *   cancelBtn: HTMLElement | null;
   *   submitBtn: HTMLButtonElement | null;
   *   successDlg: HTMLDialogElement | null;
   *   successBody: HTMLElement | null;
   *   successCloseBtn: HTMLElement | null;
   *   successOkBtn: HTMLElement | null;
   * }} ctx
   */
  function initGuestPass(ctx) {
    const isSchedule = ctx.mode === "schedule";
    /** @type {HTMLButtonElement | null} */
    let scheduleOpenBtn = null;
    let openBtnLoading = false;

    /** @type {HTMLButtonElement | null} */
    const memberOpenBtn = ctx.openBtn ?? null;

    function activeOpenBtn() {
      return isSchedule ? scheduleOpenBtn : memberOpenBtn;
    }

    function mbApiPrefix() {
      const holder = ctx.root.closest("[data-mb-proxy]");
      const raw =
        holder && typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
      return raw.replace(/\/$/, "");
    }

    function mbApiPath(path) {
      const p = path.startsWith("/") ? path : `/${path}`;
      const prefix = mbApiPrefix();
      return prefix ? `${prefix}${p}` : p;
    }

    /** @type {Record<string, unknown>|null} */
    let lastStatus = null;

    function mindbodyInstantToUtcMs(isoLike) {
      if (isoLike == null || typeof isoLike !== "string") return NaN;
      const raw = isoLike.trim();
      if (!raw) return NaN;
      if (/[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw)) {
        const t = Date.parse(raw);
        return Number.isNaN(t) ? NaN : t;
      }
      const mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
      if (!mm) {
        const t = Date.parse(raw);
        return Number.isNaN(t) ? NaN : t;
      }
      const y = +mm[1],
        mo = +mm[2],
        d = +mm[3],
        h = +mm[4],
        mi = +mm[5];
      const se = mm[6] != null ? +mm[6] : 0;
      let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: STUDIO_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      for (let i = 0; i < 48; i++) {
        const parts = fmt.formatToParts(new Date(t));
        const num = (typ) => parseInt(parts.find((p) => p.type === typ)?.value || "0", 10);
        const yy = num("year"),
          MM = num("month"),
          dd = num("day"),
          HH = num("hour"),
          mmm = num("minute"),
          ss = num("second");
        if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
        t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
        if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
      }
      return NaN;
    }

    function formatWhen(iso) {
      if (!iso) return "";
      const ms = mindbodyInstantToUtcMs(String(iso));
      if (!Number.isFinite(ms)) return String(iso);
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: STUDIO_TZ,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(ms));
      } catch {
        return String(iso);
      }
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    }

    function showErr(msg) {
      if (!ctx.errEl) return;
      if (!msg) {
        ctx.errEl.hidden = true;
        ctx.errEl.textContent = "";
        return;
      }
      ctx.errEl.hidden = false;
      ctx.errEl.textContent = msg;
    }

    function showBookingSuccess(j) {
      let sub = "Ask them to arrive 10 minutes early for their waiver.";
      if (j && j.requiresInStudioWaiver === true) {
        sub += " This is their first visit to AMARÉ.";
      }
      if (ctx.successDlg && ctx.successBody) {
        ctx.successBody.innerHTML = `<p class="mb-book-dialog__lead">Your guest is booked!</p><p class="mb-book-dialog__sub">${escapeHtml(sub)}</p>`;
        if (typeof ctx.successDlg.showModal === "function") ctx.successDlg.showModal();
        return;
      }
      window.alert(`Your guest is booked! ${sub}`);
    }

    function closeSuccessDialog() {
      if (ctx.successDlg && ctx.successDlg.open) ctx.successDlg.close();
    }

    function setOpenBtnLoading(loading) {
      openBtnLoading = loading;
      const btn = activeOpenBtn();
      if (!btn) return;
      if (loading) {
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        btn.classList.add("mb-guest-pass__cta--loading");
        btn.textContent = "Loading…";
      } else {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.classList.remove("mb-guest-pass__cta--loading");
        btn.textContent = OPEN_BTN_LABEL;
      }
    }

    function errorCopy(j) {
      const code = typeof j.error === "string" ? j.error : "";
      const map = {
        invalid_fields: "Please complete all guest details.",
        booking_consent_required: "Please confirm your guest gave permission to be booked.",
        cannot_invite_self: "You can't invite yourself as your own guest.",
        tier_not_eligible:
          "Bring a Friend Pass is included with monthly memberships and 10/20 Flexible Packs.",
        already_used_this_period: "You've already used your guest pass for this period.",
        guest_already_used_this_period: "This guest already used a complimentary pass this period.",
        member_not_booked_to_class: "Book yourself first — your guest pass only works for classes you're attending.",
        class_not_available_for_guest:
          "This class is almost full. Pick a class with at least 2 open spots.",
        guest_lookup_ambiguous:
          "We found more than one profile matching this guest. Please contact the studio.",
        guest_already_booked_to_class: "Your guest is already booked into this class.",
        mindbody_guest_create_failed:
          "We couldn't create your guest's profile in Mindbody. Please check their details or contact the studio.",
        mindbody_sale_failed:
          "We couldn't issue the guest pass in Mindbody. Please try again or contact the studio.",
        mindbody_booking_failed:
          "We couldn't book your guest into the class. Please try again or contact the studio.",
        guest_pass_blobs_unavailable:
          "Guest pass storage isn't available in this environment. Contact the studio if this persists.",
      };
      return map[code] || "Something went wrong. Please try again or contact the studio.";
    }

    function renewAtMarkup(data) {
      if (data.periodMode !== "calendarMonth" || !data.resetsAt) return "";
      return `<p class="mb-guest-pass__renew">Renews ${escapeHtml(formatWhen(String(data.resetsAt)))}</p>`;
    }

    function renderMemberStatus(data) {
      const card = ctx.card;
      const hint = ctx.hint;
      const statusEl = ctx.statusEl;
      const openBtn = ctx.openBtn;
      if (!card || !statusEl || !openBtn) return;

      lastStatus = data;
      if (!data.eligible) {
        card.hidden = false;
        openBtn.hidden = true;
        openBtn.setAttribute("hidden", "");
        if (hint) {
          hint.textContent =
            "Bring a Friend Pass is included with monthly memberships and 10/20 Flexible Packs.";
        }
        statusEl.innerHTML = `<p class="mb-guest-pass__badge mb-guest-pass__badge--used">Not available on your current plan</p>`;
        return;
      }
      card.hidden = false;
      const st = String(data.status || "");
      if (st === "available") {
        openBtn.hidden = false;
        openBtn.removeAttribute("hidden");
      } else {
        openBtn.hidden = true;
        openBtn.setAttribute("hidden", "");
      }
      if (hint) {
        hint.textContent =
          data.periodMode === "packLifetime"
            ? "One complimentary guest class per Flexible Pack purchase."
            : "One complimentary guest class per calendar month for eligible memberships.";
      }
      if (st === "available") {
        statusEl.innerHTML = `<p class="mb-guest-pass__badge mb-guest-pass__badge--available">Available</p>`;
        if (data.resetsAt && hint) {
          hint.textContent += ` Resets ${formatWhen(String(data.resetsAt))}.`;
        }
      } else if (st === "used" && data.usedFor && typeof data.usedFor === "object") {
        const u = /** @type {Record<string, unknown>} */ (data.usedFor);
        statusEl.innerHTML = `<p class="mb-guest-pass__badge mb-guest-pass__badge--used">Used — ${escapeHtml(String(u.guestFirstName || ""))} ${escapeHtml(String(u.guestLastInitial || ""))} · ${escapeHtml(formatWhen(String(u.classStartDateTime || "")))}</p>${renewAtMarkup(data)}`;
      } else if (st === "confirmed_cancelled") {
        statusEl.innerHTML = `<p class="mb-guest-pass__badge mb-guest-pass__badge--used">Pass used (cancelled)</p>${renewAtMarkup(data)}`;
      } else if (st === "failed_manual_review") {
        openBtn.setAttribute("hidden", "");
        statusEl.innerHTML = `<p class="mb-guest-pass__badge mb-guest-pass__badge--err">Needs studio help — ref ${escapeHtml(String(data.supportContext || ""))}</p>`;
        if (hint) {
          hint.textContent =
            "Your guest pass slot is locked after a partial booking. Contact the studio with the reference above, or ask them to reset your pass for this month.";
        }
      } else if (st === "pending") {
        statusEl.innerHTML = `<p class="mb-guest-pass__badge">Booking in progress…</p>`;
      } else {
        statusEl.innerHTML = "";
      }
    }

    function ensureScheduleInviteShell() {
      const mount = ctx.scheduleMount;
      if (!mount || mount.querySelector("[data-mb-schedule-guest-pass-open]")) return;
      mount.replaceChildren();
      const inner = document.createElement("div");
      inner.className = "mb-schedule-guest-pass__inner";
      inner.setAttribute("role", "region");
      inner.setAttribute("aria-label", "Bring a Friend guest pass");

      const eyebrow = document.createElement("p");
      eyebrow.className = "mb-schedule-guest-pass__eyebrow";
      eyebrow.textContent = "Bring a Friend";

      const hint = document.createElement("p");
      hint.className = "mb-schedule-guest-pass__hint";
      hint.textContent = "One complimentary guest class this period — for classes you're already booked into.";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--cream mb-guest-pass__cta mb-schedule-guest-pass__cta";
      btn.textContent = OPEN_BTN_LABEL;
      btn.dataset.mbScheduleGuestPassOpen = "1";

      inner.append(eyebrow, hint, btn);
      mount.append(inner);
      scheduleOpenBtn = btn;

      btn.addEventListener("click", () => {
        if (openBtnLoading) return;
        showErr("");
        setOpenBtnLoading(true);
        void loadStatus()
          .then(() => {
            if (typeof ctx.dlg.showModal === "function") ctx.dlg.showModal();
          })
          .finally(() => {
            setOpenBtnLoading(false);
          });
      });
    }

    function renderScheduleInvite(data) {
      const mount = ctx.scheduleMount;
      if (!mount) return;
      lastStatus = data;
      const show = data.eligible === true && String(data.status || "") === "available";
      mount.hidden = !show;
      if (!show) return;
      ensureScheduleInviteShell();
    }

    function hideScheduleInvite() {
      if (!ctx.scheduleMount) return;
      ctx.scheduleMount.hidden = true;
    }

    function populateClassSelect(data) {
      ctx.classSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a class…";
      ctx.classSelect.append(placeholder);
      const list = Array.isArray(data.upcomingBookedClasses) ? data.upcomingBookedClasses : [];
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const row = /** @type {Record<string, unknown>} */ (raw);
        const opt = document.createElement("option");
        opt.value = String(row.classId ?? "");
        const when = formatWhen(String(row.startDateTime ?? ""));
        opt.textContent = `${row.name || "Class"} — ${when} (${row.spotsRemaining ?? "?"} spots)`;
        ctx.classSelect.append(opt);
      }
      if (list.length === 0) {
        placeholder.textContent = "No eligible upcoming classes";
        const st = lastStatus ? String(lastStatus.status || "") : "";
        if (lastStatus && lastStatus.eligible && st === "available") {
          if (isSchedule && ctx.scheduleMount) {
            const hintEl = ctx.scheduleMount.querySelector(".mb-schedule-guest-pass__hint");
            if (hintEl) {
              hintEl.textContent =
                "Book yourself into a class with at least 2 open spots, then tap Invite a friend again.";
            }
          } else if (ctx.hint && ctx.openBtn) {
            ctx.hint.textContent =
              "Book yourself into a class with at least 2 open spots, then reopen this dialog (Refresh if you just booked).";
            ctx.openBtn.removeAttribute("hidden");
          }
        }
      }
    }

    async function loadStatus() {
      try {
        const res = await fetch(mbApiPath("/api/mindbody/member/bring-a-friend/status"), {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok && res.status === 401) {
          if (isSchedule) hideScheduleInvite();
          else if (ctx.card) ctx.card.hidden = true;
          return null;
        }
        const data = j && typeof j === "object" ? j : {};
        if (isSchedule) renderScheduleInvite(data);
        else renderMemberStatus(data);
        populateClassSelect(data);
        if (typeof data.bookingConsentText === "string" && ctx.consentText) {
          ctx.consentText.textContent = data.bookingConsentText;
        } else if (ctx.consentText && !ctx.consentText.textContent) {
          ctx.consentText.textContent =
            "I confirm my guest gave permission to share their contact information with Amaré and understands they must arrive 10 minutes early to complete the in-studio waiver and check-in.";
        }
        return data;
      } catch {
        if (isSchedule) hideScheduleInvite();
        else if (ctx.card) ctx.card.hidden = true;
        return null;
      }
    }

    if (ctx.cancelBtn) {
      ctx.cancelBtn.addEventListener("click", () => ctx.dlg.close());
    }
    if (ctx.successCloseBtn) {
      ctx.successCloseBtn.addEventListener("click", closeSuccessDialog);
    }
    if (ctx.successOkBtn) {
      ctx.successOkBtn.addEventListener("click", closeSuccessDialog);
    }
    if (ctx.successDlg) {
      ctx.successDlg.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        closeSuccessDialog();
      });
    }

    if (!isSchedule && ctx.openBtn) {
      ctx.openBtn.addEventListener("click", () => {
        if (openBtnLoading) return;
        showErr("");
        setOpenBtnLoading(true);
        void loadStatus()
          .then(() => {
            if (typeof ctx.dlg.showModal === "function") ctx.dlg.showModal();
          })
          .finally(() => {
            setOpenBtnLoading(false);
          });
      });
    }

    ctx.form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      showErr("");
      if (ctx.submitBtn) {
        ctx.submitBtn.disabled = true;
        ctx.submitBtn.textContent = "Booking…";
      }
      const fd = new FormData(ctx.form);
      const body = {
        classId: parseInt(String(fd.get("classId") || ""), 10),
        guestFirstName: String(fd.get("guestFirstName") || "").trim(),
        guestLastName: String(fd.get("guestLastName") || "").trim(),
        guestEmail: String(fd.get("guestEmail") || "").trim(),
        guestPhone: String(fd.get("guestPhone") || "").trim(),
        bookingConsentAccepted: fd.get("bookingConsentAccepted") === "1",
      };
      try {
        const res = await fetch(mbApiPath("/api/mindbody/member/bring-a-friend"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          showErr(errorCopy(j && typeof j === "object" ? j : {}));
          return;
        }
        ctx.dlg.close();
        ctx.form.reset();
        showBookingSuccess(j && typeof j === "object" ? j : {});
        void loadStatus();
      } catch (e) {
        showErr(String(/** @type {{ message?: string }} */ (e)?.message ?? e));
      } finally {
        if (ctx.submitBtn) {
          ctx.submitBtn.disabled = false;
          ctx.submitBtn.textContent = "Book guest";
        }
      }
    });

    if (isSchedule) {
      document.addEventListener("mb-schedule-member-summary-loaded", (ev) => {
        const detail = ev.detail && typeof ev.detail === "object" ? ev.detail : {};
        if (detail.ok !== true) {
          hideScheduleInvite();
          return;
        }
        void loadStatus();
      });
    } else {
      document.addEventListener("mb-member-summary-loaded", () => void loadStatus());
      void loadStatus();
    }
  }

  const memberRoot = document.querySelector("[data-mb-member-root]");
  if (memberRoot) {
    const dlg = /** @type {HTMLDialogElement|null} */ (
      memberRoot.querySelector("[data-mb-guest-pass-dialog]")
    );
    const form = /** @type {HTMLFormElement|null} */ (
      memberRoot.querySelector("[data-mb-guest-pass-form]")
    );
    const classSelect = /** @type {HTMLSelectElement|null} */ (
      memberRoot.querySelector("[data-mb-guest-pass-class]")
    );
    const openBtn = /** @type {HTMLButtonElement|null} */ (
      memberRoot.querySelector("[data-mb-guest-pass-open]")
    );
    if (
      memberRoot.querySelector("[data-mb-guest-pass]") &&
      openBtn &&
      dlg &&
      form &&
      classSelect
    ) {
      initGuestPass({
        mode: "member",
        root: memberRoot,
        card: memberRoot.querySelector("[data-mb-guest-pass]"),
        hint: memberRoot.querySelector("[data-mb-guest-pass-hint]"),
        statusEl: memberRoot.querySelector("[data-mb-guest-pass-status]"),
        openBtn,
        dlg,
        form,
        classSelect,
        errEl: memberRoot.querySelector("[data-mb-guest-pass-err]"),
        consentText: memberRoot.querySelector("[data-mb-guest-pass-consent-text]"),
        cancelBtn: memberRoot.querySelector("[data-mb-guest-pass-cancel]"),
        submitBtn: memberRoot.querySelector("[data-mb-guest-pass-submit]"),
        successDlg: memberRoot.querySelector("[data-mb-guest-pass-success]"),
        successBody: memberRoot.querySelector("[data-mb-guest-pass-success-body]"),
        successCloseBtn: memberRoot.querySelector("[data-mb-guest-pass-success-close]"),
        successOkBtn: memberRoot.querySelector("[data-mb-guest-pass-success-ok]"),
      });
    }
  }

  const scheduleRoot = document.getElementById("mb-schedule-root");
  const scheduleMount = document.getElementById("mb-schedule-guest-pass");
  const scheduleDlg = /** @type {HTMLDialogElement|null} */ (
    document.getElementById("mb-schedule-guest-pass-dialog")
  );
  const scheduleForm = /** @type {HTMLFormElement|null} */ (
    document.getElementById("mb-schedule-guest-pass-form")
  );
  const scheduleClassSelect = /** @type {HTMLSelectElement|null} */ (
    document.getElementById("mb-schedule-guest-pass-class")
  );
  if (scheduleRoot && scheduleMount && scheduleDlg && scheduleForm && scheduleClassSelect) {
    initGuestPass({
      mode: "schedule",
      root: scheduleRoot,
      scheduleMount,
      dlg: scheduleDlg,
      form: scheduleForm,
      classSelect: scheduleClassSelect,
      errEl: document.getElementById("mb-schedule-guest-pass-err"),
      consentText: document.getElementById("mb-schedule-guest-pass-consent-text"),
      cancelBtn: document.getElementById("mb-schedule-guest-pass-cancel"),
      submitBtn: document.getElementById("mb-schedule-guest-pass-submit"),
      successDlg: document.getElementById("mb-schedule-guest-pass-success"),
      successBody: document.getElementById("mb-schedule-guest-pass-success-body"),
      successCloseBtn: document.getElementById("mb-schedule-guest-pass-success-close"),
      successOkBtn: document.getElementById("mb-schedule-guest-pass-success-ok"),
    });
  }
})();
