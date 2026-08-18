import crypto from "node:crypto";
import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";
import { calendarMonthPeriodKey } from "./guest-pass-lib.mjs";
import { loadGuestPassLib } from "./guest-pass-lib-loader.mjs";
import { partnerBenefitsBlobReadConsistency } from "./partner-benefits-blobs.mjs";

export const STUDIO_TZ = "America/New_York";

/** @returns {string} */
export function tokenSecret() {
  const s = (process.env.BENEFITS_TOKEN_SECRET || process.env.SESSION_SECRET || "").trim();
  if (s.length >= 16) return s;
  return "dev-partner-benefits-token-secret";
}

/** @param {string} token */
export function hashToken(token) {
  return crypto.createHmac("sha256", tokenSecret()).update(token).digest("base64url");
}

/** @returns {string} */
export function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** @param {string} benefitId */
export function benefitKey(benefitId) {
  return `benefit:${benefitId}`;
}

/** @param {string} benefitId @param {number} memberClientId @param {string} periodKey */
export function redemptionKey(benefitId, memberClientId, periodKey) {
  return `redemption:${benefitId}:${memberClientId}:${periodKey}`;
}

/** @param {string} tokenHash */
export function tokenLookupKey(tokenHash) {
  return `token:${tokenHash}`;
}

/** @param {string} periodKey @param {string} partnerSlug @param {string} redemptionId */
export function reportKey(periodKey, partnerSlug, redemptionId) {
  return `report:${periodKey}:${partnerSlug}:${redemptionId}`;
}

/** @param {Date} [now] */
export function currentPeriodKey(now = new Date()) {
  return calendarMonthPeriodKey(now, STUDIO_TZ);
}

/**
 * @param {string} periodKey YYYY-MM
 */
export function periodEndIso(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || "").trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(lastDay)}T23:59:59-05:00`;
}

/** @param {string} periodKey */
export function validThroughLabel(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) return "—";
  const y = +m[1];
  const mo = +m[2];
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[mo - 1]} ${lastDay}`;
}

/** @param {string} periodKey */
export function nextPeriodStartLabel(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) return "next month";
  let y = +m[1];
  let mo = +m[2] + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[mo - 1]} 1`;
}

/** @param {string} ymd YYYY-MM-DD */
export function dateLabelFromYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!m) return "—";
  const mo = +m[2];
  const day = +m[3];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[mo - 1]} ${day}`;
}

/** @param {unknown} freq */
export function normalizeFrequency(freq) {
  if (freq && typeof freq === "object") {
    const t = String(/** @type {Record<string, unknown>} */ (freq).type || "").trim();
    if (t === "once_per_campaign" || t === "calendar_month") {
      return { type: t, limit: 1 };
    }
  }
  return { type: "calendar_month", limit: 1 };
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit */
export function benefitFrequencyType(benefit) {
  return normalizeFrequency(benefit?.frequency).type;
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {Date} [now] */
export function redemptionPeriodKey(benefit, now = new Date()) {
  if (benefitFrequencyType(benefit) === "once_per_campaign") {
    const from = benefit.activeFrom || "open";
    const until = benefit.activeUntil || "open";
    return `campaign:${from}:${until}`;
  }
  return currentPeriodKey(now);
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {string} periodKey */
export function redemptionExpiresAt(benefit, periodKey) {
  if (benefitFrequencyType(benefit) === "once_per_campaign") {
    if (benefit.activeUntil) return `${benefit.activeUntil}T23:59:59-05:00`;
    return periodEndIso(currentPeriodKey()) || new Date().toISOString();
  }
  return periodEndIso(periodKey);
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {string} periodKey */
export function validThroughLabelForBenefit(benefit, periodKey) {
  const pk = String(periodKey || "");
  if (benefitFrequencyType(benefit) === "once_per_campaign") {
    if (benefit.activeUntil) return dateLabelFromYmd(benefit.activeUntil);
    const camp = /^campaign:([^:]*):([^:]*)$/.exec(pk);
    if (camp?.[2] && camp[2] !== "open") return dateLabelFromYmd(camp[2]);
    return "—";
  }
  return validThroughLabel(pk);
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {Record<string, unknown>} redemption */
export function validThroughLabelForRedemption(benefit, redemption) {
  const periodKey = String(redemption?.periodKey || "");
  let label = validThroughLabelForBenefit(benefit, periodKey);
  if (label !== "—") return label;
  const exp = String(redemption?.expiresAt || "");
  let ym = /^(\d{4})-(\d{2})-(\d{2})/.exec(exp);
  if (ym) return dateLabelFromYmd(`${ym[1]}-${ym[2]}-${ym[3]}`);
  const computed = redemptionExpiresAt(benefit, periodKey);
  ym = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(computed || ""));
  if (ym) return dateLabelFromYmd(`${ym[1]}-${ym[2]}-${ym[3]}`);
  return "—";
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {string} periodKey */
export function redeemedAvailableAgainLabel(benefit, periodKey) {
  if (benefitFrequencyType(benefit) === "once_per_campaign") return null;
  return nextPeriodStartLabel(periodKey);
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit */
export function notEligibleMessageForBenefit(benefit) {
  if (benefitFrequencyType(benefit) === "once_per_campaign") {
    return "This one-time perk is for active monthly members and 10/20 class packs.";
  }
  return "Monthly perks are included with active monthly memberships.";
}

/** @typedef {{ monthly: boolean; flexiblePack: boolean }} PartnerBenefitsEntitlement */

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {PartnerBenefitsEntitlement} entitlement */
export function isEligibleForBenefit(benefit, entitlement) {
  if (benefitFrequencyType(benefit) === "once_per_campaign") {
    return Boolean(entitlement.monthly || entitlement.flexiblePack);
  }
  return Boolean(entitlement.monthly);
}

/** @param {NonNullable<Awaited<ReturnType<typeof getBenefit>>>} benefit @param {Record<string, unknown> | null} redemption @param {PartnerBenefitsEntitlement} entitlement */
export function memberBenefitStatus(benefit, redemption, entitlement) {
  const periodKey = redemptionPeriodKey(benefit);
  const eligible = isEligibleForBenefit(benefit, entitlement);
  if (!eligible) {
    return {
      status: "not_eligible",
      message: notEligibleMessageForBenefit(benefit),
      redemptionPeriodKey: periodKey,
    };
  }
  if (redemption && String(redemption.status) === "redeemed") {
    const redeemedAt = String(redemption.redeemedAt || "").slice(0, 10);
    const availableAgain = redeemedAvailableAgainLabel(benefit, periodKey);
    return {
      status: "redeemed",
      redeemedAt,
      availableAgain,
      redeemedMessage: availableAgain ? null : "One-time campaign perk",
      redemptionPeriodKey: periodKey,
    };
  }
  if (redemption && String(redemption.status) === "pending" && !redemptionIsExpired(redemption)) {
    return {
      status: "pending_token",
      validThrough: validThroughLabelForBenefit(benefit, periodKey),
      redemptionPeriodKey: periodKey,
    };
  }
  return {
    status: "eligible",
    validThrough: validThroughLabelForBenefit(benefit, periodKey),
    redemptionPeriodKey: periodKey,
  };
}

/** @param {import("@netlify/blobs").Store} store @param {number} clientId @param {PartnerBenefitsEntitlement} entitlement */
export async function collectMemberBenefitItems(store, clientId, entitlement) {
  const benefits = (await listBenefits(store)).filter((b) => isBenefitVisible(b));
  const seenIds = new Set(benefits.map((b) => b.id));
  /** @type {{ benefit: NonNullable<Awaited<ReturnType<typeof getBenefit>>>; st: ReturnType<typeof memberBenefitStatus> }[]} */
  const items = [];

  for (const benefit of benefits) {
    const rk = redemptionPeriodKey(benefit);
    const redemption = await loadRedemption(store, benefit.id, clientId, rk);
    const st = memberBenefitStatus(benefit, redemption, entitlement);
    items.push({ benefit, st });
  }

  const pendingOnly = await listPendingRedemptionsForMember(store, clientId);
  for (const redemption of pendingOnly) {
    const benefitId = String(redemption.benefitId || "");
    if (!benefitId || seenIds.has(benefitId)) continue;
    const benefit = await getBenefit(store, benefitId);
    if (!benefit) continue;
    const rk = redemptionPeriodKey(benefit);
    if (String(redemption.periodKey || "") !== rk) continue;
    seenIds.add(benefitId);
    const st = memberBenefitStatus(benefit, redemption, entitlement);
    items.push({ benefit, st });
  }

  return items;
}

/** @param {{ benefit: NonNullable<Awaited<ReturnType<typeof getBenefit>>>; st: ReturnType<typeof memberBenefitStatus> }[]} items */
export function memberBenefitsBadgeFromItems(items) {
  const eligible = items.filter((i) => i.st.status === "eligible");
  const count = eligible.length;
  const eligibleIds = eligible.map((i) => i.benefit.id);
  /** @type {string | null} */
  let headline = null;
  if (count === 1) {
    const title = String(eligible[0].benefit.title || "").trim();
    headline = title
      ? `You have a new member benefit waiting: ${title}`
      : "You have a new member benefit waiting";
  } else if (count > 1) {
    headline = `You have ${count} new member benefits waiting`;
  }
  return {
    show: count > 0,
    eligibleCount: count,
    eligibleIds,
    eligibleBenefits: eligible.map((i) => ({
      id: i.benefit.id,
      title: String(i.benefit.title || "").trim(),
    })),
    headline,
    memberUrl: "/member#benefits",
  };
}

/** @param {unknown} row */
export function normalizeBenefit(row) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  const id = String(o.id || "").trim();
  if (!id) return null;
  return {
    id,
    partnerSlug: String(o.partnerSlug || id).trim(),
    partnerDisplayName: String(o.partnerDisplayName || "Partner").trim(),
    title: String(o.title || "Member benefit").trim(),
    description: String(o.description || "").trim(),
    terms: String(o.terms || "").trim(),
    logoUrl: String(o.logoUrl || "").trim(),
    locationAddress: String(o.locationAddress || "").trim(),
    partnerPhone: String(o.partnerPhone || "").trim(),
    activeFrom: String(o.activeFrom || "").trim(),
    activeUntil: String(o.activeUntil || "").trim(),
    eligibility: { type: "monthly_membership" },
    frequency: normalizeFrequency(o.frequency),
    active: o.active !== false,
    createdAt: String(o.createdAt || ""),
    updatedAt: String(o.updatedAt || ""),
  };
}

/** @param {import("@netlify/blobs").Store} store */
export async function listBenefits(store) {
  /** @type {ReturnType<typeof normalizeBenefit>[]} */
  const out = [];
  const pages = store.list({ prefix: "benefit:", paginate: true });
  for await (const page of pages) {
    for (const b of page?.blobs ?? []) {
      if (!b?.key) continue;
      const raw = await store.get(b.key, { type: "json" });
      const norm = normalizeBenefit(raw);
      if (norm) out.push(norm);
    }
  }
  out.sort((a, b) => String(a?.title).localeCompare(String(b?.title)));
  return out;
}

/** @param {import("@netlify/blobs").Store} store @param {string} benefitId */
export async function getBenefit(store, benefitId) {
  const raw = await store.get(benefitKey(benefitId), { type: "json" });
  return normalizeBenefit(raw);
}

/** @param {ReturnType<typeof normalizeBenefit>} benefit @param {Date} [now] */
export function isBenefitVisible(benefit, now = new Date()) {
  if (!benefit?.active) return false;
  const t = now.getTime();
  if (benefit.activeFrom) {
    const from = Date.parse(`${benefit.activeFrom}T00:00:00`);
    if (Number.isFinite(from) && t < from) return false;
  }
  if (benefit.activeUntil) {
    const until = Date.parse(`${benefit.activeUntil}T23:59:59`);
    if (Number.isFinite(until) && t > until) return false;
  }
  return true;
}

/** @param {import("@netlify/blobs").Store} store @param {number} memberClientId */
export async function listPendingRedemptionsForMember(store, memberClientId) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  const pages = store.list({ prefix: "redemption:", paginate: true });
  for await (const page of pages) {
    for (const b of page?.blobs ?? []) {
      if (!b?.key) continue;
      const raw = await store.get(b.key, { type: "json" });
      if (!raw || typeof raw !== "object") continue;
      const redemption = /** @type {Record<string, unknown>} */ (raw);
      if (Number(redemption.memberClientId) !== memberClientId) continue;
      if (String(redemption.status) !== "pending") continue;
      if (redemptionIsExpired(redemption)) continue;
      out.push(redemption);
    }
  }
  return out;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {number} memberClientId
 * @param {{ consumerAuthHeaders?: Record<string, string> | null }} [opts]
 * @returns {Promise<PartnerBenefitsEntitlement>}
 */
export async function resolvePartnerBenefitsEntitlement(event, memberClientId, opts = {}) {
  const gpg = await loadGuestPassLib();
  const { resolveGuestPassStaffHeaders } = await import("./mindbody-guest-pass-sale.mjs");
  const staffHeaders = await resolveGuestPassStaffHeaders();
  const entOpts = {
    consumerAuthHeaders: opts.consumerAuthHeaders ?? null,
    staffHeaders,
  };
  const [ent, flexiblePack] = await Promise.all([
    gpg.resolveGuestPassEntitlement(memberClientId, event, entOpts),
    gpg.hasActiveNonExpiredFlexiblePack(memberClientId, event, entOpts),
  ]);
  return {
    monthly: Boolean(ent?.ok && ent.periodMode === "calendarMonth"),
    flexiblePack: Boolean(flexiblePack),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {number} memberClientId */
export async function hasActiveMonthlyMembership(event, memberClientId) {
  const ent = await resolvePartnerBenefitsEntitlement(event, memberClientId);
  return ent.monthly;
}

/** @param {string} first @param {string} [lastInitial] */
export function formatMemberShort(first, lastInitial) {
  const f = String(first || "Member").trim();
  const li = String(lastInitial || "").trim();
  return li ? `${f} ${li}.` : f;
}

/** @param {string | null | undefined} fullName @param {Record<string, unknown> | null} [client] */
export function memberDisplayName(fullName, client) {
  let first = "";
  let last = "";
  if (client && typeof client === "object") {
    first = String(client.FirstName ?? client.firstName ?? "").trim();
    last = String(client.LastName ?? client.lastName ?? "").trim();
  }
  if (!first && fullName) {
    const parts = String(fullName).trim().split(/\s+/);
    first = parts[0] || "";
    last = parts.slice(1).join(" ");
  }
  const lastInitial = last ? last.charAt(0).toUpperCase() : "";
  return {
    firstName: first || "Member",
    lastInitial,
    display: formatMemberShort(first || "Member", lastInitial),
  };
}

/** @param {import("@netlify/blobs").Store} store @param {string} benefitId @param {number} memberClientId @param {string} periodKey */
export async function loadRedemption(store, benefitId, memberClientId, periodKey) {
  const raw = await store.get(redemptionKey(benefitId, memberClientId, periodKey), { type: "json" });
  if (!raw || typeof raw !== "object") return null;
  return /** @type {Record<string, unknown>} */ (raw);
}

/** @param {Record<string, unknown>} redemption */
export function redemptionIsExpired(redemption) {
  if (String(redemption.status) === "redeemed") return false;
  const exp = Date.parse(String(redemption.expiresAt || ""));
  if (!Number.isFinite(exp)) return false;
  return Date.now() > exp;
}

/** @param {import("@netlify/blobs").Store} store @param {{ benefit: NonNullable<ReturnType<typeof normalizeBenefit>>; memberClientId: number; memberFirstName: string; memberLastInitial: string; periodKey: string; }} opts */
export async function issueOrReuseToken(store, opts) {
  const rk = redemptionKey(opts.benefit.id, opts.memberClientId, opts.periodKey);
  const existing = await loadRedemption(store, opts.benefit.id, opts.memberClientId, opts.periodKey);
  if (existing) {
    if (String(existing.status) === "redeemed") {
      return { ok: false, error: "already_redeemed_this_period" };
    }
    if (String(existing.status) === "pending" && !redemptionIsExpired(existing)) {
      const plain = String(existing.tokenPlain || "");
      if (plain) {
        return { ok: true, token: plain, tokenHash: String(existing.tokenHash || hashToken(plain)), redemption: existing, reused: true };
      }
    }
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = redemptionExpiresAt(opts.benefit, opts.periodKey);
  const redemptionId = crypto.randomBytes(8).toString("hex");
  const record = {
    id: redemptionId,
    status: "pending",
    benefitId: opts.benefit.id,
    partnerSlug: opts.benefit.partnerSlug,
    memberClientId: opts.memberClientId,
    memberFirstName: opts.memberFirstName,
    memberLastInitial: opts.memberLastInitial,
    periodKey: opts.periodKey,
    issuedAt: new Date().toISOString(),
    expiresAt,
    redeemedAt: null,
    tokenHash,
    tokenPlain: token,
  };

  const created = await atomicCreateJSON(store, rk, record);
  if (!created.modified) {
    const again = await loadRedemption(store, opts.benefit.id, opts.memberClientId, opts.periodKey);
    if (again && String(again.status) === "pending" && again.tokenPlain) {
      return { ok: true, token: String(again.tokenPlain), tokenHash: String(again.tokenHash), redemption: again, reused: true };
    }
    if (again && String(again.status) === "redeemed") {
      return { ok: false, error: "already_redeemed_this_period" };
    }
    return { ok: false, error: "issue_conflict" };
  }

  await store.setJSON(tokenLookupKey(tokenHash), { redemptionKey: rk, benefitId: opts.benefit.id, expiresAt });
  return { ok: true, token, tokenHash, redemption: record, reused: false };
}

/** @param {import("@netlify/blobs").Store} store @param {string} token */
export async function validateToken(store, token) {
  const tokenHash = hashToken(token);
  const lookup = await store.get(tokenLookupKey(tokenHash), { type: "json" });
  if (!lookup || typeof lookup !== "object") return { ok: false, error: "invalid_token" };
  const rk = String(/** @type {Record<string, unknown>} */ (lookup).redemptionKey || "");
  if (!rk) return { ok: false, error: "invalid_token" };
  const redemption = await store.get(rk, { type: "json" });
  if (!redemption || typeof redemption !== "object") return { ok: false, error: "invalid_token" };
  const r = /** @type {Record<string, unknown>} */ (redemption);
  if (String(r.status) === "redeemed") return { ok: false, error: "already_redeemed", redemption: r };
  if (redemptionIsExpired(r)) return { ok: false, error: "period_expired", redemption: r };
  const benefit = await getBenefit(store, String(r.benefitId || ""));
  if (!benefit) return { ok: false, error: "benefit_not_found" };
  return { ok: true, redemption: r, benefit };
}

/** @param {import("@netlify/blobs").Store} store @param {string} token @param {string | null} ip */
export async function confirmRedemption(store, token, ip) {
  const validated = await validateToken(store, token);
  if (!validated.ok) return validated;
  const rk = redemptionKey(
    String(validated.redemption.benefitId),
    Number(validated.redemption.memberClientId),
    String(validated.redemption.periodKey),
  );

  const result = await atomicUpdateJSON(
    store,
    rk,
    async (current) => {
      if (!current || typeof current !== "object") return null;
      const c = /** @type {Record<string, unknown>} */ (current);
      if (String(c.status) === "redeemed") return null;
      if (redemptionIsExpired(c)) return null;
      return { ...c, status: "redeemed", redeemedAt: new Date().toISOString(), redeemedIp: ip || null };
    },
    { readConsistency: partnerBenefitsBlobReadConsistency(store) },
  );

  if (!result.ok || !result.modified) {
    const again = await loadRedemption(
      store,
      String(validated.redemption.benefitId),
      Number(validated.redemption.memberClientId),
      String(validated.redemption.periodKey),
    );
    if (again && String(again.status) === "redeemed") {
      return { ok: false, error: "already_redeemed", redemption: again, benefit: validated.benefit };
    }
    return { ok: false, error: "confirm_failed" };
  }

  const updated = /** @type {Record<string, unknown>} */ (result.record);
  const benefit = validated.benefit;
  const names = formatMemberShort(String(updated.memberFirstName || ""), String(updated.memberLastInitial || ""));
  const redeemedAt = String(updated.redeemedAt || "");
  const reportMonth = calendarMonthPeriodKey(new Date(redeemedAt || Date.now()), STUDIO_TZ);
  const reportRow = {
    redemptionId: String(updated.id || ""),
    redeemedAt,
    memberClientId: Number(updated.memberClientId),
    memberDisplayName: names,
    memberFirstName: String(updated.memberFirstName || ""),
    memberLastInitial: String(updated.memberLastInitial || ""),
    benefitId: benefit.id,
    benefitTitle: benefit.title,
    partnerSlug: benefit.partnerSlug,
    partnerDisplayName: benefit.partnerDisplayName,
    periodKey: String(updated.periodKey || ""),
    status: "redeemed",
  };
  await store.setJSON(
    reportKey(reportMonth, benefit.partnerSlug, String(updated.id || "x")),
    reportRow,
  );
  return { ok: true, redemption: updated, benefit, report: reportRow };
}

/** @param {import("@netlify/blobs").Store} store @param {{ month?: string; benefitId?: string; partnerSlug?: string }} filters */
export async function listReportRows(store, filters) {
  const month = filters.month || currentPeriodKey();
  const prefix = `report:${month}:`;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const pages = store.list({ prefix, paginate: true });
  for await (const page of pages) {
    for (const b of page?.blobs ?? []) {
      if (!b?.key) continue;
      const raw = await store.get(b.key, { type: "json" });
      if (!raw || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      if (filters.benefitId && String(row.benefitId) !== filters.benefitId) continue;
      if (filters.partnerSlug && String(row.partnerSlug) !== filters.partnerSlug) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => String(b.redeemedAt).localeCompare(String(a.redeemedAt)));
  return rows;
}

/** @param {string} baseUrl @param {string} token */
export function qrUrl(baseUrl, token) {
  return `${baseUrl.replace(/\/$/, "")}/benefits/redeem?t=${encodeURIComponent(token)}`;
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export function siteOriginFromEvent(event) {
  const host = event.headers["x-forwarded-host"] || event.headers["host"] || "www.amarewellness.com";
  const proto = event.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export function clientIp(event) {
  const xff = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return event.headers["client-ip"] || null;
}

/** @param {string} address */
export function mapsUrlForAddress(address) {
  const a = String(address || "").trim();
  if (!a) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
}

/** @param {string} slug */
export function slugify(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** @param {Record<string, unknown>} body */
export function benefitFromAdminBody(body) {
  const title = String(body.title || "").trim();
  const partnerDisplayName = String(body.partnerDisplayName || body.partnerName || "").trim();
  if (!title || !partnerDisplayName) return { ok: false, error: "missing_fields" };
  const id = String(body.id || slugify(`${partnerDisplayName}-${title}`)).trim() || slugify(title);
  const now = new Date().toISOString();
  const frequency = normalizeFrequency(
    body.frequencyType ? { type: body.frequencyType } : body.frequency,
  );
  const defaultTerms =
    frequency.type === "once_per_campaign"
      ? "One use per member during the campaign dates."
      : "One per active monthly member per calendar month.";
  return {
    ok: true,
    benefit: {
      id,
      partnerSlug: slugify(String(body.partnerSlug || partnerDisplayName)),
      partnerDisplayName,
      title,
      description: String(body.description || "").trim(),
      terms: String(body.terms || defaultTerms).trim(),
      logoUrl: String(body.logoUrl || "").trim(),
      locationAddress: String(body.locationAddress || "").trim(),
      partnerPhone: String(body.partnerPhone || "").trim(),
      activeFrom: String(body.activeFrom || "").trim(),
      activeUntil: String(body.activeUntil || "").trim(),
      eligibility: { type: "monthly_membership" },
      frequency,
      active: body.active !== false,
      createdAt: String(body.createdAt || now),
      updatedAt: now,
    },
  };
}
