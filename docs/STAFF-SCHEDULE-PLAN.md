# Front Desk Staff Schedule — Implementation Plan (AMARÉ Admin)

**Status:** Phase A1 implemented (2026-05-27)  
**Last updated:** 2026-05-27  
**Scope:** Phase A (MVP) — internal front-desk shift planning only.  
**Related:** [`FOLLOW-UP-DASHBOARD.md`](./FOLLOW-UP-DASHBOARD.md), [`MINDBODY.md`](./MINDBODY.md)

---

## TL;DR (עברית)

Mindbody **לא** נותן לוח משמרות למזכירות (בוקר/ערב) ולא שולח לוז שבועי לעובדות.  
**Phase A** בונה אצלנו:

- Admin פנימי — שיבוץ FRONT DESK לפי שבוע + משמרת (בוקר/ערב)
- API לקריאת הלוז (`GET`)
- אחסון ב-Netlify Blob
- (אופציונלי) email שבועי לעובדות דרך Resend

**Mindbody נשאר** ל-Time Clock, Payroll, שיעורים ולקוחות — **לא** מחליפים אותו.

---

## Summary

Build a **small internal scheduling module** on the existing AMARÉ admin stack so studio managers can assign **front desk / reception** staff to **morning and evening shifts** per week, persist the plan in our API, and optionally email the published schedule to staff.

This is **not** a full workforce-management product (no clock-in, no payroll engine, no shift swaps in MVP). Actual hours worked and end-of-month pay stay in **Mindbody Time Clock + Payroll** (or export to Gusto/Paychex).

---

## Problem

| Need | Mindbody | Deputy / Sheets |
|------|----------|-----------------|
| Weekly front-desk roster (who works Mon AM, Tue PM, …) | ❌ | ✅ (Deputy) / manual (Sheets) |
| Morning / evening shift templates | ❌ | ✅ |
| Send weekly schedule to staff | ❌ (only class/appointment alerts) | ✅ |
| API we control | ❌ | Deputy ✅ / Sheets ⚠️ |
| Already paid for | ✅ (Mindbody subscription) | Extra cost or manual |

**Decision:** Own the **planned** front-desk schedule on amare-site; keep **actual** time tracking in Mindbody.

---

## Principles

| Principle | Detail |
|-----------|--------|
| **Mindbody = source of truth for classes & clients** | Class schedule, bookings, member data unchanged |
| **Mindbody = source of truth for clock & payroll hours** | Time Clock in/out; Payroll report at month end |
| **AMARÉ admin = source of truth for planned front-desk shifts** | Who is *scheduled* to work reception |
| **Reuse existing admin auth** | Same `ADMIN_DEBUG_TOKEN` + `x-admin-token` as follow-ups |
| **Internal only** | No public page; no customer-facing schedule |
| **Minimal MVP** | Plan + assign + read API + optional email — no HR feature creep |
| **Draft → Publish** | Managers edit draft week; publish locks staff notifications |

---

## Phase A scope (MVP)

### In scope

- Staff directory: front-desk employees (name, email, active flag)
- Shift slot templates: `morning`, `evening` (configurable start/end, timezone `America/New_York`)
- Weekly grid: assign one staff member per slot per day (or leave open)
- CRUD via admin UI tab
- REST API (admin-authenticated) to read/write schedule for a week
- Netlify Blob persistence
- Publish week + optional **Resend email** to assigned staff (internal addresses only)
- Export week as CSV (for manager / payroll cross-check)

### Out of scope (Phase A)

- Clock in/out (Mindbody Time Clock)
- Payroll calculation (Mindbody Payroll / external)
- Shift swap / time-off requests
- Deputy / Homebase sync
- Auto-generate shifts from Mindbody class density
- Staff mobile app
- SMS to staff (email only in MVP)
- Instructor scheduling (stays in Mindbody)
- Multi-location (single studio: Hallandale)

---

## Phase B+ (future, not in MVP)

| Feature | Notes |
|---------|--------|
| **Class overlay** | Show Mindbody class count per day in admin when planning coverage |
| **Suggested coverage** | Webhook or daily pull: flag days with many classes but no front-desk shift |
| **Compare planned vs actual** | Import Time Clock report CSV or Mindbody API `payroll/timeclock` vs our plan |
| **Staff read-only view** | Tokenized link `/staff/schedule?token=…` (no admin token) |
| **Deputy one-way push** | POST published shifts to Deputy API if studio adopts Deputy later |
| **Hebrew UI** | Admin labels in Hebrew if ops team prefers |

---

## Architecture

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│ /admin/staff-schedule   │────▶│ Netlify Functions            │
│ (or tab on follow-ups)  │     │ staff-schedule-staff.mjs     │
│                         │     │ staff-schedule-week.mjs      │
│                         │     │ staff-schedule-email.mjs     │
└─────────────────────────┘     └──────────────┬───────────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
            Netlify Blob                 Resend (optional)          Mindbody (unchanged)
            `staff-schedule`             weekly email to staff      Time Clock + Payroll
```

**No Mindbody writes in Phase A.** Optional read-only class metadata in Phase B for planning hints only.

---

## Data model

### Blob store: `staff-schedule`

| Key pattern | Content |
|-------------|---------|
| `v1/config` | Shift templates, studio timezone, defaults |
| `v1/staff/{staffId}` | Staff member record |
| `v1/staff/index` | List of active staff IDs (or derive from prefix scan) |
| `v1/weeks/{weekStart}` | Week document (ISO date Monday or studio week start) |

### Staff member

```json
{
  "id": "st_abc123",
  "name": "Sarah Cohen",
  "email": "sarah@example.com",
  "role": "front_desk",
  "active": true,
  "createdAt": "2026-05-27T12:00:00.000Z",
  "updatedAt": "2026-05-27T12:00:00.000Z"
}
```

### Config (`v1/config`)

```json
{
  "timezone": "America/New_York",
  "weekStartsOn": "monday",
  "shiftTemplates": {
    "morning": { "label": "Morning", "start": "09:00", "end": "14:00" },
    "evening": { "label": "Evening", "start": "15:00", "end": "20:00" }
  }
}
```

Times are **local wall time** in `timezone` (same convention as class schedule on the site).

### Week document

```json
{
  "weekStart": "2026-05-26",
  "status": "draft",
  "publishedAt": null,
  "publishedBy": null,
  "shifts": [
    {
      "id": "sh_001",
      "date": "2026-05-26",
      "slot": "morning",
      "staffId": "st_abc123",
      "note": ""
    },
    {
      "id": "sh_002",
      "date": "2026-05-26",
      "slot": "evening",
      "staffId": null,
      "note": "TBD"
    }
  ],
  "updatedAt": "2026-05-27T14:30:00.000Z"
}
```

**Rules:**

- At most **one assignment per `(date, slot)`** per week doc.
- `staffId: null` = open / unassigned (allowed in draft).
- Publishing with open slots → warn in UI; allow publish if manager confirms.
- Editing a **published** week creates a new draft state or requires explicit “Unpublish” (implementer choice: prefer **unpublish → edit → re-publish** for audit clarity).

---

## API

All endpoints require header `x-admin-token: {ADMIN_DEBUG_TOKEN}` (reuse `adminAuthorized` from `new-client-sms-admin-auth.mjs`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/staff-schedule/config` | Shift templates + timezone |
| PUT | `/api/admin/staff-schedule/config` | Update templates (admin only) |
| GET | `/api/admin/staff-schedule/staff` | List staff (`?active=1`) |
| POST | `/api/admin/staff-schedule/staff` | Add staff member |
| PUT | `/api/admin/staff-schedule/staff/{id}` | Update staff |
| DELETE | `/api/admin/staff-schedule/staff/{id}` | Soft-deactivate (`active: false`) |
| GET | `/api/admin/staff-schedule/weeks/{weekStart}` | Get week (`weekStart` = `YYYY-MM-DD`) |
| PUT | `/api/admin/staff-schedule/weeks/{weekStart}` | Save week (draft) |
| POST | `/api/admin/staff-schedule/weeks/{weekStart}/publish` | Set `status: published`, stamp `publishedAt` |
| POST | `/api/admin/staff-schedule/weeks/{weekStart}/unpublish` | Revert to draft |
| POST | `/api/admin/staff-schedule/weeks/{weekStart}/email` | Send schedule email to assigned staff |
| GET | `/api/admin/staff-schedule/weeks/{weekStart}/export.csv` | CSV download |

**Response shape (week GET):** include resolved staff names/emails on each shift for UI convenience.

**Errors:**

| Code | `error` | When |
|------|---------|------|
| 401 | `unauthorized` | Bad/missing admin token |
| 404 | `week_not_found` | No blob for week (UI may create empty draft) |
| 409 | `staff_conflict` | Same staff double-booked same day overlapping slots (optional validation) |
| 422 | `invalid_week_start` | Not a Monday (if enforcing week start) |

---

## Admin UI

### Route

**Preferred:** new page `/admin/staff-schedule`  
**Alternative:** new tab on `/admin/follow-ups` (more crowded; separate page is clearer).

### Screens

1. **Unlock** — same admin token panel as follow-ups (shared `admin-follow-up-shared.js` pattern).
2. **Staff** — table: name, email, active; add/edit/deactivate.
3. **Week planner** — week picker (prev/next); grid:

   | | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
   |---|-----|-----|-----|-----|-----|-----|-----|
   | Morning | dropdown staff | … | … | … | … | … | … |
   | Evening | dropdown staff | … | … | … | … | … | … |

4. **Actions:** Save draft · Publish · Email staff · Export CSV  
5. **Status badge:** Draft / Published + last published time

### UX notes

- Default week = current week (Monday start, America/New_York).
- Dropdown includes “— Open —” (`staffId: null`).
- Confirm before publish if any slot is open.
- After publish, show copy: “Staff should still clock in via Mindbody Time Clock.”

---

## Weekly email (optional, recommended)

Reuse Resend infrastructure from follow-up dashboard.

**Trigger:** manager clicks “Email schedule” on a **published** week (or auto on publish if env flag set).

**Recipients:** unique emails from assigned shifts only (not BCC whole studio unless configured).

**Subject:** `AMARÉ Front Desk Schedule — Week of May 26, 2026`

**Body:** plain + simple HTML table: day, slot, time range, assignee name.

**Safety:**

- Internal staff emails only; no customer PII.
- Gate with `ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1`.
- From address: reuse `SMS_ADMIN_REPORT_FROM` or dedicated `STAFF_SCHEDULE_EMAIL_FROM`.

---

## Environment variables

```env
# Required (existing)
ADMIN_DEBUG_TOKEN=…

# Optional — weekly schedule email
ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1
STAFF_SCHEDULE_EMAIL_FROM=AMARÉ Schedule <schedule@amarewellness.com>
# Falls back to SMS_ADMIN_REPORT_FROM if unset

# Local dev blob fallback (mirror follow-up-actions)
# STAFF_SCHEDULE_STORE_LOCAL_MEMORY=1

# Optional — enforce week starts Monday (default true)
# STAFF_SCHEDULE_WEEK_START=monday
```

No new Mindbody env vars for Phase A.

---

## Security

| Topic | Approach |
|-------|----------|
| Auth | `ADMIN_DEBUG_TOKEN` only; constant-time compare (existing helper) |
| CORS | Same as follow-ups admin (`adminCorsHeaders`) |
| Public access | None — no unauthenticated read in MVP |
| PII in email | Staff names + work emails only |
| Blob | Netlify Blobs store `staff-schedule`; not in git |

---

## Manager workflow (SOP)

### Weekly (typical)

1. Open `/admin/staff-schedule`.
2. Select upcoming week.
3. Assign morning/evening per day from staff dropdown.
4. **Save draft** → review.
5. **Publish** when final.
6. **Email schedule** to staff (or share CSV via WhatsApp if email skipped).
7. Staff work shifts; each person **clocks in/out in Mindbody** (Business app or Manager).
8. End of month: Mindbody **Payroll / Time Clock report** for actual hours; compare to plan if needed (manual or Phase B).

### Staff instructions (one-liner for runbook)

> Your shift times are in the weekly email from AMARÉ. Clock in and out in Mindbody when you arrive and leave.

---

## Relationship to Mindbody

| Function | System |
|----------|--------|
| Class schedule | Mindbody |
| Instructor assignment | Mindbody |
| Front desk **planned** shifts | **AMARÉ admin (this plan)** |
| Clock in/out | Mindbody Time Clock |
| Hourly rate | Mindbody staff profile |
| Pay calculation | Mindbody Payroll report → Gusto/Paychex/Excel |
| Client check-in at desk | Mindbody Business app |

**Do not** mark front-desk staff as Mindbody “Instructor” or use Appointment Availability as a workaround — that affects client booking UX.

---

## Implementation checklist

### Backend

- [ ] `staff-schedule-store.mjs` — Blob + local memory dev mode
- [ ] `staff-schedule-lib.mjs` — validation, week helpers, CSV builder
- [ ] `staff-schedule-staff.mjs` — staff CRUD
- [ ] `staff-schedule-week.mjs` — week GET/PUT/publish/unpublish
- [ ] `staff-schedule-email.mjs` — Resend weekly email
- [ ] `netlify.toml` redirects for `/api/admin/staff-schedule/*`

### Frontend

- [ ] `src/content/admin-staff-schedule.html`
- [ ] `src/js/admin-staff-schedule.js`
- [ ] `src/css/components-admin-staff-schedule.css` (or extend `components-admin-sms.css`)
- [ ] Build script: include page in site map / admin nav link from follow-ups (optional)

### Docs & ops

- [ ] Link from `FOLLOW-UP-DASHBOARD.md` or admin intro
- [ ] Staff runbook paragraph (clock in Mindbody + read weekly email)

### Tests

- [ ] Unit: week validation, CSV export, publish state transitions
- [ ] Manual: create staff → assign week → publish → GET API → email dry-run

---

## Test plan (QA)

1. **Auth:** requests without token → 401.
2. **Staff CRUD:** add two staff, deactivate one, list shows active only.
3. **Week save:** assign Mon morning → reload page → persists.
4. **Publish:** draft → publish → `status: published`; edit requires unpublish.
5. **Email:** with `ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1`, send to test inbox; only assigned staff receive.
6. **CSV:** export matches grid.
7. **Local dev:** `STAFF_SCHEDULE_STORE_LOCAL_MEMORY=1` works without Netlify Blobs.
8. **Regression:** follow-ups admin still works; no shared blob key collisions.

---

## Effort estimate

| Piece | Estimate |
|-------|----------|
| Blob store + APIs | ~1–2 days |
| Admin UI (week grid) | ~1–2 days |
| Email + CSV | ~0.5 day |
| QA + docs | ~0.5 day |
| **Phase A total** | **~3–5 days** |

Phase B (Mindbody overlay, planned vs actual) is separate.

---

## When **not** to build this

- Only 1–2 shifts/week and owner already uses a shared Google Sheet — overhead may exceed benefit.
- Studio needs full workforce (swaps, geofencing, native staff app) — **Deputy** is faster than growing this module.

For AMARÉ (small front-desk team, existing admin stack, desire for API): **Phase A is justified.**

---

## Open questions (decide before coding)

1. **Week start:** Monday (recommended) or Sunday?
2. **Separate page vs tab** on follow-ups dashboard?
3. **Auto-email on publish** or manual “Email staff” button only?
4. **Saturday/Sunday slots:** include in grid or hide days studio is closed?
5. **Overlap rule:** block same person on morning + evening same day, or allow?

Default recommendations: Monday start · separate `/admin/staff-schedule` · manual email button · show all 7 days · allow both slots same person (manager discretion).

---

## References

- Mindbody staff / Time Clock: [Staff Management](https://www.mindbodyonline.com/business/staff-management)
- Existing admin pattern: [`FOLLOW-UP-DASHBOARD.md`](./FOLLOW-UP-DASHBOARD.md)
- Admin auth: `netlify/functions/new-client-sms-admin-auth.mjs`
- Blob pattern: `netlify/functions/follow-up-actions-store.mjs`
