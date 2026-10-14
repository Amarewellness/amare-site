import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEnrollmentVisitMap,
  mergeEnrollmentVisitMaps,
  reconcileEnrollmentPatchMap,
} from "./member-summary.ts";
import { upcomingVisitsFromSummary } from "./visit-utils.ts";

const FUTURE = "2099-06-15T18:00:00";
const CLASS_ID = 12885;
const VISIT_ID = 49750;

function summaryWithVisits(visits: Record<string, unknown>[]) {
  return { clientVisits: { Visits: visits } };
}

function activeVisit() {
  return {
    Id: VISIT_ID,
    ClassId: CLASS_ID,
    StartDateTime: FUTURE,
  };
}

function lateCancelledVisit() {
  return {
    Id: VISIT_ID,
    ClassId: CLASS_ID,
    StartDateTime: FUTURE,
    LateCancelled: true,
  };
}

/** Real production Late Cancel shape (49823 / 49824). */
function productionLateCancelVisit49823() {
  return {
    Id: 49823,
    ClassId: 18027,
    StartDateTime: "2026-10-13T19:00:00",
    AppointmentStatus: "Cancelled",
    LateCancelled: true,
    Missed: true,
    ServiceId: 34497,
    ProductId: 100135,
  };
}

function productionLateCancelVisit49824() {
  return {
    Id: 49824,
    ClassId: 14657,
    StartDateTime: "2026-10-13T18:30:00",
    AppointmentStatus: "Cancelled",
    LateCancelled: true,
    Missed: true,
    ServiceId: 34497,
    ProductId: 100135,
  };
}

describe("buildEnrollmentVisitMap", () => {
  it("maps active upcoming visit", () => {
    const map = buildEnrollmentVisitMap(summaryWithVisits([activeVisit()]));
    assert.equal(map.get(CLASS_ID), VISIT_ID);
  });

  it("ignores LateCancelled visit in stale summary", () => {
    const map = buildEnrollmentVisitMap(summaryWithVisits([lateCancelledVisit()]));
    assert.equal(map.has(CLASS_ID), false);
  });

  it("excludes production Late Cancel 49823 / 49824 (LateCancelled + Missed)", () => {
    const summary = summaryWithVisits([
      productionLateCancelVisit49823(),
      productionLateCancelVisit49824(),
    ]);
    const map = buildEnrollmentVisitMap(summary);
    assert.equal(map.has(18027), false);
    assert.equal(map.has(14657), false);
  });
});

describe("upcomingVisitsFromSummary", () => {
  it("excludes LateCancelled from My Classes upcoming", () => {
    const rows = upcomingVisitsFromSummary(summaryWithVisits([lateCancelledVisit()]));
    assert.equal(rows.length, 0);
  });

  it("excludes production 49823 / 49824 from My Classes upcoming", () => {
    const rows = upcomingVisitsFromSummary(
      summaryWithVisits([productionLateCancelVisit49823(), productionLateCancelVisit49824()]),
    );
    assert.equal(rows.length, 0);
    assert.equal(
      rows.some((r) => Number(r.Id) === 49823 || Number(r.Id) === 49824),
      false,
    );
  });
});

describe("cancel flow with stale summary", () => {
  it("Schedule stays unbooked after cancel patch + LateCancelled summary", () => {
    const apiMap = buildEnrollmentVisitMap(summaryWithVisits([lateCancelledVisit()]));
    const patch = new Map<number, number | null>([[CLASS_ID, null]]);
    const merged = mergeEnrollmentVisitMaps(apiMap, patch);
    assert.equal(merged.has(CLASS_ID), false);
  });

  it("reconcile drops cancel patch when summary no longer enrolls class", () => {
    const stale = summaryWithVisits([lateCancelledVisit()]);
    const patch = new Map<number, number | null>([[CLASS_ID, null]]);
    const next = reconcileEnrollmentPatchMap(stale, patch);
    assert.equal(next.has(CLASS_ID), false);
    const merged = mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(stale), next);
    assert.equal(merged.has(CLASS_ID), false);
  });

  it("alreadyCancelled success path: stale LateCancelled summary stays unbooked", () => {
    const stale = summaryWithVisits([lateCancelledVisit()]);
    const merged = mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(stale), new Map());
    assert.equal(merged.has(CLASS_ID), false);
  });

  it("reconcile clears cancel patch when production LateCancelled+Missed rows excluded", () => {
    const stale = summaryWithVisits([
      productionLateCancelVisit49823(),
      productionLateCancelVisit49824(),
    ]);
    const patch = new Map<number, number | null>([
      [18027, null],
      [14657, null],
    ]);
    const next = reconcileEnrollmentPatchMap(stale, patch);
    assert.equal(next.has(18027), false);
    assert.equal(next.has(14657), false);
    const merged = mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(stale), next);
    assert.equal(merged.has(18027), false);
    assert.equal(merged.has(14657), false);
  });
});

describe("book patch regression", () => {
  it("keeps book patch until summary confirms visit", () => {
    const empty = summaryWithVisits([]);
    const patch = new Map<number, number | null>([[CLASS_ID, VISIT_ID]]);
    const next = reconcileEnrollmentPatchMap(empty, patch);
    assert.equal(next.get(CLASS_ID), VISIT_ID);
    const merged = mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(empty), next);
    assert.equal(merged.get(CLASS_ID), VISIT_ID);
  });

  it("clears book patch once summary contains the visit", () => {
    const withVisit = summaryWithVisits([activeVisit()]);
    const patch = new Map<number, number | null>([[CLASS_ID, VISIT_ID]]);
    const next = reconcileEnrollmentPatchMap(withVisit, patch);
    assert.equal(next.has(CLASS_ID), false);
  });
});

describe("cancel patch lifecycle", () => {
  it("keeps cancel patch while summary still shows active enrollment", () => {
    const withActive = summaryWithVisits([activeVisit()]);
    const patch = new Map<number, number | null>([[CLASS_ID, null]]);
    const next = reconcileEnrollmentPatchMap(withActive, patch);
    assert.equal(next.get(CLASS_ID), null);
    const merged = mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(withActive), next);
    assert.equal(merged.has(CLASS_ID), false);
  });
});
