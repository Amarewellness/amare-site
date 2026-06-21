import { classStart, classTitle, spotsRemaining, staffName } from "../api/client";
import { mindbodyInstantToUtcMs } from "./mindbody-time";

export const TZ = "America/New_York";
export const DAY_STRIP_LEN = 14;

const POPULAR_OCCUPANCY_LARGE = 0.7;
const CAPACITY_TIER_SMALL = 9;
const CAPACITY_TIER_MID = 13;
const FEW_SPOTS_MAX_SMALL = 3;
const FEW_SPOTS_MAX_MID = 5;
const POPULAR_MIN_SPOTS_SMALL = 4;
const POPULAR_MIN_SPOTS_MID = 6;
const POPULAR_MIN_BOOKED_SMALL = 5;
const POPULAR_MIN_BOOKED_MID = 6;
const PRIME_TIME_START_MIN = 17 * 60 + 30;
const PRIME_TIME_END_MIN = 19 * 60 + 30;
const PRIME_TIME_MIN_BOOKED = 3;

export type ScheduleRow = {
  cls: Record<string, unknown>;
  dk: string;
  isoMs: number;
};

export type FilterState = {
  timeBucket: string;
  instructor: string;
  classTitle: string;
  q: string;
};

export type ClassBadge = {
  label: string;
  type: "few-spots" | "popular" | "prime-time" | "intro-friendly";
};

const dayKeyFmt = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

const hourFmtEt = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });

const timeFmt = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const pillLine1Fmt = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

const pillMmDdFmt = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });

const dayHeadingFmt = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

export function dateKeyEt(isoMs: number): string {
  return dayKeyFmt().format(new Date(isoMs));
}

export function addDaysToYmdEt(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const ms = Date.UTC(y, m - 1, d + delta) + 43200000;
  return dateKeyEt(ms);
}

export function stripKeysFromTodayEt(): string[] {
  const start = dateKeyEt(Date.now());
  const keys: string[] = [];
  let k = start;
  for (let i = 0; i < DAY_STRIP_LEN; i++) {
    keys.push(k);
    k = addDaysToYmdEt(k, 1);
  }
  return keys;
}

export function midMsForEtYmd(dk: string): number {
  const parts = dk.split("-");
  if (parts.length !== 3) return NaN;
  const [y, m, d] = parts.map((x) => parseInt(x, 10));
  if (![y, m, d].every((n) => Number.isFinite(n))) return NaN;
  return Date.UTC(y, m - 1, d, 17, 0, 0);
}

export function formatDayHeading(dk: string): string {
  return dayHeadingFmt().format(new Date(midMsForEtYmd(dk)));
}

export function formatPillWeekday(dk: string, todayKey: string): string {
  if (dk === todayKey) return "Today";
  return pillLine1Fmt().format(new Date(midMsForEtYmd(dk)));
}

export function formatPillDate(dk: string): string {
  return pillMmDdFmt().format(new Date(midMsForEtYmd(dk)));
}

export function formatSlotTime(isoMs: number): string {
  return timeFmt().format(new Date(isoMs));
}

export function normalizeClassRow(cls: Record<string, unknown>): ScheduleRow | null {
  const iso = classStart(cls);
  const ms = mindbodyInstantToUtcMs(iso);
  if (!Number.isFinite(ms)) return null;
  return { cls, dk: dateKeyEt(ms), isoMs: ms };
}

export function hourEt(isoMs: number): number {
  try {
    const parts = hourFmtEt().formatToParts(new Date(isoMs));
    const h = parts.find((p) => p.type === "hour");
    return h ? parseInt(h.value, 10) : 12;
  } catch {
    return 12;
  }
}

export function matchesTimeBucket(hour: number, bucket: string): boolean {
  if (!bucket) return true;
  if (bucket === "earlybird") return hour < 7;
  if (bucket === "morning") return hour < 12;
  if (bucket === "afternoon") return hour >= 12 && hour < 17;
  if (bucket === "evening") return hour >= 17 && hour < 21;
  if (bucket === "late") return hour >= 21;
  return true;
}

export function passesSecondaryFilters(row: ScheduleRow, state: FilterState): boolean {
  const { cls, isoMs } = row;
  if (!matchesTimeBucket(hourEt(isoMs), state.timeBucket)) return false;
  if (state.instructor && staffName(cls) !== state.instructor) return false;
  const titleStr = classTitle(cls);
  if (state.classTitle && titleStr !== state.classTitle) return false;
  if (state.q) {
    const needle = state.q.trim().toLowerCase();
    if (needle && !(titleStr + " " + staffName(cls)).toLowerCase().includes(needle)) return false;
  }
  return true;
}

export function countsByDay(rows: ScheduleRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.dk] = (m[r.dk] ?? 0) + 1;
  return m;
}

function numField(cls: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = cls[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function bookedCount(cls: Record<string, unknown>): number {
  return numField(cls, ["TotalBooked", "totalBooked"]) ?? 0;
}

function maxCapacity(cls: Record<string, unknown>): number | null {
  const maxCap = numField(cls, ["MaxCapacity", "maxCapacity"]);
  if (maxCap != null && maxCap > 0) return Math.trunc(maxCap);
  const webCap = numField(cls, ["WebCapacity", "webCapacity"]);
  if (webCap != null && webCap > 0) return Math.trunc(webCap);
  return null;
}

function classCapacitySnapshot(cls: Record<string, unknown>) {
  const capacity = maxCapacity(cls);
  const booked = bookedCount(cls);
  const spots = spotsRemaining(cls);
  const occupancy = capacity != null && capacity > 0 ? booked / capacity : null;
  return { capacity, booked, spots, occupancy };
}

function isFewSpotsClass(cls: Record<string, unknown>): boolean {
  const { capacity, spots } = classCapacitySnapshot(cls);
  if (spots == null || spots <= 0 || capacity == null || capacity <= 0) return false;
  if (capacity <= CAPACITY_TIER_SMALL) return spots <= FEW_SPOTS_MAX_SMALL;
  if (capacity <= CAPACITY_TIER_MID) return spots <= FEW_SPOTS_MAX_MID;
  return spots <= Math.max(1, Math.floor(capacity * 0.2));
}

function isPopularClass(cls: Record<string, unknown>): boolean {
  const { capacity, booked, spots, occupancy } = classCapacitySnapshot(cls);
  if (capacity == null || capacity <= 0 || spots == null) return false;
  if (capacity <= CAPACITY_TIER_SMALL) {
    return booked >= POPULAR_MIN_BOOKED_SMALL && spots >= POPULAR_MIN_SPOTS_SMALL;
  }
  if (capacity <= CAPACITY_TIER_MID) {
    return booked >= POPULAR_MIN_BOOKED_MID && spots >= POPULAR_MIN_SPOTS_MID;
  }
  return occupancy != null && occupancy >= POPULAR_OCCUPANCY_LARGE;
}

function minutesSinceMidnightEt(start: Date): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(start);
  const m: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") m[p.type] = p.value;
  }
  const hour = parseInt(m.hour ?? "0", 10);
  const minute = parseInt(m.minute ?? "0", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function isWeekdayEt(start: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(start);
  return day !== "Sat" && day !== "Sun";
}

function isPrimeTimeClass(cls: Record<string, unknown>): boolean {
  const ms = mindbodyInstantToUtcMs(classStart(cls));
  if (!Number.isFinite(ms)) return false;
  const start = new Date(ms);
  if (!isWeekdayEt(start)) return false;
  const mins = minutesSinceMidnightEt(start);
  if (mins == null) return false;
  if (mins < PRIME_TIME_START_MIN || mins > PRIME_TIME_END_MIN) return false;
  return bookedCount(cls) >= PRIME_TIME_MIN_BOOKED;
}

function isIntroFriendlyClass(cls: Record<string, unknown>): boolean {
  const name = classTitle(cls).toLowerCase();
  if (/\b(intermediate|advanced|intensive|kangoo)\b/.test(name)) return false;
  if (/\bmat\b/.test(name)) return true;
  if (!/\b(all\s+levels|beginner|beginners|foundations|intro|introduction)\b/.test(name)) return false;
  return !/\b(burn|sculpt|spicy|heated)\b/.test(name);
}

export function classStartHasPassed(isoMs: number): boolean {
  return Date.now() >= isoMs;
}

/** Studio late-cancel window — matches Mindbody Manager setting (12h). */
export const LATE_CANCEL_HOURS = 12;

export function isWithinLateCancelWindow(isoMs: number): boolean {
  if (!Number.isFinite(isoMs)) return false;
  const msUntilStart = isoMs - Date.now();
  if (msUntilStart <= 0) return true;
  return msUntilStart < LATE_CANCEL_HOURS * 60 * 60 * 1000;
}

export function isWithinLateCancelWindowForClass(cls: Record<string, unknown>): boolean {
  return isWithinLateCancelWindow(mindbodyInstantToUtcMs(classStart(cls)));
}

export function shouldShowJoinWaitlist(cls: Record<string, unknown>): boolean {
  const wl = cls.IsWaitlistAvailable === true || cls.isWaitlistAvailable === true;
  if (!wl) return false;
  const avail = cls.IsAvailable ?? cls.isAvailable;
  if (avail === false) return true;
  if (avail === true) return false;
  return true;
}

export function classDurationMinutes(cls: Record<string, unknown>): number | null {
  const startMs = mindbodyInstantToUtcMs(classStart(cls));
  const endRaw = cls.EndDateTime ?? cls.endDateTime;
  const endMs = endRaw ? mindbodyInstantToUtcMs(String(endRaw)) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const mins = Math.round((endMs - startMs) / 60000);
  return mins > 0 ? mins : null;
}

export function getClassBadges(
  cls: Record<string, unknown>,
  state: { elapsed: boolean; isEnrolled: boolean; onWaitlist: boolean; showJoinWaitlist: boolean },
): ClassBadge[] {
  if (state.elapsed || state.isEnrolled || state.onWaitlist || state.showJoinWaitlist) return [];
  const badges: ClassBadge[] = [];
  const avail = cls.IsAvailable ?? cls.isAvailable;
  if (avail !== false && isFewSpotsClass(cls)) {
    badges.push({ label: "Few spots left", type: "few-spots" });
  } else if (avail !== false && isPopularClass(cls)) {
    badges.push({ label: "Popular", type: "popular" });
  } else if (isPrimeTimeClass(cls)) {
    badges.push({ label: "Prime time", type: "prime-time" });
  }
  if (isIntroFriendlyClass(cls)) {
    badges.push({ label: "Intro friendly", type: "intro-friendly" });
  }
  return badges;
}

function plainTextFromHtml(html: string): string {
  if (!html.trim()) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeClassDescriptionHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta, form").forEach((el) => {
    el.remove();
  });
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || n === "srcdoc") el.removeAttribute(attr.name);
      else if (n === "href" && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML.trim();
}

export function classDetailsHtml(cls: Record<string, unknown>): string | null {
  const cd = cls.ClassDescription ?? cls.classDescription;
  if (!cd || typeof cd !== "object") return null;
  const rawDesc = (cd as Record<string, unknown>).Description;
  if (typeof rawDesc !== "string" || !plainTextFromHtml(rawDesc)) return null;
  return sanitizeClassDescriptionHtml(rawDesc);
}

export function uniqueClassTitlesForDay(rows: ScheduleRow[], dk: string, filters: FilterState): string[] {
  const merged = { ...filters, classTitle: "" };
  const names = new Set<string>();
  for (const r of rows) {
    if (r.dk !== dk) continue;
    if (!passesSecondaryFilters(r, merged)) continue;
    names.add(classTitle(r.cls));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function uniqueInstructors(rows: ScheduleRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add(staffName(r.cls));
  return [...set].sort((a, b) => a.localeCompare(b));
}
