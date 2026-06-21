/** Mindbody class times are wall-clock in America/New_York (often without Z/offset). */

export const MB_TZ = "America/New_York";

function naiveEtWallIterateToUtcMs(y: number, mo: number, d: number, h: number, mi: number, se: number): number {
  let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: MB_TZ,
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
    const num = (typ: string) => parseInt(parts.find((p) => p.type === typ)?.value || "0", 10);
    const yy = num("year");
    const MM = num("month");
    const dd = num("day");
    const HH = num("hour");
    const mmm = num("minute");
    const ss = num("second");
    if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
    t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
    if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
  }
  return NaN;
}

/** Parse Mindbody ISO-like timestamp as studio ET wall time → UTC ms. */
export function mindbodyInstantToUtcMs(isoLike: unknown): number {
  if (isoLike == null || typeof isoLike !== "string") return NaN;
  const raw = isoLike.trim();
  if (!raw) return NaN;
  const hasExplicitTz = /[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw);
  if (hasExplicitTz) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
  if (!mm) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const y = +mm[1];
  const mo = +mm[2];
  const d = +mm[3];
  const h = +mm[4];
  const mi = +mm[5];
  const se = mm[6] != null ? +mm[6] : 0;
  try {
    const TemporalGlobal = (globalThis as { Temporal?: { ZonedDateTime: { from: (o: object) => { epochMilliseconds: number } } } }).Temporal;
    if (TemporalGlobal) {
      const z = TemporalGlobal.ZonedDateTime.from({
        timeZone: MB_TZ,
        calendar: "iso8601",
        year: y,
        month: mo,
        day: d,
        hour: h,
        minute: mi,
        second: se,
        millisecond: 0,
      });
      return z.epochMilliseconds;
    }
  } catch {
    /* fall through */
  }
  return naiveEtWallIterateToUtcMs(y, mo, d, h, mi, se);
}

export function formatMindbodyEt(isoLike: string, options?: Intl.DateTimeFormatOptions): string {
  const ms = mindbodyInstantToUtcMs(isoLike);
  if (!Number.isFinite(ms)) return isoLike || "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      timeZone: MB_TZ,
      ...options,
    });
  } catch {
    return isoLike;
  }
}
