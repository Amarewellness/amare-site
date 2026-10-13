import assert from "node:assert/strict";
import test from "node:test";

test("null announcement response shape", () => {
  const data = { ok: true, announcement: null };
  assert.equal(data.ok, true);
  assert.equal(data.announcement, null);
});

test("active announcement parsing fields", () => {
  const ann = {
    id: "id-1",
    title: "Heads up",
    message: "Allow extra time.",
    requireAcknowledgment: true,
    ctaLabel: "Got it",
    ctaUrl: null,
  };
  assert.equal(ann.requireAcknowledgment, true);
  assert.equal(ann.ctaUrl, null);
});
