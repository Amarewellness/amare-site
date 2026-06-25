import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  benefitFromAdminBody,
  benefitKey,
  currentPeriodKey,
  getBenefit,
  listBenefits,
  listReportRows,
  normalizeBenefit,
} from "./partner-benefits-lib.mjs";

/** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
function adminJson(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...adminCorsHeaders(extra),
    },
    body: JSON.stringify(body),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function adminPath(event) {
  const fwd = event.headers["x-forwarded-uri"] || event.headers["X-Forwarded-Uri"];
  if (typeof fwd === "string" && fwd.includes("/api/admin/benefits")) {
    return fwd.split("?")[0].replace(/\/+$/, "");
  }
  const raw = event.rawUrl || event.path || "";
  const path = raw.includes("://") ? new URL(raw).pathname : String(raw).split("?")[0];
  return path.replace(/\/+$/, "") || "/api/admin/benefits";
}

/** @param {Record<string, unknown>[]} rows */
function csvFromRows(rows) {
  const header = [
    "redeemedAt",
    "memberDisplayName",
    "memberClientId",
    "benefitTitle",
    "partnerDisplayName",
    "partnerSlug",
    "benefitId",
    "periodKey",
    "status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      header
        .map((k) => {
          const v = String(r[k] ?? "");
          if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
          return v;
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

async function adminHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: adminCorsHeaders(), body: "" };
  }
  if (!adminAuthorized(event)) {
    return adminJson(401, { ok: false, error: "unauthorized" });
  }
  if (!partnerBenefitsBlobsEnabled()) {
    return adminJson(503, { ok: false, error: "partner_benefits_blobs_disabled" });
  }
  const store = tryOpenPartnerBenefitsBlobStore(event);
  if (!store) return adminJson(503, { ok: false, error: "partner_benefits_store_unavailable" });

  const path = adminPath(event);
  const qs = event.queryStringParameters || {};

  if (path.endsWith("/list") && event.httpMethod === "GET") {
    const benefits = await listBenefits(store);
    return adminJson(200, { ok: true, benefits });
  }

  if (path.endsWith("/create") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const parsed = benefitFromAdminBody(body);
    if (!parsed.ok) return adminJson(400, { ok: false, error: parsed.error });
    const existing = await getBenefit(store, parsed.benefit.id);
    if (existing) return adminJson(409, { ok: false, error: "benefit_exists" });
    await store.setJSON(benefitKey(parsed.benefit.id), parsed.benefit);
    return adminJson(201, { ok: true, benefit: parsed.benefit });
  }

  if (path.endsWith("/update") && event.httpMethod === "PUT") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const existing = await getBenefit(store, id);
    if (!existing) return adminJson(404, { ok: false, error: "not_found" });
    const parsed = benefitFromAdminBody({ ...existing, ...body, id, createdAt: existing.createdAt });
    if (!parsed.ok) return adminJson(400, { ok: false, error: parsed.error });
    await store.setJSON(benefitKey(id), parsed.benefit);
    return adminJson(200, { ok: true, benefit: parsed.benefit });
  }

  if (path.endsWith("/redemptions/export") && event.httpMethod === "GET") {
    const month = String(qs.month || currentPeriodKey()).trim();
    const rows = await listReportRows(store, {
      month,
      benefitId: String(qs.benefitId || "").trim() || undefined,
      partnerSlug: String(qs.partnerSlug || "").trim() || undefined,
    });
    const csv = csvFromRows(rows);
    return {
      statusCode: 200,
      headers: {
        ...adminCorsHeaders({ "Content-Type": "text/csv; charset=utf-8" }),
        "Content-Disposition": `attachment; filename="benefits-redemptions-${month}.csv"`,
      },
      body: csv,
    };
  }

  if (path.endsWith("/redemptions") && event.httpMethod === "GET") {
    const month = String(qs.month || currentPeriodKey()).trim();
    const rows = await listReportRows(store, {
      month,
      benefitId: String(qs.benefitId || "").trim() || undefined,
      partnerSlug: String(qs.partnerSlug || "").trim() || undefined,
    });
    const byBenefit = /** @type {Record<string, number>} */ ({});
    const byPartner = /** @type {Record<string, number>} */ ({});
    for (const r of rows) {
      const bt = String(r.benefitTitle || r.benefitId || "unknown");
      const ps = String(r.partnerDisplayName || r.partnerSlug || "unknown");
      byBenefit[bt] = (byBenefit[bt] || 0) + 1;
      byPartner[ps] = (byPartner[ps] || 0) + 1;
    }
    return adminJson(200, {
      ok: true,
      month,
      total: rows.length,
      byBenefit,
      byPartner,
      rows,
    });
  }

  return adminJson(404, { ok: false, error: "not_found" });
}

export const handler = adminHandler;
