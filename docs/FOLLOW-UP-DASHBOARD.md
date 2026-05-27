# AMARÉ Follow-Up Dashboard (Phase 1)

Internal decision-support dashboard for studio follow-up. **Report-only** — no live SMS, no customer-facing email.

## Routes

| URL | Purpose |
|-----|---------|
| `/admin/follow-ups` | **Main dashboard** — tabs for all follow-up categories |
| `/admin/new-client-followup` | Standalone New Client page (still supported) |

Both require `ADMIN_DEBUG_TOKEN` via `x-admin-token` header (browser UI stores token in sessionStorage for the tab only).

## Phase 1 scope (implemented)

| Tab | Status | Data source |
|-----|--------|-------------|
| **New Client** | Live | Series Expirations report + Mindbody API (existing NCS pipeline) |
| **Low Credits** | Live | Same saved Series Expirations report — 10/20 pack rows with 1–4 visits remaining |
| Frequent Non-Members | Placeholder | Phase 2 |
| ClassPass Repeat | Placeholder | Phase 2 |
| Lapsed Clients | Placeholder | Phase 2 |

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/admin/follow-ups/run` | Run New Client + Low Credits (`categories`, `useSavedReport`, `sendTeamEmail`) |
| POST | `/api/admin/follow-ups/low-credits/run` | Low Credits only |
| POST | `/api/admin/follow-ups/send-report` | Combined team email from last run results |
| POST/GET | `/api/admin/follow-ups/actions` | Mark contacted / snooze / hide (Netlify Blob `follow-up-actions`) |
| POST | `/api/admin/new-client-sms/run` | New Client only (unchanged) |

## Workflow

### New Client + Low Credits (shared report)

1. Mindbody → **Series Expirations** → today through +60 days → export `.xls`
2. Open `/admin/follow-ups` → enter admin token
3. **New Client** tab → upload report (persists to Blob for cron)
4. **Low Credits** tab → Run report (uses same saved Series Expirations)

### Combined run

**Run all reports** toolbar button → New Client + Low Credits + optional team email.

Per-tab: run, export CSV, copy suggested message, mark contacted / snooze / hide.

## Team email

Subject: `AMARÉ Daily Follow-Up Report — {total} clients`

Includes New Client + Low Credits sections. No full phone numbers or full emails in email — last 4 + domain only.

### Env vars

```env
# Combined dashboard email (falls back to ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=1)
ENABLE_FOLLOWUP_DASHBOARD_ADMIN_EMAIL=1
ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=1
SMS_ADMIN_REPORT_FROM=AMARÉ Reports <reports@amarewellness.com>
SMS_ADMIN_REPORT_TO=ops@example.com,owner@example.com
RESEND_API_KEY=re_...

# Low Credits
FOLLOWUP_LOW_CREDITS_MAX_REMAINING=4
# FOLLOWUP_LOW_CREDITS_SERVICE_IDS=100127,100128

# Actions store (local dev only)
# FOLLOWUP_ACTIONS_STORE_LOCAL_MEMORY=1
```

## Safety (Phase 1)

- No live Twilio SMS
- No customer-facing Resend email
- No “Send SMS” buttons
- Segment C customer messaging remains off
- SMS opt-outs respected in recommended actions (report-only)

## Phase 2 (future)

- **ClassPass Repeat** — Client Visits report, 2+ ClassPass visits in lookback window (`FOLLOWUP_CLASSPASS_REPEAT_THRESHOLD`, `FOLLOWUP_CLASSPASS_LOOKBACK_DAYS`)
- Frequent Non-Members (`FOLLOWUP_FREQUENT_VISIT_THRESHOLD`, `FOLLOWUP_FREQUENT_LOOKBACK_DAYS`)
- Lapsed Clients (`FOLLOWUP_LAPSED_DAYS=14,30,45`)
- Optional client-facing messages (explicit studio approval)

See also: [NEW-CLIENT-SMS-FOLLOWUP.md](./NEW-CLIENT-SMS-FOLLOWUP.md)
