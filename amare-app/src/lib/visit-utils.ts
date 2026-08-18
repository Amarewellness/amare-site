import { staffName, scheduleQueryParamsForEtRange } from "../api/client";
import { classDetailsHtml, addDaysToYmdEt, dateKeyEt, DAY_STRIP_LEN } from "./schedule-utils";
import { formatMindbodyEt, mindbodyInstantToUtcMs } from "./mindbody-time";
export type VisitRow = Record<string, unknown>;

const VISIT_ROOT_KEYS = ["Visits", "visits", "ClientVisits", "VisitDetails", "ScheduledVisits"];

function pickRow(v: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (v[k] != null && v[k] !== "") return v[k];
  }
  return null;
}

function firstArray(obj: unknown, keys: string[]): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k];
  }
  const pr = o.PaginationResponse;
  if (pr && typeof pr === "object") {
    for (const k of keys) {
      if (Array.isArray((pr as Record<string, unknown>)[k])) {
        return (pr as Record<string, unknown>)[k] as unknown[];
      }
    }
  }
  return [];
}

export function visitsFromSummary(data: unknown): VisitRow[] {
  if (!data || typeof data !== "object") return [];
  const cv = (data as Record<string, unknown>).clientVisits;
  return firstArray(cv, VISIT_ROOT_KEYS).filter(
    (x): x is VisitRow => x != null && typeof x === "object",
  );
}

export function visitStartIso(v: VisitRow): string {
  const direct = pickRow(v, [
    "StartDateTime",
    "startDateTime",
    "StartDate",
    "VisitStartDateTime",
    "visitStartDateTime",
  ]);
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = cls as Record<string, unknown>;
    const fromClass = pickRow(c, ["StartDateTime", "startDateTime"]);
    if (typeof fromClass === "string" && fromClass.trim()) return fromClass.trim();
    const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
    if (sched && typeof sched === "object") {
      const raw = pickRow(sched as Record<string, unknown>, ["StartDateTime", "startDateTime"]);
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  return "";
}

export function visitEndIso(v: VisitRow): string {
  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = cls as Record<string, unknown>;
    const end = pickRow(c, ["EndDateTime", "endDateTime"]);
    if (typeof end === "string" && end.trim()) return end.trim();
  }
  return "";
}

export function visitStartMs(v: VisitRow): number | null {
  const iso = visitStartIso(v);
  if (!iso) return null;
  const ms = mindbodyInstantToUtcMs(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function visitName(v: VisitRow): string {
  const flat = pickRow(v, ["Name", "name", "ServiceName", "serviceName", "ClassName"]);
  if (typeof flat === "string" && flat.trim()) return flat.trim();

  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = cls as Record<string, unknown>;
    const cd = c.ClassDescription ?? c.classDescription;
    if (cd && typeof cd === "object") {
      const n = (cd as Record<string, unknown>).Name ?? (cd as Record<string, unknown>).name;
      if (typeof n === "string" && n.trim()) return n.trim();
    }
    const n = c.Name ?? c.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return "Class";
}

export function visitClassId(v: VisitRow): number | null {
  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = cls as Record<string, unknown>;
    const id = c.Id ?? c.id;
    if (id != null && Number.isFinite(Number(id))) return Number(id);
    const sched = c.ClassSchedule ?? c.classSchedule ?? c.Schedule ?? c.schedule;
    if (sched && typeof sched === "object") {
      const cid = (sched as Record<string, unknown>).ClassId ?? (sched as Record<string, unknown>).classId;
      if (cid != null && Number.isFinite(Number(cid))) return Number(cid);
    }
  }
  const raw = v.ClassId ?? v.classId;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

export function visitRowId(v: VisitRow): number | null {
  const raw = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

export function visitStaffLabel(v: VisitRow): string {
  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") return staffName(cls as Record<string, unknown>);

  const staff = v.Staff ?? v.staff ?? v.Trainers ?? v.trainers;
  if (Array.isArray(staff) && staff[0] && typeof staff[0] === "object") {
    return staffName(staff[0] as Record<string, unknown>);
  }
  if (staff && typeof staff === "object") return staffName(staff as Record<string, unknown>);
  return "Instructor TBA";
}

export function visitDurationMinutes(v: VisitRow): number | null {
  const startMs = visitStartMs(v);
  if (startMs == null) return null;
  const endIso = visitEndIso(v);
  const endMs = endIso ? mindbodyInstantToUtcMs(endIso) : NaN;
  if (!Number.isFinite(endMs)) return null;
  const mins = Math.round((endMs - startMs) / 60000);
  return mins > 0 ? mins : null;
}

export function formatVisitWhen(v: VisitRow): string {
  const iso = visitStartIso(v);
  if (!iso) return "—";
  return formatMindbodyEt(iso, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Shape compatible with CancelClassDialog / classTitle helpers. */
export function visitAsClassShape(v: VisitRow): Record<string, unknown> {
  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = { ...(cls as Record<string, unknown>) };
    if (!c.StartDateTime && !c.startDateTime) {
      const iso = visitStartIso(v);
      if (iso) c.StartDateTime = iso;
    }
    return c;
  }
  const iso = visitStartIso(v);
  const end = visitEndIso(v);
  return {
    Name: visitName(v),
    StartDateTime: iso,
    EndDateTime: end || undefined,
    Staff: v.Staff ?? v.staff,
    ClassDescription: { Name: visitName(v) },
  };
}

export function visitDetailsHtml(v: VisitRow): string | null {
  const cls = visitAsClassShape(v);
  return classDetailsHtml(cls);
}

/** Schedule query covering all upcoming visit dates (plus default 14-day window). */
export function scheduleQueryParamsForVisits(visits: VisitRow[]): string {
  const todayEt = dateKeyEt(Date.now());
  let startYmd = todayEt;
  let endYmd = addDaysToYmdEt(todayEt, DAY_STRIP_LEN - 1);
  for (const v of visits) {
    const ms = visitStartMs(v);
    if (ms == null) continue;
    const dk = dateKeyEt(ms);
    if (dk < startYmd) startYmd = dk;
    if (dk > endYmd) endYmd = dk;
  }
  return scheduleQueryParamsForEtRange(startYmd, endYmd);
}

/** Merge full schedule class row (descriptions, staff) when available. */
export function classShapeForVisit(
  visit: VisitRow,
  scheduleByClassId: Map<number, Record<string, unknown>>,
): Record<string, unknown> {
  const cid = visitClassId(visit);
  if (cid != null && scheduleByClassId.has(cid)) return scheduleByClassId.get(cid)!;
  return visitAsClassShape(visit);
}

export function visitRowIsWaitlist(v: VisitRow): boolean {
  for (const k of ["Waitlist", "waitlist", "OnWaitlist", "onWaitlist", "IsWaitlist", "isWaitlist"]) {
    const f = v[k];
    if (f === true || f === 1 || f === "true" || f === "1") return true;
  }
  const action = String(v.Action ?? v.action ?? v.VisitType ?? v.visitType ?? "").toLowerCase();
  return action.includes("waitlist");
}

/** Upcoming booked visits (excludes waitlist) — used to reconcile stale package balances. */
export function countUpcomingBookedVisits(data: unknown): number {
  const now = Date.now();
  let n = 0;
  for (const v of visitsFromSummary(data)) {
    if (visitRowIsWaitlist(v)) continue;
    const ms = visitStartMs(v);
    if (ms != null && ms > now) n++;
  }
  return n;
}

export function upcomingVisitsFromSummary(data: unknown): VisitRow[] {
  const now = Date.now();
  return visitsFromSummary(data)
    .filter((v) => {
      if (visitRowIsWaitlist(v)) return false;
      const ms = visitStartMs(v);
      return ms != null && ms >= now - 3600000;
    })
    .sort((a, b) => (visitStartMs(a) ?? 0) - (visitStartMs(b) ?? 0));
}

export function upcomingWaitlistVisitsFromSummary(data: unknown): VisitRow[] {
  const now = Date.now();
  return visitsFromSummary(data)
    .filter((v) => {
      if (!visitRowIsWaitlist(v)) return false;
      const ms = visitStartMs(v);
      return ms == null || ms >= now - 3600000;
    })
    .sort((a, b) => (visitStartMs(a) ?? 0) - (visitStartMs(b) ?? 0));
}

export function visitRowKey(v: VisitRow, index: number): string {
  const vid = visitRowId(v);
  const cid = visitClassId(v);
  const iso = visitStartIso(v);
  return `${vid ?? "v"}-${cid ?? "c"}-${iso}-${index}`;
}

export function visitIsSignedIn(v: VisitRow): boolean {
  return v.SignedIn === true || v.signedIn === true;
}

/** Prefer `SignedIn` when Mindbody leaves a stale NoShow on `AppointmentStatus`. */
export function visitStatusLabel(v: VisitRow): string {
  const parts: string[] = [];
  if (visitIsSignedIn(v)) {
    parts.push("Signed in");
  } else {
    const st = pickRow(v, ["AppointmentStatus", "appointmentStatus"]);
    if (typeof st === "string" && st.trim()) parts.push(st.trim());
  }
  if (v.LateCancelled === true) parts.push("Late cancel");
  if (v.Missed === true) parts.push("Missed");
  return parts.length ? parts.join(" · ") : "—";
}

export function completedVisitsFromSummary(data: unknown): VisitRow[] {
  const now = Date.now();
  return visitsFromSummary(data)
    .filter((v) => {
      const ms = visitStartMs(v);
      return ms != null && ms <= now;
    })
    .sort((a, b) => (visitStartMs(b) ?? 0) - (visitStartMs(a) ?? 0));
}
