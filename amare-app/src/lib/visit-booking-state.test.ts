import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visitIsCancelledForBooking } from "./visit-booking-state.ts";

const FUTURE = "2099-06-15T18:00:00";

function baseVisit(overrides: Record<string, unknown> = {}) {
  return {
    Id: 9001,
    ClassId: 12885,
    StartDateTime: FUTURE,
    ...overrides,
  };
}

describe("visitIsCancelledForBooking", () => {
  it("active visit is not cancelled", () => {
    assert.equal(visitIsCancelledForBooking(baseVisit()), false);
  });

  it("LateCancelled=true is cancelled", () => {
    assert.equal(visitIsCancelledForBooking(baseVisit({ LateCancelled: true })), true);
  });

  it("AppointmentStatus Cancelled is cancelled", () => {
    assert.equal(
      visitIsCancelledForBooking(baseVisit({ AppointmentStatus: "Cancelled" })),
      true,
    );
  });

  it("AppointmentStatus Canceled is cancelled", () => {
    assert.equal(
      visitIsCancelledForBooking(baseVisit({ AppointmentStatus: "Canceled" })),
      true,
    );
  });

  it("Action late cancel is cancelled", () => {
    assert.equal(visitIsCancelledForBooking(baseVisit({ Action: "Late Cancel" })), true);
  });

  it("waitlist is not classified as cancelled", () => {
    assert.equal(visitIsCancelledForBooking(baseVisit({ Waitlist: true })), false);
  });

  it("Missed alone is not classified as cancelled", () => {
    assert.equal(visitIsCancelledForBooking(baseVisit({ Missed: true })), false);
  });

  it("NoShow status is not classified as cancelled", () => {
    assert.equal(
      visitIsCancelledForBooking(baseVisit({ AppointmentStatus: "NoShow" })),
      false,
    );
  });

  it("production Late Cancel A: Cancelled + LateCancelled + Missed", () => {
    assert.equal(
      visitIsCancelledForBooking(
        baseVisit({
          Id: 49823,
          ClassId: 18027,
          StartDateTime: "2026-10-13T19:00:00",
          AppointmentStatus: "Cancelled",
          LateCancelled: true,
          Missed: true,
          ServiceId: 34497,
          ProductId: 100135,
        }),
      ),
      true,
    );
  });

  it("production Late Cancel B: Cancelled + Missed without LateCancelled flag", () => {
    assert.equal(
      visitIsCancelledForBooking(
        baseVisit({
          AppointmentStatus: "Cancelled",
          LateCancelled: false,
          Missed: true,
        }),
      ),
      true,
    );
  });

  it("production C: Booked + Missed is not cancelled", () => {
    assert.equal(
      visitIsCancelledForBooking(
        baseVisit({
          AppointmentStatus: "Booked",
          LateCancelled: false,
          Missed: true,
        }),
      ),
      false,
    );
  });

  it("production D: NoShow + Missed is not cancelled for booking UI", () => {
    assert.equal(
      visitIsCancelledForBooking(
        baseVisit({
          AppointmentStatus: "NoShow",
          LateCancelled: false,
          Missed: true,
        }),
      ),
      false,
    );
  });
});
