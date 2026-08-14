/**
 * /event-info — private event deposit form → Stripe Checkout.
 */
(function eventReserveBootstrap() {
  var form = document.getElementById("event-reserve-form");
  if (!form) return;

  var inpMonth = document.getElementById("pe-inp-month");
  var inpDay = document.getElementById("pe-inp-day");
  var inpYear = document.getElementById("pe-inp-year");
  var inpTime = document.getElementById("pe-inp-time");
  var guestsEl = document.getElementById("er-guests");
  var roomEl = document.getElementById("er-room");
  var stylingEl = document.getElementById("er-styling");
  var stylingWrap = form.querySelector("[data-er-styling-wrap]");
  var stylingPriceEl = form.querySelector("[data-er-styling-price]");
  var summaryEl = form.querySelector("[data-er-summary]");
  var scheduleEl = form.querySelector("[data-er-schedule]");
  var errorEl = form.querySelector("[data-er-error]");
  var submitBtn = form.querySelector("[data-er-submit]");

  var PACKAGE = 55000;
  var DEPOSIT = 20000;
  var STYLING_REFORMER = 15000;
  var STYLING_MAT = 20000;

  function money(cents) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  }

  function addMinutesHhmm(hhmm, delta) {
    var parts = String(hhmm || "00:00").split(":");
    var h = parseInt(parts[0], 10);
    var mi = parseInt(parts[1], 10);
    var total = ((h * 60 + mi + delta) % (24 * 60) + 24 * 60) % (24 * 60);
    var nh = Math.floor(total / 60);
    var nm = total % 60;
    return (nh < 10 ? "0" : "") + nh + ":" + (nm < 10 ? "0" : "") + nm;
  }

  function formatClock(hhmm) {
    var parts = String(hhmm || "00:00").split(":");
    var h = parseInt(parts[0], 10);
    var mi = parseInt(parts[1], 10);
    var h12 = ((h + 11) % 12) + 1;
    var ampm = h < 12 ? "AM" : "PM";
    return h12 + ":" + (mi < 10 ? "0" : "") + mi + " " + ampm;
  }

  function refreshSchedule() {
    if (!scheduleEl) return;
    var eventTime = readEventTime();
    if (!eventTime) {
      scheduleEl.textContent = "Choose a start time to see arrival, class, and after.";
      return;
    }
    var arrival = formatClock(addMinutesHhmm(eventTime, -30));
    var classStart = formatClock(eventTime);
    var classEnd = formatClock(addMinutesHhmm(eventTime, 60));
    var afterEnd = formatClock(addMinutesHhmm(eventTime, 90));
    scheduleEl.innerHTML =
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">Arrival</span> ' +
      arrival +
      " — 30 min before (setup)</p>" +
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">Class time</span> ' +
      classStart +
      "–" +
      classEnd +
      "</p>" +
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">After</span> ' +
      classEnd +
      "–" +
      afterEnd +
      " — pictures, mingling, cake</p>";
  }

  function readEventDate() {
    var y = inpYear && inpYear.value ? inpYear.value : "";
    var m = inpMonth && inpMonth.value ? inpMonth.value : "";
    var d = inpDay && inpDay.value ? inpDay.value : "";
    if (!y || !m || !d) return "";
    return y + "-" + m + "-" + String(d).padStart(2, "0");
  }

  function readEventTime() {
    return inpTime && inpTime.value ? inpTime.value : "";
  }

  function isSaturday(ymd) {
    if (!ymd) return false;
    var parts = ymd.split("-");
    if (parts.length !== 3) return false;
    var dt = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0));
    return dt.getUTCDay() === 6;
  }

  function guests() {
    var n = parseInt(guestsEl && guestsEl.value ? guestsEl.value : "", 10);
    return Number.isFinite(n) ? n : 0;
  }

  function resolvedRoom() {
    var want = roomEl && roomEl.value ? roomEl.value : "auto";
    var g = guests();
    if (want === "kangoo" || want === "reformer" || want === "mat") return want;
    if (g >= 10) return "mat";
    return "reformer";
  }

  function stylingCents(room) {
    if (!(stylingEl && stylingEl.checked)) return 0;
    if (room === "reformer") return STYLING_REFORMER;
    if (room === "mat") return STYLING_MAT;
    return 0;
  }

  function roomLabel(room) {
    if (room === "reformer") return "Reformer room";
    if (room === "mat") return "Mat room";
    return "Kangoo Jump";
  }

  function refresh() {
    var room = resolvedRoom();
    var g = guests();
    if (stylingWrap) {
      stylingWrap.hidden = room === "kangoo";
      if (room === "kangoo" && stylingEl) stylingEl.checked = false;
    }
    if (stylingPriceEl) {
      stylingPriceEl.textContent = room === "mat" ? "$200" : "$150";
    }
    if (!summaryEl) return;
    if (g < 1) {
      summaryEl.textContent = "Choose a date, guest count, and room to see the remaining balance.";
      refreshSchedule();
      return;
    }
    var style = stylingCents(room);
    var total = PACKAGE + style;
    var remaining = total - DEPOSIT;
    var who = roomLabel(room) + " · " + g + (g === 1 ? " guest" : " guests");
    var lines =
      '<p class="event-reserve-form__schedule-line">' +
      who +
      (style ? " · styling " + money(style) : "") +
      "</p>" +
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">Total</span> ' +
      money(total) +
      "</p>" +
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">Now</span> ' +
      money(DEPOSIT) +
      " deposit</p>" +
      '<p class="event-reserve-form__schedule-line"><span class="event-reserve-form__schedule-label">Day before</span> ' +
      money(remaining) +
      " after we confirm</p>" +
      '<p class="event-reserve-form__schedule-line event-reserve-form__summary-note">If we can’t confirm the date, the deposit is refunded.</p>';
    summaryEl.innerHTML = lines;
    refreshSchedule();
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.hidden = !msg;
    errorEl.textContent = msg || "";
  }

  function showBanner(id) {
    var el = document.getElementById(id);
    if (el) el.hidden = false;
  }

  try {
    var url = new URL(window.location.href);
    if (url.searchParams.get("reserved") === "1") showBanner("event-reserved-banner");
    if (url.searchParams.get("canceled") === "1") showBanner("event-canceled-banner");
  } catch (e) {
    /* ignore */
  }

  refresh();

  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    showError("");
    var eventDate = readEventDate();
    var eventTime = readEventTime();
    if (!eventDate || !eventTime) {
      showError("Please choose an event date and start time.");
      return;
    }
    if (isSaturday(eventDate)) {
      showError("We’re closed on Saturdays. Please pick Sunday through Friday.");
      return;
    }
    var parts = eventDate.split("-");
    var friday =
      parts.length === 3 &&
      new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0)).getUTCDay() === 5;
    if (friday) {
      var tp = eventTime.split(":");
      var mins = parseInt(tp[0], 10) * 60 + parseInt(tp[1], 10);
      if (mins > 16 * 60) {
        showError("Friday events start by 4:00 PM.");
        return;
      }
    }
    var consent = document.getElementById("er-consent");
    if (consent && !consent.checked) {
      showError("Please confirm you authorize the remaining balance and extra-time charges.");
      return;
    }
    var payload = {
      firstName: (document.getElementById("er-first-name") || {}).value || "",
      lastName: (document.getElementById("er-last-name") || {}).value || "",
      email: (document.getElementById("er-email") || {}).value || "",
      phone: (document.getElementById("er-phone") || {}).value || "",
      eventDate: eventDate,
      eventTime: eventTime,
      guests: guests(),
      room: roomEl ? roomEl.value : "auto",
      styling: !!(stylingEl && stylingEl.checked),
      consent: true,
    };
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Opening checkout…";
    }
    fetch("/api/stripe/events/create-deposit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "1",
      },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data || {} };
        });
      })
      .then(function (out) {
        if (out.data && out.data.ok && out.data.url) {
          window.location.href = out.data.url;
          return;
        }
        var msg =
          (out.data && out.data.message) ||
          "Could not start checkout. You can send an inquiry and we’ll follow up.";
        showError(msg);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Pay $200 deposit";
        }
      })
      .catch(function () {
        showError("Could not start checkout. Please try again, or send an inquiry.");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Pay $200 deposit";
        }
      });
  });
})();
