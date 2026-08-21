/**
 * Shared booking cancellation-policy kind for web + mobile.
 * Uses the same bookable ClientService rules as class book (Remaining > 0, not expired).
 * ProductIds match member-topup-lib / catalog — no display-name inference.
 */
import { connectLambda, getStore } from "@netlify/blobs";
import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import {
  GUEST_PASS_SERVICE_ID,
  MONTHLY_5_8_PRODUCT_IDS,
  MONTHLY_UNLIMITED_PRODUCT_IDS,
  ORDINARY_GROUP_CLASS_PRODUCT_IDS,
  TOPUP_SERVICE_ID,
  clientServiceExpired,
  clientServiceProductId,
  clientServiceRemaining,
  clientServicesRowsFromPayload,
} from "./member-topup-lib.mjs";

export const UNLIMITED_FEE_POLICY_VERSION = "unlimited_booking_fee_v1";
export const BOOKING_ACK_STORE_NAME = "class-booking-acks";

export const UNLIMITED_POLICY_COPY = Object.freeze({
  title: "Unlimited Member Policy",
  body: "I understand that late cancellations made less than 12 hours before class and no-shows are subject to a $10 fee.",
  checkboxLabel:
    "I understand that late cancellations made less than 12 hours before class and no-shows are subject to a $10 fee.",
});

export const CREDIT_POLICY_COPY = Object.freeze({
  title: "Cancellation Policy",
  body: "Cancellations made less than 12 hours before class are considered late cancellations and the class credit will be forfeited.",
  checkboxLabel: null,
});

const CREDIT_PRODUCT_IDS = new Set([
  ...ORDINARY_GROUP_CLASS_PRODUCT_IDS,
  ...MONTHLY_5_8_PRODUCT_IDS,
  TOPUP_SERVICE_ID,
]);

/** @param {unknown} raw */
export function clientServiceRowId(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const sid = row.Id ?? row.id;
  if (typeof sid === "number" && Number.isFinite(sid) && sid > 0) return Math.trunc(sid);
  if (typeof sid === "string" && /^\d+$/.test(sid.trim())) return parseInt(sid.trim(), 10);
  return null;
}

/**
 * Same bookable filter as listActiveClientServiceIds: Remaining > 0 and not expired.
 * Does not require Mindbody Active/Current — exhausted monthly rows are not bookable here
 * because Remaining is 0.
 *
 * @param {Record<string, unknown>} row
 * @param {number} [nowMs]
 */
export function isBookableClassServiceRow(row, nowMs = Date.now()) {
  if (!row || typeof row !== "object") return false;
  const rem = clientServiceRemaining(row);
  if (!(rem > 0)) return false;
  if (clientServiceExpired(row, nowMs)) return false;
  const pid = clientServiceProductId(row);
  if (pid === GUEST_PASS_SERVICE_ID) return false;
  return true;
}

/** @param {Record<string, unknown>} row */
export function bookingServiceKind(row) {
  const pid = clientServiceProductId(row);
  if (MONTHLY_UNLIMITED_PRODUCT_IDS.includes(pid)) return "unlimited";
  if (CREDIT_PRODUCT_IDS.has(pid)) return "credit";
  if (Number.isFinite(pid) && pid > 0) return "credit";
  return "credit";
}

/**
 * @param {unknown} servicePayloadOrRows
 * @param {number} [nowMs]
 */
export function resolveBookingCancellationPolicy(servicePayloadOrRows, nowMs = Date.now()) {
  const rows = Array.isArray(servicePayloadOrRows)
    ? servicePayloadOrRows.filter((x) => x && typeof x === "object")
    : clientServicesRowsFromPayload(servicePayloadOrRows);

  let unlimitedBookable = 0;
  let creditBookable = 0;
  for (const raw of rows) {
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (!isBookableClassServiceRow(row, nowMs)) continue;
    if (bookingServiceKind(row) === "unlimited") unlimitedBookable += 1;
    else creditBookable += 1;
  }

  if (unlimitedBookable > 0) {
    return {
      kind: "unlimited_fee",
      requiresAcknowledgment: true,
      policyVersion: UNLIMITED_FEE_POLICY_VERSION,
      title: UNLIMITED_POLICY_COPY.title,
      body: UNLIMITED_POLICY_COPY.body,
      checkboxLabel: UNLIMITED_POLICY_COPY.checkboxLabel,
      unlimitedBookable,
      creditBookable,
      mixedBookable: creditBookable > 0,
    };
  }
  if (creditBookable > 0) {
    return {
      kind: "credit_forfeit",
      requiresAcknowledgment: false,
      policyVersion: null,
      title: CREDIT_POLICY_COPY.title,
      body: CREDIT_POLICY_COPY.body,
      checkboxLabel: null,
      unlimitedBookable: 0,
      creditBookable,
      mixedBookable: false,
    };
  }
  return {
    kind: "none",
    requiresAcknowledgment: false,
    policyVersion: null,
    title: null,
    body: null,
    checkboxLabel: null,
    unlimitedBookable: 0,
    creditBookable: 0,
    mixedBookable: false,
  };
}

/**
 * Consumer + staff ClientServices union (same merge idea as class book / member-summary).
 * @param {number} clientId
 * @param {Record<string, string> | null} consumerHeaders
 * @param {Record<string, string> | null} [staffHeaders]
 */
export async function loadMergedClientServiceRows(clientId, consumerHeaders, staffHeaders) {
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const path = `/public/v${MB_API_VERSION}/client/clientservices?${q}`;
  const [consumer, staff] = await Promise.all([
    consumerHeaders ? fetchMb("GET", path, consumerHeaders, null) : Promise.resolve({ ok: false, data: null }),
    staffHeaders ? fetchMb("GET", path, staffHeaders, null) : Promise.resolve({ ok: false, data: null }),
  ]);
  /** @type {Map<number, Record<string, unknown>>} */
  const byId = new Map();
  for (const row of [
    ...clientServicesRowsFromPayload(consumer.ok ? consumer.data : null),
    ...clientServicesRowsFromPayload(staff.ok ? staff.data : null),
  ]) {
    const id = clientServiceRowId(row);
    if (id != null) byId.set(id, row);
  }
  return [...byId.values()];
}

/** Public member-summary / client payload — no internal counts. */
export function publicCancellationPolicy(policy) {
  return {
    kind: policy.kind,
    requiresAcknowledgment: policy.requiresAcknowledgment === true,
    policyVersion: policy.policyVersion || null,
    title: policy.title || null,
    body: policy.body || null,
    checkboxLabel: policy.checkboxLabel || null,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @param {{ kind?: string, requiresAcknowledgment?: boolean, policyVersion?: string | null }} policy
 */
export function unlimitedFeeAcknowledgmentFromBody(body, policy) {
  if (!policy || policy.kind !== "unlimited_fee" || policy.requiresAcknowledgment !== true) {
    return { required: false, ok: true, policyVersion: null };
  }
  const version = String(body.policyVersion ?? body.PolicyVersion ?? "").trim();
  const ack =
    body.policyAcknowledged === true ||
    body.policyAcknowledged === "true" ||
    body.policyAcknowledged === 1 ||
    body.unlimitedFeeAcknowledged === true ||
    body.unlimitedFeeAcknowledged === "true";
  if (version !== UNLIMITED_FEE_POLICY_VERSION || !ack) {
    return { required: true, ok: false, policyVersion: version || null };
  }
  return { required: true, ok: true, policyVersion: UNLIMITED_FEE_POLICY_VERSION };
}

/** @param {number} mindbodyClientId @param {number} classId @param {string} stamp */
export function unlimitedFeeAckKey(mindbodyClientId, classId, stamp) {
  return `unlimitedFeeAck:${mindbodyClientId}:${classId}:${stamp}`;
}

/**
 * Persist acknowledgment on the existing Netlify Blobs system (same pattern as
 * guest-pass / membership consent). Best-effort after a successful book.
 *
 * @param {{ blobs?: string } | unknown} event
 * @param {Record<string, unknown>} record
 */
export async function persistUnlimitedFeeAcknowledgment(event, record) {
  const clientId = Number(record.mindbodyClientId);
  const classId = Number(record.classId);
  const stamp =
    record.visitId != null
      ? `visit:${record.visitId}`
      : record.waitlistEntryId != null
        ? `waitlist:${record.waitlistEntryId}`
        : String(record.acknowledgedAt || new Date().toISOString());
  const key = unlimitedFeeAckKey(clientId, classId, stamp);
  try {
    if (event && typeof event === "object" && typeof /** @type {{ blobs?: string }} */ (event).blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    const store = getStore({ name: BOOKING_ACK_STORE_NAME, consistency: "eventual" });
    await store.setJSON(key, record);
    return { ok: true, key };
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "unlimited_fee_ack_persist_failed",
        key,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return { ok: false, key };
  }
}
