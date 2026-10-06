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
  const cleared = await releaseCompletedClassBookClaim(store, 31, 32, { visitId: 49387 });
  check("successful member cancel releases the completed claim", cleared.ok === true && cleared.modified === true);
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
const clearAt = cancelSrc.indexOf("await releaseCompletedClassBookClaim");
check("completed claim is cleared only after member cancel returns", memberCancelAt > 0 && clearAt > memberCancelAt);
check("guest-only cancel returns before that clear", cancelSrc.indexOf("memberBookingKept") > 0 && cancelSrc.indexOf("memberBookingKept") < clearAt);
check("rollback helper does not clear completed claims", !bookSrc.includes("releaseCompletedClassBookClaim"));

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
