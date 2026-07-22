/**
 * Mindbody class wall-clock times (America/New_York) without explicit offset.
 */

export const STUDIO_TIMEZONE = "America/New_York";

/**
 * @param {string | null | undefined} isoLike
 * @returns {number}
 */
export function mindbodyWallTimeToUtcMs(isoLike) {
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
    timeZone: STUDIO_TIMEZONE,
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

/**
 * @param {string | null | undefined} classStartIso
 * @param {number} [nowMs]
 */
export function classStartInstantHasPassed(classStartIso, nowMs = Date.now()) {
  const ms = mindbodyWallTimeToUtcMs(classStartIso);
  if (!Number.isFinite(ms)) return false;
  return ms <= nowMs;
}

/**
 * @param {string | null | undefined} isoLike
 * @returns {{ dateLine: string; timeLine: string }}
 */
export function formatClassWhenEt(isoLike) {
  const ms = mindbodyWallTimeToUtcMs(isoLike);
  if (!Number.isFinite(ms)) {
    return { dateLine: String(isoLike || "TBD"), timeLine: "" };
  }
  const d = new Date(ms);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TIMEZONE,
    weekday: "long",
  }).format(d);
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TIMEZONE,
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const timeLine = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return { dateLine: `${weekday}, ${datePart}`, timeLine };
}

/**
 * @param {string | null | undefined} isoLike
 */
export function isClassStartingSoonEt(isoLike, withinMs = 3 * 60 * 60 * 1000) {
  const ms = mindbodyWallTimeToUtcMs(isoLike);
  if (!Number.isFinite(ms)) return false;
  const delta = ms - Date.now();
  return delta > 0 && delta <= withinMs;
}
