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

export function firstNameFromDisplay(name: string | null | undefined): string {
  const t = String(name || "").trim();
  if (!t || t === "—") return "";
  return t.split(/\s+/)[0] || "";
}

export function classesThisMonthCount(summary: unknown): number {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return attendedVisits(summary).filter((v) => {
    const ms = visitStartMs(v);
    if (ms == null) return false;
    const d = new Date(ms);
    return d.getFullYear() === year && d.getMonth() === month;
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
  if (vm.kind === "packs") return String(usableClassCreditsRemaining(summary));
  return "—";
}

export function planLabel(summary: unknown): string {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "packs") return vm.packs[0]?.name || "Package";
  if (vm.kind === "membership") return vm.membershipName;
  return "No active plan";
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
