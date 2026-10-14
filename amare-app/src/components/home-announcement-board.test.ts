import assert from "node:assert/strict";
import test from "node:test";
import {
  boardCtaVisible,
  shouldPostBoardSeen,
  shouldRenderHomeBoard,
} from "./home-announcement-board-helpers.ts";

const sampleBoard = {
  id: "b1",
  title: "THIS WEEK AT AMARÉ ✨",
  message: "Plan ahead.",
  requireAcknowledgment: false,
  ctaLabel: "View Schedule",
  ctaUrl: null as string | null,
};

test("O null board → should not render", () => {
  assert.equal(shouldRenderHomeBoard(null), false);
});

test("board exists → should render", () => {
  assert.equal(shouldRenderHomeBoard(sampleBoard), true);
});

test("optional CTA hidden without url", () => {
  assert.equal(boardCtaVisible(sampleBoard), false);
  assert.equal(boardCtaVisible({ ...sampleBoard, ctaUrl: "https://www.amarewellness.com/schedule" }), true);
});

test("seen tracking posts once per announcement id", () => {
  assert.equal(shouldPostBoardSeen("b1", null), true);
  assert.equal(shouldPostBoardSeen("b1", "b1"), false);
  assert.equal(shouldPostBoardSeen("b2", "b1"), true);
});

test("seen tracking does not imply hide (render still true with receipt)", () => {
  assert.equal(shouldRenderHomeBoard(sampleBoard), true);
});
