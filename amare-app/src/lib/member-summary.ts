import { visitStartMs } from "./visit-utils";

function visitsArrayFromClientVisits(clientVisits: unknown): Record<string, unknown>[] {
  if (!clientVisits || typeof clientVisits !== "object") return [];
  const cv = clientVisits as Record<string, unknown>;
  for (const key of ["Visits", "visits"]) {
    if (Array.isArray(cv[key])) return cv[key] as Record<string, unknown>[];
  }
  return [];
}

function visitRowIsWaitlist(v: Record<string, unknown>): boolean {
  for (const k of ["Waitlist", "waitlist", "OnWaitlist", "onWaitlist", "IsWaitlist", "isWaitlist"]) {
    const f = v[k];
    if (f === true || f === 1 || f === "true" || f === "1") return true;
  }
  const action = String(v.Action ?? v.action ?? v.VisitType ?? v.visitType ?? "").toLowerCase();
  return action.includes("waitlist");
}

function visitStartMsFromRow(v: Record<string, unknown>): number | null {
  return visitStartMs(v);
}

function visitClassIdFromRow(v: Record<string, unknown>): number | null {
  const cls = v.Class ?? v.class;
  if (cls && typeof cls === "object") {
    const c = cls as Record<string, unknown>;
    const id = c.Id ?? c.id;
    if (id != null && Number.isFinite(Number(id))) return Number(id);
  }
  const raw = v.ClassId ?? v.classId;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

function visitRowIdFromRow(v: Record<string, unknown>): number | null {
  const raw = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

export function buildEnrollmentVisitMap(summaryPayload: unknown): Map<number, number> {
  const map = new Map<number, number>();
  if (!summaryPayload || typeof summaryPayload !== "object") return map;
  const sum = summaryPayload as Record<string, unknown>;
  const rows = visitsArrayFromClientVisits(sum.clientVisits);
  const now = Date.now();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    if (visitRowIsWaitlist(item)) continue;
    const ms = visitStartMsFromRow(item);
    if (ms == null || ms <= now) continue;
    const cid = visitClassIdFromRow(item);
    const vid = visitRowIdFromRow(item);
    if (cid != null && vid != null) map.set(cid, vid);
  }
  return map;
}

export function buildWaitlistEntryMap(summaryPayload: unknown): Map<number, number> {
  const map = new Map<number, number>();
  if (!summaryPayload || typeof summaryPayload !== "object") return map;
  const raw = (summaryPayload as Record<string, unknown>).waitlistByClassId;
  if (!raw || typeof raw !== "object") return map;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const cid = parseInt(k, 10);
    if (!Number.isFinite(cid) || cid <= 0) continue;
    if (v && typeof v === "object") {
      const row = v as Record<string, unknown>;
      const eidRaw = row.waitlistEntryId ?? row.WaitlistEntryId;
      const eid = typeof eidRaw === "number" ? eidRaw : parseInt(String(eidRaw), 10);
      if (Number.isFinite(eid) && eid > 0) map.set(cid, eid);
    } else if (typeof v === "number" && v > 0) {
      map.set(cid, v);
    }
  }
  return map;
}

/** Keep optimistic book/cancel rows until member summary catches up. */
export function mergeEnrollmentVisitMaps(
  apiMap: Map<number, number>,
  patchMap: Map<number, number | null>,
): Map<number, number> {
  const merged = new Map(apiMap);
  for (const [cid, vid] of patchMap) {
    if (vid == null) merged.delete(cid);
    else merged.set(cid, vid);
  }
  return merged;
}

export function mergeWaitlistEntryMaps(
  apiMap: Map<number, number>,
  patchMap: Map<number, number | null>,
): Map<number, number> {
  const merged = new Map(apiMap);
  for (const [cid, eid] of patchMap) {
    if (eid == null) merged.delete(cid);
    else merged.set(cid, eid);
  }
  return merged;
}
