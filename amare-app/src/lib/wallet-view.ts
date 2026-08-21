import { countUpcomingBookedVisits } from "./visit-utils";

type PackMeta = {
  name: string;
  remaining: number;
  total: number;
  expiryLabel: string;
  isRecurringMonthly: boolean;
  isUnlimited: boolean;
};

const UNLIMITED_SENTINEL = 999999;
const UNLIMITED_PRODUCT_IDS = new Set([100056, 100135]);

function isUnlimitedService(r: Record<string, unknown>, remaining: number | null): boolean {
  const pid = Number(pick(r, ["ProductId", "productId", "ServiceId", "serviceId"]));
  if (Number.isFinite(pid) && UNLIMITED_PRODUCT_IDS.has(pid)) return true;
  return remaining != null && remaining >= UNLIMITED_SENTINEL;
}

export type WalletViewModel =
  | { kind: "loading" }
  | { kind: "message"; variant: "info" | "warn"; text: string }
  | { kind: "packs"; packs: PackMeta[]; moreCount: number }
  | { kind: "membership"; membershipName: string; renewsLabel: string };

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

function firstArray(obj: unknown, keys: string[]): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

function clientServiceExpired(r: Record<string, unknown>): boolean {
  const exp = pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
  if (exp == null || exp === "") return false;
  const d = new Date(String(exp));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return expDay < todayDay;
}

function clientServiceRemaining(r: Record<string, unknown>): number | null {
  const remRaw = pick(r, ["Remaining", "remaining"]);
  if (typeof remRaw === "number") return remRaw;
  if (remRaw != null && Number.isFinite(Number(remRaw))) return Number(remRaw);
  return null;
}

function passesActiveService(row: Record<string, unknown>): boolean {
  if (clientServiceExpired(row)) return false;
  const rem = clientServiceRemaining(row);
  return rem != null && rem > 0;
}

function positiveIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) return Math.round(Number(v));
  return null;
}

function inferSessionsFromTitle(title: string): number | null {
  const s = title.trim();
  if (!s) return null;
  for (const re of [/\b(\d+)\s*[-]?\s*pack\b/i, /\b(\d+)\s*(?:class(?:es)?|sessions?|visits?)\b/i]) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function formatDate(v: unknown): string {
  if (v == null || v === "") return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function isMonthlyMembershipPack(name: string): boolean {
  if (/top-?up/i.test(name) || /guest\s*pass/i.test(name)) return false;
  return /\bmonthly\b/i.test(name);
}

function clientServiceName(r: Record<string, unknown>): string {
  const nameRaw = pick(r, ["Name", "ProgramName", "serviceName"]);
  return typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Package";
}

function clientServiceApiTotal(r: Record<string, unknown>): number | null {
  return positiveIntOrNull(
    pick(r, [
      "TotalPurchased",
      "totalPurchased",
      "PurchasedCount",
      "SessionCount",
      "TotalCount",
      "OriginalTotal",
      "originalTotal",
      "Count",
      "count",
      "NumberOfSessions",
      "numberOfSessions",
    ]),
  );
}

function clientServiceDeducted(r: Record<string, unknown>): number | null {
  const deductedRaw = pick(r, ["NumberDeducted", "numberDeducted", "Visited", "visited"]);
  if (typeof deductedRaw === "number" && Number.isFinite(deductedRaw) && deductedRaw >= 0) {
    return Math.round(deductedRaw);
  }
  if (deductedRaw != null && Number.isFinite(Number(deductedRaw)) && Number(deductedRaw) >= 0) {
    return Math.round(Number(deductedRaw));
  }
  return null;
}

/** Visits already taken from this row (including Remaining=0 packs). */
function clientServiceUsedCount(r: Record<string, unknown>): number {
  const remaining = clientServiceRemaining(r);
  const rem = remaining == null ? 0 : remaining;
  const deducted = clientServiceDeducted(r);
  if (deducted != null) return deducted;
  const name = clientServiceName(r);
  const fromTitle = inferSessionsFromTitle(name);
  const apiTotal = clientServiceApiTotal(r);
  let total: number | null = null;
  if (fromTitle != null && fromTitle >= rem) total = fromTitle;
  if (total == null && apiTotal != null && apiTotal >= rem) total = apiTotal;
  if (total == null) return 0;
  return Math.max(0, total - rem);
}

function packMeta(r: Record<string, unknown>): PackMeta | null {
  const remaining = clientServiceRemaining(r);
  if (remaining == null || remaining <= 0) return null;

  const name = clientServiceName(r);
  const deducted = clientServiceDeducted(r);
  const apiTotal = clientServiceApiTotal(r);

  let total =
    deducted != null ? remaining + deducted : null;
  if (total != null && (!Number.isFinite(total) || total < remaining)) total = null;

  const fromTitle = inferSessionsFromTitle(name);
  if (total == null && fromTitle != null && fromTitle >= remaining) total = fromTitle;
  if (total == null && apiTotal != null && apiTotal >= remaining) {
    if (fromTitle != null && fromTitle === remaining && apiTotal !== fromTitle) total = fromTitle;
    else total = apiTotal;
  }
  if (total == null) total = remaining;
  if (total < remaining) total = remaining;

  return {
    name,
    remaining,
    total,
    expiryLabel: formatDate(pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"])),
    isRecurringMonthly: isMonthlyMembershipPack(name),
    isUnlimited: isUnlimitedService(r, remaining),
  };
}

/** Same remaining the wallet shows — never a second total formula. */
export function packCreditsForDisplay(
  row: Record<string, unknown>,
  summary: unknown,
  reconcile: boolean,
): { remaining: number; total: number } | null {
  const meta = packMeta(row);
  if (!meta) {
    const rem = clientServiceRemaining(row);
    if (rem == null) return null;
    return { remaining: Math.max(0, rem), total: Math.max(0, rem) };
  }
  if (!reconcile) return { remaining: meta.remaining, total: meta.total };
  const unaccounted = unaccountedUpcomingVisitCount(summary);
  const rec = reconcilePackWithUnaccountedVisits(meta, unaccounted);
  return { remaining: rec.remaining, total: rec.total };
}

export function formatPackCreditsLeft(
  row: Record<string, unknown>,
  summary: unknown,
  reconcile: boolean,
): string {
  if (isUnlimitedService(row, clientServiceRemaining(row))) return "Unlimited visits";
  const credits = packCreditsForDisplay(row, summary, reconcile);
  if (!credits) return "—";
  return `${credits.remaining} left`;
}

function clientServicesFromSummary(sumPayload: unknown): Record<string, unknown>[] {
  if (!sumPayload || typeof sumPayload !== "object") return [];
  const sum = sumPayload as Record<string, unknown>;
  return firstArray(sum.clientServices, ["ClientServices", "Services", "clientServices"])
    .filter((x) => x && typeof x === "object")
    .map((x) => x as Record<string, unknown>);
}

/**
 * Upcoming visits already deducted from any non-expired Client Service
 * (including Remaining=0 rows) must not be subtracted again from a sibling pack.
 */
export function unaccountedUpcomingVisitCount(summary: unknown): number {
  const upcoming = countUpcomingBookedVisits(summary);
  if (upcoming <= 0) return 0;
  let used = 0;
  for (const row of clientServicesFromSummary(summary)) {
    if (clientServiceExpired(row)) continue;
    used += clientServiceUsedCount(row);
  }
  return Math.max(0, upcoming - used);
}

export function reconcilePackWithUnaccountedVisits(pack: PackMeta, unaccountedCount: number): PackMeta {
  if (unaccountedCount <= 0) return pack;
  return {
    ...pack,
    remaining: Math.max(0, pack.remaining - unaccountedCount),
  };
}

function activePackMetas(sumPayload: unknown): PackMeta[] {
  const servicesArr = clientServicesFromSummary(sumPayload)
    .filter(passesActiveService)
    .sort((a, b) => (clientServiceRemaining(b) ?? -1) - (clientServiceRemaining(a) ?? -1));

  const metas: PackMeta[] = [];
  for (const row of servicesArr) {
    const m = packMeta(row);
    if (m) metas.push(m);
  }

  let leftover = unaccountedUpcomingVisitCount(sumPayload);
  return metas.map((pack) => {
    if (leftover <= 0) return pack;
    const cut = Math.min(pack.remaining, leftover);
    leftover -= cut;
    return { ...pack, remaining: pack.remaining - cut };
  });
}

/** Sum of remaining visits across every currently usable Client Service. */
export function usableClassCreditsRemaining(sumPayload: unknown): number {
  return activePackMetas(sumPayload).reduce((sum, pack) => sum + pack.remaining, 0);
}

export const WALLET_SEG_DISPLAY_MAX = 42;

export function walletPunchSlotLayout(remaining: number, total: number) {
  const t = Math.max(1, Math.round(total));
  const r = Math.max(0, Math.round(remaining));
  if (t <= WALLET_SEG_DISPLAY_MAX) return { slotCount: t, filled: Math.min(r, t) };
  const slotCount = WALLET_SEG_DISPLAY_MAX;
  return { slotCount, filled: Math.max(0, Math.min(slotCount, Math.round((r / t) * slotCount))) };
}

export function scheduleWalletViewModel(sumPayload: unknown): WalletViewModel {
  if (!sumPayload || typeof sumPayload !== "object") {
    return { kind: "message", variant: "warn", text: "Couldn't load package balance." };
  }
  const sum = sumPayload as Record<string, unknown>;
  if (sum.clientId == null) {
    return {
      kind: "message",
      variant: "warn",
      text: "We couldn't match your sign-in to this studio's client record.",
    };
  }

  const metas = activePackMetas(sum);
  const top = metas.slice(0, 2);
  const moreCount = Math.max(0, metas.length - top.length);
  if (top.length) return { kind: "packs", packs: top, moreCount };

  const mems = firstArray(sum.memberships, [
    "ClientMemberships",
    "Memberships",
    "memberships",
    "ActiveClientMemberships",
    "ActiveMemberships",
    "activeMemberships",
  ])
    .filter((x) => x && typeof x === "object")
    .map((x) => x as Record<string, unknown>);

  const activeMem = mems.find((m) => {
    const a = m.Active ?? m.active;
    return a === true || a === "true" || a === 1;
  });

  if (activeMem) {
    const mn = pick(activeMem, ["MembershipName", "Name", "name", "ProgramName", "Description"]);
    const label = typeof mn === "string" && mn.trim() ? mn.trim() : "Membership";
    return {
      kind: "membership",
      membershipName: label,
      renewsLabel: formatDate(pick(activeMem, ["ExpirationDate", "EndDate", "end"])),
    };
  }

  return {
    kind: "message",
    variant: "info",
    text: "You’re out of visits for now. Add a pass and this class is yours.",
  };
}
