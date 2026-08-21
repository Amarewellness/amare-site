import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVE_MONTHLY_MEMBERSHIP_COPY,
  formatMembershipActive,
  hasActiveMonthlyMembership,
  hostedCheckoutFailureMessage,
  monthlyMembershipWindowActive,
} from "./member-profile-utils";

const NOW = Date.parse("2026-08-21T18:00:00.000Z");

const monthly8 = {
  ProductId: 100134,
  MembershipName: "8 monthly classes",
  Remaining: 0,
  Current: false,
  Active: false,
  ActiveDate: "2026-08-20T00:00:00",
  ExpirationDate: "2026-09-20T00:00:00",
};

describe("monthly membership Profile Active", () => {
  it("uses the date window, not Remaining/Current, for Stripe Monthly 8", () => {
    assert.equal(monthlyMembershipWindowActive(monthly8, NOW), true);
    assert.equal(formatMembershipActive(monthly8, NOW), "Yes");
  });

  it("is inactive after the window ends", () => {
    assert.equal(formatMembershipActive(monthly8, Date.parse("2026-09-21T12:00:00.000Z")), "No");
  });

  it("treats a memberships-table end date as Active when ActiveDate is absent", () => {
    assert.equal(
      formatMembershipActive(
        {
          MembershipName: "8 monthly classes",
          Current: false,
          Active: false,
          ExpirationDate: "2026-09-20T00:00:00",
        },
        NOW,
      ),
      "Yes",
    );
  });

  it("still recognizes a memberships-table name without ProductId", () => {
    const named = { ...monthly8 };
    delete (named as { ProductId?: number }).ProductId;
    assert.equal(formatMembershipActive(named, NOW), "Yes");
  });

  it("does not treat a drop-in service as monthly Active via date window", () => {
    assert.equal(
      formatMembershipActive(
        {
          ProductId: 22270,
          Name: "Drop-In",
          Active: false,
          Current: false,
          ExpirationDate: "2026-09-20T00:00:00",
        },
        NOW,
      ),
      "No",
    );
  });

  it("detects an active monthly from summary services or memberships", () => {
    assert.equal(
      hasActiveMonthlyMembership(
        {
          memberships: { ClientMemberships: [monthly8] },
          clientServices: { ClientServices: [] },
        },
        NOW,
      ),
      true,
    );
    assert.equal(hasActiveMonthlyMembership({ memberships: { ClientMemberships: [] } }, NOW), false);
  });
});

describe("hosted checkout membership block copy", () => {
  it("maps subscription_already_active to the studio-contact message", () => {
    assert.equal(
      hostedCheckoutFailureMessage(
        {
          error: "subscription_already_active",
          message: "You already have an active Amaré monthly membership. Please contact us to change plans.",
        },
        409,
      ),
      ACTIVE_MONTHLY_MEMBERSHIP_COPY,
    );
  });
});
