/**
 * Optional pull of historical `private-events` submissions from Netlify Forms.
 * Needs SITE_ID (automatic on Netlify) plus NETLIFY_AUTH_TOKEN / NETLIFY_PAT,
 * or a logged-in Netlify CLI locally.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { composeInquiryDate } from "./event-inquiry-store.mjs";

function repoRoot() {
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
  return process.cwd();
}

function netlifyCliConfigPath() {
  if ((process.env.NETLIFY_CLI_CONFIG || "").trim()) return process.env.NETLIFY_CLI_CONFIG.trim();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "netlify",
      "Config",
      "config.json",
    );
  }
  return path.join(os.homedir(), ".config", "netlify", "config.json");
}

function readNetlifyCliAuthToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(netlifyCliConfigPath(), "utf8"));
    for (const user of Object.values(cfg?.users || {})) {
      const token = String(/** @type {{ auth?: { token?: string } }} */ (user)?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    /* not logged in */
  }
  return "";
}

function linkedSiteId() {
  const fromEnv = (process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(repoRoot(), ".netlify", "state.json"), "utf8"));
    return String(state.siteId || "").trim();
  } catch {
    return "";
  }
}

function authToken() {
  return (process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PAT || readNetlifyCliAuthToken()).trim();
}

/** @param {Record<string, unknown>} data */
function fromNetlifyData(data) {
  const year = String(data.event_year || data.year || "").trim();
  const month = String(data.event_month || data.month || "").trim();
  const day = String(data.event_day || data.day || "").trim();
  return {
    firstName: String(data.first_name || data.firstName || "").trim(),
    lastName: String(data.last_name || data.lastName || "").trim(),
    email: String(data.email || "").trim(),
    phone: String(data.phone || "").trim(),
    eventDate: composeInquiryDate(year, month, day),
    eventTime: String(data.event_time || data.time || "").trim(),
    message: String(data.message || "").trim(),
  };
}

/**
 * @returns {Promise<{ rows: import("./event-inquiry-store.mjs").EventInquiry[]; source: "netlify"|"none"; error?: string }>}
 */
export async function fetchNetlifyEventInquiries() {
  const siteID = linkedSiteId();
  const token = authToken();
  if (!siteID || !token) {
    return { rows: [], source: "none" };
  }

  const headers = { Authorization: `Bearer ${token}` };
  try {
    const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteID)}/forms`, {
      headers,
    });
    if (!formsRes.ok) {
      return { rows: [], source: "none", error: `forms_${formsRes.status}` };
    }
    const forms = await formsRes.json();
    if (!Array.isArray(forms)) return { rows: [], source: "none", error: "forms_invalid" };
    const form = forms.find((f) => {
      const name = String(f?.name || "").toLowerCase().replace(/_/g, "-");
      return name === "private-events";
    });
    if (!form?.id) return { rows: [], source: "netlify" };

    const subsRes = await fetch(
      `https://api.netlify.com/api/v1/forms/${encodeURIComponent(String(form.id))}/submissions?per_page=100`,
      { headers },
    );
    if (!subsRes.ok) {
      return { rows: [], source: "none", error: `submissions_${subsRes.status}` };
    }
    const subs = await subsRes.json();
    if (!Array.isArray(subs)) return { rows: [], source: "netlify" };

    /** @type {import("./event-inquiry-store.mjs").EventInquiry[]} */
    const rows = [];
    for (const sub of subs) {
      const data = sub?.data && typeof sub.data === "object" ? /** @type {Record<string, unknown>} */ (sub.data) : {};
      const mapped = fromNetlifyData(data);
      if (!mapped.email && !mapped.message) continue;
      const netlifyId = String(sub.id || "").trim();
      rows.push({
        id: netlifyId ? `nf_${netlifyId}` : `nf_${rows.length}`,
        ...mapped,
        source: "netlify",
        netlifyId,
        createdAt: String(sub.created_at || sub.createdAt || new Date().toISOString()),
      });
    }
    return { rows, source: "netlify" };
  } catch (e) {
    return {
      rows: [],
      source: "none",
      error: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 160),
    };
  }
}
