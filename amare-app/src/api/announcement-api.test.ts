import assert from "node:assert/strict";
import test from "node:test";
import { activeAnnouncementPath } from "./announcement-api.ts";

test("null announcement response shape", () => {
  const data = { ok: true, announcement: null };
  assert.equal(data.ok, true);
  assert.equal(data.announcement, null);
});

test("active API path includes display type", () => {
  assert.equal(activeAnnouncementPath("popup"), "/api/app/announcement/active?type=popup");
  assert.equal(activeAnnouncementPath("board"), "/api/app/announcement/active?type=board");
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
