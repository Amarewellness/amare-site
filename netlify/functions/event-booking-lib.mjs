/**
 * Private-event pricing and reservation validation.
 * Source of truth for deposit / package / styling — never trust amounts from the browser.
 */

export const EVENT_PACKAGE_CENTS = 55000;
export const EVENT_DEPOSIT_CENTS = 20000;
export const EVENT_STYLING_REFORMER_CENTS = 15000;
export const EVENT_STYLING_MAT_CENTS = 20000;
export const EVENT_OVERTIME_BLOCK_CENTS = 5000;
export const EVENT_OVERTIME_MAX_MINUTES = 240;
export const EVENT_CURRENCY = "usd";

/**
 * Extra time is $50 per 30 minutes, from 30 up to 4 hours.
 * @param {unknown} raw
 * @returns {{ ok: true, minutes: number, cents: number } | { ok: false, error: string, message: string }}
 */
export function parseEventOvertimeMinutes(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isInteger(n) || n < 30 || n > EVENT_OVERTIME_MAX_MINUTES || n % 30 !== 0) {
    return {
      ok: false,
      error: "invalid_minutes",
      message: "Extra time must be 30–240 minutes in 30-minute steps.",
    };
  }
  return { ok: true, minutes: n, cents: (n / 30) * EVENT_OVERTIME_BLOCK_CENTS };
}

export const EVENT_CUSTOM_CHARGE_MIN_CENTS = 100;
export const EVENT_CUSTOM_CHARGE_MAX_CENTS = 200000;
export const EVENT_PACKAGE_MIN_CENTS = 100;
export const EVENT_PACKAGE_MAX_CENTS = 500000;
export const EVENT_DEPOSIT_MIN_CENTS = 100;
export const EVENT_CLEANING_MAX_CENTS = 200000;
export const EVENT_SESSION_MAX_MINUTES = 480;

/** @typedef {{ beforeMinutes: number, sessionMinutes: number, afterMinutes: number, sessionLabel: string }} EventSchedule */

export const DEFAULT_EVENT_SCHEDULE = Object.freeze({
  beforeMinutes: 30,
  sessionMinutes: 60,
  afterMinutes: 30,
  sessionLabel: "Workout",
});

/**
 * Admin-entered package / deposit dollars → cents.
 * @param {unknown} raw
 * @param {number} minCents
 * @param {number} maxCents
 * @returns {{ ok: true, cents: number } | { ok: false, error: string, message: string }}
 */
export function parseEventUsdToCents(raw, minCents, maxCents) {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim().replace(/[$,]/g, ""))
        : NaN;
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: "invalid_amount", message: "Enter a dollar amount of 0 or more." };
  }
  const cents = Math.round(n * 100);
  if (cents < minCents || cents > maxCents) {
    return {
      ok: false,
      error: "invalid_amount",
      message: `Amount must be between ${formatUsd(minCents)} and ${formatUsd(maxCents)}.`,
    };
  }
  return { ok: true, cents };
}

/**
 * @param {{ depositCents?: number, depositPaid?: boolean, remainingPaid?: boolean, stripeCheckoutSessionId?: string, status?: string }} rec
 */
export function reservationDepositPaid(rec) {
  if (!rec || !Number(rec.depositCents)) return false;
  if (rec.remainingPaid === true) return true;
  if (rec.depositPaid === true) return true;
  if (rec.depositPaid === false) return false;
  if (rec.stripeCheckoutSessionId) return true;
  if (rec.manualEntry === true) return false;
  return rec.status === "deposit_paid_pending_confirm" || rec.status === "confirmed";
}

/**
 * Staff-entered extra charge (styling upgrade, merch, etc.).
 * @param {unknown} amountRaw
 * @param {unknown} descriptionRaw
 * @returns {{ ok: true, cents: number, description: string } | { ok: false, error: string, message: string }}
 */
export function parseEventCustomCharge(amountRaw, descriptionRaw) {
  const description = eventSafeStr(descriptionRaw, 80);
  if (description.length < 2) {
    return { ok: false, error: "invalid_description", message: "Enter a short description (at least 2 characters)." };
  }
  const n =
    typeof amountRaw === "number"
      ? amountRaw
      : typeof amountRaw === "string"
        ? Number(amountRaw.trim().replace(/[$,]/g, ""))
        : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "invalid_amount", message: "Enter a dollar amount greater than 0." };
  }
  const cents = Math.round(n * 100);
  if (cents < EVENT_CUSTOM_CHARGE_MIN_CENTS || cents > EVENT_CUSTOM_CHARGE_MAX_CENTS) {
    return {
      ok: false,
      error: "invalid_amount",
      message: "Amount must be between $1.00 and $2,000.00.",
    };
  }
  return { ok: true, cents, description };
}

export const EVENT_CONSENT_TEXT =
  "I authorize AMARÉ Wellness Studio to charge this card for the remaining event balance the day before the event, and $50 for every extra 30 minutes beyond the booked time.";

export const EVENT_ROOMS = /** @type {const} */ (["reformer", "mat", "kangoo"]);

const STUDIO_TZ = "America/New_York";

/** @param {unknown} v @param {number} max */
export function eventSafeStr(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/** Internal staff notes. Preserves line breaks. Never emailed. */
export function eventStaffNotes(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n/g, "\n").trim().slice(0, 2000);
}

/** @param {string} email */
export function eventIsReasonableEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email);
}

/** @param {string} hhmm */
export function isAllowedEventTime(hhmm) {
  if (!/^(?:[01]\d|2[0-3]):[03]0$/.test(hhmm)) return false;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const minutes = h * 60 + m;
  return minutes >= 8 * 60 && minutes <= 22 * 60;
}

/** Today's calendar date in America/New_York as YYYY-MM-DD. */
export function todayEtYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const num = (/** @type {string} */ typ) => parts.find((p) => p.type === typ)?.value || "";
  return `${num("year")}-${num("month")}-${num("day")}`;
}

/**
 * @param {string} ymd
 * @returns {number | null} 0=Sun … 6=Sat, or null if invalid
 */
export function weekdayUtcNoon(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getUTCDay();
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, guests: number } | { ok: false, error: string }}
 */
export function parseGuestCount(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 17) return { ok: false, error: "invalid_guests" };
  return { ok: true, guests: Math.trunc(n) };
}

/**
 * @param {number} guests
 * @param {string} requested
 * @returns {{ ok: true, room: "reformer"|"mat"|"kangoo" } | { ok: false, error: string, message: string }}
 */
export function resolveEventRoom(guests, requested) {
  const want = String(requested || "auto").trim().toLowerCase();
  if (want === "kangoo") {
    if (guests > 10) {
      return { ok: false, error: "room_capacity", message: "Kangoo Jump events are limited to 10 participants." };
    }
    return { ok: true, room: "kangoo" };
  }
  if (want === "reformer") {
    if (guests > 9) {
      return { ok: false, error: "room_capacity", message: "The Reformer room holds up to 9 guests." };
    }
    return { ok: true, room: "reformer" };
  }
  if (want === "mat") {
    if (guests > 17) {
      return { ok: false, error: "room_capacity", message: "The Mat room holds up to 17 guests." };
    }
    return { ok: true, room: "mat" };
  }
  if (guests <= 9) return { ok: true, room: "reformer" };
  return { ok: true, room: "mat" };
}

/**
 * @param {"reformer"|"mat"|"kangoo"} room
 * @param {boolean} styling
 */
/**
 * @param {string} eventDate
 * @param {string} eventTime
 * @param {{ allowPast?: boolean }} [opts]
 * @returns {{ ok: true, eventDate: string, eventTime: string } | { ok: false, error: string, message: string }}
 */
export function validateEventDateTime(eventDate, eventTime, opts) {
  const date = eventSafeStr(eventDate, 10);
  const time = eventSafeStr(eventTime, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "invalid_date", message: "Please choose an event date." };
  }
  const dow = weekdayUtcNoon(date);
  if (dow == null) {
    return { ok: false, error: "invalid_date", message: "Please choose a valid event date." };
  }
  if (dow === 6) {
    return { ok: false, error: "studio_closed", message: "We’re closed on Saturdays. Please pick Sunday through Friday." };
  }
  if (!opts?.allowPast && date < todayEtYmd()) {
    return { ok: false, error: "date_in_past", message: "Please choose a future date." };
  }
  if (!isAllowedEventTime(time)) {
    return { ok: false, error: "invalid_time", message: "Please choose a start time between 8:00 AM and 10:00 PM." };
  }
  if (dow === 5) {
    const [fh, fm] = time.split(":").map((n) => parseInt(n, 10));
    if (fh * 60 + fm > 16 * 60) {
      return { ok: false, error: "friday_hours", message: "Friday events start by 4:00 PM." };
    }
  }
  return { ok: true, eventDate: date, eventTime: time };
}

export function stylingCentsForRoom(room, styling) {
  if (!styling) return 0;
  if (room === "reformer") return EVENT_STYLING_REFORMER_CENTS;
  if (room === "mat") return EVENT_STYLING_MAT_CENTS;
  return 0;
}

/**
 * @param {object} body
 * @returns {{
 *   ok: true,
 *   firstName: string,
 *   lastName: string,
 *   email: string,
 *   phone: string,
 *   eventDate: string,
 *   eventTime: string,
 *   guests: number,
 *   room: "reformer"|"mat"|"kangoo",
 *   styling: boolean,
 *   stylingCents: number,
 *   remainingCents: number,
 *   packageCents: number,
 *   depositCents: number,
 *   cleaningCents: number,
 * } | { ok: false, error: string, message: string }}
 * @param {{ packageCents?: number, depositCents?: number, cleaningCents?: number }} [priceOverride]
 */
export function validateEventReservationInput(body, priceOverride) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body", message: "Please check the form and try again." };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const firstName = eventSafeStr(b.firstName, 80);
  const lastName = eventSafeStr(b.lastName, 80);
  const email = eventSafeStr(b.email, 254).toLowerCase();
  const phone = eventSafeStr(b.phone, 32);
  const eventDate = eventSafeStr(b.eventDate, 10);
  const eventTime = eventSafeStr(b.eventTime, 5);
  const consent = b.consent === true || b.consent === "1" || b.consent === "true";
  const styling = b.styling === true || b.styling === "1" || b.styling === "true";

  if (!firstName || !lastName) {
    return { ok: false, error: "invalid_name", message: "Please enter your first and last name." };
  }
  if (!eventIsReasonableEmail(email)) {
    return { ok: false, error: "invalid_email", message: "Please enter a valid email." };
  }
  if (!consent) {
    return {
      ok: false,
      error: "consent_required",
      message: "Please confirm you authorize the remaining balance and extra-time charges.",
    };
  }
  const whenOk = validateEventDateTime(eventDate, eventTime);
  if (!whenOk.ok) return whenOk;

  const guestsParsed = parseGuestCount(b.guests);
  if (!guestsParsed.ok) {
    return { ok: false, error: "invalid_guests", message: "Please enter a guest count between 1 and 17." };
  }
  const roomResolved = resolveEventRoom(guestsParsed.guests, eventSafeStr(b.room, 16));
  if (!roomResolved.ok) return roomResolved;

  if (styling && roomResolved.room === "kangoo") {
    return {
      ok: false,
      error: "styling_unavailable",
      message: "Room styling is available for Reformer and Mat events.",
    };
  }

  const stylingCents = stylingCentsForRoom(roomResolved.room, styling);
  const packageCents =
    Number.isInteger(priceOverride?.packageCents) && (priceOverride?.packageCents || 0) > 0
      ? /** @type {number} */ (priceOverride.packageCents)
      : EVENT_PACKAGE_CENTS;
  const depositCents =
    Number.isInteger(priceOverride?.depositCents) && (priceOverride?.depositCents || 0) > 0
      ? /** @type {number} */ (priceOverride.depositCents)
      : EVENT_DEPOSIT_CENTS;
  const cleaningCents =
    Number.isInteger(priceOverride?.cleaningCents) && (priceOverride?.cleaningCents || 0) > 0
      ? /** @type {number} */ (priceOverride.cleaningCents)
      : 0;
  const remainingCents = packageCents + stylingCents + cleaningCents - depositCents;
  if (remainingCents < 0) {
    return { ok: false, error: "invalid_totals", message: "Deposit cannot exceed package + styling + cleaning." };
  }

  return {
    ok: true,
    firstName,
    lastName,
    email,
    phone,
    eventDate,
    eventTime,
    guests: guestsParsed.guests,
    room: roomResolved.room,
    styling,
    stylingCents,
    remainingCents,
    packageCents,
    depositCents,
    cleaningCents,
  };
}

/** @param {number} cents */
export function formatUsd(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** @param {"reformer"|"mat"|"kangoo"} room */
export function roomLabel(room) {
  if (room === "reformer") return "Reformer room";
  if (room === "mat") return "Mat room";
  return "Kangoo Jump";
}

/** @param {string} hhmm @param {number} deltaMinutes */
export function addMinutesHhmm(hhmm, deltaMinutes) {
  const [h, mi] = String(hhmm || "00:00")
    .split(":")
    .map((n) => parseInt(n, 10));
  const start = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(mi) ? mi : 0);
  const total = ((start + deltaMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

/** @param {string} hhmm */
export function formatEventClock(hhmm) {
  const [h, mi] = String(hhmm || "00:00")
    .split(":")
    .map((n) => parseInt(n, 10));
  const hour = Number.isFinite(h) ? h : 0;
  const min = Number.isFinite(mi) ? mi : 0;
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/** @param {string} ymd @param {string} hhmm */
export function formatEventWhen(ymd, hhmm) {
  const [y, mo, d] = ymd.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d, 16, 0, 0));
  const dateLine = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(dt);
  return { dateLine, timeLine: formatEventClock(hhmm) };
}

/**
 * @param {unknown} raw
 * @param {{ allowZero?: boolean, fallback?: number }} [opts]
 * @returns {{ ok: true, minutes: number } | { ok: false, error: string, message: string }}
 */
export function parseEventDurationMinutes(raw, opts = {}) {
  if (raw === "" || raw == null) {
    if (opts.fallback != null) return { ok: true, minutes: opts.fallback };
    return { ok: false, error: "invalid_duration", message: "Choose a duration." };
  }
  const n = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
  if (opts.allowZero && n === 0) return { ok: true, minutes: 0 };
  if (!Number.isInteger(n) || n < 30 || n > EVENT_SESSION_MAX_MINUTES || n % 30 !== 0) {
    return {
      ok: false,
      error: "invalid_duration",
      message: "Times must be 30-minute steps, from 30 minutes up to 8 hours.",
    };
  }
  return { ok: true, minutes: n };
}

/** @param {unknown} raw */
export function normalizeEventSchedule(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_EVENT_SCHEDULE };
  const src = /** @type {Record<string, unknown>} */ (raw);
  const before = Number(src.beforeMinutes);
  const session = Number(src.sessionMinutes);
  const after = Number(src.afterMinutes);
  const valid = (n) => Number.isInteger(n) && n >= 30 && n <= EVENT_SESSION_MAX_MINUTES && n % 30 === 0;
  return {
    beforeMinutes: before === 0 ? 0 : valid(before) ? before : DEFAULT_EVENT_SCHEDULE.beforeMinutes,
    sessionMinutes: valid(session) ? session : DEFAULT_EVENT_SCHEDULE.sessionMinutes,
    afterMinutes: after === 0 ? 0 : valid(after) ? after : DEFAULT_EVENT_SCHEDULE.afterMinutes,
    sessionLabel: eventSafeStr(src.sessionLabel, 40) || DEFAULT_EVENT_SCHEDULE.sessionLabel,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {{ ok: true, schedule: EventSchedule } | { ok: false, error: string, message: string }}
 */
export function parseEventScheduleInput(body) {
  const src =
    body && typeof body.schedule === "object" && body.schedule
      ? /** @type {Record<string, unknown>} */ (body.schedule)
      : body || {};
  const omitted =
    src.beforeMinutes == null && src.sessionMinutes == null && src.afterMinutes == null && !src.sessionLabel;
  if (omitted) return { ok: true, schedule: { ...DEFAULT_EVENT_SCHEDULE } };
  const before = parseEventDurationMinutes(src.beforeMinutes, { allowZero: true, fallback: 30 });
  if (!before.ok) return before;
  const session = parseEventDurationMinutes(src.sessionMinutes, { fallback: 60 });
  if (!session.ok) return session;
  const after = parseEventDurationMinutes(src.afterMinutes, { allowZero: true, fallback: 30 });
  if (!after.ok) return after;
  return {
    ok: true,
    schedule: {
      beforeMinutes: before.minutes,
      sessionMinutes: session.minutes,
      afterMinutes: after.minutes,
      sessionLabel: eventSafeStr(src.sessionLabel, 40) || "Workout",
    },
  };
}

/**
 * @param {unknown} raw
 * @param {boolean} [enabled]
 * @returns {{ ok: true, cents: number } | { ok: false, error: string, message: string }}
 */
export function parseEventCleaningCents(raw, enabled) {
  if (enabled === false) return { ok: true, cents: 0 };
  if (raw == null || raw === "" || raw === 0 || raw === "0") {
    if (enabled === true) {
      return { ok: false, error: "invalid_cleaning", message: "Enter a cleaning fee amount." };
    }
    return { ok: true, cents: 0 };
  }
  const parsed = parseEventUsdToCents(raw, 100, EVENT_CLEANING_MAX_CENTS);
  if (!parsed.ok) return { ok: false, error: "invalid_cleaning", message: `Cleaning fee: ${parsed.message}` };
  return parsed;
}

/** @param {string} label */
function sessionCopyForLabel(label) {
  const l = String(label || "").toLowerCase();
  if (l.includes("rental") || l.includes("studio")) return "You’ll have the studio for this block.";
  return "A fun class with one of our instructors.";
}

/**
 * `hhmm` is session start. Before is subtracted; after follows the session.
 * @param {string} hhmm
 * @param {unknown} [schedule]
 */
export function eventScheduleBlocks(hhmm, schedule) {
  const s = normalizeEventSchedule(schedule);
  /** @type {{ kind: "before"|"session"|"after", label: string, copy: string, startHhmm: string, endHhmm: string, start: string, end: string }[]} */
  const blocks = [];
  const sessionStart = hhmm;
  if (s.beforeMinutes > 0) {
    const beforeStart = addMinutesHhmm(sessionStart, -s.beforeMinutes);
    blocks.push({
      kind: "before",
      label: "Before",
      copy: "Setup and decorate — you’ll have the room before the main session starts.",
      startHhmm: beforeStart,
      endHhmm: sessionStart,
      start: formatEventClock(beforeStart),
      end: formatEventClock(sessionStart),
    });
  }
  const sessionEnd = addMinutesHhmm(sessionStart, s.sessionMinutes);
  blocks.push({
    kind: "session",
    label: s.sessionLabel || "Workout",
    copy: sessionCopyForLabel(s.sessionLabel),
    startHhmm: sessionStart,
    endHhmm: sessionEnd,
    start: formatEventClock(sessionStart),
    end: formatEventClock(sessionEnd),
  });
  if (s.afterMinutes > 0) {
    const afterEnd = addMinutesHhmm(sessionEnd, s.afterMinutes);
    blocks.push({
      kind: "after",
      label: "After",
      copy: "Pictures, mingling, cake, and enjoying the moment.",
      startHhmm: sessionEnd,
      endHhmm: afterEnd,
      start: formatEventClock(sessionEnd),
      end: formatEventClock(afterEnd),
    });
  }
  return { schedule: s, blocks };
}

/**
 * Booked start = session start. Before is earlier; after follows the session.
 * @param {string} ymd
 * @param {string} hhmm
 * @param {unknown} [schedule]
 */
export function formatEventSchedule(ymd, hhmm, schedule) {
  const when = formatEventWhen(ymd, hhmm);
  const { blocks, schedule: s } = eventScheduleBlocks(hhmm, schedule);
  const first = blocks[0];
  const session = blocks.find((b) => b.kind === "session") || first;
  const last = blocks[blocks.length - 1];
  const rangeLine = blocks.map((b) => `${b.label} ${b.start}–${b.end}`).join(" · ");
  return {
    ...when,
    schedule: s,
    blocks,
    arrival: first?.start || when.timeLine,
    classStart: session?.start || when.timeLine,
    classEnd: session?.end || when.timeLine,
    afterEnd: last?.end || session?.end || when.timeLine,
    rangeLine,
  };
}
