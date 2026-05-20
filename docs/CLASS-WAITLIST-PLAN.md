# Class Waitlist — Implementation Plan (AMARÉ `/classes`)

**Status:** Ready for implementation (approved with UX/backend clarifications)  
**Last updated:** 2026-05-20  
**Scope:** MVP only — ship, QA on sandbox/prod, iterate from real usage; no extra complexity in this phase.
**Related:** [`MINDBODY.md`](./MINDBODY.md), [`email-templates/04-waitlist-added.html`](./email-templates/04-waitlist-added.html), [`email-templates/05-waitlist-promoted.html`](./email-templates/05-waitlist-promoted.html)

---

## Summary

Extend the existing Mindbody booking flow on [`/classes`](../src/content/classes.html) so members can **join** and **leave** a class waitlist. Mindbody remains the **source of truth** for promotion, order, emails, and capacity rules. The site only:

- Displays schedule rows from `GET /public/v6/class/classes`
- Sends `AddClientToClass` with `Waitlist: true` or `false`
- Sends `RemoveFromWaitlist` with `WaitlistEntryIds`
- Shows per-user state from `member/summary` (visits + waitlist entries)

We do **not** build a separate waitlist engine, cron promotion, or duplicate Resend emails.

---

## Gate before development (blocking)

**Do not start frontend/backend waitlist work until this passes.** If it fails, fix Mindbody Manager settings first — code cannot compensate.

### Mandatory API smoke test

1. Pick a **real class instance** that is **full** in Mindbody Manager (Sign In shows at capacity) but should accept waitlist (waitlist enabled, not locked, **Show to public** on).
2. Call production or sandbox:  
   `GET /api/mindbody/class/classes` (same date range as the site, `HideCanceledClasses=true`).
3. Find that class in `Classes[]` and confirm:
   - The row **exists** in the response (if missing → fix Show to public / web visibility, not waitlist UI).
   - **`IsWaitlistAvailable === true`** for that `ClassId`.

Record in this doc or the PR: `ClassId`, `StartDateTime`, `IsWaitlistAvailable`, date tested.

If the class is full but `IsWaitlistAvailable` is `false` → fix waitlist lock/capacity/settings in Manager before building Join waitlist UI.

### Hard rule for all implementers

> **Do not calculate waitlist availability from `MaxCapacity`, `TotalBooked`, `WebCapacity`, or `WebBooked`.**  
> Those fields are often `null` in our Get Classes responses and are intentionally not shown on the site.  
> **Only trust `IsWaitlistAvailable`** (and live Mindbody errors on Book) for whether to offer Join waitlist.

Code review should reject any `totalBooked >= maxCapacity` logic for waitlist CTAs.

---

## Principles

| Principle | Detail |
|-----------|--------|
| One action per row | At most one primary CTA: **Book**, **Cancel booking**, or **Leave waitlist** |
| No “Full” label on rows | Same as today — no capacity counters from cached schedule (stale up to ~15 min CDN) |
| Trust Mindbody flags only | **`IsWaitlistAvailable` only** — never derive waitlist from `MaxCapacity` / `TotalBooked` / `WebCapacity` (see [Gate before development](#gate-before-development-blocking)) |
| Booking wins over waitlist | If both `visitId` and `waitlistEntryId` exist for the same `classId`, treat as **booked** (`visitId` wins) |
| Same package rules as Book | Waitlist still requires a valid `ClientServiceId` when Mindbody requires payment |
| Emails from Mindbody | `SendEmail: true` on join; templates 04/05 in Mindbody Manager — no parallel Resend in MVP |
| No `SchedulingWindow=true` | Keep default on Get Classes so schedule window settings do not shrink the public list |

---

## Mindbody Manager prerequisites (before code)

Complete together with the [mandatory API smoke test](#mandatory-api-smoke-test) above.

- [ ] Waitlists enabled (Booking & Sign-in Policies)
- [ ] Waitlist capacity per Class Schedule
- [ ] **Show to public** on the schedule (maps to API `Active` / consumer visibility)
- [ ] Waitlist **not locked** for the instance (locked → `IsWaitlistAvailable: false`)
- [ ] Email templates: Schedule \| Added to Waitlist, Schedule \| Promoted from Waitlist (see `docs/email-templates/`)
- [ ] **BLOCKING:** Documented smoke test — full class visible in Get Classes with `IsWaitlistAvailable: true`

Studio settings that affect behavior (reference only): Waitlist Lock Window (e.g. 120 min), “Count all Pre-registrations as web sign-ups”, schedule windows per category.

---

## Architecture

```
┌─────────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│ classes-schedule.js │────▶│ Netlify Functions        │────▶│ Mindbody        │
│ renderSlot / dialogs│     │ class/book               │     │ AddClientToClass│
│                     │     │ class/waitlist/remove      │     │ RemoveFromWaitlist
│                     │     │ member/summary (+ waitlist)│     │ ClientSchedule  │
└─────────────────────┘     └──────────────────────────┘     └─────────────────┘
```

**Mindbody Public API (v6):**

- [Get Classes](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/api-endpoints/class/get-classes) — schedule + `IsWaitlistAvailable`, `TotalBookedWaitlist`
- [Add Client To Class](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/api-endpoints/class/add-client-to-class) — `Waitlist: true` to join waitlist
- RemoveFromWaitlist — `WaitlistEntryIds: [id]`
- GET ClientSchedule — `includeWaitlistEntries=true` (release notes: waitlist data + order; LocationId fixes)

---

## Backend

### 1. Extend `POST /api/mindbody/class/book`

**File:** `netlify/functions/mindbody-class-book.mjs`

**Request body:**

```json
{
  "classId": 123456,
  "clientServiceId": 78910,
  "waitlist": false
}
```

**Mindbody payload change:**

```javascript
Waitlist: body.waitlist === true,
// today: Waitlist: false (hardcoded)
```

Keep: `SendEmail: true`, `Test: false`, `pickClientServiceId` fallback, `resolveConsumerClient`.

**Success response (extend):**

```json
{
  "ok": true,
  "classId": 123456,
  "onWaitlist": false,
  "visitId": 111,
  "waitlistEntryId": null
}
```

Waitlist success:

```json
{
  "ok": true,
  "classId": 123456,
  "onWaitlist": true,
  "visitId": null,
  "waitlistEntryId": 98765
}
```

**Implementation notes:**

- Add `extractWaitlistEntryIdFromBookResponse(data, classId)` (mirror `extractVisitIdFromBookResponse`).
- Do not treat waitlist success as `classNoLongerAvailable` on the client.
- Map “no package / no payment” errors the same as regular booking (suggest Pricing).

### 2. New `POST /api/mindbody/class/waitlist/remove`

**New file:** `netlify/functions/mindbody-class-waitlist-remove.mjs`

**Request:**

```json
{ "waitlistEntryId": 98765 }
```

**Mindbody:** `RemoveFromWaitlist` with `{ "WaitlistEntryIds": [98765] }`.

**Response:** `{ "ok": true }` or a calm message if entry already removed (Mindbody improved this error in release notes).

**Wire-up:**

- `netlify.toml` redirect
- `scripts/mindbody-public-routes.mjs`
- `scripts/unified-local-dev.mjs`

### 3. Extend `GET /api/mindbody/member/summary`

**File:** `netlify/functions/mindbody-member-summary.mjs`

**Add fetch:** `GET /public/v6/client/clientschedule` with `includeWaitlistEntries=true`.

**Date range:** Align with the public schedule window — **today through `DAY_STRIP_LEN` days ahead (14)** in `America/New_York`. Do not pull months of waitlist entries (unlike the wide window used for visit history).

**Response extension:**

```json
{
  "waitlistByClassId": {
    "123456": {
      "waitlistEntryId": 98765,
      "orderNumber": 2
    }
  }
}
```

- `orderNumber` — **internal / debug only**; do not show in MVP UI.
- Filter to upcoming classes only (`StartDateTime` > now, same ET parsing as schedule).

**Critical:** Ensure waitlist rows from `clientvisits` are **not** mapped into `visitId` in `buildEnrollmentVisitMap` (frontend). Waitlist state must only come from `waitlistByClassId`.

---

## Frontend

**File:** `src/js/classes-schedule.js`

### State

```javascript
let enrollVisitByClassId = new Map();      // existing: classId → visitId
let waitlistEntryByClassId = new Map();    // new: classId → waitlistEntryId
```

Add `mergeWaitlistMaps(apiMap, prevMap)` — same optimistic merge pattern as `mergeEnrollmentVisitMaps`.

### Button logic (`renderSlot`) — priority order

```
1. if (!oauthLoggedIn)           → Book (or Sign in flow in dialog)
2. else if (visitId)            → Cancel booking     // visit wins
3. else if (waitlistEntryId)    → Leave waitlist
4. else if (shouldShowJoinWaitlist(cls)) → Join waitlist
5. else                         → Book
```

**`shouldShowJoinWaitlist(cls)` (MVP heuristic):**

- `cls.IsWaitlistAvailable === true` (or `isWaitlistAvailable` camelCase), and
- Prefer also `IsAvailable === false` when present (full / not bookable for anonymous catalog), but do not rely on `MaxCapacity` / `TotalBooked`.

**Never show two actions** (e.g. Cancel booking + Leave waitlist) on the same row.

### Join waitlist — primary path

When **Join waitlist** is the row CTA:

1. Open confirm dialog (English copy below).
2. `POST /api/mindbody/class/book` with `{ classId, waitlist: true }`.
3. On success: `waitlistEntryByClassId.set(classId, waitlistEntryId)` + `renderAll()` + optional `refreshWalletFromMemberSummary()`.
4. On no package: same Pricing / package embed flow as failed Book (`suggestPackages`).

### Join waitlist — fallback path

When row shows **Book** but Mindbody returns class full:

1. Detect via `classNoLongerAvailable()` / “class is full” heuristics (existing).
2. If `IsWaitlistAvailable` for that class → second dialog: offer **Join waitlist**.
3. On confirm → `waitlist: true` as above.
4. If waitlist not available → existing “refresh schedule” / full message only.

This covers stale CDN schedule (row looked bookable, live Mindbody says full).

### Leave waitlist

1. **Leave waitlist** click → confirm: `Leave the waitlist for this class?`
2. `POST /api/mindbody/class/waitlist/remove` with `{ waitlistEntryId }`.
3. Remove from map + `renderAll()`; if 404/already removed → calm copy + refresh summary.

### Promotion from waitlist

No site logic. When Mindbody promotes a client:

- They receive Mindbody email (template 05).
- On next `member/summary`, `visitId` appears and `waitlistEntryId` should be gone → UI shows **Cancel booking**.

---

## English UI copy (MVP)

| Context | Copy |
|---------|------|
| CTA (waitlist) | `Join waitlist` |
| CTA (leave) | `Leave waitlist` |
| CTA (booked) | `Cancel booking` (unchanged) |
| CTA (default) | `Book` (unchanged) |
| Confirm join | `Join the waitlist for this class? We'll email you if a spot opens.` |
| Confirm leave | `Leave the waitlist for this class?` / `Keep my spot on the waitlist` |
| Success join | `You're on the waitlist. We'll email you if a spot opens.` |
| Full, no waitlist | `This class is full. Please choose another time.` |
| Full, offer waitlist (fallback dialog) | `This class is currently full. Would you like to join the waitlist?` |
| No package | `You'll need an active package or membership to join the waitlist.` (+ Pricing CTA, same as Book) |

Do **not** display waitlist position (`orderNumber`) to clients in MVP.

---

## What we do not build

- Cron or background jobs to promote from waitlist
- Resend emails on join/promote (Mindbody only)
- Separate `POST /join-waitlist` endpoint (use `book` + `waitlist: true`)
- “X spots left” or **Full** badges on schedule rows
- `SchedulingWindow=true` on Get Classes
- Get Class Schedules as the live day list (templates only; instances stay on Get Classes)

---

## QA checklist

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Class has space | Book → Cancel booking (unchanged) |
| 2 | Full + `IsWaitlistAvailable` | Join waitlist on row OR after failed Book → Leave waitlist |
| 3 | Full + waitlist locked/unavailable | No join; clear full message |
| 4 | On waitlist | Only **Leave waitlist**, not Book |
| 5 | Promoted by Mindbody | **Cancel booking**; not Leave waitlist |
| 6 | Both visitId and waitlistEntryId (stale) | **Cancel booking** (visit wins) |
| 7 | No package | Pricing flow, same as Book |
| 8 | Not signed in | Sign in flow (unchanged) |
| 9 | `Show to public` off in Manager | Class absent from Get Classes (not a waitlist UI bug) |

---

## Implementation order

1. `mindbody-class-book.mjs` — dynamic `Waitlist`, response `waitlistEntryId` / `onWaitlist`
2. `mindbody-class-waitlist-remove.mjs` + Netlify/local routes
3. `mindbody-member-summary.mjs` — `waitlistByClassId` (14-day ET window)
4. `classes-schedule.js` — maps, `renderSlot`, dialogs, `bookClassViaApi({ waitlist })`, fallback full→waitlist
5. Manual QA on prod/sandbox per [QA checklist](#qa-checklist); optional short section in `MINDBODY.md` troubleshooting

**Rough effort:** 2–3 dev days.

**Do not expand scope in this phase** (no order number in UI, no admin tools, no Resend, no cron). Improve after real member usage.

---

## Developer checklist (approved clarifications)

0. **BLOCKING:** Complete [Gate before development](#gate-before-development-blocking) smoke test; do not use capacity fields for waitlist UI.
1. Mindbody remains the source of truth — no promotion logic, cron, or duplicate Resend.
2. Use `AddClientToClass` with `Waitlist: true` for joining; extend existing `/api/mindbody/class/book`.
3. Use `RemoveFromWaitlist` with `WaitlistEntryIds` for leaving; new `/api/mindbody/class/waitlist/remove`.
4. Extend `member/summary` with `waitlistByClassId` via ClientSchedule `includeWaitlistEntries=true` (or WaitlistEntries), **14-day ET window** aligned with schedule.
5. If both `visitId` and `waitlistEntryId` exist for the same class → **booked**; `visitId` wins.
6. If full and `IsWaitlistAvailable === true` → show **Join waitlist** on the row when possible; **also** keep fallback after failed Book (stale cache).
7. Do not show `orderNumber` to clients in MVP.
8. No valid package/credit → same pricing/package flow as regular booking.
9. One action per row: **Book**, **Cancel booking**, or **Leave waitlist**.

---

## Background: lessons from production debugging

These informed the plan (see team notes May 2026):

- Classes hidden from the site when **Show to public** is off — not a site filter bug.
- Full classes may be omitted from Get Classes when web capacity is exhausted; waitlist depends on `IsWaitlistAvailable` and Manager lock settings.
- Site hides past classes with `isoMs > nowMs` in `renderAll()` — unrelated to waitlist.
- Email templates `04-waitlist-added.html` / `05-waitlist-promoted.html` are for Mindbody Manager setup, not site-sent mail.

---

## Current code references (pre-implementation)

| Area | Location |
|------|----------|
| Hardcoded `Waitlist: false` | `netlify/functions/mindbody-class-book.mjs` |
| Enrollment map | `classes-schedule.js` → `buildEnrollmentVisitMaps`, `enrollVisitByClassId` |
| Book / cancel UI | `classes-schedule.js` → `openBookFlow`, `bookClassViaApi`, `openCancelReservationFlow` |
| Schedule cache | `netlify/functions/mindbody-class-classes.mjs` (~15 min `s-maxage`) |
| Day strip length | `DAY_STRIP_LEN = 14` in `classes-schedule.js` |
