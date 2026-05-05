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
  getSessionWithConsumerHeaders,
  jsonResponse,
  pickClientByEmail,
  tryResolveClientId,
  visitsList,
} from "./mindbody-consumer-lib.mjs";

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

  const [rClient, rServices, rPurchases, rMemberships, rBalances, rVisits] = await Promise.all([
    fetchMb("GET", `${base}/clients?${qClient}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientservices?${qServices}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientpurchases?${qPurchases}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/activeclientmemberships?${qMemberships}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientaccountbalances?${qBalances}`, auth.authHeaders, null),
    fetchClientVisitsAggregated(clientId, auth.authHeaders),
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
      warnings,
    },
    setHdr,
  );
}
