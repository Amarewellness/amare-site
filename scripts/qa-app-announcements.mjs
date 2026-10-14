/**
 * AMARÉ in-app announcement — unit tests (lib + memory store semantics).
 * Run: node scripts/qa-app-announcements.mjs
 */

import assert from "node:assert/strict";
import {
  DISPLAY_TYPE_BOARD,
  DISPLAY_TYPE_POPUP,
  mapAnnouncementRow,
  normalizeDisplayType,
  parseAnnouncementSaveBody,
  shouldShowAnnouncementToUser,
  shouldShowBoardAnnouncementToUser,
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
    display_type: DISPLAY_TYPE_POPUP,
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

function boardAnn(overrides = {}) {
  return ann({ display_type: DISPLAY_TYPE_BOARD, id: "board1", ...overrides });
}

check(
  "A existing row without display_type migrates to popup",
  mapAnnouncementRow({
    id: "legacy",
    title: "T",
    message: "M",
    is_active: false,
    starts_at: new Date(),
    expires_at: new Date(now + hour),
    require_acknowledgment: false,
    cta_label: "Got it",
    cta_url: null,
  }).displayType === DISPLAY_TYPE_POPUP,
);

check("normalizeDisplayType board", normalizeDisplayType("board") === DISPLAY_TYPE_BOARD);
check("normalizeDisplayType default popup", normalizeDisplayType("") === DISPLAY_TYPE_POPUP);

check("legacy no active → shouldShow false", !shouldShowAnnouncementToUser(ann({ is_active: false }), null));

check(
  "popup not started → invisible",
  !shouldShowAnnouncementToUser(
    ann({
      starts_at: new Date(now + hour),
      expires_at: new Date(now + 2 * hour),
    }),
    null,
  ),
);

check(
  "popup expired → invisible",
  !shouldShowAnnouncementToUser(
    ann({
      starts_at: new Date(now - 2 * hour),
      expires_at: new Date(now - hour),
    }),
    null,
  ),
);

check("popup active eligible unseen → show", shouldShowAnnouncementToUser(ann(), null));

check(
  "M popup requireAck false + seen → hide",
  !shouldShowAnnouncementToUser(ann(), { first_seen_at: new Date().toISOString() }),
);

check(
  "popup requireAck true + seen no ack → show",
  shouldShowAnnouncementToUser(ann({ require_acknowledgment: true }), {
    first_seen_at: new Date().toISOString(),
  }),
);

check(
  "popup requireAck true + ack → hide",
  !shouldShowAnnouncementToUser(ann({ require_acknowledgment: true }), {
    first_seen_at: new Date().toISOString(),
    acknowledged_at: new Date().toISOString(),
  }),
);

check("G board not started → not returned", !shouldShowBoardAnnouncementToUser(
  boardAnn({
    starts_at: new Date(now + hour),
    expires_at: new Date(now + 2 * hour),
  }),
));

check("H board expired → not returned", !shouldShowBoardAnnouncementToUser(
  boardAnn({
    starts_at: new Date(now - 2 * hour),
    expires_at: new Date(now - hour),
  }),
));

check("I board inactive → not returned", !shouldShowBoardAnnouncementToUser(boardAnn({ is_active: false })));

check("J eligible board → returned", shouldShowBoardAnnouncementToUser(boardAnn()));

check(
  "K board user already has first_seen_at → STILL returned",
  shouldShowBoardAnnouncementToUser(boardAnn()) &&
    shouldShowBoardAnnouncementToUser(boardAnn()),
);

check(
  "L board user already acknowledged → STILL returned (visibility ignores receipt)",
  shouldShowBoardAnnouncementToUser(boardAnn()) &&
    !shouldShowAnnouncementToUser(
      boardAnn(),
      { first_seen_at: new Date().toISOString(), acknowledged_at: new Date().toISOString() },
    ),
);

const mem = createMemoryAnnouncementStore();
const windowRow = {
  title: "a",
  message: "b",
  starts_at: new Date(now - hour),
  expires_at: new Date(now + hour),
};

mem.upsertAnnouncement({
  id: "p1",
  display_type: DISPLAY_TYPE_POPUP,
  is_active: true,
  ...windowRow,
});
mem.upsertAnnouncement({
  id: "p2",
  display_type: DISPLAY_TYPE_POPUP,
  is_active: false,
  ...windowRow,
});
check("B one active popup → allowed", mem.countActiveByType(DISPLAY_TYPE_POPUP) === 1);

mem.setOnlyActiveByType("p2");
check(
  "C second active popup → first deactivated",
  mem.countActiveByType(DISPLAY_TYPE_POPUP) === 1 &&
    mem.getAnnouncement("p1").is_active === false &&
    mem.getAnnouncement("p2").is_active === true,
);

mem.upsertAnnouncement({
  id: "b1",
  display_type: DISPLAY_TYPE_BOARD,
  is_active: true,
  ...windowRow,
});
check("D one active board → allowed", mem.countActiveByType(DISPLAY_TYPE_BOARD) === 1);
check(
  "E popup + board active simultaneously → allowed",
  mem.countActiveByType(DISPLAY_TYPE_POPUP) === 1 && mem.countActiveByType(DISPLAY_TYPE_BOARD) === 1,
);

mem.upsertAnnouncement({
  id: "b2",
  display_type: DISPLAY_TYPE_BOARD,
  is_active: false,
  ...windowRow,
});
mem.setOnlyActiveByType("b2");
check(
  "F second board activation → previous board deactivated",
  mem.countActiveByType(DISPLAY_TYPE_BOARD) === 1 &&
    mem.getAnnouncement("b1").is_active === false &&
    mem.getAnnouncement("b2").is_active === true,
);

mem.upsertAnnouncement({ id: "x1", display_type: DISPLAY_TYPE_POPUP, is_active: false, ...windowRow });

const firstSeen = mem.recordSeen("x1", "usr_test1").first_seen_at;
mem.recordSeen("x1", "usr_test1");
check("N board/popup seen twice same first_seen_at", mem.getReceipt("x1", "usr_test1").first_seen_at === firstSeen);

const ack1 = mem.recordAck("x1", "usr_test2").acknowledged_at;
mem.recordAck("x1", "usr_test2");
check("ack twice same acknowledged_at", mem.getReceipt("x1", "usr_test2").acknowledged_at === ack1);

check("cta rejects javascript scheme", validateCtaUrl("javascript:alert(1)").ok === false);
check("cta allows play store https", validateCtaUrl("https://play.google.com/store/apps/details?id=com.amarewellness.app").ok === true);

const badDates = parseAnnouncementSaveBody({ title: "Hi", message: "Body", startsAt: "", expiresAt: "" });
check("invalid dates rejected", badDates.ok === false);

const boardSave = parseAnnouncementSaveBody({
  title: "Board",
  message: "Msg",
  startsAt: "2026-10-14T09:00",
  expiresAt: "2026-10-15T09:00",
  displayType: "board",
  requireAcknowledgment: true,
});
check(
  "board save forces requireAck false",
  boardSave.ok === true && boardSave.value.requireAcknowledgment === false,
);

check(
  "J user who saw campaign A still eligible for campaign B",
  shouldShowAnnouncementToUser(ann({ id: "campaign_b" }), null) &&
    !shouldShowAnnouncementToUser(ann({ id: "campaign_a" }), {
      first_seen_at: new Date().toISOString(),
    }),
);

check(
  "K editing same id keeps seen users hidden (popup)",
  !shouldShowAnnouncementToUser(ann({ id: "campaign_a", title: "Updated title" }), {
    first_seen_at: new Date().toISOString(),
  }),
);

console.log("qa-app-announcements: all passed");
