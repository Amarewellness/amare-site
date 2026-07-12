/**
 * Backfill Mindbody email subscriptions for clients who joined via the site.
 *
 * Sets (when off): SendAccountEmails, SendScheduleEmails, SendPromotionalEmails
 * → Account management, Reminder & schedule changes (email), News & promos (email).
 *
 * Default is DRY RUN — no Mindbody writes. Pass --live to apply.
 *
 * Usage:
 *   node scripts/backfill-site-email-opt-in.mjs
 *   node scripts/backfill-site-email-opt-in.mjs --client-ids=100002643
 *   node scripts/backfill-site-email-opt-in.mjs --email=norena56@icloud.com
 *   node scripts/backfill-site-email-opt-in.mjs --live --limit=10
 *   node scripts/backfill-site-email-opt-in.mjs --comprehensive --live
 *   node scripts/backfill-site-email-opt-in.mjs --audit
 *   node scripts/backfill-site-email-opt-in.mjs --audit --min-client-id=100002400
 *
 * Seed sources (merged, deduped):
 *   • --client-ids=…           explicit Mindbody client IDs
 *   • --email=… / --emails=…   resolve client(s) by email
 *   • --comprehensive          Mindbody bulk discovery (120d) + all Stripe NCS + series report
 *   • NCS follow-up discovery  Series Expirations report + Stripe NCS orders (collectSeedClientIds)
 *   • --all-stripe-orders      all live mindbody_synced Stripe checkout orders (not just NCS)
 *   • --production-orders=1    fetch orders from live site admin API (local dev when Blobs empty)
 *   • --stripe-only=1          only Stripe buyers (no Mindbody bulk / NCS seed discovery)
 *   • EMAIL_OPTIN_BACKFILL_CLIENT_IDS env (comma-separated)
 */
import "./load-env.mjs";

import { MB_API_VERSION, clientsList, fetchMb } from "../netlify/functions/mindbody-consumer-lib.mjs";
import {
  collectSeedClientIds,
  extractNcsServices,
  fetchClientServicesBatched,
  resolveNcsServiceIds,
} from "../netlify/functions/new-client-sms-lib.mjs";
import { resolveSeedReportContent } from "../netlify/functions/new-client-sms-seed-report.mjs";
import {
  defaultNcsPricingOptionNames,
  isMindbodyHtmlReport,
  matchSeriesExpirationRows,
  parseSeriesExpirationReport,
} from "../netlify/functions/new-client-sms-series-expiration.mjs";
import { loadStripeMindbodyCatalog } from "../netlify/functions/stripe-catalog-lib.mjs";
import { openOrderStore } from "../netlify/functions/stripe-order-store.mjs";
import {
  CLIENT_SITE_EMAIL_SUBSCRIPTION_FIELDS,
  ensureStudioClientTransactionalEmailOptIn,
  fetchClientIdByEmail,
  __testing,
} from "../netlify/functions/stripe-mindbody-sync-lib.mjs";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const a of process.argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) return "1";
  }
  return fallback;
}

const LIVE = arg("live") === "1";
const CLIENT_IDS_RAW = arg("client-ids", "");
const EMAIL = (arg("email", "") || "").trim().toLowerCase();
const EMAILS_RAW = (arg("emails", "") || "").trim();
const ALL_STRIPE = arg("all-stripe-orders") === "1" || arg("stripe-only") === "1";
const STRIPE_ONLY = arg("stripe-only") === "1";
const PRODUCTION_ORDERS = arg("production-orders") === "1" || STRIPE_ONLY;
const AUDIT = arg("audit") === "1";
const COMPREHENSIVE = (arg("comprehensive") === "1" || AUDIT) && !STRIPE_ONLY;
const MIN_CLIENT_ID = parseInt(String(arg("min-client-id", "0")), 10) || 0;
const NCS_ONLY = STRIPE_ONLY || AUDIT ? false : arg("ncs-only") !== "0";
const LIMIT = Math.max(0, parseInt(String(arg("limit", "0")), 10) || 0);
const SKIP_NCS_SEED = arg("skip-ncs-seed") === "1" || STRIPE_ONLY;

if (COMPREHENSIVE) {
  process.env.NEW_CLIENT_SMS_ENABLE_MINDBODY_FALLBACK = "1";
  if (!process.env.NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS) {
    process.env.NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS = "120";
  }
  process.env.NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENTS = "500";
  process.env.NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES = "50";
  process.env.NEW_CLIENT_SMS_MAX_EVALUATED_CLIENTS = "500";
}

/** @param {{ account: string; schedule: string; promo: string }} r */
function gapLabel(r) {
  const a = r.account === "ON";
  const s = r.schedule === "ON";
  const p = r.promo === "ON";
  if (!a && !s && !p) return "all_three_off";
  if (a && s && !p) return "promo_only_off";
  if (!a && !s && p) return "acct_sched_off_promo_on";
  if (!a || !s || !p) return "mixed_partial";
  return "all_on";
}

/** @param {unknown} row @param {string[]} keys */
function boolField(row, keys) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of keys) {
    const v = o[k];
    if (v === true) return true;
    if (v === false) return false;
  }
  return null;
}

/** @param {Record<string, string>} headers @param {number} clientId */
async function fetchClientRow(headers, clientId) {
  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.limit", "5");
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${q}`,
    headers,
    null,
    { timeoutMs: 15000 },
  );
  if (!r.ok) return null;
  const list = clientsList(r.data);
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const id = row.Id ?? row.id;
    if (Number(id) === clientId) return row;
  }
  return null;
}

/** @param {Record<string, unknown> | null} row */
function readEmailSubscriptions(row) {
  return {
    account: boolField(row, ["SendAccountEmails", "sendAccountEmails"]),
    schedule: boolField(row, ["SendScheduleEmails", "sendScheduleEmails"]),
    promo: boolField(row, ["SendPromotionalEmails", "sendPromotionalEmails"]),
  };
}

/** @param {{ account: boolean | null; schedule: boolean | null; promo: boolean | null }} subs */
function needsEmailOptInBackfill(subs) {
  return subs.account !== true || subs.schedule !== true || subs.promo !== true;
}

/** @param {string} email */
function emailDomain(email) {
  const at = email.indexOf("@");
  if (at <= 0) return "—";
  return `***@${email.slice(at + 1)}`;
}

/**
 * @param {Map<number, Set<string>>} merged
 * @param {number} id
 * @param {string} source
 */
function addSeed(merged, id, source) {
  if (!Number.isFinite(id) || id <= 0) return;
  const tid = Math.trunc(id);
  let set = merged.get(tid);
  if (!set) {
    set = new Set();
    merged.set(tid, set);
  }
  set.add(source);
}

/** @returns {Promise<Map<number, Set<string>>>} */
async function collectAllStripeNcsClientIds() {
  /** @type {Map<number, Set<string>>} */
  const merged = new Map();
  const orderStore = openOrderStore(null);
  if (!orderStore.available) return merged;

  const orders = await orderStore.listByStatus("mindbody_synced", { limit: 500 });
  const { items } = loadStripeMindbodyCatalog();
  const ncsSkus = new Set(items.filter((i) => i.kind === "newClient").map((i) => i.localSku));

  for (const order of orders) {
    if (!ncsSkus.has(order.localSku)) continue;
    if (order.stripeLivemode !== true) continue;
    const cid = order.resolvedMindbodyClientId ?? order.mindbodyClientId;
    if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) {
      addSeed(merged, Number(cid), `stripe_ncs:${order.localSku}`);
    }
  }
  return merged;
}

/** @param {Record<string, string>} headers @param {string} searchText */
async function searchClientsByText(headers, searchText) {
  const q = (searchText || "").trim();
  if (!q) return [];
  const params = new URLSearchParams();
  params.set("request.searchText", q);
  params.set("request.limit", "25");
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${params}`,
    headers,
    null,
    { timeoutMs: 15000 },
  );
  if (!r.ok) return [];
  return clientsList(r.data);
}

/**
 * Resolve Series Expiration rows that failed phone matching (name search fallback).
 *
 * @param {Record<string, string>} staffHeaders
 */
async function seedFromSeriesReportExtras(staffHeaders) {
  /** @type {Map<number, Set<string>>} */
  const merged = new Map();
  const seedReport = await resolveSeedReportContent(null);
  if (!seedReport?.text || !isMindbodyHtmlReport(seedReport.text)) {
    return { merged, unmatchedNames: [], ambiguousNames: [] };
  }

  const parsed = parseSeriesExpirationReport(seedReport.text, defaultNcsPricingOptionNames());
  const seriesMatch = await matchSeriesExpirationRows(staffHeaders, parsed.ncsRows, parsed.totalRows);
  for (const hit of seriesMatch.matched) {
    addSeed(merged, hit.clientId, "series_matched");
  }

  /** @type {string[]} */
  const unmatchedNames = [];
  /** @type {string[]} */
  const ambiguousNames = [];

  for (const row of seriesMatch.unmatched) {
    const name = (row.csvClientName || "").trim();
    if (!name) {
      unmatchedNames.push("(no name)");
      continue;
    }
    const hits = await searchClientsByText(staffHeaders, name);
    if (hits.length === 1) {
      const id = Number(hits[0]?.Id ?? hits[0]?.id);
      if (Number.isFinite(id) && id > 0) addSeed(merged, id, "series_name_resolved");
      else unmatchedNames.push(name);
    } else if (hits.length > 1) {
      ambiguousNames.push(name);
    } else {
      unmatchedNames.push(name);
    }
  }

  for (const row of seriesMatch.ambiguous) {
    if (row.csvClientName) ambiguousNames.push(row.csvClientName);
  }

  return { merged, unmatchedNames, ambiguousNames, seriesMatch };
}

/** @returns {Promise<Map<number, Set<string>>>} */
async function collectAllStripeSiteClientIdsFromAdminApi() {
  /** @type {Map<number, Set<string>>} */
  const merged = new Map();
  const token = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  const base = (process.env.SITE_ORIGIN || process.env.URL || "https://www.amarewellness.com").replace(/\/$/, "");
  if (!token || token.length < 16) {
    console.warn("WARN — production-orders requested but ADMIN_DEBUG_TOKEN missing");
    return merged;
  }

  const { items } = loadStripeMindbodyCatalog();
  const siteSkus = new Set(items.filter((i) => i.enabled !== false).map((i) => i.localSku));

  /** @param {string} path */
  async function adminGet(path) {
    const r = await fetch(`${base}${path}`, { headers: { "x-admin-token": token } });
    if (!r.ok) throw new Error(`admin_api_${r.status}:${path}`);
    return /** @type {Record<string, unknown>} */ (await r.json());
  }

  const ordersPayload = await adminGet("/api/stripe/admin/orders?status=mindbody_synced&limit=500");
  /** @type {Array<Record<string, unknown>>} */
  const orders = Array.isArray(ordersPayload.orders) ? ordersPayload.orders : [];
  for (const order of orders) {
    const sku = String(order.localSku || "");
    if (!siteSkus.has(sku)) continue;
    const sessionId = String(order.stripeCheckoutSessionId || "");
    if (sessionId.startsWith("cs_test_")) continue;
    const cid = order.resolvedMindbodyClientId ?? order.mindbodyClientId ?? order.knownMindbodyClientId;
    if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) {
      addSeed(merged, Number(cid), `prod_stripe_order:${sku}`);
    }
  }

  for (const status of ["active", "past_due", "pending_first_invoice"]) {
    try {
      const subsPayload = await adminGet(
        `/api/stripe/admin/subscriptions?status=${encodeURIComponent(status)}&limit=200`,
      );
      /** @type {Array<Record<string, unknown>>} */
      const subs = Array.isArray(subsPayload.subscriptions) ? subsPayload.subscriptions : [];
      for (const sub of subs) {
        const sku = String(sub.localSku || "");
        if (sku && !siteSkus.has(sku)) continue;
        const cid = sub.mindbodyClientId;
        if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) {
          addSeed(merged, Number(cid), `prod_stripe_sub:${sku || status}`);
        }
      }
    } catch (e) {
      console.warn(
        `WARN — subscription admin list ${status}: ${String(/** @type {{ message?: string }} */ (e)?.message ?? e)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "email_optin_backfill_seed_production_admin",
      base,
      count: merged.size,
    }),
  );
  return merged;
}

/** @returns {Promise<Map<number, Set<string>>>} */
async function collectAllStripeSiteClientIds() {
  /** @type {Map<number, Set<string>>} */
  const merged = new Map();
  const orderStore = openOrderStore(null);
  if (orderStore.available) {
    const orders = await orderStore.listByStatus("mindbody_synced", { limit: 500 });
    const { items } = loadStripeMindbodyCatalog();
    const siteSkus = new Set(items.filter((i) => i.enabled !== false).map((i) => i.localSku));

    for (const order of orders) {
      if (order.stripeLivemode !== true) continue;
      if (!siteSkus.has(order.localSku)) continue;
      const cid = order.resolvedMindbodyClientId ?? order.mindbodyClientId;
      if (cid != null && Number.isFinite(Number(cid)) && Number(cid) > 0) {
        addSeed(merged, Number(cid), `stripe_order:${order.localSku}`);
      }
    }
  }

  if (merged.size === 0 && PRODUCTION_ORDERS) {
    const fromAdmin = await collectAllStripeSiteClientIdsFromAdminApi();
    for (const [id, sources] of fromAdmin) {
      for (const s of sources) addSeed(merged, id, s);
    }
  }
  return merged;
}

/** @param {Record<string, string>} staffHeaders */
async function collectClientIds(staffHeaders) {
  /** @type {Map<number, Set<string>>} */
  const merged = new Map();

  if (CLIENT_IDS_RAW) {
    for (const part of CLIENT_IDS_RAW.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) addSeed(merged, n, "cli_client_ids");
    }
  }

  const envIds = (process.env.EMAIL_OPTIN_BACKFILL_CLIENT_IDS || "").trim();
  if (envIds) {
    for (const part of envIds.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) addSeed(merged, n, "env_client_ids");
    }
  }

  if (EMAIL) {
    const id = await fetchClientIdByEmail(staffHeaders, EMAIL, { timeoutMs: 15000 });
    if (id != null) addSeed(merged, id, "cli_email");
    else console.warn(`WARN — no unique Mindbody client for email ${emailDomain(EMAIL)}`);
  }

  const emailList = [
    ...EMAILS_RAW.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  ];
  if (EMAIL && !emailList.includes(EMAIL)) emailList.unshift(EMAIL);
  for (const em of emailList) {
    const id = await fetchClientIdByEmail(staffHeaders, em, { timeoutMs: 15000 });
    if (id != null) addSeed(merged, id, "cli_emails");
    else console.warn(`WARN — no unique Mindbody client for email ${emailDomain(em)}`);
  }

  if (COMPREHENSIVE) {
    const seriesExtras = await seedFromSeriesReportExtras(staffHeaders);
    for (const [id, sources] of seriesExtras.merged) {
      for (const s of sources) addSeed(merged, id, s);
    }
    const stripeNcs = await collectAllStripeNcsClientIds();
    for (const [id, sources] of stripeNcs) {
      for (const s of sources) addSeed(merged, id, s);
    }
    console.log(
      JSON.stringify({
        event: "email_optin_backfill_comprehensive_seed",
        seriesNameResolved: seriesExtras.merged.size,
        seriesUnmatchedNames: seriesExtras.unmatchedNames?.slice(0, 10) ?? [],
        seriesAmbiguousNames: seriesExtras.ambiguousNames?.slice(0, 10) ?? [],
        stripeNcsOrders: stripeNcs.size,
        lookbackDays: process.env.NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS,
      }),
    );
  }

  if (!SKIP_NCS_SEED) {
    const seed = await collectSeedClientIds(null, staffHeaders);
    for (const entry of seed.clientIds) {
      addSeed(merged, entry.id, `ncs_seed:${entry.seedSources.join("+")}`);
    }
    console.log(
      JSON.stringify({
        event: "email_optin_backfill_seed_ncs",
        orderStoreAvailable: seed.orderStoreAvailable,
        seedReportLoaded: seed.seedReportLoaded,
        seedReportSource: seed.seedReportSource,
        ncsSeedCount: seed.clientIds.length,
        stripeNcsOrders: seed.seedSources.stripeOrders,
        seriesExpirationMatched: seed.seedSources.mindbodySeriesExpirationMatched,
        discoveryNotes: seed.discoveryNotes.slice(0, 8),
      }),
    );
  }

  if (ALL_STRIPE || STRIPE_ONLY) {
    const stripeMap = await collectAllStripeSiteClientIds();
    for (const [id, sources] of stripeMap) {
      for (const s of sources) addSeed(merged, id, s);
    }
    console.log(
      JSON.stringify({
        event: "email_optin_backfill_seed_all_stripe",
        count: stripeMap.size,
      }),
    );
  }

  return merged;
}

function formatTriState(v) {
  if (v === true) return "ON";
  if (v === false) return "OFF";
  return "?";
}

async function main() {
  const staff = await __testing.staffHeadersForSync();
  if (!staff.ok) {
    console.error("Staff Mindbody headers unavailable:", staff.reason);
    process.exit(1);
  }
  const headers = staff.headers;

  const merged = await collectClientIds(headers);
  let clientIds = [...merged.keys()].sort((a, b) => a - b);

  if (!clientIds.length) {
    console.error(
      "No client IDs to evaluate. Try --client-ids=…, --email=…, or upload Series Expirations report for NCS seed.",
    );
    process.exit(1);
  }

  console.log("─".repeat(72));
  console.log(
    `Site email opt-in backfill — mode=${LIVE ? "LIVE" : "DRY_RUN"}${AUDIT ? " (audit)" : COMPREHENSIVE ? " (comprehensive)" : ""}`,
  );
  console.log(`Target flags: ${JSON.stringify(CLIENT_SITE_EMAIL_SUBSCRIPTION_FIELDS)}`);
  console.log(`Clients in seed set: ${clientIds.length}`);
  console.log("─".repeat(72));

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  /** @type {Map<number, number | null>} */
  const ncsRemaining = new Map();
  /** @type {Map<number, boolean>} */
  const hasNcs = new Map();

  const ncsIds = new Set(resolveNcsServiceIds());
  const batchSize = 50;
  for (let i = 0; i < clientIds.length; i += batchSize) {
    const chunk = clientIds.slice(i, i + batchSize);
    const services = await fetchClientServicesBatched(headers, chunk);
    for (const clientId of chunk) {
      const clientServices = services.byClientId.get(clientId) || [];
      const ncs = extractNcsServices(clientServices, ncsIds);
      hasNcs.set(clientId, ncs.length > 0);
      const active = ncs.filter((s) => s.active !== false && s.remaining > 0);
      ncsRemaining.set(
        clientId,
        active.length ? Math.max(...active.map((s) => s.remaining)) : ncs.length ? 0 : null,
      );
    }
  }

  if (NCS_ONLY) {
    const before = clientIds.length;
    clientIds = clientIds.filter((id) => hasNcs.get(id) === true);
    console.log(`NCS filter: ${before} seeded → ${clientIds.length} with NCS pricing option`);
  }

  if (MIN_CLIENT_ID > 0) {
    const before = clientIds.length;
    clientIds = clientIds.filter((id) => id >= MIN_CLIENT_ID);
    console.log(`Min clientId ${MIN_CLIENT_ID}: ${before} → ${clientIds.length}`);
  }

  for (const clientId of clientIds) {
    const row = await fetchClientRow(headers, clientId);
    const subs = readEmailSubscriptions(row);
    const needs = needsEmailOptInBackfill(subs);
    const email =
      row && typeof row.Email === "string"
        ? row.Email.trim().toLowerCase()
        : row && typeof row.email === "string"
          ? row.email.trim().toLowerCase()
          : "";
    const firstName =
      row && typeof row.FirstName === "string" ? row.FirstName.trim() : "";

    /** @type {Record<string, unknown>} */
    const out = {
      clientId,
      firstName: firstName || "—",
      emailDomain: email ? emailDomain(email) : "—",
      account: formatTriState(subs.account),
      schedule: formatTriState(subs.schedule),
      promo: formatTriState(subs.promo),
      ncsRemaining: ncsRemaining.get(clientId) ?? "—",
      needsUpdate: needs,
      seedSources: [...(merged.get(clientId) || [])].sort().join(", "),
      action: needs ? (LIVE ? "pending" : "would_update") : "skip_ok",
    };

    rows.push(out);
  }

  const needsUpdate = rows.filter((r) => r.needsUpdate);
  const gapCounts = /** @type {Record<string, number>} */ ({});
  for (const r of needsUpdate) {
    const g = gapLabel(/** @type {{ account: string; schedule: string; promo: string }} */ (r));
    gapCounts[g] = (gapCounts[g] || 0) + 1;
  }

  const toApply = LIMIT > 0 ? needsUpdate.slice(0, LIMIT) : needsUpdate;
  const applyIds = new Set(toApply.map((r) => /** @type {number} */ (r.clientId)));

  if (LIVE) {
    for (const r of rows) {
      if (!applyIds.has(/** @type {number} */ (r.clientId))) continue;
      const opt = await ensureStudioClientTransactionalEmailOptIn(
        headers,
        /** @type {number} */ (r.clientId),
      );
      r.updateResult = opt.ok ? (opt.noop ? "noop" : "updated") : opt.reason;
      r.action = opt.ok ? (opt.noop ? "noop" : "updated") : "failed";
      if (!opt.ok) r.updateError = opt.reason;
    }
  }

  if (LIVE && LIMIT > 0 && needsUpdate.length > LIMIT) {
    console.warn(`WARN — --limit=${LIMIT} caps live updates; re-run for remainder.`);
  }

  console.log("\nclientId | name | email | acct | sched | promo | NCS rem | action | seeds");
  console.log("-".repeat(110));
  const printRows = AUDIT ? needsUpdate : rows;
  for (const r of printRows) {
    console.log(
      [
        String(r.clientId).padEnd(8),
        String(r.firstName).slice(0, 12).padEnd(12),
        String(r.emailDomain).padEnd(22),
        String(r.account).padEnd(4),
        String(r.schedule).padEnd(5),
        String(r.promo).padEnd(5),
        String(r.ncsRemaining).padEnd(7),
        String(r.action).padEnd(12),
        String(r.seedSources).slice(0, 40),
      ].join(" | "),
    );
  }

  if (Object.keys(gapCounts).length) {
    console.log("\nGap breakdown (needs update only):");
    for (const [k, n] of Object.entries(gapCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${n}`);
    }
  }

  const summary = {
    event: "email_optin_backfill_summary",
    mode: LIVE ? "live" : "dry_run",
    audit: AUDIT,
    minClientId: MIN_CLIENT_ID || null,
    scanned: rows.length,
    alreadyOk: rows.length - needsUpdate.length,
    needsUpdate: needsUpdate.length,
    gapCounts,
    liveUpdated: LIVE ? rows.filter((r) => r.updateResult === "updated").length : 0,
    liveNoop: LIVE ? rows.filter((r) => r.updateResult === "noop").length : 0,
    liveFailed: LIVE ? rows.filter((r) => r.updateResult && r.updateResult !== "updated" && r.updateResult !== "noop").length : 0,
    wouldUpdateClientIds: needsUpdate.map((r) => r.clientId),
  };

  console.log("\n" + JSON.stringify(summary, null, 2));

  if (!LIVE && needsUpdate.length) {
    console.log("\nDry run complete — no changes written.");
    console.log("Re-run with --live to apply, optionally --limit=N for a staged rollout.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
