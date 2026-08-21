/**
 * Resolve a real class name for booking/cancel Push.
 * Never uses itemName (that is the pricing option).
 */

import { fetchMb, getMindbodyStaffAccessTokenCached, MB_API_VERSION } from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

const FALLBACK_CLASS_NAME = "your class";

function text(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

function liveLookupAllowed() {
  return Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function nameFromClassRow(raw) {
  if (!raw || typeof raw !== "object") return "";
  const r = /** @type {Record<string, unknown>} */ (raw);
  const desc =
    r.ClassDescription && typeof r.ClassDescription === "object"
      ? /** @type {Record<string, unknown>} */ (r.ClassDescription)
      : r.classDescription && typeof r.classDescription === "object"
        ? /** @type {Record<string, unknown>} */ (r.classDescription)
        : null;
  return text(desc?.Name || desc?.name || r.ClassName || r.className || r.Name || r.name);
}

function descriptionIdFromClassRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const desc =
    r.ClassDescription && typeof r.ClassDescription === "object"
      ? /** @type {Record<string, unknown>} */ (r.ClassDescription)
      : r.classDescription && typeof r.classDescription === "object"
        ? /** @type {Record<string, unknown>} */ (r.classDescription)
        : null;
  const rawId = desc?.Id ?? desc?.id ?? r.ClassDescriptionId ?? r.classDescriptionId;
  const n = typeof rawId === "number" ? rawId : parseInt(String(rawId ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function staffHeaders() {
  const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
  if (issued.ok === true) {
    const bearer = mindbodyStaffBearerHeaders(issued.accessToken);
    if (bearer) return bearer;
  }
  return mindbodyStaffApiHeaders();
}

/**
 * @param {number} classId
 * @param {string | null} [classStartAt]
 */
export async function defaultFetchMindbodyClassName(classId, classStartAt = null) {
  if (!liveLookupAllowed() || classId == null || !Number.isFinite(Number(classId))) return null;
  const headers = await staffHeaders();
  if (!headers) return null;
  const q = new URLSearchParams();
  q.set("request.classIds", String(classId));
  q.set("request.limit", "10");
  if (classStartAt && Number.isFinite(Date.parse(classStartAt))) {
    const start = new Date(Date.parse(classStartAt) - 12 * 60 * 60 * 1000);
    const end = new Date(Date.parse(classStartAt) + 12 * 60 * 60 * 1000);
    q.set("request.startDateTime", start.toISOString());
    q.set("request.endDateTime", end.toISOString());
  }
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/class/classes?${q}`, headers, null, {
    timeoutMs: 8000,
  });
  if (!r.ok || !r.data || typeof r.data !== "object") return null;
  const rows = /** @type {Record<string, unknown>} */ (r.data).Classes ?? /** @type {Record<string, unknown>} */ (r.data).classes;
  if (!Array.isArray(rows)) return null;
  const match =
    rows.find((row) => {
      const id = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row).Id ?? /** @type {Record<string, unknown>} */ (row).id : null;
      return Number(id) === Number(classId);
    }) || rows[0];
  const className = nameFromClassRow(match);
  if (!className) return null;
  return { className, classDescriptionId: descriptionIdFromClassRow(match), source: "mindbody_class_lookup" };
}

/**
 * @param {{
 *   getClassState?: Function,
 *   getClassDescription?: Function,
 *   upsertClassState?: Function,
 *   upsertClassDescription?: Function,
 * }} store
 * @param {{
 *   siteId: number,
 *   classId?: number | null,
 *   existingName?: string | null,
 *   classDescriptionId?: number | null,
 *   classStartAt?: string | null,
 *   fetchClassName?: Function | null,
 * }} input
 */
export async function enrichClassName(store, input = {}) {
  const existing = text(input.existingName);
  if (existing && existing.toLowerCase() !== FALLBACK_CLASS_NAME) {
    return { className: existing, displayName: existing, source: "roster_booking", fallbackUsed: false };
  }

  const siteId = input.siteId;
  const classId = input.classId;
  let descriptionId = input.classDescriptionId ?? null;
  let state = null;
  if (classId != null && store.getClassState) {
    state = await store.getClassState(siteId, classId);
    const fromState = text(state?.className);
    if (fromState && fromState.toLowerCase() !== FALLBACK_CLASS_NAME) {
      return { className: fromState, displayName: fromState, source: "class_notification_state", fallbackUsed: false };
    }
    if (descriptionId == null && state?.classDescriptionId != null) descriptionId = state.classDescriptionId;
  }

  if (descriptionId != null && store.getClassDescription) {
    const desc = await store.getClassDescription(siteId, descriptionId);
    const fromDesc = text(desc?.className);
    if (fromDesc && fromDesc.toLowerCase() !== FALLBACK_CLASS_NAME) {
      return { className: fromDesc, displayName: fromDesc, source: "class_description", fallbackUsed: false };
    }
  }

  const fetchClass = input.fetchClassName === undefined ? defaultFetchMindbodyClassName : input.fetchClassName;
  if (typeof fetchClass === "function" && classId != null) {
    try {
      const looked = await fetchClass(classId, input.classStartAt || state?.startAt || null);
      const lookedName = text(looked?.className);
      if (lookedName && lookedName.toLowerCase() !== FALLBACK_CLASS_NAME) {
        if (store.upsertClassState && classId != null) {
          await store.upsertClassState({
            siteId,
            classId,
            startAt: state?.startAt || input.classStartAt || null,
            isCancelled: state?.isCancelled === true,
            staffId: state?.staffId ?? null,
            classDescriptionId: looked.classDescriptionId ?? descriptionId ?? state?.classDescriptionId ?? null,
            className: lookedName,
            lastEventOriginationAt: state?.lastEventOriginationAt || new Date().toISOString(),
          });
        }
        if (store.upsertClassDescription && (looked.classDescriptionId || descriptionId)) {
          await store.upsertClassDescription({
            siteId,
            classDescriptionId: looked.classDescriptionId || descriptionId,
            className: lookedName,
            lastEventOriginationAt: new Date().toISOString(),
          });
        }
        return {
          className: lookedName,
          displayName: lookedName,
          source: looked.source || "mindbody_class_lookup",
          fallbackUsed: false,
        };
      }
    } catch {
      /* fall through to fallback */
    }
  }

  return {
    className: null,
    displayName: FALLBACK_CLASS_NAME,
    source: "fallback_your_class",
    fallbackUsed: true,
  };
}
