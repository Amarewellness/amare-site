import { apiBase, applyTunnelHeaders, saveAuth } from "../config";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch(
  path: string,
  accessToken: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const url = path.startsWith("http") ? path : `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  applyTunnelHeaders(headers, url);
  const res = await fetch(url, { ...init, headers });
  const rotatedAccess = res.headers.get("X-Amare-Access-Token");
  const rotatedRefresh = res.headers.get("X-Amare-Refresh-Token");
  if (rotatedAccess && rotatedRefresh) {
    saveAuth(rotatedAccess, rotatedRefresh);
  }
  return res;
}

export async function apiJson<T>(
  path: string,
  accessToken: string | null,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(path, accessToken, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      typeof data === "object" && data && "error" in data ? String((data as { error: string }).error) : res.statusText,
      res.status,
      data,
    );
  }
  return data as T;
}

import { DAY_STRIP_LEN, addDaysToYmdEt, dateKeyEt } from "../lib/schedule-utils";
import { mindbodyInstantToUtcMs } from "../lib/mindbody-time";

/** Build GET query for class schedule between ET calendar dates (inclusive). */
export function scheduleQueryParamsForEtRange(startYmd: string, endYmd: string): string {
  const startMs = mindbodyInstantToUtcMs(`${startYmd}T00:00:00`);
  const endMs = mindbodyInstantToUtcMs(`${endYmd}T23:59:59`);
  let startIso: string;
  let endIso: string;
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    startIso = new Date(startMs).toISOString();
    endIso = new Date(endMs + 999).toISOString();
  } else {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + DAY_STRIP_LEN);
    end.setUTCHours(23, 59, 59, 999);
    startIso = start.toISOString();
    endIso = end.toISOString();
  }
  const params = new URLSearchParams({
    StartDateTime: startIso,
    EndDateTime: endIso,
    HideCanceledClasses: "true",
    Limit: "500",
  });
  return params.toString();
}

/** Next 14 days schedule query (America/New_York wall dates) — matches site `buildQuery()`. */
export function scheduleQueryParams(): string {
  const todayEt = dateKeyEt(Date.now());
  return scheduleQueryParamsForEtRange(todayEt, addDaysToYmdEt(todayEt, DAY_STRIP_LEN - 1));
}

export function classesFromPayload(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  for (const key of ["Classes", "classes"]) {
    const arr = d[key];
    if (Array.isArray(arr)) return arr as Record<string, unknown>[];
  }
  return [];
}

export function buildScheduleClassMap(data: unknown): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>();
  for (const cls of classesFromPayload(data)) {
    const id = classId(cls);
    if (id != null) map.set(id, cls);
  }
  return map;
}

export function classId(cls: Record<string, unknown>): number | null {
  const raw = cls.Id ?? cls.id ?? cls.ClassId;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function classTitle(cls: Record<string, unknown>): string {
  const desc = cls.ClassDescription ?? cls.classDescription;
  if (desc && typeof desc === "object") {
    const name = (desc as Record<string, unknown>).Name ?? (desc as Record<string, unknown>).name;
    if (name) return String(name);
  }
  return String(cls.Name ?? cls.name ?? "Class");
}

export function classStart(cls: Record<string, unknown>): string {
  return String(cls.StartDateTime ?? cls.startDateTime ?? "");
}

function personName(s: Record<string, unknown>, allowBareName = true): string {
  const fn = String(s.FirstName ?? s.firstName ?? "").trim();
  const ln = String(s.LastName ?? s.lastName ?? "").trim();
  const combined = `${fn} ${ln}`.trim();
  if (combined) return combined;
  if (!allowBareName) return "";
  return String(s.DisplayName ?? s.displayName ?? s.Name ?? s.name ?? "").trim();
}

export function staffName(cls: Record<string, unknown>): string {
  const staff = cls.Staff ?? cls.staff ?? cls.Instructor ?? cls.instructor;
  if (Array.isArray(staff) && staff[0] && typeof staff[0] === "object") {
    const n = personName(staff[0] as Record<string, unknown>);
    if (n) return n;
  } else if (staff && typeof staff === "object") {
    const n = personName(staff as Record<string, unknown>);
    if (n) return n;
  }
  const flat = cls.StaffName ?? cls.InstructorName ?? cls.TeacherName;
  if (typeof flat === "string" && flat.trim()) return flat.trim();
  return personName(cls, false) || "—";
}

export function spotsRemaining(cls: Record<string, unknown>): number | null {
  const max = cls.MaxCapacity ?? cls.maxCapacity;
  const booked = cls.TotalBooked ?? cls.totalBooked;
  if (typeof max === "number" && typeof booked === "number") return Math.max(0, max - booked);
  return null;
}
