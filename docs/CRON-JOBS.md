# Netlify Cron Jobs (Scheduled Functions)

> **Status:** living registry of production scheduled functions on `www.amarewellness.com`.
>
> Related: `docs/NEW-CLIENT-SMS-FOLLOWUP.md`, `docs/STAFF-SCHEDULE-PLAN.md`, `/admin/staff-schedule`

---

## 1. How scheduling works on this site

Netlify Scheduled Functions run **only on the production branch** (`main`). They do not run on branch deploys, Deploy Previews, or local `netlify dev`.

### Registering a schedule

**Preferred (required on this site today):** declare the cron in `netlify.toml`:

```toml
[functions."my-function-name"]
  schedule = "0 14 * * 2"
```

**Not reliable here:** `export const config = { schedule: "..." }` inside the function file. Deploy metadata showed `function_schedules: []` until the staff reminder schedule was moved into `netlify.toml` (commit `a0dcab5`, 2026-07-09).

After a successful deploy, verify in Netlify:

1. **Deploy details** → `function_schedules` includes your function name + cron.
2. **Functions** page → function shows a **Scheduled** badge and next run time.

### Cron timezone

Netlify cron expressions use **UTC**. Studio wall time is `America/New_York` (`STUDIO_TZ` in staff schedule).

| Cron (UTC) | US Eastern (EDT) | US Eastern (EST) |
|---|---|---|
| `0 14 * * *` | ~10:00 AM daily | ~9:00 AM daily |
| `0 14 * * 2` | ~10:00 AM Tuesday | ~9:00 AM Tuesday |

Day-of-week: `0` = Sunday, `1` = Monday, `2` = Tuesday, …

### Manual trigger pattern

Scheduled handlers also accept authenticated HTTP for dry-runs:

```http
POST /api/admin/<feature>/run
x-admin-token: <ADMIN_DEBUG_TOKEN>
```

Same handler code path; logs include `"scheduled": false, "manual": true`.

### Log search

```bash
npx netlify logs --source functions --function <function-name> --since 24h
```

Look for structured JSON log lines documented per job below.

---

## 2. Active jobs

| Job | Function | Cron (UTC) | Local time (EDT) | Master env switch |
|---|---|---|---|---|
| Staff availability reminder | `staff-schedule-availability-reminder-scan` | `0 14 * * 2` | Tuesday ~10:00 AM | `ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER=1` |
| New Client SMS scan | `new-client-sms-scan` | `0 14 * * *` | Daily ~10:00 AM | `ENABLE_NEW_CLIENT_SMS_AUTOMATION=1` |

---

## 3. Staff shift availability reminder (weekly)

**Purpose:** Email all active front-desk staff asking them to submit **next week’s** shift availability — same email as the manual **Email availability request** button on `/admin/staff-schedule`.

**Implemented:** 2026-07-03 (`16d7b5c`). **Cron fix:** 2026-07-09 (`a0dcab5`) — schedule registered in `netlify.toml`.

### Files

| File | Role |
|---|---|
| `netlify.toml` | `[functions."staff-schedule-availability-reminder-scan"] schedule = "0 14 * * 2"` |
| `netlify/functions/staff-schedule-availability-reminder-scan.mjs` | Handler (scheduled + manual HTTP) |
| `netlify/functions/staff-schedule-availability-reminder-lib.mjs` | Shared run logic (cron + admin button) |
| `netlify/functions/staff-schedule-email.mjs` | Resend templates (`staff_availability_reminder` tag) |
| `netlify/functions/staff-schedule-availability-window.mjs` | Open / closed / locked week window |
| `src/content/admin-staff-schedule.html` | Admin UI — Staff availability panel |

### Redirects

| Method | Path | Function |
|---|---|---|
| POST/GET | `/api/admin/staff-schedule/availability-reminder/run` | `staff-schedule-availability-reminder-scan` |
| POST | `/api/admin/staff-schedule/weeks/{weekStart}/availability/send-reminder` | `staff-schedule-admin` (manual, selected staff) |

### Required environment variables

| Variable | Value | Notes |
|---|---|---|
| `ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER` | `1` | Automation master switch |
| `ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL` | `1` | Resend gate for all staff schedule emails |
| `RESEND_API_KEY` | (secret) | |
| `STAFF_SCHEDULE_EMAIL_FROM` | e.g. `AMARÉ Schedule <schedule@…>` | Falls back to `SMS_ADMIN_REPORT_FROM` |

### Run logic (scheduled)

On each cron invocation, `runScheduledStaffAvailabilityReminder()`:

1. **Gate:** if `ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER` is off → skip (`reason: automation_disabled`).
2. **Day guard:** if today is not **Tuesday** in `America/New_York` → skip (`reason: not_tuesday`). Belt-and-suspenders alongside the Tuesday-only cron.
3. **Target week:** `staffAvailabilityTargetWeekStart()` — always the **calendar week after the current one** (Sunday week start).
4. **Published week:** if that week is **published** (locked) → skip (`error: availability_locked`).
5. **Open if closed:** if availability is closed → **open it** (`openIfClosed: true`) before sending.
6. **Recipients:** all **active** staff with a valid email and 4–6 digit PIN (same rules as manual send). Inactive / missing email / missing PIN → skipped, not failed.
7. **Send:** one Resend email per eligible staff (`category: staff_availability_reminder`).

### Run logic (manual admin button)

`POST …/weeks/{weekStart}/availability/send-reminder` via `staff-schedule-admin` calls the same `runStaffAvailabilityReminder()` lib with:

- `staffIds` = checkboxes selected in the dialog (not all staff).
- `openIfClosed` = `true` only when admin confirms opening a closed window.

### Skip / failure outcomes

| Outcome | Meaning |
|---|---|
| `skipped: true, reason: automation_disabled` | Env flag off |
| `skipped: true, reason: not_tuesday` | Manual HTTP on a non-Tuesday day |
| `error: availability_locked` | Next week already published — unpublish first |
| `error: email_not_configured` | Resend / `ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL` missing |
| `error: no_eligible_staff` | No active staff with email + PIN |
| `ok: true, sent: N` | Emails sent; see `recipients` array in response / logs |

### Log line

```json
{
  "event": "staff_availability_auto_reminder",
  "scheduled": true,
  "manual": false,
  "ok": true,
  "skipped": false,
  "reason": null,
  "weekStart": "2026-07-12",
  "sent": 5,
  "recipients": ["…"]
}
```

### Manual test (sends real emails)

```bash
curl -X POST "https://www.amarewellness.com/api/admin/staff-schedule/availability-reminder/run" \
  -H "x-admin-token: $ADMIN_DEBUG_TOKEN"
```

---

## 4. New Client SMS scan (daily)

**Purpose:** Daily Mindbody scan for New Client Special conversion candidates; dry-run report and optional Twilio SMS.

**Full spec:** `docs/NEW-CLIENT-SMS-FOLLOWUP.md`

### Files

| File | Role |
|---|---|
| `netlify/functions/new-client-sms-scan.mjs` | Handler + `export const config = { schedule: "0 14 * * *" }` |
| `netlify.toml` | `[functions."new-client-sms-scan"] timeout = 60` only (no `schedule` yet) |

### Redirect

| Method | Path |
|---|---|
| POST/GET | `/api/admin/new-client-sms/run` |

### Master switches

| Variable | Default | Role |
|---|---|---|
| `ENABLE_NEW_CLIENT_SMS_AUTOMATION` | `0` | Cron no-op when off |
| `NEW_CLIENT_SMS_DRY_RUN` | `1` | No SMS sent when on |
| `ENABLE_NEW_CLIENT_SMS_SENDING` | `0` | Twilio send gate |

### Known issue (2026-07-09)

Like the staff reminder before `a0dcab5`, this job still uses **only** `export const config` for scheduling. Production deploy metadata may show an empty `function_schedules` entry for this function. **If daily runs are not appearing in logs, move the schedule into `netlify.toml`:**

```toml
[functions."new-client-sms-scan"]
  timeout = 60
  schedule = "0 14 * * *"
```

---

## 5. Planned (not deployed)

| Job | Doc reference | Notes |
|---|---|---|
| NCS email follow-up scan | `docs/NCS-FOLLOWUP-AUTOMATION.md` | Planned `ncs-followup-scan.mjs` — not in repo yet |
| Mindbody schedule CDN purge | `docs/MINDBODY.md` PR-3 | Optional daily purge `mindbody-schedule` ~03:00 ET |
| App push reminders | `docs/AMARE-APP-PLAN.md` | `push-reminders-cron.mjs` — future |

---

## 6. Changelog

| Date | Change |
|---|---|
| 2026-07-03 | Added `staff-schedule-availability-reminder-scan` (weekly staff availability emails). |
| 2026-07-09 | Fixed staff reminder cron: moved `schedule = "0 14 * * 2"` into `netlify.toml`; verified `function_schedules` populated on deploy `a0dcab5`. |
