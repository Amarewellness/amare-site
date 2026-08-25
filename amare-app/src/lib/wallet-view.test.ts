import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scheduleWalletViewModel,
  unaccountedUpcomingVisitCount,
  usableClassCreditsRemaining,
  walletPunchSlotLayout,
} from "./wallet-view.ts";

function creditsLabel(summary: unknown): string {
  const vm = scheduleWalletViewModel(summary);
  if (vm.kind === "membership") return "Unlimited";
  if (vm.kind === "packs") {
    if (vm.packs.some((pack) => pack.isUnlimited)) return "Unlimited";
    return String(usableClassCreditsRemaining(summary));
  }
  return "—";
}

const FUTURE = "2099-01-15T16:00:00";
const PAST_EXP = "2020-01-01T00:00:00";
const FUTURE_EXP = "2099-12-31T00:00:00";

function dropIn(id: number, remaining: number, extras: Record<string, unknown> = {}) {
  return {
    Id: id,
    ProductId: 100011,
    Name: "Drop in - Singel class",
    Count: 1,
    Remaining: remaining,
    ExpirationDate: extras.ExpirationDate ?? FUTURE_EXP,
    Active: remaining > 0,
    ...extras,
  };
}

function tenPack(id: number, remaining: number) {
  return {
    Id: id,
    ProductId: 100020,
    Name: "10 pack - 6 months",
    Count: 10,
    Remaining: remaining,
    ExpirationDate: FUTURE_EXP,
    Active: remaining > 0,
  };
}

function ncs(id: number, remaining: number) {
  return {
    Id: id,
    ProductId: 100005,
    Name: "New Client Special",
    Count: 3,
    Remaining: remaining,
    ExpirationDate: FUTURE_EXP,
    Active: remaining > 0,
  };
}

function summary(
  services: Record<string, unknown>[],
  upcomingStarts: string[] = [],
) {
  return {
    clientId: 100002726,
    clientServices: { ClientServices: services },
    clientVisits: {
      Visits: upcomingStarts.map((start, i) => ({
        Id: 26000 + i,
        ClassId: 15000 + i,
        StartDateTime: start,
        Cancelled: false,
      })),
    },
  };
}

function homeAndScheduleCredits(payload: unknown): { home: string; schedule: number | null } {
  const vm = scheduleWalletViewModel(payload);
  const schedule =
    vm.kind === "packs" ? vm.packs.reduce((n, p) => n + p.remaining, 0) : null;
  return { home: creditsLabel(payload), schedule };
}

describe("wallet credits — two Drop-In services", () => {
  it("1 + 1 → 2 with no upcoming visits", () => {
    const s = summary([dropIn(22212, 1), dropIn(22270, 1)]);
    assert.equal(usableClassCreditsRemaining(s), 2);
    assert.equal(creditsLabel(s), "2");
    assert.equal(unaccountedUpcomingVisitCount(s), 0);
    const { home, schedule } = homeAndScheduleCredits(s);
    assert.equal(home, "2");
    assert.equal(schedule, 2);
  });

  it("0 + 1 with one upcoming already deducted → 1 (not 0)", () => {
    const s = summary([dropIn(22212, 0, { Active: false }), dropIn(22270, 1)], [FUTURE]);
    assert.equal(unaccountedUpcomingVisitCount(s), 0);
    assert.equal(usableClassCreditsRemaining(s), 1);
    assert.equal(creditsLabel(s), "1");
    const { home, schedule } = homeAndScheduleCredits(s);
    assert.equal(home, "1");
    assert.equal(schedule, 1);
  });

  it("0 + 0 → empty wallet", () => {
    const s = summary([dropIn(22212, 0, { Active: false }), dropIn(22270, 0, { Active: false })]);
    assert.equal(usableClassCreditsRemaining(s), 0);
    assert.equal(creditsLabel(s), "—");
    assert.equal(scheduleWalletViewModel(s).kind, "message");
  });

  it("member-summary refresh after book keeps 1", () => {
    const afterBook = summary(
      [dropIn(22212, 0, { Active: false }), dropIn(22270, 1)],
      [FUTURE],
    );
    assert.equal(creditsLabel(afterBook), "1");
  });

  it("cancellation restores 2", () => {
    const afterCancel = summary([dropIn(22212, 1), dropIn(22270, 1)]);
    assert.equal(creditsLabel(afterCancel), "2");
  });
});

describe("wallet credits — single pack unchanged", () => {
  it("one Drop-In with remaining 1 and no upcoming stays 1", () => {
    const s = summary([dropIn(22270, 1)]);
    assert.equal(creditsLabel(s), "1");
  });

  it("one Drop-In remaining 1 with lagged upcoming (used=0) shows 0", () => {
    const s = summary([dropIn(22270, 1)], [FUTURE]);
    assert.equal(unaccountedUpcomingVisitCount(s), 1);
    assert.equal(creditsLabel(s), "0");
  });
});

describe("wallet credits — mixed usable packs", () => {
  it("Drop-In + 10 pack sums remaining", () => {
    const s = summary([dropIn(22270, 1), tenPack(30001, 7)]);
    assert.equal(usableClassCreditsRemaining(s), 8);
    assert.equal(creditsLabel(s), "8");
  });

  it("NCS + Drop-In sums remaining", () => {
    const s = summary([ncs(11001, 2), dropIn(22270, 1)]);
    assert.equal(usableClassCreditsRemaining(s), 3);
    assert.equal(creditsLabel(s), "3");
  });

  it("does not count an expired pack that still reports remaining", () => {
    const s = summary([
      dropIn(22212, 1, { ExpirationDate: PAST_EXP, Active: true }),
      dropIn(22270, 1),
    ]);
    assert.equal(usableClassCreditsRemaining(s), 1);
    assert.equal(creditsLabel(s), "1");
  });
});

function unlimitedMonthly(remaining: number, extras: Record<string, unknown> = {}) {
  return {
    Id: 40001,
    ProductId: 100135,
    Name: "AMARÉ Monthly Unlimited",
    Count: 999999,
    Remaining: remaining,
    NumberDeducted: extras.NumberDeducted ?? 999999 - remaining,
    ExpirationDate: FUTURE_EXP,
    Active: true,
    ...extras,
  };
}

describe("wallet credits — unlimited membership", () => {
  it("full progress with zero upcoming bookings", () => {
    const s = summary([unlimitedMonthly(999999, { NumberDeducted: 0 })]);
    const vm = scheduleWalletViewModel(s);
    assert.equal(vm.kind, "packs");
    if (vm.kind !== "packs") return;
    assert.equal(vm.packs[0]?.isUnlimited, true);
    assert.equal(vm.packs[0]?.remaining, 1);
    assert.equal(vm.packs[0]?.total, 1);
    assert.equal(creditsLabel(s), "Unlimited");
    const layout = walletPunchSlotLayout(vm.packs[0].remaining, vm.packs[0].total, {
      isUnlimited: true,
    });
    assert.equal(layout.filled, layout.slotCount);
  });

  it("full progress after one booked class (remaining below sentinel)", () => {
    const s = summary([unlimitedMonthly(999998, { NumberDeducted: 1 })], [FUTURE]);
    const vm = scheduleWalletViewModel(s);
    assert.equal(vm.kind, "packs");
    if (vm.kind !== "packs") return;
    assert.equal(vm.packs[0]?.isUnlimited, true);
    assert.equal(vm.packs[0]?.remaining, 1);
    assert.equal(creditsLabel(s), "Unlimited");
    assert.equal(unaccountedUpcomingVisitCount(s), 0);
  });

  it("detects unlimited by name when remaining is finite", () => {
    const s = summary([
      {
        Id: 40002,
        Name: "AMARÉ Monthly Unlimited",
        Count: 2,
        Remaining: 1,
        NumberDeducted: 1,
        ExpirationDate: FUTURE_EXP,
        Active: true,
      },
    ]);
    const vm = scheduleWalletViewModel(s);
    assert.equal(vm.kind, "packs");
    if (vm.kind !== "packs") return;
    assert.equal(vm.packs[0]?.isUnlimited, true);
    assert.equal(vm.packs[0]?.remaining, 1);
    assert.equal(vm.packs[0]?.total, 1);
  });

  it("monthly 8 keeps finite progress", () => {
    const s = summary([
      {
        Id: 40003,
        ProductId: 100134,
        Name: "AMARÉ Monthly 8 Classes",
        Count: 8,
        Remaining: 6,
        NumberDeducted: 2,
        ExpirationDate: FUTURE_EXP,
        Active: true,
      },
    ]);
    const vm = scheduleWalletViewModel(s);
    assert.equal(vm.kind, "packs");
    if (vm.kind !== "packs") return;
    assert.equal(vm.packs[0]?.isUnlimited, false);
    assert.equal(vm.packs[0]?.remaining, 6);
    assert.equal(vm.packs[0]?.total, 8);
    const layout = walletPunchSlotLayout(vm.packs[0].remaining, vm.packs[0].total);
    assert.equal(layout.filled, 6);
    assert.equal(layout.slotCount, 8);
  });
});
