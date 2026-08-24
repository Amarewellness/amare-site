/**
 * Bring a Friend early-cancel restore QA (blob logic + timing helpers).
 * Run: node scripts/qa-guest-pass-early-cancel-restore.mjs
 */
process.env.GUEST_PASS_BLOBS = "1";

import {
  cancelGuestPassSlot,
  emailReceivedKey,
  clientReceivedKey,
  findExistingGuestSlotConflict,
  phoneReceivedKey,
  reserveGuestPassSlot,
  restoreGuestPassSlotAfterEarlyCancel,
  readGuestPassUsage,
  usageKey,
  __testing,
} from "../netlify/functions/guest-pass-lib.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/** @returns {import("../netlify/functions/guest-pass-lib.mjs").BlobStore} */
function memoryStore() {
  /** @type {Map<string, { value: unknown; etag: string }>} */
  const backing = new Map();
  let etagSeq = 1;
  return {
    async get(key, opts) {
      if (opts?.type !== "json") return null;
      return backing.has(key) ? backing.get(key)?.value : null;
    },
    async getWithMetadata(key, opts) {
      if (opts?.type !== "json") return null;
      const row = backing.get(key);
      if (!row) return null;
      return { data: row.value, etag: row.etag };
    },
    async set(key, body, opts) {
      const parsed = JSON.parse(String(body));
      if (opts?.onlyIfNew && backing.has(key)) {
        return { modified: false };
      }
      if (opts?.onlyIfMatch) {
        const row = backing.get(key);
        if (!row || row.etag !== opts.onlyIfMatch) {
          return { modified: false };
        }
      }
      etagSeq += 1;
      backing.set(key, { value: parsed, etag: `etag-${etagSeq}` });
      return { modified: true, etag: `etag-${etagSeq}` };
    },
    async setJSON(key, value, opts) {
      if (opts?.onlyIfNew && backing.has(key)) {
        return { modified: false };
      }
      etagSeq += 1;
      backing.set(key, { value, etag: `etag-${etagSeq}` });
      return { modified: true, etag: `etag-${etagSeq}` };
    },
    async delete(key) {
      backing.delete(key);
    },
  };
}

const MEMBER = 100002726;
const PERIOD = "2026-09";
const CLASS_FUTURE = "2026-09-15T18:00:00-04:00";
const CLASS_SOON = "2026-09-15T12:00:00-04:00";
const NOW_EARLY = Date.parse("2026-09-14T12:00:00-04:00");
const NOW_LATE = Date.parse("2026-09-15T08:00:00-04:00");
const NOW_PAST = Date.parse("2026-09-16T12:00:00-04:00");

async function seedConfirmed(store) {
  const guestBookingId = "qa-baf-booking-1";
  const memberKey = usageKey(MEMBER, PERIOD);
  await store.setJSON(memberKey, {
    status: "confirmed",
    period: PERIOD,
    periodMode: "calendarMonth",
    entitlementSku: "monthly_8",
    memberClientId: MEMBER,
    guestClientId: 100003807,
    guestBookingId,
    classId: 9001,
    classDateTime: CLASS_FUTURE,
    className: "Reformer",
    guestFirstName: "Guest",
    guestLastName: "Example",
    guestEmailLower: "guest@example.com",
    guestPhoneNorm: "17865550100",
    confirmedAtIso: new Date().toISOString(),
  });
  await store.setJSON(emailReceivedKey("guest@example.com", PERIOD), {
    status: "confirmed",
    memberClientId: MEMBER,
    guestBookingId,
  });
  await store.setJSON(phoneReceivedKey("17865550100", PERIOD), {
    status: "confirmed",
    memberClientId: MEMBER,
    guestBookingId,
  });
  await store.setJSON(clientReceivedKey(100003807, PERIOD), {
    status: "confirmed",
    memberClientId: MEMBER,
    guestBookingId,
  });
}

// Timing helpers
{
  const early = __testing.guestPassCancelTiming({
    classDateTime: CLASS_FUTURE,
    memberLateCancel: false,
    nowMs: NOW_EARLY,
  });
  check("timing >12h before class → eligibleForEarlyRestore", early.eligibleForEarlyRestore === true);

  const late = __testing.guestPassCancelTiming({
    classDateTime: CLASS_SOON,
    memberLateCancel: false,
    nowMs: NOW_LATE,
  });
  check("timing <12h before class → effectiveLate", late.effectiveLate === true && late.eligibleForEarlyRestore === false);

  const passed = __testing.guestPassCancelTiming({
    classDateTime: CLASS_FUTURE,
    memberLateCancel: false,
    nowMs: NOW_PAST,
  });
  check("timing class passed → no early restore", passed.classAlreadyPassed === true && passed.eligibleForEarlyRestore === false);
}

// 1. Confirmed usage blocks re-invite
{
  const store = memoryStore();
  await seedConfirmed(store);
  const usage = await readGuestPassUsage(store, MEMBER, PERIOD);
  check("1 confirmed usage exists", usage?.status === "confirmed");
  const conflict = await findExistingGuestSlotConflict(store, {
    emailLower: "other@example.com",
    phoneNorm: "17865550999",
    periodKey: PERIOD,
    memberClientId: MEMBER,
  });
  check("1 used-this-period enforced while confirmed", conflict.conflict === true);
}

// 2. Early restore clears cap keys
{
  const store = memoryStore();
  await seedConfirmed(store);
  const restored = await restoreGuestPassSlotAfterEarlyCancel(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelledByMemberClientId: MEMBER,
  });
  check("2 early restore ok", restored.ok === true && restored.restored === true);
  check("2 usage key deleted", (await readGuestPassUsage(store, MEMBER, PERIOD)) == null);
  check("2 email cap deleted", (await store.get(emailReceivedKey("guest@example.com", PERIOD), { type: "json" })) == null);
  check("2 phone cap deleted", (await store.get(phoneReceivedKey("17865550100", PERIOD), { type: "json" })) == null);
  check("2 client cap deleted", (await store.get(clientReceivedKey(100003807, PERIOD), { type: "json" })) == null);
  const conflict = await findExistingGuestSlotConflict(store, {
    emailLower: "guest@example.com",
    phoneNorm: "17865550100",
    periodKey: PERIOD,
    memberClientId: MEMBER,
  });
  check("2 no conflict after restore", conflict.conflict === false);
}

// 3. Re-invite same period after restore
{
  const store = memoryStore();
  await seedConfirmed(store);
  await restoreGuestPassSlotAfterEarlyCancel(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelledByMemberClientId: MEMBER,
  });
  const again = await reserveGuestPassSlot(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    periodMode: "calendarMonth",
    entitlementSku: "monthly_8",
    guestEmailLower: "guest2@example.com",
    guestPhoneNorm: "17865550101",
    guestFirstName: "Guest",
    guestLastName: "Two",
    classId: 9002,
    classDateTime: CLASS_FUTURE,
    className: "Mat",
  });
  check("3 reserve after early restore succeeds", again.ok === true);
}

// 4. Late cancel keeps confirmed_cancelled
{
  const store = memoryStore();
  await seedConfirmed(store);
  const slot = await cancelGuestPassSlot(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelLateMember: true,
    cancelLateGuest: true,
    cancelledByMemberClientId: MEMBER,
  });
  check("4 late cancel slot ok", slot.ok === true);
  const usage = await readGuestPassUsage(store, MEMBER, PERIOD);
  check("4 status confirmed_cancelled", usage?.status === "confirmed_cancelled");
  const conflict = await findExistingGuestSlotConflict(store, {
    emailLower: "guest@example.com",
    phoneNorm: "17865550100",
    periodKey: PERIOD,
    memberClientId: MEMBER,
  });
  check("4 still blocked after late cancel", conflict.conflict === true);
}

// 5. Idempotent restore
{
  const store = memoryStore();
  await seedConfirmed(store);
  await restoreGuestPassSlotAfterEarlyCancel(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelledByMemberClientId: MEMBER,
  });
  const again = await restoreGuestPassSlotAfterEarlyCancel(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelledByMemberClientId: MEMBER,
  });
  check("5 restore retry idempotent", again.ok === true && again.alreadyRestored === true);
}

// 6. Idempotent late cancel
{
  const store = memoryStore();
  await seedConfirmed(store);
  await cancelGuestPassSlot(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelLateMember: true,
    cancelLateGuest: true,
    cancelledByMemberClientId: MEMBER,
  });
  const again = await cancelGuestPassSlot(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelLateMember: true,
    cancelLateGuest: true,
    cancelledByMemberClientId: MEMBER,
  });
  check("6 late cancel retry idempotent", again.ok === true && again.alreadyCancelled === true);
}

// 7. Cannot restore after late cancel
{
  const store = memoryStore();
  await seedConfirmed(store);
  await cancelGuestPassSlot(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelLateMember: true,
    cancelLateGuest: true,
    cancelledByMemberClientId: MEMBER,
  });
  const restored = await restoreGuestPassSlotAfterEarlyCancel(store, {
    memberClientId: MEMBER,
    periodKey: PERIOD,
    cancelledByMemberClientId: MEMBER,
  });
  check("7 no restore after late cancel", restored.reason === "already_late_cancelled");
  check("7 usage still present", (await readGuestPassUsage(store, MEMBER, PERIOD))?.status === "confirmed_cancelled");
}

console.log(failed ? `\n${failed} failed` : "\nAll early-cancel restore QA checks passed.");
process.exit(failed ? 1 : 0);
