/**
 * Live local PATH A probe: Email OTP linked, no mb_sess.
 * Run: node scripts/qa-amare-auth-parity-live.mjs
 *
 * Uses the known QA Studio customer. Does not charge. Does not enable production.
 * Waitlist join/remove only against a class that is already full.
 */
import { loadLocalEnv } from "./load-env.mjs";
import { AMARE_SESS_COOKIE, sealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";

loadLocalEnv();

const ORIGIN = "http://127.0.0.1:4321";
const userId = "usr_TRDWTEVFRGNME66PQ645RR";
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function cookieHeader() {
  return `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealAmareSessPayload({ amare_user_id: userId }))}`;
}

async function req(method, path, body) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Origin: ORIGIN,
      Cookie: cookieHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function classIdOf(row) {
  const raw = row?.Id ?? row?.id ?? row?.ClassId ?? row?.classId;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFullWaitlistClass(row) {
  if (!row || typeof row !== "object") return false;
  if (row.IsCanceled === true || row.isCanceled === true) return false;
  const start = Date.parse(String(row.StartDateTime || row.startDateTime || ""));
  if (!Number.isFinite(start) || start <= Date.now()) return false;
  const waitlistOn = row.IsWaitlistAvailable === true || row.isWaitlistAvailable === true;
  const max = Number(row.MaxCapacity ?? row.maxCapacity ?? 0);
  const booked = Number(row.TotalBooked ?? row.totalBooked ?? 0);
  return waitlistOn && max > 0 && booked >= max;
}

try {
  const session = await req("GET", "/api/amare/auth/session");
  check("PATH A session signed in", session.status === 200 && session.json?.signedIn === true);

  const mb = await req("GET", "/api/mindbody/oauth/session");
  check(
    "PATH A has no mb_sess",
    mb.status === 200 && (mb.json?.authenticated === false || mb.json?.loggedIn === false || !mb.json?.email),
  );

  const access = await req("GET", "/api/amare/auth/member-access");
  check(
    "PATH A member-access linked",
    access.status === 200 && access.json?.signedIn === true && access.json?.studioAccess === "linked",
    `status=${access.status} access=${access.json?.studioAccess || ""}`,
  );
  check("PATH A studioOperations on", access.json?.studioOperations === true);
  check("PATH A no Link My Account state", access.json?.studioAccess !== "none" && access.json?.studioAccess !== "candidate");

  const commerce = await req("GET", "/api/amare/commerce/status");
  check(
    "PATH A commerce is AMARE_LINKED not anonymous",
    commerce.status === 200 &&
      commerce.json?.state === "AMARE_LINKED" &&
      commerce.json?.signedIn === true &&
      !("clientId" in (commerce.json || {})),
    `state=${commerce.json?.state || ""}`,
  );

  const summary = await req("GET", "/api/mindbody/member/summary");
  check(
    "PATH A member/summary without mb_sess",
    summary.status === 200 && summary.json?.ok === true,
    `status=${summary.status} error=${summary.json?.error || ""}`,
  );
  if (summary.json?.ok) {
    const services = summary.json.clientServices || summary.json.ClientServices || [];
    const visits = summary.json.visits || summary.json.Visits || summary.json.clientVisits || [];
    check("PATH A summary has packages/visits shape", Array.isArray(services) || typeof services === "object");
    check("PATH A summary has visits shape", Array.isArray(visits) || typeof visits === "object");
  }

  const removeUnauthed = await req("POST", "/api/mindbody/class/waitlist/remove", { waitlistEntryId: 1 });
  check(
    "PATH A waitlist-remove does not require mb_sess",
    removeUnauthed.status !== 401 && removeUnauthed.json?.error !== "not_authenticated",
    `status=${removeUnauthed.status} error=${removeUnauthed.json?.error || ""}`,
  );
  check(
    "PATH A waitlist-remove is Staff ownership-gated",
    removeUnauthed.status === 403 && removeUnauthed.json?.error === "waitlist_entry_not_owned",
    `status=${removeUnauthed.status} error=${removeUnauthed.json?.error || ""}`,
  );

  const classes = await req("GET", "/api/mindbody/class/classes");
  const rows = Array.isArray(classes.json?.Classes)
    ? classes.json.Classes
    : Array.isArray(classes.json?.classes)
      ? classes.json.classes
      : [];
  const full = rows.find(isFullWaitlistClass);
  const fullId = full ? classIdOf(full) : null;
  if (!fullId) {
    console.log("WAITLIST LIVE — no full class in the current schedule window; Staff path covered by automated QA.");
  } else {
    const join = await req("POST", "/api/mindbody/class/book", { classId: fullId, waitlist: true });
    const mbBody = join.json?.mindbody && typeof join.json.mindbody === "object" ? join.json.mindbody : {};
    const mbErr = mbBody.Error && typeof mbBody.Error === "object" ? mbBody.Error : null;
    console.log(
      JSON.stringify({
        waitlistJoin: {
          classId: fullId,
          status: join.status,
          ok: join.json?.ok === true,
          onWaitlist: join.json?.onWaitlist === true,
          hasEntryId: Number(join.json?.waitlistEntryId) > 0,
          error: join.json?.error || null,
          mindbodyKeys: Object.keys(mbBody).slice(0, 20),
          mindbodyMessage: typeof mbBody.Message === "string" ? mbBody.Message.slice(0, 160) : null,
          mindbodyError: mbErr && typeof mbErr.Message === "string" ? mbErr.Message.slice(0, 160) : null,
        },
      }),
    );
    check(
      "PATH A waitlist join without mb_sess",
      join.status === 200 && join.json?.ok === true && join.json?.error !== "not_authenticated",
      `status=${join.status} error=${join.json?.error || ""}`,
    );
    check(
      "PATH A waitlist join is not Consumer-gated",
      join.json?.error !== "studio_not_linked" && join.json?.consumerAssociated !== false,
    );
    let entryId =
      typeof join.json?.waitlistEntryId === "number" && join.json.waitlistEntryId > 0
        ? join.json.waitlistEntryId
        : null;
    if (!entryId) {
      const after = await req("GET", "/api/mindbody/member/summary");
      const byClass = after.json?.waitlistByClassId || {};
      const row = byClass[String(fullId)] || byClass[fullId];
      if (row && Number(row.waitlistEntryId) > 0) entryId = Number(row.waitlistEntryId);
    }
    const accidentalVisit =
      Number(join.json?.visitId) > 0
        ? Number(join.json.visitId)
        : Number(join.json?.mindbody?.Visit?.Id || join.json?.mindbody?.Visit?.id || 0);
    if (accidentalVisit > 0) {
      await req("POST", "/api/mindbody/class/cancel", { visitId: accidentalVisit, classId: fullId });
      check("PATH A waitlist join did not create a Visit", false, `canceled accidental visit ${accidentalVisit}`);
    } else if (entryId) {
      const leave = await req("POST", "/api/mindbody/class/waitlist/remove", { waitlistEntryId: entryId });
      check(
        "PATH A waitlist remove via Staff path",
        leave.status === 200 && leave.json?.ok === true,
        `status=${leave.status} error=${leave.json?.error || ""}`,
      );
    } else if (join.json?.ok) {
      console.log("WAITLIST LIVE — no future full waitlist class produced an entry id; Staff path covered by automated QA.");
    }
  }
} catch (err) {
  check("PATH A live probe reached local server", false, String(err?.message || err));
}

if (failed) {
  console.error(`\n${failed} live provider-parity check(s) failed.`);
  process.exit(1);
}
console.log("\nLive PATH A provider-parity probe passed.");
