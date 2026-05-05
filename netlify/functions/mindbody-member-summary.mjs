import {
  MB_API_VERSION,
  clientsList,
  fetchMb,
  getSessionWithConsumerHeaders,
  jsonResponse,
  pickClientByEmail,
  tryResolveClientId,
} from "./mindbody-consumer-lib.mjs";

const V = MB_API_VERSION;

/** @param {unknown} data */
function visitsArray(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  if (Array.isArray(d.Visits)) return d.Visits;
  if (Array.isArray(d.ClientVisits)) return d.ClientVisits;
  return [];
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const auth = await getSessionWithConsumerHeaders(event);
  if (!auth.ok) return auth.response;

  const setHdr = auth.setCookie ? { "Set-Cookie": auth.setCookie } : {};

  const { session, email } = auth;
  const clientId = await tryResolveClientId(session, email, auth.authHeaders, auth.accessToken);

  if (clientId == null) {
    /** @type {string[]} */
    const wr = ["could_not_resolve_client"];
    if ((process.env.MINDBODY_SITE_ID?.trim() || "-99") === "-99") {
      wr.push("hint_production_site_id");
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

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 120);
  const qVisits = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.startDate": start.toISOString(),
    "request.endDate": end.toISOString(),
    "request.limit": "200",
  });

  const [rClient, rServices, rPurchases, rMemberships, rBalances, rVisits] = await Promise.all([
    fetchMb("GET", `${base}/clients?${qClient}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientservices?${qServices}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientpurchases?${qPurchases}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/activeclientmemberships?${qMemberships}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientaccountbalances?${qBalances}`, auth.authHeaders, null),
    fetchMb("GET", `${base}/clientvisits?${qVisits}`, auth.authHeaders, null),
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
      visitCount: rVisits.ok ? visitsArray(rVisits.data).length : 0,
      warnings,
    },
    setHdr,
  );
}
