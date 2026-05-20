import {
  decodeJwtPayload,
  mindbodyMembershipLeadingSiteId,
  pickMindbodyTokenSiteId,
} from "./oauth-lib.mjs";
import {
  MB_API_VERSION,
  clientsList,
  extractClientIdFromCompleteInfoPayload,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  getSessionWithConsumerHeaders,
  jsonResponse,
  pickClientByEmail,
  tryResolveClientId,
  visitsList,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import { loadMbContractTermsConfig } from "./load-mb-contract-terms.mjs";

/**
 * Build the public, member-safe projection of a SubscriptionRecord for
 * `/api/mindbody/member/summary`. Strips PII, internal IDs, agreement-text
 * hashes, and audit fields — exposes only the data the member dashboard
 * needs to overlay commitment dates on top of the Mindbody Memberships
 * table (§ 9.18).
 *
 * The `mindbodyMembershipTypeId` is resolved server-side from
 * `mb-contract-terms.config.json::byCheckoutServiceId` so the frontend can
 * match each Mindbody Membership row to its originating Stripe subscription
 * without needing to know about that mapping.
 *
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord} sub
 * @param {Record<string, string> | undefined} byCheckoutServiceId
 */
function publicSubscriptionCommitment(sub, byCheckoutServiceId) {
  let mindbodyMembershipTypeId = null;
  if (byCheckoutServiceId && Number.isFinite(sub.mindbodyServiceId)) {
    const mapped = byCheckoutServiceId[String(sub.mindbodyServiceId)];
    if (typeof mapped === "string" && mapped.trim()) {
      const n = Number(mapped);
      if (Number.isFinite(n) && n > 0) mindbodyMembershipTypeId = n;
    }
  }
  return {
    localSku: sub.localSku,
    displayName: sub.displayName,
    status: sub.status,
    mindbodyServiceId: sub.mindbodyServiceId,
    mindbodyMembershipTypeId,
    commitmentStartDate: sub.commitmentStartDate,
    commitmentEndDate: sub.commitmentEndDate,
    minimumCommitmentMonths: sub.minimumCommitmentMonths,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
  };
}

const V = MB_API_VERSION;

/** @param {unknown} data */
function paginationTotalResults(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of ["PaginationResponse", "Pagination"]) {
    const p = d[key];
    if (p && typeof p === "object") {
      const t = /** @type {Record<string, unknown>} */ (p).TotalResults;
      if (typeof t === "number") return t;
    }
  }
  return null;
}

/**
 * History + upcoming: API skips visits before `request.startDate` unless it is in the past.
 * Paginates when `TotalResults` exceeds one `limit` page.
 * @param {number} clientId
 * @param {Record<string, string>} authHeaders
 */
async function fetchClientVisitsAggregated(clientId, authHeaders) {
  const limit = 200;
  const visitStart = new Date();
  visitStart.setUTCFullYear(visitStart.getUTCFullYear() - 2);
  visitStart.setUTCHours(0, 0, 0, 0);
  const visitEnd = new Date();
  visitEnd.setUTCDate(visitEnd.getUTCDate() + 366);
  visitEnd.setUTCHours(23, 59, 59, 999);

  /** @type {Record<string, unknown>[]} */
  const merged = [];
  const seenIds = new Set();
  let offset = 0;
  /** @type {number | null} */
  let totalResults = null;

  for (let guard = 0; guard < 25; guard++) {
    const qVisits = new URLSearchParams({
      "request.clientId": String(clientId),
      "request.startDate": visitStart.toISOString(),
      "request.endDate": visitEnd.toISOString(),
      "request.limit": String(limit),
      "request.offset": String(offset),
    });
    const r = await fetchMb("GET", `/public/v${V}/client/clientvisits?${qVisits}`, authHeaders, null);
    if (!r.ok) {
      return { ok: false, status: r.status, data: r.data };
    }
    totalResults = paginationTotalResults(r.data) ?? totalResults;
    const batch = visitsList(r.data);
    for (const item of batch) {
      if (!item || typeof item !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (item);
      const vid = row.Id ?? row.id;
      const dedupe =
        vid != null && vid !== ""
          ? `id:${String(vid)}`
          : `row:${String(row.StartDateTime ?? "")}:${String(row.Name ?? "")}`;
      if (seenIds.has(dedupe)) continue;
      seenIds.add(dedupe);
      merged.push(row);
    }

    const got = merged.length;
    const cap = typeof totalResults === "number" ? totalResults : null;
    if (batch.length < limit || batch.length === 0) break;
    if (cap != null && got >= cap) break;
    offset += limit;
  }

  return {
    ok: true,
    status: 200,
    data: {
      Visits: merged,
      PaginationResponse: {
        RequestedLimit: limit,
        RequestedOffset: 0,
        PageSize: merged.length,
        TotalResults:
          typeof totalResults === "number" ? Math.max(totalResults, merged.length) : merged.length,
      },
    },
  };
}

/** Align with public schedule strip (`DAY_STRIP_LEN = 14` in classes-schedule.js). */
const SCHEDULE_WINDOW_DAYS = 14;

/** @param {unknown} data */
function waitlistEntriesList(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const key of ["WaitlistEntries", "waitlistEntries"]) {
    const v = d[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * @param {unknown[]} entries
 * @returns {Record<string, { waitlistEntryId: number, orderNumber: number | null }>}
 */
function buildWaitlistByClassId(entries) {
  /** @type {Record<string, { waitlistEntryId: number, orderNumber: number | null }>} */
  const out = {};
  const nowMs = Date.now();
  const endMs = nowMs + SCHEDULE_WINDOW_DAYS * 86400000;

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const classIdRaw = row.ClassId ?? row.classId;
    const entryIdRaw = row.Id ?? row.id ?? row.WaitlistEntryId ?? row.waitlistEntryId;
    const classId =
      typeof classIdRaw === "number"
        ? classIdRaw
        : typeof classIdRaw === "string"
          ? parseInt(classIdRaw, 10)
          : NaN;
    const entryId =
      typeof entryIdRaw === "number"
        ? entryIdRaw
        : typeof entryIdRaw === "string"
          ? parseInt(entryIdRaw, 10)
          : NaN;
    if (!Number.isFinite(classId) || classId <= 0 || !Number.isFinite(entryId) || entryId <= 0) continue;

    const startRaw =
      row.StartDateTime ??
      row.startDateTime ??
      row.ClassStartDateTime ??
      row.classStartDateTime;
    if (startRaw != null && startRaw !== "") {
      const startMs = Date.parse(String(startRaw));
      if (!Number.isNaN(startMs) && (startMs < nowMs || startMs > endMs)) continue;
    }

    const orderRaw = row.OrderNumber ?? row.orderNumber ?? row.Position ?? row.position;
    const orderNumber =
      typeof orderRaw === "number" && Number.isFinite(orderRaw)
        ? orderRaw
        : typeof orderRaw === "string" && orderRaw.trim()
          ? parseInt(orderRaw, 10)
          : null;

    out[String(classId)] = {
      waitlistEntryId: entryId,
      orderNumber: orderNumber != null && Number.isFinite(orderNumber) ? orderNumber : null,
    };
  }
  return out;
}

/** Mindbody requires staff credentials for `GET class/waitlistentries` (consumer token returns 400). */
async function staffHeadersForWaitlistRead() {
  const staffIssued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
  /** @type {Record<string, string> | null} */
  let staffHeaders =
    staffIssued.ok === true ? mindbodyStaffBearerHeaders(staffIssued.accessToken) : null;
  if (!staffHeaders) staffHeaders = mindbodyStaffApiHeaders();
  return staffHeaders;
}

/**
 * @param {string | number} clientId
 */
async function fetchClientWaitlistByClassId(clientId) {
  const staffHeaders = await staffHeadersForWaitlistRead();
  if (!staffHeaders) {
    return { ok: false, status: 0, waitlistByClassId: {} };
  }
  const q = new URLSearchParams({
    "request.clientIds": String(clientId),
    "request.hidePastEntries": "true",
    "request.limit": "200",
    "request.offset": "0",
  });
  const r = await fetchMb("GET", `/public/v${V}/class/waitlistentries?${q}`, staffHeaders, null);
  if (!r.ok) {
    return { ok: false, status: r.status, waitlistByClassId: {} };
  }
  return {
    ok: true,
    status: r.status,
    waitlistByClassId: buildWaitlistByClassId(waitlistEntriesList(r.data)),
  };
}

/**
 * @param {Record<string,string>} authHeaders
 * @param {string} searchText
 * @param {number} limit
 */
async function clientSearchTrace(authHeaders, searchText, limit) {
  const q = new URLSearchParams();
  q.set("request.searchText", searchText.trim());
  q.set("request.limit", String(limit));
  const r = await fetchMb("GET", `/public/v${V}/client/clients?${q}`, authHeaders, null);
  const list = clientsList(r.data);
  let errMsg;
  if (r.data && typeof r.data === "object") {
    const inner = /** @type {{ Error?: { Message?: string } }} */ (r.data).Error;
    if (inner && typeof inner === "object" && typeof inner.Message === "string") errMsg = inner.Message;
  }
  return {
    httpStatus: r.status,
    ok: r.ok,
    clientsReturned: list.length,
    totalResults: paginationTotalResults(r.data),
    errorMessage: errMsg ? errMsg.slice(0, 280) : undefined,
  };
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const auth = await getSessionWithConsumerHeaders(event);
  if (!auth.ok) return auth.response;

  const setHdr = auth.setCookie ? { "Set-Cookie": auth.setCookie } : {};

  const qs = event.queryStringParameters || {};
  const traceLink = qs.trace === "1";

  const { session, email } = auth;
  const clientId = await tryResolveClientId(session, email, auth.authHeaders, auth.accessToken);

  if (clientId == null) {
    /** @type {string[]} */
    const wr = ["could_not_resolve_client"];
    if ((process.env.MINDBODY_SITE_ID?.trim() || "-99") === "-99") {
      wr.push("hint_production_site_id");
    }
    /** @type {Record<string, unknown> | undefined} */
    let linkDiag = undefined;
    if (traceLink) {
      const atClaims = decodeJwtPayload(auth.accessToken);
      const jwtSite = pickMindbodyTokenSiteId(atClaims) ?? null;
      const envSite = (process.env.MINDBODY_SITE_ID || "").trim() || "-99";
      const effectiveSite =
        envSite && envSite !== "-99" ? envSite : jwtSite ?? envSite;
      linkDiag = {
        siteIdEnv: envSite,
        siteIdFromAccessTokenJwt: jwtSite,
        effectiveSiteIdHeader: effectiveSite,
        accessTokenJwtClaimKeys: Object.keys(atClaims).sort(),
        membershipIdentifierSiteHint: (() => {
          for (const [k, val] of Object.entries(atClaims)) {
            const tail = k.replace(/\\/g, "/").toLowerCase();
            if (!(tail.endsWith("/membershipidentifier") || tail === "membershipidentifier"))
              continue;
            /**
             * @type {unknown}
             */
            const v = val;
            return mindbodyMembershipLeadingSiteId(v);
          }
          return null;
        })(),
      };
      if (email) {
        linkDiag.emailSearch = await clientSearchTrace(auth.authHeaders, email, 8);
      }
      const nameTrace = typeof session.name === "string" ? session.name.trim() : "";
      if (nameTrace.length >= 2) {
        linkDiag.nameSearch = await clientSearchTrace(auth.authHeaders, nameTrace, 8);
      }

      const rCci = await fetchMb(
        "GET",
        `/public/v${V}/client/clientcompleteinfo`,
        auth.authHeaders,
        null,
      );
      /** @type {string | undefined} */
      let errCciMsg;
      if (rCci.data && typeof rCci.data === "object") {
        const inner = /** @type {{ Error?: { Message?: string } }} */ (rCci.data).Error;
        if (inner && typeof inner === "object" && typeof inner.Message === "string")
          errCciMsg = inner.Message.slice(0, 280);
      }
      linkDiag.clientCompleteInfo = {
        httpStatus: rCci.status,
        ok: rCci.ok,
        extractedClientIdHint:
          rCci.ok && rCci.data ? extractClientIdFromCompleteInfoPayload(rCci.data) : null,
        errorMessage: errCciMsg,
      };
    }
    return jsonResponse(
      200,
      {
        ok: true,
        clientId: null,
        profile: { sessionEmail: email, sessionName: typeof session.name === "string" ? session.name : null, client: null },
        clientServices: null,
        purchases: null,
        memberships: null,
        balances: null,
        clientVisits: null,
        waitlistByClassId: {},
        stripeSubscriptionCommitments: [],
        warnings: wr,
        ...(linkDiag ? { linkDiag } : {}),
      },
      setHdr,
    );
  }

  const base = `/public/v${V}/client`;
  const qClient = new URLSearchParams({
    "request.clientIDs": String(clientId),
    "request.limit": "10",
  });
  const qServices = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const qPurchases = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.limit": "50",
  });
  const qMemberships = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.limit": "50",
  });
  const qBalances = new URLSearchParams({
    "request.clientIds": String(clientId),
  });

  /**
   * Stripe-side commitment overlay for the Memberships card (§ 9.18).
   *
   * V1 deliberately does not use Mindbody Contracts, so Mindbody only knows
   * the per-renewal Service expiration (1 month). The 3-month minimum
   * commitment lives on our `SubscriptionRecord.commitmentEndDate`. Surface
   * it here so the frontend can render `Renews on` (Mindbody) + `Commitment
   * until` (us) side-by-side. Returns `[]` for clients with no Stripe
   * subscription (legacy Mindbody-Classic members) — frontend falls back to
   * the original 3-column layout in that case.
   *
   * Network/store failures here must NEVER fail the whole summary endpoint —
   * Mindbody data is the primary payload; the commitment overlay is purely
   * a UI enhancement.
   *
   * @returns {Promise<ReturnType<typeof publicSubscriptionCommitment>[]>}
   */
  async function loadStripeCommitmentsSafe() {
    try {
      const subStore = openSubscriptionStore(event);
      if (!subStore.available()) return [];
      const records = await subStore.listActiveByMindbodyClientId(clientId);
      const cfg = loadMbContractTermsConfig();
      const byServiceId = /** @type {Record<string, string> | undefined} */ (
        cfg?.byCheckoutServiceId
      );
      return records.map((r) => publicSubscriptionCommitment(r, byServiceId));
    } catch {
      return [];
    }
  }

  const [
    rClient,
    rServices,
    rPurchases,
    rMemberships,
    rBalances,
    rVisits,
    rWaitlist,
    stripeSubscriptionCommitments,
  ] = await Promise.all([
    fetchMb("GET", `${base}/clients?${qClient}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientservices?${qServices}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientpurchases?${qPurchases}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/activeclientmemberships?${qMemberships}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientaccountbalances?${qBalances}`, auth.authHeaders, null),
    fetchClientVisitsAggregated(clientId, auth.authHeaders),
    fetchClientWaitlistByClassId(clientId),
    loadStripeCommitmentsSafe(),
  ]);

  const clientList = rClient.ok ? clientsList(rClient.data) : [];
  const clientRow = pickClientByEmail(clientList, email) || clientList[0] || null;

  /** @type {string[]} */
  const warnings = [];
  if (!rClient.ok) warnings.push(`clients_${rClient.status}`);
  if (!rServices.ok) warnings.push(`clientservices_${rServices.status}`);
  if (!rPurchases.ok) warnings.push(`purchases_${rPurchases.status}`);
  if (!rMemberships.ok) warnings.push(`memberships_${rMemberships.status}`);
  if (!rBalances.ok) warnings.push(`balances_${rBalances.status}`);
  if (!rVisits.ok) warnings.push(`visits_${rVisits.status}`);
  if (!rWaitlist.ok) warnings.push(`waitlist_${rWaitlist.status}`);

  return jsonResponse(
    200,
    {
      ok: true,
      clientId,
      profile: {
        sessionEmail: email,
        sessionName: typeof session.name === "string" ? session.name : null,
        client: clientRow,
      },
      clientServices: rServices.ok ? rServices.data : null,
      purchases: rPurchases.ok ? rPurchases.data : null,
      memberships: rMemberships.ok ? rMemberships.data : null,
      balances: rBalances.ok ? rBalances.data : null,
      clientVisits: rVisits.ok ? rVisits.data : null,
      visitCount: rVisits.ok ? visitsList(rVisits.data).length : 0,
      waitlistByClassId: rWaitlist.ok ? rWaitlist.waitlistByClassId : {},
      stripeSubscriptionCommitments,
      warnings,
    },
    setHdr,
  );
}
