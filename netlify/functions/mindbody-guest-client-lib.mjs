import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";

/** @param {string} email */
export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
}

/** @param {string} phone */
export function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  return digits.slice(0, 15);
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

/** @param {unknown} row */
function emailFromRow(row) {
  if (!row || typeof row !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (row);
  const e = o.Email ?? o.email;
  return typeof e === "string" ? e.trim().toLowerCase() : "";
}

/** @param {unknown} row */
function clientIdFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  const id = o.Id ?? o.id ?? o.ClientId ?? o.clientId;
  const n = typeof id === "number" ? id : typeof id === "string" ? parseInt(id, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {unknown} row @param {string} phoneNorm */
function phoneMatchesRow(row, phoneNorm) {
  if (!row || typeof row !== "object" || !phoneNorm) return false;
  const o = /** @type {Record<string, unknown>} */ (row);
  const target = digitsOnly(phoneNorm).slice(-10);
  if (!target) return false;
  for (const k of ["MobilePhone", "HomePhone", "WorkPhone", "Phone", "mobilePhone"]) {
    const d = digitsOnly(String(o[k] ?? "")).slice(-10);
    if (d && d === target) return true;
  }
  return false;
}

/** @param {unknown} data */
function clientsArrayFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  const arr = d.Clients ?? d.clients;
  return Array.isArray(arr) ? arr : [];
}

/**
 * @param {Record<string, string>} headers
 * @param {string} searchText
 */
async function searchClients(headers, searchText) {
  if (!searchText) return [];
  const q = new URLSearchParams();
  q.set("request.searchText", searchText);
  q.set("request.limit", "100");
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/client/clients?${q}`, headers, null);
  if (!r.ok) return [];
  return clientsArrayFromPayload(r.data);
}

/** @param {unknown} data */
function extractNewClientId(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const c = d.Client ?? d.client;
  if (c && typeof c === "object") {
    const id = clientIdFromRow(c);
    if (id) return id;
  }
  const top = d.ClientId ?? d.clientId ?? d.Id;
  const n = typeof top === "number" ? top : typeof top === "string" ? parseInt(top, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function errorHintsDuplicateClient(msg) {
  if (!msg || typeof msg !== "string") return false;
  const s = msg.toLowerCase();
  return (
    /\balready\s+exist/.test(s) ||
    /\bduplicate\b/.test(s) ||
    /\bmust\s+be\s+unique\b/.test(s) ||
    /(email|e-mail).*(\balready\b|\btaken\b|\bin\s+use\b|\bregistered\b|\bassigned\b|\bduplicate\b)/.test(s)
  );
}

/** @param {unknown} data */
function mindbodyErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const mbErr = d.Error;
  if (mbErr && typeof mbErr === "object") {
    const m = /** @type {{ Message?: unknown }} */ (mbErr).Message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (typeof d.Message === "string" && d.Message.trim()) return d.Message.trim();
  return null;
}

/** @typedef {typeof searchClients} SearchClientsFn */

/**
 * @param {Record<string, string>} headers
 * @param {string} emailLower
 * @param {SearchClientsFn} search
 */
async function emailExactMatches(headers, emailLower, search = searchClients) {
  if (!emailLower) return [];
  return (await search(headers, emailLower)).filter((row) => emailFromRow(row) === emailLower);
}

/**
 * @param {Record<string, string>} headers
 * @param {string} phoneNorm
 * @param {SearchClientsFn} search
 */
async function phoneExactMatches(headers, phoneNorm, search = searchClients) {
  if (!phoneNorm) return [];
  return (await search(headers, phoneNorm)).filter((row) => phoneMatchesRow(row, phoneNorm));
}

/** @param {unknown[]} matches @param {"email"|"phone"} matchedBy */
function outcomeFromExactMatches(matches, matchedBy) {
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "guest_lookup_ambiguous",
      matchedBy,
      candidateClientIds: matches.map((r) => clientIdFromRow(r)).filter((id) => id != null),
    };
  }
  if (matches.length === 1) {
    const id = clientIdFromRow(matches[0]);
    if (id) return { ok: true, guestClientId: id, matchedBy };
  }
  return null;
}

/**
 * @param {Record<string, string>} headers
 * @param {string} emailLower
 * @param {string} phoneNorm
 * @param {SearchClientsFn} search
 */
async function retryLookupAfterDuplicate(headers, emailLower, phoneNorm, search = searchClients) {
  const emailOutcome = outcomeFromExactMatches(await emailExactMatches(headers, emailLower, search), "email");
  if (emailOutcome) return emailOutcome;

  if (phoneNorm) {
    const phoneOutcome = outcomeFromExactMatches(await phoneExactMatches(headers, phoneNorm, search), "phone");
    if (phoneOutcome) return phoneOutcome;
  }

  return null;
}

/**
 * Post-create safety: block booking when Mindbody now has duplicate or conflicting identity.
 * @param {Record<string, string>} headers
 * @param {string} emailLower
 * @param {string} phoneNorm
 * @param {number} newId
 * @param {SearchClientsFn} search
 */
async function validatePostCreateDuplicateSafety(headers, emailLower, phoneNorm, newId, search = searchClients) {
  const emailMatches = await emailExactMatches(headers, emailLower, search);
  if (emailMatches.length > 1) {
    return {
      ok: false,
      reason: "guest_lookup_ambiguous",
      matchedBy: "email",
      candidateClientIds: emailMatches.map((r) => clientIdFromRow(r)).filter((id) => id != null),
    };
  }
  if (emailMatches.length === 1) {
    const existingId = clientIdFromRow(emailMatches[0]);
    if (existingId && existingId !== newId) {
      return {
        ok: false,
        reason: "guest_lookup_ambiguous",
        matchedBy: "email",
        candidateClientIds: [existingId, newId],
      };
    }
  }

  if (phoneNorm) {
    const phoneMatches = await phoneExactMatches(headers, phoneNorm, search);
    if (phoneMatches.length > 1) {
      return {
        ok: false,
        reason: "guest_lookup_ambiguous",
        matchedBy: "phone",
        candidateClientIds: phoneMatches.map((r) => clientIdFromRow(r)).filter((id) => id != null),
      };
    }
    if (phoneMatches.length === 1) {
      const existingId = clientIdFromRow(phoneMatches[0]);
      if (existingId && existingId !== newId) {
        return {
          ok: false,
          reason: "guest_lookup_ambiguous",
          matchedBy: "phone",
          candidateClientIds: [existingId, newId],
        };
      }
    }
  }

  return { ok: true, guestClientId: newId, matchedBy: "created" };
}

/**
 * @param {{
 *   firstName: string;
 *   lastName: string;
 *   emailLower: string;
 *   phoneNorm: string;
 *   staffHeaders: Record<string, string>;
 *   deps?: { searchClients?: SearchClientsFn; fetchMb?: typeof fetchMb };
 * }} opts
 */
export async function findOrCreateGuestClient(opts) {
  const search = opts.deps?.searchClients ?? searchClients;
  const fetch = opts.deps?.fetchMb ?? fetchMb;

  const emailOutcome = outcomeFromExactMatches(
    await emailExactMatches(opts.staffHeaders, opts.emailLower, search),
    "email",
  );
  if (emailOutcome) return emailOutcome;

  if (opts.phoneNorm) {
    const phoneOutcome = outcomeFromExactMatches(
      await phoneExactMatches(opts.staffHeaders, opts.phoneNorm, search),
      "phone",
    );
    if (phoneOutcome) return phoneOutcome;
  }

  /** @type {Record<string, unknown>} */
  const clientRow = {
    FirstName: opts.firstName,
    LastName: opts.lastName,
    Email: opts.emailLower,
    Active: true,
    ...(opts.phoneNorm ? { MobilePhone: opts.phoneNorm } : {}),
  };
  const nestedPayload = {
    Client: clientRow,
    Test: false,
    SendAccountEmails: false,
    SendScheduleEmails: false,
    SendPromotionalEmails: false,
    SendEmail: false,
  };
  /** @type {Record<string, unknown>} */
  const flatPayload = {
    ...clientRow,
    Test: false,
    SendAccountEmails: false,
    SendScheduleEmails: false,
    SendPromotionalEmails: false,
    SendEmail: false,
  };
  const path = `/public/v${MB_API_VERSION}/client/addclient`;
  let r = await fetch("POST", path, opts.staffHeaders, nestedPayload);
  if (!r.ok && r.status === 400) {
    r = await fetch("POST", path, opts.staffHeaders, flatPayload);
  }
  if (!r.ok) {
    const msg = mindbodyErrorMessage(r.data);
    if (msg && errorHintsDuplicateClient(msg)) {
      const retry = await retryLookupAfterDuplicate(
        opts.staffHeaders,
        opts.emailLower,
        opts.phoneNorm,
        search,
      );
      if (retry) {
        if (retry.ok || retry.reason === "guest_lookup_ambiguous") return retry;
      }
    }
    return { ok: false, reason: "mindbody_guest_create_failed", mindbodyMessage: msg, data: r.data };
  }
  const newId = extractNewClientId(r.data);
  if (!newId) {
    return { ok: false, reason: "mindbody_guest_create_failed", mindbodyMessage: "no_client_id_in_response" };
  }
  return validatePostCreateDuplicateSafety(opts.staffHeaders, opts.emailLower, opts.phoneNorm, newId, search);
}

export const __testing = {
  emailExactMatches,
  phoneExactMatches,
  outcomeFromExactMatches,
  retryLookupAfterDuplicate,
  validatePostCreateDuplicateSafety,
  errorHintsDuplicateClient,
};

/**
 * @param {{ guestClientId: number; classId: number; staffHeaders: Record<string, string> }} opts
 */
export async function isGuestAlreadyBookedToClass(opts) {
  const q = new URLSearchParams({
    "request.clientId": String(opts.guestClientId),
    "request.classId": String(opts.classId),
    "request.limit": "20",
  });
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientvisits?${q}`,
    opts.staffHeaders,
    null,
  );
  if (!r.ok) return { booked: false };
  const d = r.data && typeof r.data === "object" ? /** @type {Record<string, unknown>} */ (r.data) : {};
  const visits = d.Visits ?? d.visits;
  if (!Array.isArray(visits)) return { booked: false };
  for (const raw of visits) {
    if (!raw || typeof raw !== "object") continue;
    const v = /** @type {Record<string, unknown>} */ (raw);
    const signedIn = v.SignedIn ?? v.signedIn;
    if (signedIn === true) continue;
    const cancelled =
      v.Cancelled === true ||
      v.cancelled === true ||
      v.LateCancelled === true ||
      v.lateCancelled === true;
    const status = String(v.AppointmentStatus ?? v.appointmentStatus ?? v.Action ?? v.action ?? "").toLowerCase();
    if (cancelled || /cancel|no.?show|missed/.test(status)) continue;
    const cid = v.ClassId ?? v.classId;
    if (cid != null && Number(cid) !== opts.classId) continue;
    const vid = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    const visitId =
      typeof vid === "number" ? vid : typeof vid === "string" && /^\d+$/.test(vid) ? parseInt(vid, 10) : null;
    return {
      booked: true,
      existingVisitId: visitId,
      visitStatus: status || "booked",
    };
  }
  return { booked: false };
}

/**
 * @param {{ guestClientId: number; classId: number; guestVisitId: number; lateCancel: boolean; staffHeaders: Record<string, string> }} opts
 */
export async function cancelGuestVisit(opts) {
  /** @type {Record<string, unknown>} */
  const payload = {
    ClientId: opts.guestClientId,
    ClassId: opts.classId,
    VisitId: opts.guestVisitId,
    SendEmail: false,
  };
  if (opts.lateCancel) payload.LateCancel = true;
  const r = await fetchMb(
    "POST",
    `/public/v${MB_API_VERSION}/class/removeclientfromclass`,
    opts.staffHeaders,
    payload,
  );
  if (!r.ok) {
    return { ok: false, status: r.status, mindbodyResponse: r.data };
  }
  return { ok: true, mindbodyResponse: r.data };
}

/**
 * @param {unknown} data
 * @param {number} classId
 * @param {number} guestClientId
 */
export function extractGuestVisitIdFromBookResponse(data, classId, guestClientId) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);

  /** @param {unknown} row */
  function pickId(row) {
    if (!row || typeof row !== "object") return null;
    const v = /** @type {Record<string, unknown>} */ (row);
    const id = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    return id != null && Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : null;
  }

  /** @param {unknown} row */
  function matches(row) {
    if (!row || typeof row !== "object") return false;
    const v = /** @type {Record<string, unknown>} */ (row);
    const cid = v.ClassId ?? v.classId;
    const clientId = v.ClientId ?? v.clientId;
    const classOk = cid == null || Number(cid) === classId;
    const clientOk = clientId == null || Number(clientId) === guestClientId;
    return classOk && clientOk;
  }

  const wrappedClass =
    d.Class && typeof d.Class === "object" ? /** @type {Record<string, unknown>} */ (d.Class) : null;
  if (wrappedClass) {
    const visitsRaw = wrappedClass.Visits ?? wrappedClass.visits;
    if (Array.isArray(visitsRaw)) {
      for (const row of visitsRaw) {
        if (matches(row)) {
          const id = pickId(row);
          if (id) return id;
        }
      }
      for (const row of visitsRaw) {
        const id = pickId(row);
        if (id) return id;
      }
    }
  }
  for (const k of ["Visit", "visit"]) {
    const id = pickId(d[k]);
    if (id) return id;
  }
  return null;
}
