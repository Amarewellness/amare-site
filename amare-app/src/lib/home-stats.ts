import { scheduleWalletViewModel, usableClassCreditsRemaining } from "./wallet-view";
import {
  completedVisitsFromSummary,
  upcomingVisitsFromSummary,
  visitRowIsWaitlist,
  visitStartMs,
  type VisitRow,
} from "./visit-utils";
import { buildWaitlistEntryMap } from "./member-summary";

function attendedVisits(summary: unknown): VisitRow[] {
  return completedVisitsFromSummary(summary).filter((v) => !visitRowIsWaitlist(v));
}

function inCurrentMonth(ms: number, now = new Date()): boolean {
  const d = new Date(ms);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export function firstNameFromDisplay(name: string | null | undefined): string {
  const t = String(name || "").trim();
  if (!t || t === "—") return "";
  const first = t.split(/\s+/)[0] || "";
  return first.replace(/(\p{L})(\p{L}*)/u, (_, a: string, b: string) => a.toLocaleUpperCase() + b);
}

export function classesThisMonthCount(summary: unknown): number {
  return attendedVisits(summary).filter((v) => {
    const ms = visitStartMs(v);
    return ms != null && inCurrentMonth(ms);
  }).length;
}

export function daysSinceLastClass(summary: unknown): number | null {
  const past = attendedVisits(summary);
  if (!past.length) return null;
  const ms = visitStartMs(past[0]);
  if (ms == null) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

export function nextUpcomingVisit(summary: unknown): VisitRow | null {
  return upcomingVisitsFromSummary(summary)[0] ?? null;
}

export function waitlistCount(summary: unknown): number {
  return buildWaitlistEntryMap(summary).size;
}

export function creditsLabel(summary: unknown): string {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "membership") return "Unlimited";
  if (vm.kind === "packs") {
    if (vm.packs.some((pack) => pack.isUnlimited)) return "Unlimited";
    return String(usableClassCreditsRemaining(summary));
  }
  return "—";
}

export type CreditsMeter = {
  mode: "unlimited" | "packs" | "empty";
  remaining: number;
  total: number;
};

export function creditsMeter(summary: unknown): CreditsMeter {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "membership") return { mode: "unlimited", remaining: 1, total: 1 };
  if (vm.kind === "packs") {
    if (vm.packs.some((pack) => pack.isUnlimited)) return { mode: "unlimited", remaining: 1, total: 1 };
    const remaining = usableClassCreditsRemaining(summary);
    const total = vm.packs.reduce((sum, pack) => sum + Math.max(pack.total, pack.remaining), 0);
    return { mode: remaining > 0 ? "packs" : "empty", remaining, total: Math.max(total, remaining, 1) };
  }
  return { mode: "empty", remaining: 0, total: 1 };
}

export function planLabel(summary: unknown): string {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "packs") return vm.packs[0]?.name || "Package";
  if (vm.kind === "membership") return vm.membershipName;
  return "No active plan";
}

export function planRenewalLine(summary: unknown): string {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "membership" && vm.renewsLabel) return `Renews ${vm.renewsLabel}`;
  if (vm.kind === "packs") {
    const pack = vm.packs[0];
    if (!pack?.expiryLabel) return "";
    return pack.isRecurringMonthly ? `Renews ${pack.expiryLabel}` : `Expires ${pack.expiryLabel}`;
  }
  return "";
}

/** True only when summary loaded and no completed (non-waitlist) visits exist. */
export function hasReliableFirstVisitContext(summary: unknown): boolean {
  if (!summary || typeof summary !== "object") return false;
  return attendedVisits(summary).length === 0;
}

export function progressLine(summary: unknown): string | null {
  const month = classesThisMonthCount(summary);
  if (month === 1) return "You've completed your first class this month.";
  if (month > 1) return `You've completed ${month} classes this month.`;
  const days = daysSinceLastClass(summary);
  if (days == null) return null;
  if (days === 0) return "Welcome back — you moved today.";
  if (days === 1) return "Welcome back — your last class was yesterday.";
  return `Welcome back — your last class was ${days} days ago.`;
}

/** Home card copy only. Upcoming → completed this month → visits left → fallback. */
export function monthMotivation(summary: unknown): string {
  const upcoming = upcomingVisitsFromSummary(summary).length;
  if (upcoming >= 3) return `${upcoming} classes locked in. Your week is looking good.`;
  if (upcoming === 2) return "Two on the calendar. Love that for you.";
  if (upcoming === 1) return "You're booked. Future you says thank you.";

  const done = classesThisMonthCount(summary);
  if (done >= 8) return `${done} classes this month. Consider this your signature move.`;
  if (done >= 6) return `${done} classes in. Keep that rhythm going.`;
  if (done === 5) return "Five in. This is becoming a lifestyle.";
  if (done === 4) return "Four this month. Okay, we see you.";
  if (done === 3) return "Three down. Consistency looks very good on you.";
  if (done === 2) return "Two in. Your routine is looking good on you.";
  if (done === 1) return "One down. You're officially in your AMARÉ era.";

  const meter = creditsMeter(summary);
  if (meter.mode === "packs") {
    const left = meter.remaining;
    if (left >= 8) return "Plenty left. Make this your strongest month yet.";
    if (left >= 5) return `${left} classes left. Make them count.`;
    if (left >= 3) return `${left} left. You're right in the sweet spot.`;
    if (left === 2) return "Two left. Finish strong, babe.";
    if (left === 1) return "One left. You know what to do.";
    return "You did that. Ready for your next chapter?";
  }

  const days = daysSinceLastClass(summary);
  if (days == null) return "Your AMARÉ era starts with one class.";
  if (days <= 7) return "Your next feel-good hour is waiting.";
  return "Come back when you're ready. We saved you a spot.";
}
