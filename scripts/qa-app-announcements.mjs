/**
 * AMARÉ in-app announcement MVP — unit tests (lib + memory store semantics).
 * Run: node scripts/qa-app-announcements.mjs
 */

import assert from "node:assert/strict";
import {
  mapAnnouncementRow,
  parseAnnouncementSaveBody,
  shouldShowAnnouncementToUser,
  validateCtaUrl,
} from "../netlify/functions/app-announcement-lib.mjs";
import { createMemoryAnnouncementStore } from "../netlify/functions/app-announcement-store.mjs";

function check(name, cond) {
  assert.ok(cond, name);
  console.log(`ok ${name}`);
}

const now = Date.now();
const hour = 60 * 60 * 1000;

function ann(overrides = {}) {
  return mapAnnouncementRow({
    id: "a1",
    title: "T",
    message: "M",
    is_active: true,
    starts_at: new Date(now - hour),
    expires_at: new Date(now + hour),
    require_acknowledgment: false,
    cta_label: "Got it",
    cta_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
}

check("A no active announcement row → shouldShow false", !shouldShowAnnouncementToUser(ann({ is_active: false }), null));

check(
  "B not started → invisible",
  !shouldShowAnnouncementToUser(
    ann({
      starts_at: new Date(now + hour),
      expires_at: new Date(now + 2 * hour),
    }),
    null,
  ),
);

check(
  "C expired → invisible",
  !shouldShowAnnouncementToUser(
    ann({
      starts_at: new Date(now - 2 * hour),
      expires_at: new Date(now - hour),
    }),
    null,
  ),
);

check("D active eligible unseen → show", shouldShowAnnouncementToUser(ann(), null));

check(
  "E requireAck false + seen → hide",
  !shouldShowAnnouncementToUser(ann(), { first_seen_at: new Date().toISOString() }),
);

check(
  "F requireAck true + seen no ack → show",
  shouldShowAnnouncementToUser(ann({ require_acknowledgment: true }), {
    first_seen_at: new Date().toISOString(),
  }),
);

check(
  "G requireAck true + ack → hide",
  !shouldShowAnnouncementToUser(ann({ require_acknowledgment: true }), {
    first_seen_at: new Date().toISOString(),
    acknowledged_at: new Date().toISOString(),
  }),
);

const mem = createMemoryAnnouncementStore();
mem.upsertAnnouncement({
  id: "x1",
  is_active: false,
  title: "a",
  message: "b",
  starts_at: new Date(),
  expires_at: new Date(Date.now() + 3600000),
});
mem.upsertAnnouncement({
  id: "x2",
  is_active: false,
  title: "a",
  message: "b",
  starts_at: new Date(),
  expires_at: new Date(Date.now() + 3600000),
});
mem.setOnlyActive("x2");
check("L second activation deactivates first", mem.countActive() === 1);

const firstSeen = mem.recordSeen("x1", "usr_test1").first_seen_at;
mem.recordSeen("x1", "usr_test1");
check("H seen twice same first_seen_at", mem.getReceipt("x1", "usr_test1").first_seen_at === firstSeen);

const ack1 = mem.recordAck("x1", "usr_test2").acknowledged_at;
mem.recordAck("x1", "usr_test2");
check("I ack twice same acknowledged_at", mem.getReceipt("x1", "usr_test2").acknowledged_at === ack1);

check("N rejects javascript scheme", validateCtaUrl("javascript:alert(1)").ok === false);
check("N allows play store https", validateCtaUrl("https://play.google.com/store/apps/details?id=com.amarewellness.app").ok === true);

const badDates = parseAnnouncementSaveBody({ title: "Hi", message: "Body", startsAt: "", expiresAt: "" });
check("invalid dates rejected", badDates.ok === false);

console.log("qa-app-announcements: all passed");
