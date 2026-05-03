(function () {
  "use strict";

  /**
   * GA4 custom events — safe if gtag is not loaded (ad blockers, env without GA_MEASUREMENT_ID).
   * Params: page_location, page_title always; link_url, button_text, cta_location, form_name when passed.
   */
  function trackEvent(eventName, params) {
    if (typeof window.gtag !== "function") return;
    var payload = {
      page_location: window.location.href,
      page_title: document.title || "",
    };
    if (params) {
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") payload[k] = v;
      });
    }
    try {
      window.gtag("event", eventName, payload);
    } catch (err) {
      /* Never block navigation or UI if GA fails */
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      var t = e.target;
      if (!t || typeof t.closest !== "function") return;
      var a = t.closest("a[href]");
      if (!a) return;
      var rawHref = a.getAttribute("href");
      if (!rawHref || rawHref.charAt(0) === "#") return;
      var explicit = (a.getAttribute("data-track") || "").trim();
      var btnText = (a.textContent || "").replace(/\s+/g, " ").trim();
      var ctaLoc = (a.getAttribute("data-cta-location") || "").trim();
      var baseParams = {
        link_url: a.href,
        button_text: btnText || undefined,
        cta_location: ctaLoc || undefined,
      };
      if (explicit) {
        trackEvent(explicit, baseParams);
        return;
      }
      try {
        var u = new URL(a.href);
        var host = u.hostname.toLowerCase();
        if (host.indexOf("mindbodyonline.com") !== -1) {
          trackEvent("mindbody_click", baseParams);
        }
      } catch (err) {
        /* ignore invalid URLs */
      }
    },
    false,
  );

  var toggle = document.getElementById("nav-toggle");
  var wrap = document.querySelector("[data-nav-scroll]");
  if (toggle && wrap) {
    toggle.addEventListener("click", function () {
      var open = wrap.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    wrap.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        wrap.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  function initTabGroup(root) {
    var list = root.querySelector('[role="tablist"]');
    if (!list) return;
    var tabs = [].slice.call(list.querySelectorAll('[role="tab"]'));
    var panels = [].slice.call(root.querySelectorAll('[role="tabpanel"]'));
    if (tabs.length === 0 || panels.length === 0) return;
    if (tabs.length !== panels.length) {
      return;
    }

    function moveFocus(i) {
      var t = tabs[i];
      if (t) t.focus();
    }

    function select(i) {
      if (i < 0) i = tabs.length - 1;
      if (i >= tabs.length) i = 0;
      tabs.forEach(function (tab, j) {
        var on = j === i;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        if (panels[j]) {
          if (on) {
            panels[j].removeAttribute("hidden");
            panels[j].setAttribute("tabindex", "0");
          } else {
            panels[j].setAttribute("hidden", "");
            panels[j].setAttribute("tabindex", "-1");
          }
        }
      });
    }

    var initial = -1;
    tabs.forEach(function (tab, j) {
      if (tab.getAttribute("aria-selected") === "true") initial = j;
    });
    if (initial < 0) initial = 0;
    select(initial);

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        select(i);
      });
      tab.addEventListener("keydown", function (e) {
        var k = e.key;
        var idx = i;
        if (k === "ArrowRight" || k === "ArrowDown") {
          e.preventDefault();
          select((idx + 1) % tabs.length);
          moveFocus((idx + 1) % tabs.length);
        } else if (k === "ArrowLeft" || k === "ArrowUp") {
          e.preventDefault();
          var ni = (idx - 1 + tabs.length) % tabs.length;
          select(ni);
          moveFocus(ni);
        } else if (k === "Home") {
          e.preventDefault();
          select(0);
          moveFocus(0);
        } else if (k === "End") {
          e.preventDefault();
          select(tabs.length - 1);
          moveFocus(tabs.length - 1);
        }
      });
    });
  }

  document.querySelectorAll(".tabs[data-tabs]").forEach(function (g) {
    initTabGroup(g);
  });

  if (!window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var nodes = document.querySelectorAll("[data-reveal]");
    if (nodes.length && "IntersectionObserver" in window) {
      var obs = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              e.target.classList.add("is-in");
            }
          });
        },
        { root: null, threshold: 0.12, rootMargin: "0px 0px -5% 0px" }
      );
      nodes.forEach(function (n) {
        obs.observe(n);
      });
    } else {
      nodes.forEach(function (n) {
        n.classList.add("is-in");
      });
    }
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (n) {
      n.classList.add("is-in");
    });
  }

  /* Home: studio video — play in view, pause out (amare-iframe-demo/branding-cta.html) */
  (function initHomeBrandVideo() {
    var v = document.querySelector("video[data-home-brand-video]");
    if (!v) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    function tryPlay() {
      var p = v.play();
      if (p && typeof p.then === "function") p.catch(function () {});
    }
    if (!("IntersectionObserver" in window)) {
      tryPlay();
      return;
    }
    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && e.intersectionRatio > 0.2) tryPlay();
          else v.pause();
        });
      },
      { root: null, threshold: [0, 0.1, 0.2, 0.35, 0.5] }
    );
    obs.observe(v);
  })();

  /* Home: PicSmart iframe — assign src when block enters viewport (autoplay after visible) */
  (function initHomeBrandIframeEmbed() {
    var iframe = document.querySelector(".home-brand-cta__video--embed[data-video-src]");
    if (!iframe) return;

    var raw = iframe.getAttribute("data-video-src");
    if (!raw) return;

    var reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function buildUrl() {
      if (!reduced) return raw;
      try {
        var u = new URL(raw);
        u.searchParams.delete("autoplay");
        return u.href;
      } catch (e) {
        return raw;
      }
    }

    var io = null;
    var fallbackTimer = null;

    function applySrc() {
      if (iframe.dataset.embedLoaded === "1") return;
      iframe.dataset.embedLoaded = "1";
      if (fallbackTimer != null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      iframe.src = buildUrl();
      iframe.removeAttribute("data-video-src");
      if (io) io.disconnect();
    }

    /* Narrow viewports: IO can miss or delay on mobile Safari (dynamic toolbar, thresholds).
       Match site.css home-brand split breakpoint (~860px). */
    var eagerEmbed =
      window.matchMedia && window.matchMedia("(max-width: 860px)").matches;

    if (eagerEmbed || !("IntersectionObserver" in window)) {
      applySrc();
      return;
    }

    fallbackTimer = setTimeout(function () {
      applySrc();
    }, 8000);

    var rootEl = iframe.closest(".home-brand-cta__video-block") || iframe;
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.12) applySrc();
        });
      },
      { root: null, threshold: [0, 0.12, 0.22], rootMargin: "0px 0px 12% 0px" }
    );
    io.observe(rootEl);
  })();

  (function initHomeReviewReadMore() {
    var root = document.querySelector(".home-reviews");
    if (!root) return;

    function maxCollapse() {
      var cs = window.getComputedStyle(root);
      var v = cs.getPropertyValue("--home-review-collapse").trim();
      return v || "10.25rem";
    }

    function measureCard(card) {
      var body = card.querySelector(".home-review-card__body");
      var btn = card.querySelector(".home-review-card__toggle");
      var foot = card.querySelector(".home-review-card__foot");
      if (!body || !btn || !foot) return;
      if (card.classList.contains("home-review-card--expanded")) return;

      body.style.maxHeight = "";
      body.classList.remove("home-review-card__body--clamp", "home-review-card__body--fade");

      var collapse = maxCollapse();
      body.style.maxHeight = collapse;
      void body.offsetHeight;
      var visH = body.clientHeight;
      body.style.maxHeight = "";
      var fullH = body.scrollHeight;

      var needs = fullH > visH + 2;
      if (needs) {
        body.classList.add("home-review-card__body--clamp", "home-review-card__body--fade");
        btn.hidden = false;
        foot.hidden = false;
        btn.textContent = "Read more";
        btn.setAttribute("aria-expanded", "false");
      } else {
        body.classList.remove("home-review-card__body--clamp", "home-review-card__body--fade");
        btn.hidden = true;
        foot.hidden = true;
      }
    }

    root.querySelectorAll(".home-review-card").forEach(function (card) {
      var btn = card.querySelector(".home-review-card__toggle");
      var body = card.querySelector(".home-review-card__body");
      if (!btn || !body) return;

      btn.addEventListener("click", function () {
        var exp = card.classList.toggle("home-review-card--expanded");
        btn.setAttribute("aria-expanded", exp ? "true" : "false");
        btn.textContent = exp ? "Read less" : "Read more";
        if (exp) {
          body.classList.remove("home-review-card__body--clamp", "home-review-card__body--fade");
        } else {
          body.classList.add("home-review-card__body--clamp", "home-review-card__body--fade");
        }
      });

      measureCard(card);
    });

    var resizeT;
    window.addEventListener("resize", function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        root.querySelectorAll(".home-review-card").forEach(measureCard);
      }, 120);
    });

    window.addEventListener("load", function () {
      root.querySelectorAll(".home-review-card").forEach(measureCard);
    });
  })();

  (function initPrivateEventsPickers() {
    var dlgTest = document.createElement("dialog");
    if (typeof dlgTest.showModal !== "function") return;

    var btnMonth = document.getElementById("pe-btn-month");
    var btnDay = document.getElementById("pe-btn-day");
    var btnYear = document.getElementById("pe-btn-year");
    var btnTime = document.getElementById("pe-btn-time");
    var inpMonth = document.getElementById("pe-inp-month");
    var inpDay = document.getElementById("pe-inp-day");
    var inpYear = document.getElementById("pe-inp-year");
    var inpTime = document.getElementById("pe-inp-time");
    var dlgMonth = document.getElementById("pe-dlg-month");
    var dlgDay = document.getElementById("pe-dlg-day");
    var dlgYear = document.getElementById("pe-dlg-year");
    var dlgTime = document.getElementById("pe-dlg-time");

    if (!btnMonth || !btnDay || !btnYear || !btnTime || !inpMonth || !inpDay || !inpYear || !inpTime) return;
    if (!dlgMonth || !dlgDay || !dlgYear || !dlgTime) return;

    var MONTHS = [
      ["01", "January"],
      ["02", "February"],
      ["03", "March"],
      ["04", "April"],
      ["05", "May"],
      ["06", "June"],
      ["07", "July"],
      ["08", "August"],
      ["09", "September"],
      ["10", "October"],
      ["11", "November"],
      ["12", "December"],
    ];

    var yNow = new Date().getFullYear();

    /** Full year list for future years; from current month through December for the current calendar year. */
    function monthsForSelectedYear(yearNum) {
      if (yearNum > yNow) return MONTHS.slice();
      if (yearNum < yNow) return [];
      var cm = new Date().getMonth() + 1;
      return MONTHS.filter(function (pair) {
        return parseInt(pair[0], 10) >= cm;
      });
    }

    function fmtAmPm(h24, m) {
      var suf = h24 >= 12 ? "PM" : "AM";
      var h12 = h24 % 12;
      if (h12 === 0) h12 = 12;
      var mm = m === 0 ? "00" : "30";
      return h12 + ":" + mm + " " + suf;
    }

    function refreshTrigger(btn, inp, labelWhenSet) {
      var span = btn.querySelector(".pe-picker__value");
      var ph = span.getAttribute("data-pe-placeholder") || "";
      if (!inp.value) {
        span.textContent = ph;
        btn.classList.add("pe-picker__trigger--empty");
      } else {
        span.textContent = labelWhenSet != null ? labelWhenSet : inp.value;
        btn.classList.remove("pe-picker__trigger--empty");
      }
    }

    function wireDialog(dlg, triggerBtn) {
      var bd = dlg.querySelector(".pe-dlg__backdrop");
      var closeBtn = dlg.querySelector(".pe-dlg__close");
      if (bd) {
        bd.addEventListener("click", function (e) {
          if (e.target === bd) dlg.close();
        });
      }
      if (closeBtn) {
        closeBtn.addEventListener("click", function () {
          dlg.close();
        });
      }
      dlg.addEventListener("close", function () {
        triggerBtn.setAttribute("aria-expanded", "false");
      });
    }

    function openDlg(dlg, triggerBtn) {
      dlg.showModal();
      triggerBtn.setAttribute("aria-expanded", "true");
    }

    function chainAfterClose(closeDlg, openFn) {
      closeDlg.close();
      window.requestAnimationFrame(function () {
        openFn();
      });
    }

    function populateMonthBody() {
      var bodyMonth = dlgMonth.querySelector('[data-pe-dlg-body="month"]');
      while (bodyMonth.firstChild) bodyMonth.removeChild(bodyMonth.firstChild);
      var ys = parseInt(inpYear.value, 10);
      if (isNaN(ys)) ys = yNow;
      var list = monthsForSelectedYear(ys);
      var codes = list.map(function (p) {
        return p[0];
      });
      if (inpMonth.value && codes.indexOf(inpMonth.value) === -1) {
        inpMonth.value = "";
        refreshTrigger(btnMonth, inpMonth);
      }
      list.forEach(function (pair) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "pe-dlg__opt pe-dlg__opt--block";
        b.textContent = pair[1];
        b.addEventListener("click", function () {
          inpMonth.value = pair[0];
          refreshTrigger(btnMonth, inpMonth, pair[1]);
          chainAfterClose(dlgMonth, function () {
            openDlg(dlgDay, btnDay);
          });
        });
        bodyMonth.appendChild(b);
      });
    }

    function invalidateMonthIfOutsideAllowed(yearStr) {
      var yn = parseInt(yearStr, 10);
      if (isNaN(yn)) return;
      var allowed = monthsForSelectedYear(yn).map(function (p) {
        return p[0];
      });
      if (inpMonth.value && allowed.indexOf(inpMonth.value) === -1) {
        inpMonth.value = "";
        refreshTrigger(btnMonth, inpMonth);
      }
    }

    wireDialog(dlgMonth, btnMonth);
    wireDialog(dlgDay, btnDay);
    wireDialog(dlgYear, btnYear);
    wireDialog(dlgTime, btnTime);

    btnMonth.addEventListener("click", function () {
      populateMonthBody();
      openDlg(dlgMonth, btnMonth);
    });
    btnDay.addEventListener("click", function () {
      openDlg(dlgDay, btnDay);
    });
    btnYear.addEventListener("click", function () {
      openDlg(dlgYear, btnYear);
    });
    btnTime.addEventListener("click", function () {
      openDlg(dlgTime, btnTime);
    });

    var prevDay = dlgDay.querySelector(".pe-dlg__prev");
    var prevYear = dlgYear.querySelector(".pe-dlg__prev");
    var prevTime = dlgTime.querySelector(".pe-dlg__prev");
    if (prevDay) {
      prevDay.addEventListener("click", function () {
        chainAfterClose(dlgDay, function () {
          populateMonthBody();
          openDlg(dlgMonth, btnMonth);
        });
      });
    }
    if (prevYear) {
      prevYear.addEventListener("click", function () {
        chainAfterClose(dlgYear, function () {
          openDlg(dlgDay, btnDay);
        });
      });
    }
    if (prevTime) {
      prevTime.addEventListener("click", function () {
        chainAfterClose(dlgTime, function () {
          openDlg(dlgYear, btnYear);
        });
      });
    }

    var bodyDay = dlgDay.querySelector('[data-pe-dlg-body="day"]');
    for (var d = 1; d <= 31; d++) {
      var bd = document.createElement("button");
      bd.type = "button";
      bd.className = "pe-dlg__opt pe-dlg__opt--day";
      bd.textContent = String(d);
      bd.setAttribute("data-value", String(d));
      bd.addEventListener("click", function (ev) {
        var day = ev.currentTarget.getAttribute("data-value");
        inpDay.value = day;
        refreshTrigger(btnDay, inpDay, day);
        chainAfterClose(dlgDay, function () {
          openDlg(dlgYear, btnYear);
        });
      });
      bodyDay.appendChild(bd);
    }

    var bodyYear = dlgYear.querySelector('[data-pe-dlg-body="year"]');
    for (var yi = 0; yi <= 1; yi++) {
      var yr = yNow + yi;
      var by = document.createElement("button");
      by.type = "button";
      by.className = "pe-dlg__opt pe-dlg__opt--block";
      by.textContent = String(yr);
      by.setAttribute("data-value", String(yr));
      by.addEventListener("click", function (ev) {
        var y = ev.currentTarget.getAttribute("data-value");
        inpYear.value = y;
        refreshTrigger(btnYear, inpYear, y);
        invalidateMonthIfOutsideAllowed(y);
        chainAfterClose(dlgYear, function () {
          openDlg(dlgTime, btnTime);
        });
      });
      bodyYear.appendChild(by);
    }

    var bodyTime = dlgTime.querySelector('[data-pe-dlg-body="time"]');
    for (var minutes = 8 * 60; minutes <= 22 * 60; minutes += 30) {
      var h = Math.floor(minutes / 60);
      var m = minutes % 60;
      var hh = String(h).padStart(2, "0");
      var mm = m === 0 ? "00" : "30";
      var val24 = hh + ":" + mm;
      var bt = document.createElement("button");
      bt.type = "button";
      bt.className = "pe-dlg__opt pe-dlg__opt--block";
      bt.textContent = fmtAmPm(h, m);
      bt.setAttribute("data-value", val24);
      bt.addEventListener("click", function (ev) {
        var v = ev.currentTarget.getAttribute("data-value");
        inpTime.value = v;
        refreshTrigger(btnTime, inpTime, ev.currentTarget.textContent);
        dlgTime.close();
      });
      bodyTime.appendChild(bt);
    }

    inpYear.value = String(yNow);
    refreshTrigger(btnYear, inpYear, String(yNow));
    refreshTrigger(btnMonth, inpMonth);
    refreshTrigger(btnDay, inpDay);
    refreshTrigger(btnTime, inpTime);
  })();

  (function initTreatmentRoomWeekday() {
    var btn = document.getElementById("tr-btn-weekday");
    var inpWd = document.getElementById("tr-inp-weekday");
    var inpDur = document.getElementById("tr-inp-duration");
    var inpHalf = document.getElementById("tr-inp-half-period");
    var dlg = document.getElementById("tr-dlg-weekday");
    if (!btn || !inpWd || !inpDur || !inpHalf || !dlg) return;
    if (typeof dlg.showModal !== "function") return;

    var span = btn.querySelector(".pe-picker__value");
    var ph = span ? span.getAttribute("data-pe-placeholder") || "Weekday & schedule" : "Weekday & schedule";

    var stepWd = document.getElementById("tr-step-weekday");
    var stepDur = document.getElementById("tr-step-duration");
    var stepHalf = document.getElementById("tr-step-half");
    var titleEl = document.getElementById("tr-dlg-schedule-title");
    var halfIntroEl = document.getElementById("tr-half-intro");
    var btnDurFull = stepDur ? stepDur.querySelector('button[data-value="full"]') : null;
    var btnDurHalf = stepDur ? stepDur.querySelector('button[data-value="half"]') : null;
    var btnHalfEvening = stepHalf ? stepHalf.querySelector('button[data-value="evening"]') : null;
    var backHalfEl = stepHalf ? stepHalf.querySelector(".tr-schedule-back") : null;

    var DEFAULT_HALF_INTRO = "Choose your half-day window.";
    var FRIDAY_HALF_INTRO =
      "Friday is available as a recurring morning half-day only (9:00 AM – 2:00 PM).";
    var DEFAULT_BACK_FROM_HALF = "← Full / half day";

    var selDay = "";
    var selDur = "";
    var selHalf = "";

    var USD_FULL_DAY = 170;
    var USD_HALF_DAY = 90;
    var WEEKS_PER_MONTH_EST = 4;

    var panel = document.getElementById("tr-price-panel");
    var priceLeadMain = document.getElementById("tr-price-lead-main");
    var priceLeadRef = document.getElementById("tr-price-lead-ref");
    var priceWeeklyNote = document.getElementById("tr-price-weekly-note");
    var priceMonthlyLine = document.getElementById("tr-price-monthly-line");
    var pricePeriodTotal = document.getElementById("tr-price-period-total");
    var cmEl = document.getElementById("tr-commitment-months");
    var inpRate = document.getElementById("tr-inp-rate");
    var inpEstMonthly = document.getElementById("tr-inp-est-monthly");
    var inpEstTotal = document.getElementById("tr-inp-est-total");
    var summaryTa = document.getElementById("tr-pricing-summary");

    function syncHiddenFromSelection() {
      inpWd.value = selDay ? selDay.trim() : "";
      if (!selDur) {
        inpDur.value = "";
        inpHalf.value = "";
        return;
      }
      if (selDur === "full") {
        inpDur.value = "full_day";
        inpHalf.value = "";
      } else if (selDur === "half") {
        inpDur.value = "half_day";
        if (selHalf === "morning") inpHalf.value = "morning_9am_2pm";
        else if (selHalf === "evening") inpHalf.value = "evening_3pm_8pm";
        else inpHalf.value = "";
      } else {
        inpDur.value = "";
        inpHalf.value = "";
      }
    }

    function refreshTriggerDisplay() {
      syncHiddenFromSelection();
      if (!selDay) {
        if (span) span.textContent = ph;
        btn.classList.add("pe-picker__trigger--empty");
        return;
      }
      btn.classList.remove("pe-picker__trigger--empty");
      var label = selDay;
      if (selDur === "full") {
        label += " · Full day";
      } else if (selDur === "half") {
        if (selHalf === "morning") {
          label += " · Half day · Morning (9:00 AM – 2:00 PM)";
        } else if (selHalf === "evening") {
          label += " · Half day · Evening (3:00 PM – 8:00 PM)";
        } else {
          label += " · Half day";
        }
      }
      if (span) span.textContent = label;
    }

    function scheduleLabelHuman() {
      if (!selDay) return "";
      var label = selDay;
      if (selDur === "full") label += " · Full day";
      else if (selDur === "half") {
        if (selHalf === "morning") label += " · Half day · Morning (9:00 AM – 2:00 PM)";
        else if (selHalf === "evening") label += " · Half day · Evening (3:00 PM – 8:00 PM)";
        else label += " · Half day";
      }
      return label;
    }

    function restoreAvailabilityUi() {
      if (btnDurFull) {
        btnDurFull.disabled = false;
        btnDurFull.removeAttribute("aria-disabled");
        btnDurFull.removeAttribute("title");
      }
      if (btnDurHalf) {
        btnDurHalf.disabled = false;
      }
      if (btnHalfEvening) {
        btnHalfEvening.disabled = false;
        btnHalfEvening.removeAttribute("aria-disabled");
        btnHalfEvening.removeAttribute("title");
      }
      if (halfIntroEl) halfIntroEl.textContent = DEFAULT_HALF_INTRO;
      if (backHalfEl) backHalfEl.textContent = DEFAULT_BACK_FROM_HALF;
    }

    function applyFridayDurationLocks() {
      if (btnDurFull) {
        btnDurFull.disabled = true;
        btnDurFull.setAttribute("aria-disabled", "true");
        btnDurFull.setAttribute("title", "Full day is not available on Friday.");
      }
      if (btnDurHalf) btnDurHalf.disabled = false;
    }

    function applyFridayHalfLocks() {
      if (btnHalfEvening) {
        btnHalfEvening.disabled = true;
        btnHalfEvening.setAttribute("aria-disabled", "true");
        btnHalfEvening.setAttribute("title", "Evening half-day is not available on Friday.");
      }
    }

    function showStep(step) {
      if (stepWd) stepWd.hidden = step !== "weekday";
      if (stepDur) stepDur.hidden = step !== "duration";
      if (stepHalf) stepHalf.hidden = step !== "half";

      if (step === "duration") {
        if (selDay === "Friday") applyFridayDurationLocks();
      } else if (step === "half") {
        if (halfIntroEl) halfIntroEl.textContent = selDay === "Friday" ? FRIDAY_HALF_INTRO : DEFAULT_HALF_INTRO;
        if (selDay === "Friday") applyFridayHalfLocks();
        else if (btnHalfEvening) {
          btnHalfEvening.disabled = false;
          btnHalfEvening.removeAttribute("aria-disabled");
          btnHalfEvening.removeAttribute("title");
        }
      }

      var titles = {
        weekday: "Choose weekday",
        duration: "Full day or half day?",
        half: selDay === "Friday" ? "Morning slot (Friday)" : "Morning or evening?",
      };
      if (titleEl && titles[step]) titleEl.textContent = titles[step];
    }

    function scheduleComplete() {
      syncHiddenFromSelection();
      var wdTrim = inpWd.value.trim();
      if (!wdTrim || !inpDur.value) return false;
      if (wdTrim === "Saturday") return false;
      if (wdTrim === "Friday") {
        return inpDur.value === "half_day" && inpHalf.value === "morning_9am_2pm";
      }
      if (inpDur.value === "full_day") return true;
      if (inpDur.value === "half_day") {
        return inpHalf.value === "morning_9am_2pm" || inpHalf.value === "evening_3pm_8pm";
      }
      return false;
    }

    function hidePricingPanel() {
      if (panel) panel.hidden = true;
      if (inpRate) inpRate.value = "";
      if (inpEstMonthly) inpEstMonthly.value = "";
      if (inpEstTotal) inpEstTotal.value = "";
      if (summaryTa) summaryTa.value = "";
      if (priceLeadMain) priceLeadMain.textContent = "";
      if (priceLeadRef) priceLeadRef.textContent = "";
      if (priceWeeklyNote) priceWeeklyNote.textContent = "";
      if (priceMonthlyLine) priceMonthlyLine.textContent = "";
      if (pricePeriodTotal) pricePeriodTotal.textContent = "";
    }

    function updatePricingTotals() {
      syncHiddenFromSelection();
      if (!scheduleComplete()) {
        hidePricingPanel();
        return;
      }
      var rate = inpDur.value === "full_day" ? USD_FULL_DAY : USD_HALF_DAY;
      var kindLabel = inpDur.value === "full_day" ? "full day" : "half day";
      var weeksMo = WEEKS_PER_MONTH_EST;
      var estMonthly = rate * weeksMo;
      var months = 1;
      if (cmEl && cmEl.value !== "") {
        var parsed = parseInt(cmEl.value, 10);
        if (!isNaN(parsed) && parsed >= 1) months = parsed;
      }
      var estTotal = estMonthly * months;

      if (panel) panel.hidden = false;
      if (inpRate) inpRate.value = String(rate);
      if (inpEstMonthly) inpEstMonthly.value = String(estMonthly);
      if (inpEstTotal) inpEstTotal.value = String(estTotal);

      if (priceLeadMain) {
        priceLeadMain.textContent =
          "$" +
          rate +
          " per recurring weekday block (" +
          kindLabel +
          ").";
      }
      if (priceLeadRef) {
        priceLeadRef.textContent =
          "Reference: full day $" +
          USD_FULL_DAY +
          " · half day $" +
          USD_HALF_DAY +
          ".";
      }
      if (priceWeeklyNote) {
        priceWeeklyNote.textContent =
          "One fixed weekday block per week — we estimate about " +
          weeksMo +
          " blocks per month for budgeting.";
      }
      if (priceMonthlyLine) {
        priceMonthlyLine.textContent =
          "Estimated monthly (≈" +
          weeksMo +
          " × $" +
          rate +
          "): $" +
          estMonthly.toLocaleString("en-US");
      }
      if (pricePeriodTotal) {
        pricePeriodTotal.textContent =
          "$" +
          estTotal.toLocaleString("en-US") +
          " (" +
          months +
          " month" +
          (months !== 1 ? "s" : "") +
          ")";
      }

      var scheduleHuman = scheduleLabelHuman();
      var summaryLines = [
        "Schedule: " + scheduleHuman,
        "Rate per recurring block: $" + rate + " (" + kindLabel + ")",
        "Estimated monthly (≈" + weeksMo + " blocks): $" + estMonthly.toLocaleString("en-US"),
        "Commitment length: " + months + " month" + (months !== 1 ? "s" : ""),
        "Estimated total for this commitment: $" + estTotal.toLocaleString("en-US"),
      ];
      if (summaryTa) summaryTa.value = summaryLines.join("\n");
    }

    function resetWizard() {
      selDay = "";
      selDur = "";
      selHalf = "";
      inpWd.value = "";
      inpDur.value = "";
      inpHalf.value = "";
      restoreAvailabilityUi();
      hidePricingPanel();
      showStep("weekday");
      refreshTriggerDisplay();
    }

    function finishAndClose() {
      refreshTriggerDisplay();
      updatePricingTotals();
      dlg.close();
    }

    var bd = dlg.querySelector(".pe-dlg__backdrop");
    var closeBtn = dlg.querySelector(".pe-dlg__close");
    if (bd) {
      bd.addEventListener("click", function (e) {
        if (e.target === bd) dlg.close();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        dlg.close();
      });
    }

    dlg.addEventListener("close", function () {
      btn.setAttribute("aria-expanded", "false");
      if (!scheduleComplete()) resetWizard();
    });

    btn.addEventListener("click", function () {
      resetWizard();
      dlg.showModal();
      btn.setAttribute("aria-expanded", "true");
    });

    var weekdayBtns = document.querySelectorAll("#tr-weekday-options button");
    weekdayBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.disabled) return;
        restoreAvailabilityUi();
        selDay = b.getAttribute("data-value") || "";
        selDur = "";
        selHalf = "";
        showStep("duration");
      });
    });

    if (stepDur) {
      stepDur.querySelectorAll("button[data-value]").forEach(function (el) {
        el.addEventListener("click", function () {
          if (el.disabled) return;
          var v = el.getAttribute("data-value");
          selDur = v || "";
          selHalf = "";
          if (v === "full") {
            finishAndClose();
          } else if (v === "half") {
            showStep("half");
          }
        });
      });
      var backWd = stepDur.querySelector(".tr-schedule-back");
      if (backWd) {
        backWd.addEventListener("click", function () {
          restoreAvailabilityUi();
          selDay = "";
          selDur = "";
          selHalf = "";
          showStep("weekday");
        });
      }
    }

    if (stepHalf) {
      stepHalf.querySelectorAll("button[data-value]").forEach(function (el) {
        el.addEventListener("click", function () {
          if (el.disabled) return;
          selHalf = el.getAttribute("data-value") || "";
          finishAndClose();
        });
      });
      var backDur = stepHalf.querySelector(".tr-schedule-back");
      if (backDur) {
        backDur.addEventListener("click", function () {
          selHalf = "";
          showStep("duration");
        });
      }
    }

    if (cmEl) {
      cmEl.addEventListener("input", function () {
        updatePricingTotals();
      });
    }

    refreshTriggerDisplay();
  })();

  (function validateTreatmentRoomSchedule() {
    var form = document.querySelector('form[name="treatment-room"]');
    if (!form) return;
    form.addEventListener("submit", function (e) {
      var wd = document.getElementById("tr-inp-weekday");
      var dur = document.getElementById("tr-inp-duration");
      var half = document.getElementById("tr-inp-half-period");
      if (!wd || !dur || !half) return;
      var wdTrim = wd.value.trim();
      var ok = false;
      if (!wdTrim || !dur.value) {
        ok = false;
      } else if (wdTrim === "Saturday") {
        ok = false;
      } else if (wdTrim === "Friday") {
        ok = dur.value === "half_day" && half.value === "morning_9am_2pm";
      } else if (dur.value === "full_day") {
        ok = true;
      } else if (dur.value === "half_day") {
        ok = half.value === "morning_9am_2pm" || half.value === "evening_3pm_8pm";
      }
      if (!ok) {
        e.preventDefault();
        alert(
          wdTrim === "Saturday"
            ? "Saturday is not available for recurring weekday rentals—please choose another day."
            : wdTrim === "Friday"
              ? "Friday is only offered as a morning half-day—please confirm Morning (9:00 AM – 2:00 PM)."
              : "Please choose a weekday, full day or half day, and—if half day—a morning or evening window.",
        );
      }
    });
  })();

  (function wireNetlifyFormSentFlags() {
    var fc = document.querySelector('form[name="contact"]');
    if (fc) {
      fc.addEventListener("submit", function () {
        try {
          sessionStorage.setItem("amare-form-sent-contact", "1");
        } catch (e) {}
      });
    }
    var fp = document.querySelector('form[name="private-events"]');
    if (fp) {
      fp.addEventListener("submit", function () {
        try {
          sessionStorage.setItem("amare-form-sent-private-events", "1");
        } catch (e) {}
      });
    }
    var ft = document.querySelector('form[name="treatment-room"]');
    if (ft) {
      ft.addEventListener("submit", function () {
        try {
          sessionStorage.setItem("amare-form-sent-treatment-room", "1");
        } catch (e) {}
      });
    }
  })();

  (function initNetlifyFormSuccess() {
    try {
      var path = window.location.pathname.replace(/\/$/, "") || "/";
      var dlgId = null;
      var bannerId = null;
      var storageKey = null;
      var leadFormName = null;
      if (path.endsWith("contact.html") || path === "/contact") {
        dlgId = "contact-success-dialog";
        bannerId = "contact-sent-banner";
        storageKey = "amare-form-sent-contact";
        leadFormName = "contact";
      } else if (path.endsWith("privateevents.html") || path === "/privateevents") {
        dlgId = "private-events-success-dialog";
        bannerId = "private-events-sent-banner";
        storageKey = "amare-form-sent-private-events";
        leadFormName = "private_events";
      } else if (path.endsWith("treatment-room.html") || path === "/treatment-room") {
        dlgId = "treatment-room-success-dialog";
        bannerId = "treatment-room-sent-banner";
        storageKey = "amare-form-sent-treatment-room";
        leadFormName = "treatment_room";
      } else {
        return;
      }

      var params = new URLSearchParams(window.location.search);
      var fromQuery = params.get("sent") === "1";
      var fromStorage = false;
      try {
        fromStorage = Boolean(storageKey && sessionStorage.getItem(storageKey) === "1");
      } catch (err) {
        fromStorage = false;
      }

      if (!fromQuery && !fromStorage) return;

      try {
        if (storageKey) sessionStorage.removeItem(storageKey);
      } catch (e2) {}

      var banner = document.getElementById(bannerId);
      if (banner) {
        banner.hidden = false;
      }

      if (leadFormName) {
        trackEvent("lead_submit", { form_name: leadFormName });
      }

      function cleanUrl() {
        window.history.replaceState(null, "", path + (window.location.hash || ""));
      }

      var dlg = document.getElementById(dlgId);
      if (dlg && typeof dlg.showModal === "function") {
        var ok = dlg.querySelector(".form-sent-dialog__ok");
        if (ok) {
          ok.addEventListener("click", function () {
            dlg.close();
          });
        }
        try {
          dlg.showModal();
        } catch (err) {
          /* dialog may fail in locked-down embeds — banner still visible */
        }
      }

      cleanUrl();
      window.scrollTo(0, 0);
    } catch (e) {}
  })();

  if (window.AMARE_GA4_ID) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(window.AMARE_GA4_ID);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() {
      dataLayer.push(arguments);
    }
    gtag("js", new Date());
    gtag("config", window.AMARE_GA4_ID, { anonymize_ip: true });
  }
})();
