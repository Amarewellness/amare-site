/**
 * Low Credits follow-up — direct class packs (10/20 pack) with 1–4 visits remaining.
 * Report-only / dry-run. Uses Series Expirations report + Mindbody API verification.
 */

import { loadStripeMindbodyCatalog } from "./stripe-catalog-lib.mjs";
import { mapWithConcurrency } from "./new-client-sms-async.mjs";
import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import { fetchMindbodyClientContact } from "./stripe-mindbody-sync-lib.mjs";
import {
  defaultNcsPricingOptionNames,
  isNcsPricingOptionRow,
  matchSeriesExpirationRows,
  parseSeriesExpirationReport,
} from "./new-client-sms-series-expiration.mjs";
import {
  daysUntilExpiration,
  fetchClientMindbodyBundle,
  fetchClientServicesBatched,
  readSmsConsent,
  smsRunCaps,
  smsTimezone,
} from "./new-client-sms-lib.mjs";
import {
  isFollowUpActionActive,
  openFollowUpActionsStore,
} from "./follow-up-actions-store.mjs";

export const LOW_CREDITS_CATEGORY = "low_credits";

/** @returns {number} */
function maxRemainingVisits() {
  const raw = Number(process.env.FOLLOWUP_LOW_CREDITS_MAX_REMAINING || 4);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 4;
  return Math.max(1, Math.min(n, 5));
}

/** @returns {number} */
function minRemainingVisits() {
  return 1;
}

/** @returns {number[]} */
export function resolveDirectPackServiceIds() {
  const override = (process.env.FOLLOWUP_LOW_CREDITS_SERVICE_IDS || "").trim();
  if (override) {
    return override
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const { items } = loadStripeMindbodyCatalog();
  /** @type {number[]} */
  const ids = [];
  for (const item of items) {
    if (item.kind !== "packs") continue;
    if (item.mindbodyServiceId != null && Number.isFinite(item.mindbodyServiceId)) {
      ids.push(Number(item.mindbodyServiceId));
    }
  }
  return [...new Set(ids)];
}

/** @param {string} pricingOption */
export function isDirectPackPricingOptionRow(pricingOption) {
  const n = pricingOption.trim().toLowerCase();
  if (!n) return false;
  if (isNcsPricingOptionRow(pricingOption, defaultNcsPricingOptionNames())) return false;
  if (/\bclass\s*pass\b|\bclasspass\b/.test(n)) return false;
  if (/\bmonthly\b|\bmembership\b|\brecurring\b/.test(n)) return false;
  if (/\bdrop[\s-]?in\b|\bsingle class\b|\bsame day\b|\bnew client\b|\bintro\b|\b3 pack\b/.test(n)) {
    return false;
  }

  const { items } = loadStripeMindbodyCatalog();
  for (const item of items) {
    if (item.kind !== "packs") continue;
    const matchers = item.mindbodyServiceNameMatchAny || [];
    const excludes = item.mindbodyServiceNameMatchExclude || [];
    if (excludes.some((ex) => n.includes(String(ex).toLowerCase()))) continue;
    if (matchers.some((m) => n.includes(String(m).toLowerCase()))) return true;
  }
  return /\b10[\s-]?pack\b|\b20[\s-]?pack\b|\b10 class\b|\b20 class\b/.test(n);
}

/** @param {string} remainingRaw */
function parseRemainingVisits(remainingRaw) {
  const s = String(remainingRaw || "").trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {import("./new-client-sms-series-expiration.mjs").SeriesExpirationRow[]} allRows
 */
export function filterLowCreditPackRowsFromReport(allRows) {
  const maxRem = maxRemainingVisits();
  const minRem = minRemainingVisits();
  return allRows.filter((row) => {
    if (!isDirectPackPricingOptionRow(row.pricingOption)) return false;
    const rem = parseRemainingVisits(row.remaining);
    if (rem == null || rem < minRem || rem > maxRem) return false;
    const active = String(row.active || "").trim().toLowerCase();
    if (active === "false" || active === "no" || active === "0") return false;
    return true;
  });
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

/** @param {unknown} row @param {Set<number>} packIds */
function isDirectPackServiceRow(row, packIds) {
  const serviceId = numField(row, ["ProductId", "productId", "ServiceId", "serviceId"]);
  if (serviceId != null && packIds.has(serviceId)) return true;
  const name = String(
    /** @type {Record<string, unknown>} */ (row).Name ??
      /** @type {Record<string, unknown>} */ (row).name ??
      "",
  ).toLowerCase();
  if (!name) return false;
  if (/\bclass\s*pass\b|\bclasspass\b/.test(name)) return false;
  return /\b10[\s-]?pack\b|\b20[\s-]?pack\b|\b10 class\b|\b20 class\b/.test(name);
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

/** @param {string} firstName @param {number} remaining @param {string} pricingUrl */
export function buildLowCreditsMessage(firstName, remaining, pricingUrl) {
  const name = (firstName || "there").trim() || "there";
  const url = (pricingUrl || "https://www.amarewellness.com/pricing").trim();
  const n = remaining === 1 ? "1 class" : `${remaining} classes`;
  return `Hi ${name} 🫶 you have ${n} left on your class pack. If you're coming weekly, a membership is the best value — or renew your pack for flexibility: ${url}`;
}

/** @param {Record<string, unknown>} row */
export function recommendedActionForLowCredits(row) {
  const consent = String(row.smsConsent || "unknown");
  if (consent === "explicit_opt_out") {
    return "Do not send marketing SMS. Use approved channel / in-studio / phone / email follow-up.";
  }
  return "Client is close to the end of their pack. Recommend membership if they attend weekly, or pack renewal if they need flexibility.";
}

function phoneLast4(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

function emailDomainOnly(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

/**
 * @param {unknown} event
 * @param {Record<string, string>} staffHeaders
 * @param {string} reportHtml
 */
export async function runLowCreditsReport(event, staffHeaders, reportHtml) {
  const startedAt = Date.now();
  const tz = smsTimezone();
  const pricingUrl = (
    process.env.FOLLOWUP_PRICING_URL ||
    process.env.NEW_CLIENT_SMS_PRICING_URL ||
    "https://www.amarewellness.com/pricing"
  ).trim();
  const packIds = new Set(resolveDirectPackServiceIds());

  const parsed = parseSeriesExpirationReport(reportHtml);
  const packRows = filterLowCreditPackRowsFromReport(parsed.allRows || []);
  const match = await matchSeriesExpirationRows(staffHeaders, packRows, parsed.totalRows);

  /** @type {Map<number, { clientId: number; meta: import("./new-client-sms-intro-csv.mjs").CsvRowReportMeta }>} */
  const byClient = new Map();
  for (const m of match.matched) {
    if (!byClient.has(m.clientId)) {
      byClient.set(m.clientId, { clientId: m.clientId, meta: m.meta });
    }
  }

  const clientEntries = [...byClient.values()];
  const evalConcurrency = smsRunCaps().evalConcurrency.configured;
  const servicesBatch = await fetchClientServicesBatched(
    staffHeaders,
    clientEntries.map((e) => e.clientId),
  );

  const actionsStore = openFollowUpActionsStore(event);
  const priorActions = actionsStore.available
    ? await actionsStore.listByCategory(LOW_CREDITS_CATEGORY)
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
    const { clientId, meta } = entry;
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

    const bundle = await fetchClientMindbodyBundle(staffHeaders, clientId, {
      preloadedServices: servicesBatch.byClientId.has(clientId)
        ? servicesBatch.byClientId.get(clientId)
        : undefined,
    });

    if (hasActiveMindbodyMembership(bundle.memberships)) {
      return { candidate: null, skipReasons: ["skipped_active_mindbody_membership"] };
    }

    const maxRem = maxRemainingVisits();
    const minRem = minRemainingVisits();
    /** @type {Record<string, unknown> | null} */
    let best = null;
    let bestRemaining = 999;

    for (const raw of bundle.services) {
      if (!isDirectPackServiceRow(raw, packIds)) continue;
      const remaining = numField(raw, ["Remaining", "remaining"]) ?? 0;
      if (remaining < minRem || remaining > maxRem) continue;
      const activeRaw = /** @type {Record<string, unknown>} */ (raw).Active ?? /** @type {Record<string, unknown>} */ (raw).active;
      if (activeRaw === false) continue;
      if (remaining >= bestRemaining) continue;

      const expirationDateIso =
        String(
          /** @type {Record<string, unknown>} */ (raw).ExpirationDate ??
            /** @type {Record<string, unknown>} */ (raw).expirationDate ??
            "",
        ).trim() || null;
      const serviceName = String(
        /** @type {Record<string, unknown>} */ (raw).Name ??
          /** @type {Record<string, unknown>} */ (raw).name ??
          meta.csvIntroOffer ??
          "Class pack",
      );
      const smsConsent = readSmsConsent(clientRow);
      const messageBody = buildLowCreditsMessage(contact.firstName, remaining, pricingUrl);
      const row = {
        category: LOW_CREDITS_CATEGORY,
        mindbodyClientId: clientId,
        csvClientName: meta.csvClientName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
        packName: serviceName,
        remainingVisits: remaining,
        expirationDate: expirationDateIso,
        daysToExpiry: expirationDateIso ? daysUntilExpiration(expirationDateIso, tz) : null,
        activeMindbodyMembershipFound: false,
        smsConsent,
        phone: (contact.phone || "").trim(),
        email: (contact.email || "").trim().toLowerCase(),
        phoneLast4: phoneLast4(contact.phone),
        emailDomain: emailDomainOnly(contact.email),
        messageBody,
        recommendedAction: "",
        reportOnly: true,
        wouldSend: false,
        blockReason: "report_only_phase1",
      };
      row.recommendedAction = recommendedActionForLowCredits(row);
      best = row;
      bestRemaining = remaining;
    }

    if (!best) {
      return { candidate: null, skipReasons: ["skipped_no_qualifying_pack"] };
    }
    return { candidate: best, skipReasons: [] };
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
    category: LOW_CREDITS_CATEGORY,
    durationMs: Date.now() - startedAt,
    seedSources: {
      mindbodySeriesExpirationRows: parsed.totalRows,
      lowCreditPackRows: packRows.length,
      lowCreditPackMatched: match.matched.length,
      lowCreditPackUnmatched: match.unmatched.length,
      lowCreditPackAmbiguous: match.ambiguous.length,
    },
    evaluatedClients: clientEntries.length,
    candidates: candidates.length,
    skippedClients: skippedClients.length,
    skippedByReason,
    clientservicesBatchLoaded: servicesBatch.clientsLoaded,
    clientservicesBatchRequested: servicesBatch.clientsRequested,
    report: {
      candidates,
      skippedClients,
      csvUnmatchedRows: match.unmatched,
      csvAmbiguousRows: match.ambiguous,
    },
  };
}
