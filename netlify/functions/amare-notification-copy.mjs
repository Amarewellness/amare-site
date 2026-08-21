/**
 * V1 push copy. Uses only supplied state. Does not invent instructor or time.
 */

export const CANDIDATE_PREF_MAP = Object.freeze({
  booking_created: "class_booking_updates",
  booking_cancelled: "class_booking_updates",
  class_cancelled: "class_booking_updates",
  class_time_changed: "class_booking_updates",
  waitlist_joined: "waitlist_updates",
  waitlist_removed: "waitlist_updates",
  waitlist_promoted: "waitlist_updates",
  class_reminder_due: "class_reminders",
  class_reminder: "class_reminders",
  studio_news: "studio_news",
});

const TZ = "America/New_York";

function text(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

export function formatClassWhen(isoLike) {
  const raw = text(isoLike);
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

export function formatClassTimeOnly(isoLike) {
  const raw = text(isoLike);
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function className(payload = {}) {
  return text(payload.className || payload.classTitle || payload.name);
}

function startAt(payload = {}) {
  return text(payload.classStartAt || payload.startAt || payload.classStartDateTime);
}

function joinParts(parts) {
  return parts.filter(Boolean).join(" · ");
}

export function reminderLeadLabel(payload = {}) {
  const n = Number(payload.leadMinutes);
  if (Number.isFinite(n) && n > 0) {
    if (n % 60 === 0) {
      const hours = n / 60;
      return hours === 1 ? "1 hour" : `${hours} hours`;
    }
    return `${n} minutes`;
  }
  return "";
}

export function pushPathForCandidate(kind, payload = {}) {
  const classId = payload.classId != null && /^\d{1,12}$/.test(String(payload.classId)) ? String(payload.classId) : "";
  const classQ = classId ? `&classId=${classId}` : "";
  if (kind === "waitlist_joined" || kind === "waitlist_removed") {
    return `/my-classes?section=waitlist${classQ}`;
  }
  // waitlist_promoted is a booking: Upcoming, never Waitlist.
  return `/my-classes?section=upcoming${classQ}`;
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} [payload]
 */
export function renderPushCopy(kind, payload = {}) {
  const name = className(payload);
  const when = formatClassWhen(startAt(payload));
  const newTime = formatClassTimeOnly(payload.startAt || payload.newStartAt || payload.classStartAt);
  const titleClass = name || "your class";

  if (kind === "booking_created") {
    return { title: "You're booked ✨", body: joinParts([titleClass, when]) };
  }
  if (kind === "booking_cancelled") {
    return { title: "Booking cancelled", body: `Your reservation for ${titleClass} has been cancelled.` };
  }
  if (kind === "waitlist_joined") {
    return { title: "You're on the waitlist", body: joinParts([name, when]) || "You’re on the waitlist." };
  }
  if (kind === "waitlist_removed") {
    return { title: "Waitlist update", body: joinParts([name, when]) || "You’re no longer on the waitlist." };
  }
  if (kind === "waitlist_promoted") {
    return {
      title: "You're in",
      body: name ? `A spot opened in ${name}. You're now booked.` : "A spot opened. You're now booked.",
    };
  }
  if (kind === "class_cancelled") {
    return { title: "Class cancelled", body: joinParts([name, when]) || "A class you booked was cancelled." };
  }
  if (kind === "class_time_changed") {
    return {
      title: "Class time changed",
      body: newTime ? `${titleClass} is now at ${newTime}` : `${titleClass} has a new time.`,
    };
  }
  if (kind === "class_reminder_due" || kind === "class_reminder") {
    return { title: "Class tomorrow ✨", body: joinParts([titleClass, when]) };
  }
  return { title: "AMARÉ", body: name || "You have a studio update." };
}
