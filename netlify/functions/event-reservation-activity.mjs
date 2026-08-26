/**
 * Activity / audit timeline for private-event reservations.
 */

import { randomUUID } from "node:crypto";

import { formatUsd } from "./event-booking-lib.mjs";

/** @typedef {{ id: string, at: string, kind: string, label: string, amountCents?: number, offerId?: string, meta?: Record<string, unknown> }} EventActivityItem */

const MAX_LOG = 200;

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @returns {EventActivityItem[]}
 */
export function buildEventActivityTimeline(rec) {
  /** @type {EventActivityItem[]} */
  const items = [];

  /** @param {EventActivityItem} item */
  const push = (item) => {
    if (!item.at) return;
    items.push(item);
  };

  for (const raw of Array.isArray(rec.activityLog) ? rec.activityLog : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const at = String(row.at || "").trim();
    const kind = String(row.kind || "").trim();
    const label = String(row.label || "").trim();
    if (!at || !kind || !label) continue;
    push({
      id: String(row.id || `act_${kind}_${at}`),
      at,
      kind,
      label,
      amountCents: Number.isInteger(row.amountCents) ? Number(row.amountCents) : undefined,
      offerId: row.offerId ? String(row.offerId) : undefined,
      meta: row.meta && typeof row.meta === "object" ? /** @type {Record<string, unknown>} */ (row.meta) : undefined,
    });
  }

  /** @param {string} at @param {string} kind @param {string} label @param {{ amountCents?: number, offerId?: string }} [extra] */
  const legacy = (at, kind, label, extra = {}) => {
    if (!at) return;
    const dup = items.some(
      (it) =>
        it.kind === kind &&
        Math.abs(Date.parse(it.at) - Date.parse(at)) < 90_000 &&
        (extra.amountCents == null || it.amountCents === extra.amountCents),
    );
    if (dup) return;
    push({
      id: `leg_${kind}_${at}`,
      at,
      kind,
      label,
      amountCents: extra.amountCents,
      offerId: extra.offerId,
    });
  };

  legacy(rec.createdAt, "created", rec.manualEntry ? "Event added by staff" : "Event reservation created");
  legacy(rec.bookingLinkSentAt, "booking_link_sent", "Payment / booking link sent", { offerId: rec.offerId || undefined });

  if (rec.stripeCheckoutSessionId && rec.depositPaid === true && !rec.remainingPaid) {
    const dep = Number(rec.depositCents) || 0;
    legacy(
      rec.consentAcceptedAt || rec.updatedAt,
      "deposit_paid",
      dep > 0 ? `Deposit paid online (${formatUsd(dep)})` : "Deposit paid online",
      { amountCents: dep > 0 ? dep : undefined },
    );
  }

  if (rec.remainingPaid === true && rec.remainingPaidAt) {
    const rem = Number(rec.remainingCents) || 0;
    legacy(
      rec.remainingPaidAt,
      "remaining_paid",
      rem > 0 ? `Event balance paid (${formatUsd(rem)})` : "Event balance paid",
      { amountCents: rem > 0 ? rem : undefined },
    );
  }

  legacy(rec.confirmedAt, "confirmed", "Event date confirmed by studio");
  legacy(rec.canceledAt, "canceled", rec.cancelNote ? `Event canceled — ${rec.cancelNote}` : "Event canceled");

  if (rec.previousEventDate && rec.eventDate && rec.previousEventDate !== rec.eventDate) {
    legacy(rec.updatedAt, "rescheduled", `Date moved to ${rec.eventDate}${rec.eventTime ? ` ${rec.eventTime}` : ""}`);
  }

  for (const charge of Array.isArray(rec.overtimeCharges) ? rec.overtimeCharges : []) {
    if (!charge || charge.status === "failed") continue;
    legacy(
      charge.chargedAt,
      "overtime_charged",
      `Extra time charged (${formatUsd(charge.cents)}) — ${charge.minutes} min`,
      { amountCents: charge.cents },
    );
  }

  for (const charge of Array.isArray(rec.customCharges) ? rec.customCharges : []) {
    if (!charge || charge.status === "failed") continue;
    legacy(
      charge.chargedAt,
      "custom_charged",
      `Other charge (${formatUsd(charge.cents)}) — ${charge.description}`,
      { amountCents: charge.cents },
    );
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return items;
}

/**
 * @param {ReturnType<typeof import("./event-reservation-store.mjs").openEventReservationStore>} store
 * @param {string} reservationId
 * @param {{ kind: string, label: string, amountCents?: number, offerId?: string, meta?: Record<string, unknown> }} entry
 * @param {{ dedupeMs?: number }} [opts]
 */
export async function appendReservationActivity(store, reservationId, entry, opts = {}) {
  if (!store?.available || !reservationId || !entry.kind || !entry.label) return { ok: false };
  const rec = await store.get(reservationId);
  if (!rec) return { ok: false, error: "not_found" };

  const now = new Date().toISOString();
  const dedupeMs = opts.dedupeMs ?? 0;
  const log = Array.isArray(rec.activityLog) ? [...rec.activityLog] : [];

  if (dedupeMs > 0) {
    const recent = [...log].reverse().find((row) => row && row.kind === entry.kind);
    if (recent?.at && Date.now() - Date.parse(String(recent.at)) < dedupeMs) {
      return { ok: true, skipped: true };
    }
  }

  log.push({
    id: `act_${randomUUID().replace(/-/g, "").slice(0, 22)}`,
    at: now,
    kind: entry.kind,
    label: entry.label,
    amountCents: entry.amountCents,
    offerId: entry.offerId,
    meta: entry.meta,
  });

  while (log.length > MAX_LOG) log.shift();
  await store.patch(reservationId, { activityLog: log });
  return { ok: true };
}
