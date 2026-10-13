import assert from "node:assert/strict";
import test from "node:test";
import { announcementBackdropDismissible } from "./AnnouncementDialog.tsx";

test("backdrop dismissible when acknowledgment not required", () => {
  assert.equal(announcementBackdropDismissible(false), true);
});

test("backdrop not dismissible when acknowledgment required", () => {
  assert.equal(announcementBackdropDismissible(true), false);
});
