/**
 * Derive front-desk coverage hours from Mindbody class schedule for a week.
 */

import { getMindbodyStaffAccessTokenCached } from "./mindbody-consumer-lib.mjs";
import {
  mindbodyHeaders,
  mindbodyHost,
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { STUDIO_TZ, addDaysYmd, EARLY_MORNING_CLASS_CUTOFF, weekDatesFromStart } from "./staff-schedule-lib.mjs";

/** @param {string | null | undefined} isoLike */
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

/** @param {number} ms */
function formatYmdEt(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** @param {number} ms */
function formatHmEt(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${hh}:${mm}`;
}

/** @param {string} hm */
function parseHmToMinutes(hm) {
  const [h, m] = String(hm || "0:0").split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/** @returns {Promise<Record<string, string> | null>} */
async function resolveScheduleHeaders() {
  const base = mindbodyHeaders();
  if (!base) return null;

  const issued = await getMindbodyStaffAccessTokenCached();
  if (issued.ok) {
    const staff = mindbodyStaffBearerHeaders(issued.accessToken);
    if (staff) return staff;
  }

  const legacyStaff = mindbodyStaffApiHeaders();
  if (legacyStaff) return legacyStaff;

  return base;
}

/**
 * @typedef {Object} SlotCoverage
 * @property {string} start
 * @property {string} end
 * @property {number} classCount
 * @property {"classes"|"template"} source
 */

/**
 * @param {unknown[]} classes
 * @param {string} weekStart
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 * @returns {Record<string, Record<import("./staff-schedule-lib.mjs").ShiftSlot, SlotCoverage>>}
 */
export function computeClassCoverageFromRows(classes, weekStart, config) {
  const dates = weekDatesFromStart(weekStart);
  const templates = config.shiftTemplates;
  const earlyMorningEndMinutes = parseHmToMinutes(
    templates.early_morning?.end || EARLY_MORNING_CLASS_CUTOFF,
  );
  const eveningStartMinutes = parseHmToMinutes(templates.evening?.start || "15:00");

  /** @type {Record<string, Record<import("./staff-schedule-lib.mjs").ShiftSlot, number[]>>} */
  const buckets = {};
  for (const date of dates) {
    buckets[date] = { early_morning: [], morning: [], evening: [] };
  }

  for (const raw of classes) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.IsCancelled === true || row.isCancelled === true) continue;

    const startRaw = row.StartDateTime ?? row.startDateTime;
    const endRaw = row.EndDateTime ?? row.endDateTime;
    if (typeof startRaw !== "string" || typeof endRaw !== "string") continue;

    const startMs = mindbodyInstantToUtcMs(startRaw);
    const endMs = mindbodyInstantToUtcMs(endRaw);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    const date = formatYmdEt(startMs);
    if (!buckets[date]) continue;

    const startParts = new Intl.DateTimeFormat("en-US", {
      timeZone: STUDIO_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(startMs));
    const sh = parseInt(startParts.find((p) => p.type === "hour")?.value || "0", 10);
    const sm = parseInt(startParts.find((p) => p.type === "minute")?.value || "0", 10);
    const startDayMinutes = sh * 60 + sm;

    /** @type {import("./staff-schedule-lib.mjs").ShiftSlot} */
    let slot = "evening";
    if (startDayMinutes < earlyMorningEndMinutes) slot = "early_morning";
    else if (startDayMinutes < eveningStartMinutes) slot = "morning";
    buckets[date][slot].push(startMs, endMs);
  }

  /** @type {Record<string, Record<import("./staff-schedule-lib.mjs").ShiftSlot, SlotCoverage>>} */
  const out = {};
  for (const date of dates) {
    /** @param {import("./staff-schedule-lib.mjs").ShiftSlot} slot */
    const buildSlot = (slot) => {
      const times = buckets[date][slot];
      const tmpl = templates[slot];
      if (!times.length) {
        return {
          start: tmpl?.start || "",
          end: tmpl?.end || "",
          classCount: 0,
          source: /** @type {const} */ ("template"),
        };
      }
      const starts = [];
      const ends = [];
      for (let i = 0; i < times.length; i += 2) {
        starts.push(times[i]);
        ends.push(times[i + 1]);
      }
      return {
        start: formatHmEt(Math.min(...starts)),
        end: formatHmEt(Math.max(...ends)),
        classCount: starts.length,
        source: /** @type {const} */ ("classes"),
      };
    };
    out[date] = {
      early_morning: buildSlot("early_morning"),
      morning: buildSlot("morning"),
      evening: buildSlot("evening"),
    };
  }
  return out;
}

/**
 * @param {string} weekStart
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 */
export async function fetchWeekClassCoverage(weekStart, config) {
  const headers = await resolveScheduleHeaders();
  const dates = weekDatesFromStart(weekStart);
  if (!headers) {
    return {
      coverage: computeClassCoverageFromRows([], weekStart, config),
      mindbodyOk: false,
    };
  }

  const startMs = mindbodyInstantToUtcMs(`${dates[0]}T00:00:00`);
  // End-of-week 23:59:59 can fail naive ET conversion at month boundaries — use start of next day (exclusive).
  const endExclusiveMs = mindbodyInstantToUtcMs(`${addDaysYmd(dates[6], 1)}T00:00:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endExclusiveMs)) {
    const fallback = computeClassCoverageFromRows([], weekStart, config);
    return { coverage: fallback, mindbodyOk: false };
  }

  const q = new URLSearchParams();
  q.set("StartDateTime", new Date(startMs).toISOString());
  q.set("EndDateTime", new Date(endExclusiveMs - 1).toISOString());
  q.set("HideCanceledClasses", "true");
  q.set("Limit", "500");

  const url = `https://${mindbodyHost()}/public/v6/class/classes?${q}`;
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const fallback = computeClassCoverageFromRows([], weekStart, config);
      return { coverage: fallback, mindbodyOk: false };
    }
    const data = await res.json();
    const rows = Array.isArray(data?.Classes)
      ? data.Classes
      : Array.isArray(data?.classes)
        ? data.classes
        : [];
    return {
      coverage: computeClassCoverageFromRows(rows, weekStart, config),
      mindbodyOk: true,
    };
  } catch {
    const fallback = computeClassCoverageFromRows([], weekStart, config);
    return { coverage: fallback, mindbodyOk: false };
  }
}
