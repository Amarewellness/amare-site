/**
 * Duplicate class-booking guard. Local only. No Mindbody writes.
 * Run: node scripts/qa-class-book-duplicate-guard.mjs
 */
import fs from "node:fs";
import {
  CLASS_BOOK_CLAIM_TTL_MS,
  CLASS_BOOK_COMPLETED_TTL_MS,
  acquireClassBookClaim,
  classBookClaimKey,
  completeClassBookClaim,
  completedVisitIdFromRecord,
  createMemoryClassBookClaimStore,
  guardNormalSeatBeforeMutation,
  isActiveEnrolledClassVisit,
  isAmbiguousClassBookTransportFailure,
  releaseClassBookClaim,
  releaseCompletedClassBookClaim,
  clearCompletedClassBookClaimForCancelledVisit,
} from "../netlify/functions/class-book-claim.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const bookSrc = fs.readFileSync(new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url), "utf8");
const deferredSrc = fs.readFileSync(
  new URL("../netlify/functions/mindbody-deferred-class-book.mjs", import.meta.url),
  "utf8",
);
const webSrc = fs.readFileSync(new URL("../src/js/classes-schedule.js", import.meta.url), "utf8");
const mobileSchedule = fs.readFileSync(
  new URL("../amare-app/src/screens/ScheduleScreen.tsx", import.meta.url),
  "utf8",
);
const mobileErrors = fs.readFileSync(
  new URL("../amare-app/src/api/booking-errors.ts", import.meta.url),
  "utf8",
);
const mobilePayload = fs.readFileSync(
  new URL("../amare-app/src/lib/cancellation-policy.ts", import.meta.url),
  "utf8",
);
const claimSrc = fs.readFileSync(new URL("../netlify/functions/class-book-claim.mjs", import.meta.url), "utf8");
const cancelSrc = fs.readFileSync(new URL("../netlify/functions/mindbody-class-cancel.mjs", import.meta.url), "utf8");

function visit(partial) {
  return {
    Id: 1,
    ClassId: 13645,
    LateCancelled: false,
    AppointmentStatus: "Booked",
    Action: "None",
    ...partial,
  };
}

console.log("=== Active visit definition ===");
check("booked same class is active", isActiveEnrolledClassVisit(visit({ Id: 49387 }), 13645));
check("signed-in no-show still occupies the seat", isActiveEnrolledClassVisit(visit({ AppointmentStatus: "NoShow", SignedIn: true }), 13645));
check("missed future row still active", isActiveEnrolledClassVisit(visit({ Missed: true, AppointmentStatus: "Booked" }), 13645));
check("late cancelled is not active", !isActiveEnrolledClassVisit(visit({ LateCancelled: true }), 13645));
check("cancelled status is not active", !isActiveEnrolledClassVisit(visit({ AppointmentStatus: "Cancelled" }), 13645));
check("waitlist status is not active", !isActiveEnrolledClassVisit(visit({ AppointmentStatus: "Waitlisted" }), 13645));
check("other class is not active", !isActiveEnrolledClassVisit(visit({ ClassId: 99 }), 13645));
check("missing visit id is not active", !isActiveEnrolledClassVisit(visit({ Id: 0 }), 13645));

console.log("\n=== Claim atomicity ===");
{
  const store = createMemoryClassBookClaimStore();
  const [a, b] = await Promise.all([
    acquireClassBookClaim(store, 100003540, 13645),
    acquireClassBookClaim(store, 100003540, 13645),
  ]);
  const wins = [a, b].filter((r) => r.ok);
  check("concurrent acquire: exactly one winner", wins.length === 1, `wins=${wins.length}`);
  check("claim key", classBookClaimKey(100003540, 13645) === "class-book:100003540:13645");
  check("ttl is 45s", CLASS_BOOK_CLAIM_TTL_MS === 45_000);
  check("onlyIfNew via atomicCreateJSON, not setJSON onlyIfNew", claimSrc.includes("atomicCreateJSON") && claimSrc.includes("onlyIfMatch"));
}

console.log("\n=== Muriel +12s with a stale visit list ===");
{
  const store = createMemoryClassBookClaimStore();
  let mindbodyVisitId = null;
  let adds = 0;
  const clientId = 100003540;
  const classId = 13645;
  const first = await guardNormalSeatBeforeMutation({
    store,
    clientId,
    classId,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: mindbodyVisitId }),
  });
  check("request A acquires in_progress", first.action === "proceed" && first.claim?.record?.state === "in_progress");
  adds += 1;
  const completedAt = Date.now() - 12_000;
  const completed = await completeClassBookClaim(store, first.claim, 49387, {
    nowMs: completedAt,
    ttlMs: CLASS_BOOK_COMPLETED_TTL_MS,
  });
  check("request A transitions to completed", completed.ok === true && completed.modified === true);
  const stored = await store.get(classBookClaimKey(clientId, classId), { type: "json" });
  check("completed claim stores visitId", stored?.state === "completed" && stored?.visitId === 49387);
  check("completed TTL is 45s", CLASS_BOOK_COMPLETED_TTL_MS === 45_000 && stored.expiresAtMs - stored.completedAtMs === 45_000);
  mindbodyVisitId = null;
  const second = await guardNormalSeatBeforeMutation({
    store,
    clientId,
    classId,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: mindbodyVisitId }),
  });
  check("stale retry returns the completed visitId", second.action === "already_booked" && second.visitId === 49387);
  check("stale retry does not AddClientToClass", adds === 1);
  check("release after success cannot wipe completed", (await releaseClassBookClaim(store, first.claim), (await store.get(classBookClaimKey(clientId, classId), { type: "json" }))?.state === "completed"));
}

console.log("\n=== Concurrent requests ===");
{
  const store = createMemoryClassBookClaimStore();
  let visitId = null;
  let adds = 0;
  async function book(authSource) {
    const guard = await guardNormalSeatBeforeMutation({
      store,
      clientId: 100003540,
      classId: 13645,
      authSource,
      readVisits: async () => ({ ok: true, visitId }),
    });
    if (guard.action !== "proceed") return guard.action;
    adds += 1;
    visitId = 49387;
    await completeClassBookClaim(store, guard.claim, visitId);
    return "booked";
  }
  const results = await Promise.all([book("amare"), book("deferred")]);
  check("one proceeds", results.filter((r) => r === "booked").length === 1, results.join(","));
  check("other does not add", results.some((r) => r === "in_progress" || r === "already_booked"));
  check("concurrent: one AddClientToClass", adds === 1, `adds=${adds}`);
}

console.log("\n=== Held claim, visit not visible yet ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 3, 4);
  const guard = await guardNormalSeatBeforeMutation({
    store,
    clientId: 3,
    classId: 4,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  check("second request is in_progress", guard.action === "in_progress");
  check("second request does not receive the claim", guard.claim == null);
  await releaseClassBookClaim(store, held);
}

console.log("\n=== Crash before mutation, then expiry ===");
{
  const store = createMemoryClassBookClaimStore();
  const crashed = await acquireClassBookClaim(store, 5, 6, { ttlMs: -1000 });
  check("crashed holder acquired", crashed.ok === true);
  const next = await acquireClassBookClaim(store, 5, 6);
  check("expired claim can be taken", next.ok === true && next.owner !== crashed.owner);
}

console.log("\n=== Release lets the next book proceed ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 8, 9);
  await releaseClassBookClaim(store, held);
  const again = await acquireClassBookClaim(store, 8, 9);
  check("released claim is immediately reusable", again.ok === true);
}

console.log("\n=== Verify rollback releases; Resend failure stays completed ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 11, 12);
  try {
    throw new Error("payment verification failed");
  } catch {
    await releaseClassBookClaim(store, held);
  }
  const afterRollback = await store.get(classBookClaimKey(11, 12), { type: "json" });
  check("verify rollback leaves no completed claim", afterRollback?.state !== "completed");
  const next = await acquireClassBookClaim(store, 11, 12);
  check("claim is reusable after a verify failure releases it", next.ok === true);
  await completeClassBookClaim(store, next, 49388);
  try {
    throw new Error("resend failed");
  } catch {
    /* email failure must not release the guard */
  }
  const afterEmail = await store.get(classBookClaimKey(11, 12), { type: "json" });
  check("Resend failure leaves the completed claim", afterEmail?.state === "completed" && afterEmail?.visitId === 49388);
  const stale = await guardNormalSeatBeforeMutation({
    store,
    clientId: 11,
    classId: 12,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  check("stale retry after Resend failure returns the visit", stale.action === "already_booked" && stale.visitId === 49388);
}

console.log("\n=== Completed expiry still defers to the visit preflight ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 21, 22);
  await completeClassBookClaim(store, held, 500, { ttlMs: -1000 });
  const blocked = await guardNormalSeatBeforeMutation({
    store,
    clientId: 21,
    classId: 22,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: 500 }),
  });
  check("expired completed claim still blocks when the Visit is visible", blocked.action === "already_booked" && blocked.visitId === 500);
  const open = await guardNormalSeatBeforeMutation({
    store,
    clientId: 21,
    classId: 22,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  check("expired completed claim does not block forever", open.action === "proceed");
  if (open.claim) await releaseClassBookClaim(store, open.claim);
}

console.log("\n=== Cancel then rebook ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 31, 32);
  await completeClassBookClaim(store, held, 49387);
  const inProgress = await acquireClassBookClaim(store, 31, 99);
  const spared = await releaseCompletedClassBookClaim(store, 31, 99, { visitId: 1 });
  check("cancel does not clear a different class", spared.ok === true && spared.modified === false);
  check("cancel does not clear an in-progress claim", (await store.get(classBookClaimKey(31, 99), { type: "json" }))?.state === "in_progress");
  await releaseClassBookClaim(store, inProgress);
  const mismatch = await releaseCompletedClassBookClaim(store, 31, 32, { visitId: 999 });
  check("failed or different visit does not clear completed", mismatch.modified !== true);
  check(
    "completed remains when cancel does not succeed",
    completedVisitIdFromRecord(await store.get(classBookClaimKey(31, 32), { type: "json" })) === 49387,
  );
  const beforeClear = await store.get(classBookClaimKey(31, 32), { type: "json" });
  const cleared = await clearCompletedClassBookClaimForCancelledVisit(store, 31, 32, 49387);
  check("successful member cancel releases the completed claim", cleared.ok === true && cleared.modified === true && cleared.reason === "released");
  check(
    "cancel clear does not require the booking owner",
    typeof beforeClear?.owner === "string" && beforeClear.owner.length > 0 && cleared.modified === true,
  );
  let adds = 0;
  const rebook = await guardNormalSeatBeforeMutation({
    store,
    clientId: 31,
    classId: 32,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  if (rebook.action === "proceed") adds += 1;
  check("cancel then rebook can proceed when no Visit remains", rebook.action === "proceed" && adds === 1);
  if (rebook.claim) await releaseClassBookClaim(store, rebook.claim);
}

console.log("\n=== Cancel clear conditions ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 51, 52);
  await completeClassBookClaim(store, held, 100);
  const wrong = await clearCompletedClassBookClaimForCancelledVisit(store, 51, 52, 101);
  check("cancel of a different visit leaves the completed claim", wrong.modified !== true && wrong.reason === "visit_mismatch");
  check(
    "visit 100 remains after visit 101 cancel",
    completedVisitIdFromRecord(await store.get(classBookClaimKey(51, 52), { type: "json" })) === 100,
  );
  const replaced = await acquireClassBookClaim(store, 61, 62);
  await completeClassBookClaim(store, replaced, 100);
  const key = classBookClaimKey(61, 62);
  const completed = await store.get(key, { type: "json" });
  await store.set(
    key,
    JSON.stringify({ ...completed, state: "in_progress", visitId: null, released: false, expiresAtMs: Date.now() + 45000 }),
  );
  const sparedProgress = await clearCompletedClassBookClaimForCancelledVisit(store, 61, 62, 100);
  check("in_progress claim survives a cancel for the old visit", sparedProgress.reason === "state_mismatch");
  check(
    "in_progress record was not released",
    (await store.get(key, { type: "json" }))?.state === "in_progress",
  );

  const failed = createMemoryClassBookClaimStore();
  const failedHold = await acquireClassBookClaim(failed, 71, 72);
  await completeClassBookClaim(failed, failedHold, 100);
  const still = await guardNormalSeatBeforeMutation({
    store: failed,
    clientId: 71,
    classId: 72,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  check("failed cancel leaves the completed claim blocking a retry", still.action === "already_booked" && still.visitId === 100);
}

function casScriptStore(reads, failMatches) {
  const sets = [];
  let readIndex = 0;
  let live = reads[0];
  return {
    sets,
    live: () => live,
    async get(_key, opts) {
      return opts?.type === "json" ? live.data : JSON.stringify(live.data);
    },
    async getWithMetadata() {
      const row = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      live = row;
      return { data: row.data, etag: row.etag };
    },
    async set(_key, body, opts) {
      const parsed = JSON.parse(body);
      sets.push({ onlyIfMatch: opts?.onlyIfMatch ?? null, onlyIfNew: opts?.onlyIfNew === true, state: parsed.state });
      if (!opts?.onlyIfMatch || failMatches.includes(opts.onlyIfMatch) || opts.onlyIfMatch !== live.etag) {
        return { modified: false };
      }
      live = { data: parsed, etag: `etag-${sets.length}` };
      return { modified: true, etag: live.etag };
    },
  };
}

function completedRow(visitId, etag) {
  return {
    etag,
    data: {
      state: "completed",
      visitId,
      released: false,
      owner: "booking-owner",
      expiresAtMs: Date.now() + 45000,
    },
  };
}

console.log("\n=== Cancel clear CAS ===");
{
  const moved = casScriptStore(
    [
      completedRow(100, "e1"),
      {
        etag: "e2",
        data: { state: "in_progress", visitId: null, released: false, owner: "newer-booking", expiresAtMs: Date.now() + 45000 },
      },
    ],
    ["e1"],
  );
  const raced = await clearCompletedClassBookClaimForCancelledVisit(moved, 81, 82, 100);
  check("CAS conflict that became in_progress is not cleared", raced.reason === "state_mismatch" && raced.modified !== true);
  check("newer in_progress claim remains", moved.live().data.state === "in_progress");
  check(
    "clear did not blind-set the raced claim",
    moved.sets.length === 1 && moved.sets[0].onlyIfMatch === "e1" && moved.sets[0].onlyIfNew === false,
  );

  const same = casScriptStore([completedRow(100, "e1"), completedRow(100, "e2")], ["e1"]);
  const retried = await clearCompletedClassBookClaimForCancelledVisit(same, 83, 84, 100);
  check("CAS conflict retries while the same completed visit remains", retried.reason === "released" && retried.modified === true);
  check("retried clear released the claim", same.live().data.state === "released" && same.live().data.expiresAtMs === 0);
  check(
    "both clear writes were If-Match CAS",
    same.sets.length === 2 && same.sets.every((call) => typeof call.onlyIfMatch === "string" && call.onlyIfNew === false),
  );
}

console.log("\n=== Recovered visit becomes completed ===");
{
  const store = createMemoryClassBookClaimStore();
  const held = await acquireClassBookClaim(store, 41, 42);
  const failure = { ok: false, status: 504, data: { _mbFetchTimeout: true } };
  const recoveredVisitId = 49388;
  let adds = 1;
  if (isAmbiguousClassBookTransportFailure(failure) && recoveredVisitId) {
    await completeClassBookClaim(store, held, recoveredVisitId);
  } else {
    adds += 1;
  }
  const retry = await guardNormalSeatBeforeMutation({
    store,
    clientId: 41,
    classId: 42,
    authSource: "amare",
    readVisits: async () => ({ ok: true, visitId: null }),
  });
  check("recovered visit is a completed claim", retry.action === "already_booked" && retry.visitId === 49388 && adds === 1);
}

console.log("\n=== Ambiguous timeout recovery ===");
check(
  "504/timeout is ambiguous",
  isAmbiguousClassBookTransportFailure({ ok: false, status: 504, data: { _mbFetchTimeout: true } }),
);
check(
  "Mindbody 400 is not ambiguous",
  !isAmbiguousClassBookTransportFailure({ ok: false, status: 400, data: { Error: { Message: "Client is already booked" } } }),
);
{
  let adds = 0;
  const failure = { ok: false, status: 504, data: { _mbFetchTimeout: true } };
  const visitId = 49388;
  if (isAmbiguousClassBookTransportFailure(failure) && visitId) {
    /* recovered — do not add */
  } else {
    adds += 1;
  }
  check("timeout after commit does not add again", adds === 0);
}

console.log("\n=== Handler preserves existing safety ===");
const guardAt = bookSrc.indexOf("await guardNormalSeatBeforeMutation");
const addAt = bookSrc.indexOf("await tryBookWith(", guardAt);
const capacityAt = bookSrc.indexOf('guardStaffNormalSeat("amare_direct"', guardAt);
const dateAt = bookSrc.indexOf("noCreditsValidForClassDateResponse");
check("preflight/claim is before AddClientToClass", guardAt > 0 && guardAt < addAt);
check("class-date rejection stays before the claim", dateAt > 0 && dateAt < guardAt);
check("capacity guard still runs after the claim", capacityAt > guardAt);
check("RequirePayment still set for paid seats", bookSrc.includes("if (requirePayment) payload.RequirePayment = true"));
check("payment verify still runs", bookSrc.includes("verifyBookPaymentApplied"));
check("rollback still runs", bookSrc.includes("rollbackFailedPaymentBooking"));
check("Resend still after verify", bookSrc.includes("sendVerifiedClassBookingConfirmationEmail"));
check("waitlist skips the seat claim", bookSrc.includes("if (!waitlist)") && bookSrc.includes("const guardHeaders"));
check("claim released in finally", bookSrc.includes("releaseClassBookClaim"));
check("recovered visit does not start a second add inside tryBookWith", bookSrc.includes("class_book_existing_visit_recovered"));
check("dedupe response is HTTP 200 with visitId", bookSrc.includes("alreadyBooked: true") && bookSrc.includes("status: 200"));
check("in-progress response has human detail", bookSrc.includes("booking_in_progress") && bookSrc.includes("detail: BOOKING_IN_PROGRESS_DETAIL"));
check(
  "ambiguous transport does not continue service fallbacks",
  bookSrc.includes("!isAmbiguousClassBookTransportFailure(r)"),
);
check("email failure does not roll back a verified visit", bookSrc.includes("Email failure must not roll back the verified visit"));
const completeAt = bookSrc.indexOf("await completeClassBookClaim");
const emailSendAt = bookSrc.indexOf("await sendVerifiedClassBookingConfirmationEmail");
check("completed claim is written before Resend", completeAt > 0 && emailSendAt > completeAt);
check("verified booking does not drop the claim in finally", bookSrc.includes("if (classBookClaim && !retainClassBookClaim)"));

console.log("\n=== Deferred shares the claim ===");
check("deferred uses the same guard", deferredSrc.includes("guardNormalSeatBeforeMutation"));
check("deferred releases the claim", deferredSrc.includes("releaseClassBookClaim"));
check("deferred recovers ambiguous transport", deferredSrc.includes("class_book_existing_visit_recovered"));
check("deferred still verifies payment", deferredSrc.includes("verifyBookPaymentApplied"));
check("deferred still rolls back unpaid visits", deferredSrc.includes("rollbackBookedVisit"));
check(
  "deferred ambiguous miss stays retryable",
  deferredSrc.includes('reason: "ambiguous_transport"'),
);
check("deferred success completes the shared claim", deferredSrc.includes("await completeClassBookClaim"));
check("deferred finally keeps a completed claim", deferredSrc.includes("if (!retainClassBookClaim && guard.claim"));

console.log("\n=== Member cancel integration ===");
const memberCancelAt = cancelSrc.indexOf("await cancelMemberVisit");
const clearAt = cancelSrc.indexOf("await clearCompletedClassBookClaimForCancelledVisit");
check("completed claim is cleared only after member cancel returns", memberCancelAt > 0 && clearAt > memberCancelAt);
check(
  "clear runs only after Mindbody cancel succeeds",
  cancelSrc.slice(memberCancelAt, clearAt).includes("if (r.ok)"),
);
check("guest-only cancel returns before that clear", cancelSrc.indexOf("memberBookingKept") > 0 && cancelSrc.indexOf("memberBookingKept") < clearAt);
check("rollback helper does not clear completed claims", !bookSrc.includes("clearCompletedClassBookClaimForCancelledVisit"));
check("booking-owner release still refuses a completed claim", bookSrc.includes("releaseClassBookClaim") && !bookSrc.includes("clearCompletedClassBookClaimForCancelledVisit"));

console.log("\n=== Web success dialog ===");
const confirmAt = webSrc.indexOf("confirm.textContent = \"Book Class\"");
const immediateAt = webSrc.indexOf("applyLocalEnrollmentChange(cid, result.visitId)");
const doneSlice = webSrc.slice(webSrc.indexOf("done.textContent = result.ok"), webSrc.indexOf("done.textContent = result.ok") + 900);
check("enrollment is applied when the book response is accepted", confirmAt > 0 && immediateAt > confirmAt);
check("Done handler does not commit enrollment", !doneSlice.includes("applyLocalEnrollmentChange"));

console.log("\n=== Released mobile payload and error copy ===");
check("book payload has no client idempotency field", !mobilePayload.includes("idempotency"));
check("schedule still posts the same book endpoint", mobileSchedule.includes('"/api/mindbody/class/book"'));
check(
  "success still keys off numeric visitId",
  mobileSchedule.includes("typeof res.visitId === \"number\" && res.visitId > 0"),
);
const detailFn = mobileErrors.slice(mobileErrors.indexOf("function mindbodyMessage"), mobileErrors.indexOf("function interpretMessage"));
check("mobile reads detail before falling through", detailFn.includes("j.detail") && detailFn.indexOf("j.detail") < detailFn.lastIndexOf("return \"\""));
check(
  "summary refresh still clears the optimistic patch (future UX issue, unchanged)",
  mobileSchedule.includes("setEnrollmentPatch(new Map())"),
);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll duplicate-guard checks passed.");
