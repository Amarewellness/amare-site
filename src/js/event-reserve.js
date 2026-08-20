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
  var lockedWhenEl = form.querySelector("[data-er-locked-when]");
  var offerToken = "";
  try {
    offerToken = new URL(window.location.href).searchParams.get("o") || "";
  } catch (e) {
    offerToken = "";
  }

  var PACKAGE = 55000;
  var DEPOSIT = 20000;
  var CLEANING = 0;
  var SCHEDULE = { beforeMinutes: 30, sessionMinutes: 60, afterMinutes: 30, sessionLabel: "Workout" };
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
      scheduleEl.classList.remove("event-reserve-form__schedule--timeline");
      scheduleEl.textContent = "Choose a start time to see the event schedule.";
      return;
    }
    var sessionStart = eventTime;
    var blocks = [];
    if (SCHEDULE.beforeMinutes > 0) {
      var beforeStart = addMinutesHhmm(sessionStart, -SCHEDULE.beforeMinutes);
      blocks.push({ label: "Before", start: beforeStart, end: sessionStart, copy: "Setup and decorate — you’ll have the room before the main session starts." });
    }
    var sessionEnd = addMinutesHhmm(sessionStart, SCHEDULE.sessionMinutes);
    var sessionCopy = /rental|studio/i.test(SCHEDULE.sessionLabel)
      ? "You’ll have the studio for this block."
      : "A fun class with one of our instructors.";
    blocks.push({ label: SCHEDULE.sessionLabel, start: sessionStart, end: sessionEnd, copy: sessionCopy });
    if (SCHEDULE.afterMinutes > 0) {
      var afterEnd = addMinutesHhmm(sessionEnd, SCHEDULE.afterMinutes);
      blocks.push({ label: "After", start: sessionEnd, end: afterEnd, copy: "Pictures, mingling, cake, and enjoying the moment." });
    }
    scheduleEl.classList.add("event-reserve-form__schedule--timeline");
    scheduleEl.innerHTML =
      '<ol class="event-info-timeline">' +
      blocks.map(function (block) {
        return '<li class="event-info-timeline__step">' +
          '<p class="event-info-timeline__time">' + formatClock(block.start) + "–" + formatClock(block.end) + "</p>" +
          '<p class="event-info-timeline__phase">' + escapeHtml(block.label) + "</p>" +
          '<p class="event-info-timeline__copy">' + escapeHtml(block.copy) + "</p></li>";
      }).join("") +
      "</ol>";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
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
    var total = PACKAGE + style + CLEANING;
    var remaining = total - DEPOSIT;
    var who = roomLabel(room) + " · " + g + (g === 1 ? " guest" : " guests");
    var lines =
      '<p class="event-reserve-form__schedule-line">' +
      who +
      (style ? " · styling " + money(style) : "") +
      (CLEANING ? " · cleaning " + money(CLEANING) : "") +
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

  function monthLabel(mm) {
    var names = [
      "",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    var n = parseInt(mm, 10);
    return names[n] || mm;
  }

  function setPicker(inp, btnId, label) {
    if (inp && label != null) inp.value = String(inp.value || "");
    var btn = document.getElementById(btnId);
    if (!btn) return;
    var span = btn.querySelector(".pe-picker__value");
    if (span && label) {
      span.textContent = label;
      btn.classList.remove("pe-picker__trigger--empty");
    }
  }

  function lockPicker(btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.classList.add("pe-picker__trigger--locked");
  }

  function setField(id, value, locked) {
    var node = document.getElementById(id);
    if (!node) return;
    if (value) node.value = value;
    if (locked) {
      node.readOnly = true;
      if (node.tagName === "SELECT") {
        node.disabled = true;
        var hiddenName = node.getAttribute("name");
        if (hiddenName && form) {
          var existing = form.querySelector('input[type="hidden"][data-er-locked-hidden="' + hiddenName + '"]');
          if (!existing) {
            existing = document.createElement("input");
            existing.type = "hidden";
            existing.name = hiddenName;
            existing.setAttribute("data-er-locked-hidden", hiddenName);
            node.insertAdjacentElement("afterend", existing);
          }
          existing.value = node.value;
        }
      }
      node.classList.add("event-reserve-form__locked-input");
    }
  }

  function fillPagePrices() {
    var pkg = money(PACKAGE);
    var dep = money(DEPOSIT);
    var rem = money(Math.max(PACKAGE + CLEANING - DEPOSIT, 0));
    document.querySelectorAll("[data-er-page-package]").forEach(function (n) {
      n.textContent = pkg;
    });
    document.querySelectorAll("[data-er-page-deposit]").forEach(function (n) {
      n.textContent = dep;
    });
    document.querySelectorAll("[data-er-page-remaining]").forEach(function (n) {
      n.textContent = rem;
    });
    var ex = document.querySelector("[data-er-page-example]");
    if (ex) {
      var style = STYLING_REFORMER;
      ex.textContent =
        "Example: Reformer package + styling is " +
        money(PACKAGE + style + CLEANING) +
        " total — " +
        dep +
        " to reserve, " +
        money(PACKAGE + style + CLEANING - DEPOSIT) +
        " the day before.";
    }
  }

  function applyOffer(offer) {
    setField("er-first-name", offer.firstName || "", offer.lockName === true);
    setField("er-last-name", offer.lastName || "", offer.lockName === true);
    setField("er-email", offer.email || "", offer.lockEmail === true);
    setField("er-phone", offer.phone || "", offer.lockPhone === true);
    var ymd = String(offer.eventDate || "");
    var parts = ymd.split("-");
    if (parts.length === 3 && inpYear && inpMonth && inpDay) {
      inpYear.value = parts[0];
      inpMonth.value = parts[1];
      inpDay.value = String(parseInt(parts[2], 10));
      setPicker(inpYear, "pe-btn-year", parts[0]);
      setPicker(inpMonth, "pe-btn-month", monthLabel(parts[1]));
      setPicker(inpDay, "pe-btn-day", String(parseInt(parts[2], 10)));
    }
    if (offer.eventTime && inpTime) {
      inpTime.value = offer.eventTime;
      setPicker(inpTime, "pe-btn-time", formatClock(offer.eventTime));
    }
    if (offer.guests) setField("er-guests", String(offer.guests), offer.lockGuestsRoom === true);
    if (offer.room) setField("er-room", String(offer.room), offer.lockGuestsRoom === true);
    var lockedPartyEl = form.querySelector("[data-er-locked-party]");
    if (offer.lockGuestsRoom && lockedPartyEl) {
      var roomNames = { auto: "auto by guest count", reformer: "Reformer", mat: "Mat", kangoo: "Kangoo Jump" };
      var roomName = roomNames[String(offer.room || "auto")] || String(offer.room || "auto");
      lockedPartyEl.hidden = false;
      lockedPartyEl.textContent =
        "Guests and room are set: " +
        String(offer.guests || "") +
        " guests, " +
        roomName +
        ". Contact the studio if you need to change them.";
    }
    if (Number(offer.packageCents) > 0) PACKAGE = Number(offer.packageCents);
    if (Number(offer.depositCents) > 0) DEPOSIT = Number(offer.depositCents);
    CLEANING = Number.isInteger(Number(offer.cleaningCents)) && Number(offer.cleaningCents) > 0 ? Number(offer.cleaningCents) : 0;
    if (offer.schedule && typeof offer.schedule === "object") {
      var before = Number(offer.schedule.beforeMinutes);
      var session = Number(offer.schedule.sessionMinutes);
      var after = Number(offer.schedule.afterMinutes);
      SCHEDULE = {
        beforeMinutes: before === 0 || before > 0 ? before : 30,
        sessionMinutes: session > 0 ? session : 60,
        afterMinutes: after === 0 || after > 0 ? after : 30,
        sessionLabel: String(offer.schedule.sessionLabel || "Workout"),
      };
    }
    if (submitBtn) submitBtn.textContent = "Pay " + money(DEPOSIT) + " deposit";
    fillPagePrices();
    if (offer.lockDateTime) {
      lockPicker("pe-btn-month");
      lockPicker("pe-btn-day");
      lockPicker("pe-btn-year");
      lockPicker("pe-btn-time");
      var dt = form.querySelector("[data-er-datetime]");
      if (dt) dt.hidden = true;
      if (lockedWhenEl && ymd && offer.eventTime) {
        lockedWhenEl.hidden = false;
        lockedWhenEl.textContent =
          "Your date and start time are set: " +
          formatClock(offer.eventTime) +
          " on " +
          monthLabel(parts[1]) +
          " " +
          String(parseInt(parts[2], 10)) +
          ", " +
          parts[0] +
          ". Contact the studio if you need to change them.";
      }
    }
    refresh();
  }

  if (offerToken) {
    fetch("/api/events/offer?o=" + encodeURIComponent(offerToken), {
      headers: { "ngrok-skip-browser-warning": "1" },
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data || {} };
        });
      })
      .then(function (out) {
        if (out.data && out.data.ok && out.data.offer) {
          applyOffer(out.data.offer);
          window.setTimeout(function () {
            applyOffer(out.data.offer);
          }, 50);
          window.setTimeout(function () {
            applyOffer(out.data.offer);
          }, 400);
          return;
        }
        showError((out.data && out.data.message) || "This booking link is not valid.");
        if (submitBtn) submitBtn.disabled = true;
      })
      .catch(function () {
        showError("Could not load this booking link. Please try again.");
      });
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
    if (offerToken) payload.offerId = offerToken;
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
          submitBtn.textContent = "Pay " + money(DEPOSIT) + " deposit";
        }
      })
      .catch(function () {
        showError("Could not start checkout. Please try again, or send an inquiry.");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Pay " + money(DEPOSIT) + " deposit";
        }
      });
  });
})();
