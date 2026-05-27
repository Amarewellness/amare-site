/**
 * ClassPass Repeat follow-up — clients with multiple ClassPass visits in lookback window.
 * Report-only. Uses Client Visits report + Mindbody API verification.
 */

import { mapWithConcurrency } from "./new-client-sms-async.mjs";
import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import { fetchMindbodyClientContact } from "./stripe-mindbody-sync-lib.mjs";
import { VisitsReportFormatError } from "./new-client-sms-client-visits.mjs";
import {
  digitsOnlyPhone,
  matchSeriesExpirationRows,
} from "./new-client-sms-series-expiration.mjs";
import {
  fetchClientMindbodyBundle,
  readSmsConsent,
  smsRunCaps,
} from "./new-client-sms-lib.mjs";
import {
  isFollowUpActionActive,
  openFollowUpActionsStore,
} from "./follow-up-actions-store.mjs";

export const CLASSPASS_CATEGORY = "classpass_repeat";

/** @returns {number} */
export function classpassRepeatThreshold() {
  const raw = Number(process.env.FOLLOWUP_CLASSPASS_REPEAT_THRESHOLD || 2);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 2;
  return Math.max(2, Math.min(n, 10));
}

/** @returns {number} */
export function classpassLookbackDays() {
  const raw = Number(process.env.FOLLOWUP_CLASSPASS_LOOKBACK_DAYS || 60);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 60;
  return Math.max(7, Math.min(n, 180));
}

/** @param {unknown} row @param {string[]} keys */
function numField(row, keys) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** @param {unknown[]} membershipRows */
function hasActiveMindbodyMembership(membershipRows) {
  for (const raw of membershipRows) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const active =
      o.Active === true ||
      o.active === true ||
      String(o.Status ?? o.status ?? "").toLowerCase() === "active";
    if (active) return true;
  }
  return membershipRows.length > 0;
}

/** @param {Record<string, string>} headers @param {number} clientId */
async function fetchClientRowById(headers, clientId) {
  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.limit", "5");
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${q}`,
    headers,
    null,
    { timeoutMs: 12000 },
  );
  if (!r.ok) return null;
  const rows = Array.isArray(r.data?.Clients) ? r.data.Clients : [];
  for (const raw of rows) {
    const id = numField(raw, ["Id", "id", "UniqueId", "uniqueId"]);
    if (id === clientId) return /** @type {Record<string, unknown>} */ (raw);
  }
  return rows[0] && typeof rows[0] === "object"
    ? /** @type {Record<string, unknown>} */ (rows[0])
    : null;
}

/**
 * Resolve Mindbody client IDs for aggregated ClassPass rows.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {ReturnType<typeof aggregateClassPassClients>} aggregates
 */
async function matchClassPassAggregates(staffHeaders, aggregates) {
  /** @type {Array<{ clientId: number; aggregate: (typeof aggregates)[number]; meta: import("./new-client-sms-intro-csv.mjs").CsvRowReportMeta }>} */
  const matched = [];
  /** @type {import("./new-client-sms-intro-csv.mjs").CsvRowReportMeta[]} */
  const unmatched = [];
  /** @type {import("./new-client-sms-intro-csv.mjs").CsvRowReportMeta[]} */
  const ambiguous = [];

  for (const aggregate of aggregates) {
    const meta = {
      csvRowIndex: null,
      csvExpiration: null,
      csvIntroOffer: "ClassPass",
      csvVisits: String(aggregate.classPassVisits),
      csvNextVisit: null,
      csvActivationDate: aggregate.firstVisitDate,
      csvRemaining: null,
      csvActive: null,
      csvPaymentRef: null,
      csvClientName: aggregate.clientName,
      csvEmail: aggregate.email || null,
      csvPhone: aggregate.phone || null,
      csvMatchedBy: /** @type {"phone"|"none"} */ ("none"),
      csvMatchStatus: /** @type {"matched"|"unmatched"|"ambiguous"} */ ("unmatched"),
      mindbodyClientId: null,
      csvMatchDetail: null,
    };

    if (aggregate.reportClientId != null) {
      const row = await fetchClientRowById(staffHeaders, aggregate.reportClientId);
      if (row) {
        meta.csvMatchedBy = "none";
        meta.csvMatchStatus = "matched";
        meta.mindbodyClientId = aggregate.reportClientId;
        matched.push({ clientId: aggregate.reportClientId, aggregate, meta });
        continue;
      }
    }

    if (aggregate.phone.trim()) {
      const pseudoRow = {
        rowIndex: 0,
        clientName: aggregate.clientName,
        pricingOption: "ClassPass",
        paymentRef: "",
        activationDate: aggregate.firstVisitDate || "",
        expirationDate: aggregate.lastVisitDate || "",
        paid: "",
        remaining: String(aggregate.classPassVisits),
        active: "",
        rep1: "",
        phone: aggregate.phone,
      };
      const phoneMatch = await matchSeriesExpirationRows(staffHeaders, [pseudoRow], 1);
      if (phoneMatch.matched.length === 1) {
        const m = phoneMatch.matched[0];
        matched.push({ clientId: m.clientId, aggregate, meta: { ...m.meta, csvVisits: String(aggregate.classPassVisits) } });
        continue;
      }
      if (phoneMatch.ambiguous.length) {
        meta.csvMatchStatus = "ambiguous";
        ambiguous.push(meta);
        continue;
      }
    }

    unmatched.push(meta);
  }

  return { matched, unmatched, ambiguous };
}

/** @param {string} firstName @param {number} visitCount @param {string} pricingUrl */
export function buildClassPassMessage(firstName, visitCount, pricingUrl) {
  const name = (firstName || "there").trim() || "there";
  const url = (pricingUrl || "https://www.amarewellness.com/pricing").trim();
  const visits = visitCount === 1 ? "1 ClassPass visit" : `${visitCount} ClassPass visits`;
  return `Hi ${name} 🫶 we've loved seeing you at AMARÉ (${visits} recently). If you're coming regularly, our memberships are the best value — see options: ${url}`;
}

/** @param {Record<string, unknown>} row */
export function recommendedActionForClassPass(row) {
  const consent = String(row.smsConsent || "unknown");
  if (consent === "explicit_opt_out") {
    return "Do not send marketing SMS. Use approved channel / in-studio / phone / email follow-up.";
  }
  return "Repeat ClassPass visitor — good membership conversion candidate. Recommend direct booking + membership if they attend weekly.";
}

/**
 * @param {unknown} event
 * @param {Record<string, string>} staffHeaders
 * @param {Buffer} reportBuffer
 */
export async function runClassPassReport(event, staffHeaders, reportBuffer) {
  const startedAt = Date.now();
  const threshold = classpassRepeatThreshold();
  const lookbackDays = classpassLookbackDays();
  const pricingUrl = (
    process.env.FOLLOWUP_PRICING_URL ||
    process.env.NEW_CLIENT_SMS_PRICING_URL ||
    "https://www.amarewellness.com/pricing"
  ).trim();

  const parsed = parseClientVisitsReportInput(reportBuffer);
  const classPassRows = filterClassPassRowsByLookback(parsed.classPassRows, lookbackDays);
  const aggregates = aggregateClassPassClients(classPassRows, threshold);
  const match = await matchClassPassAggregates(staffHeaders, aggregates);

  const clientEntries = match.matched;
  const evalConcurrency = smsRunCaps().evalConcurrency.configured;

  const actionsStore = openFollowUpActionsStore(event);
  const priorActions = actionsStore.available
    ? await actionsStore.listByCategory(CLASSPASS_CATEGORY)
    : [];
  const hiddenIds = new Set(
    priorActions
      .filter((a) => isFollowUpActionActive(a) && (a.action === "hidden" || a.action === "contacted"))
      .map((a) => a.mindbodyClientId),
  );
  const snoozedIds = new Set(
    priorActions
      .filter((a) => isFollowUpActionActive(a) && a.action === "snoozed")
      .map((a) => a.mindbodyClientId),
  );

  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  /** @type {Record<string, unknown>[]} */
  const skippedClients = [];
  /** @type {Record<string, number>} */
  const skippedByReason = {};

  const evalResults = await mapWithConcurrency(clientEntries, evalConcurrency, async (entry) => {
    const { clientId, aggregate, meta } = entry;
    if (hiddenIds.has(clientId)) {
      return { candidate: null, skipReasons: ["skipped_hidden_by_team"] };
    }
    if (snoozedIds.has(clientId)) {
      return { candidate: null, skipReasons: ["skipped_snoozed_by_team"] };
    }

    const [contact, clientRow] = await Promise.all([
      fetchMindbodyClientContact(staffHeaders, clientId, { timeoutMs: 12000 }),
      fetchClientRowById(staffHeaders, clientId),
    ]);
    if (!contact) {
      return { candidate: null, skipReasons: ["client_profile_not_found"] };
    }

    const bundle = await fetchClientMindbodyBundle(staffHeaders, clientId);
    if (hasActiveMindbodyMembership(bundle.memberships)) {
      return { candidate: null, skipReasons: ["skipped_active_mindbody_membership"] };
    }

    const smsConsent = readSmsConsent(clientRow);
    const messageBody = buildClassPassMessage(
      contact.firstName,
      aggregate.classPassVisits,
      pricingUrl,
    );
    const row = {
      category: CLASSPASS_CATEGORY,
      mindbodyClientId: clientId,
      csvClientName: meta.csvClientName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      classPassVisits: aggregate.classPassVisits,
      lastVisitDate: aggregate.lastVisitDate,
      firstVisitDate: aggregate.firstVisitDate,
      lookbackDays,
      repeatThreshold: threshold,
      activeMindbodyMembershipFound: false,
      smsConsent,
      phone: (contact.phone || aggregate.phone || "").trim(),
      email: (contact.email || aggregate.email || "").trim().toLowerCase(),
      phoneLast4: digitsOnlyPhone(contact.phone || aggregate.phone).slice(-4) || "",
      emailDomain: (() => {
        const e = (contact.email || aggregate.email || "").trim().toLowerCase();
        const at = e.indexOf("@");
        return at >= 0 ? e.slice(at + 1) : "";
      })(),
      messageBody,
      recommendedAction: "",
      reportOnly: true,
      wouldSend: false,
      blockReason: "report_only_phase1",
    };
    row.recommendedAction = recommendedActionForClassPass(row);
    return { candidate: row, skipReasons: [] };
  });

  for (let i = 0; i < evalResults.length; i += 1) {
    const result = evalResults[i];
    if (result.candidate) {
      candidates.push(result.candidate);
    } else {
      const reason = result.skipReasons[0] || "skipped";
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      skippedClients.push({
        mindbodyClientId: clientEntries[i].clientId,
        csvClientName: clientEntries[i].meta.csvClientName,
        skipReasons: result.skipReasons,
      });
    }
  }

  return {
    ok: true,
    dryRun: true,
    reportOnly: true,
    category: CLASSPASS_CATEGORY,
    durationMs: Date.now() - startedAt,
    seedSources: {
      clientVisitsReportRows: parsed.totalRows,
      classPassVisitRows: parsed.classPassRows.length,
      classPassVisitRowsInLookback: classPassRows.length,
      classPassAggregates: aggregates.length,
      classPassMatched: match.matched.length,
      classPassUnmatched: match.unmatched.length,
      classPassAmbiguous: match.ambiguous.length,
      lookbackDays,
      repeatThreshold: threshold,
    },
    evaluatedClients: clientEntries.length,
    candidates: candidates.length,
    skippedClients: skippedClients.length,
    skippedByReason,
    report: {
      candidates,
      skippedClients,
      csvUnmatchedRows: match.unmatched,
      csvAmbiguousRows: match.ambiguous,
    },
  };
}
