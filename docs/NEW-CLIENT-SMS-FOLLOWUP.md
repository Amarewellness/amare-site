# New Client SMS Conversion Follow-up

> **Status:** implemented (dry-run default — no SMS sent until explicitly enabled).
>
> Related: `docs/NCS-FOLLOWUP-AUTOMATION.md` (planned email variant),
> `docs/email-templates/10-pricing-visits-low.html` + `11-pricing-time-low.html` (Mindbody auto-emails),
> `src/content/stripe-mindbody-catalog.config.json` (product IDs).

---

## 1. Goal

Daily job that identifies New Client Special (NCS) clients who are good membership-conversion candidates, builds the SMS that would be sent, and (when enabled) sends through Twilio.

**Phase 1 (current):** dry-run report only — verify candidates manually before any SMS goes out.

**Phase 2:** enable Twilio sending per segment after ops sign-off.

**Phase 3 (later):** Segment D — ClassPass repeat visitors (stubbed in code, not scanned).

---

## 2. Technical plan

### 2.1 Mindbody endpoints and data

All queries use **staff Bearer headers** (`staffHeadersForSync()` from `stripe-mindbody-sync-lib.mjs`) — same pattern as checkout sync and admin retry endpoints.

| Endpoint | Purpose |
|---|---|
| `GET /client/clients?request.clientIDs=` | Client profile: `FirstName`, `MobilePhone`, email |
| `GET /client/clientservices?request.clientId=` | NCS remaining visits, expiration, `Active`, `Id` (instance key) |
| `GET /client/clientpurchases?request.clientId=` | Follow-up purchase detection (post-NCS date) |
| `GET /client/activeclientmemberships?request.clientId=` | Skip clients with active Mindbody-native membership |

Per-client fetches mirror `mindbody-member-summary.mjs` but run under staff auth for cron (no consumer JWT).

### 2.2 NCS ownership, remaining visits, expiration

**NCS Mindbody Pricing Option ID:** `100012` (`new_client_special_3_for_65` in catalog).

Optional override: `NEW_CLIENT_SMS_MINDBODY_SERVICE_IDS` (comma-separated). When unset, IDs are derived from catalog items with `kind === "newClient"`.

A `ClientServices` row is treated as NCS when:

1. `ServiceId` / `ProductId` matches a configured NCS service ID, **or**
2. Service name matches `NCS_HISTORY_KEYWORDS` in `stripe-mindbody-sync-lib.mjs` and does not match membership/recurring exclusions.

Fields used:

| Field | Use |
|---|---|
| `Id` | Idempotency instance key (`ncsClientServiceId`) — one SMS per segment per NCS *instance* |
| `Remaining` | Segment A (`=== 1`), Segment C (`=== 0`) |
| `ExpirationDate` | Segment B (≤ 5 days), expiry skip for inactive packages |
| `Active` | Must be true (when present) for A/B |
| `PaymentDate` / purchase date | Anchor for follow-up detection |

Date comparisons use **local calendar dates** (studio timezone `America/New_York` via `NEW_CLIENT_SMS_TIMEZONE`).

### 2.3 Follow-up purchase / active membership detection

Skip SMS (reason `skipped_already_converted`) when the client has **any** of:

| Source | Detects |
|---|---|
| `activeclientmemberships` | Mindbody Classic / contract memberships |
| Stripe subscription store (`listActiveByMindbodyClientId`) | Stripe recurring memberships (`active`, `pending_first_invoice`, `past_due`) |
| `clientpurchases` + `clientservices` after NCS date | 10-pack (`100127`), 20-pack (`100128`), drop-ins (`100011`, `100123`), monthly sync services (`100133`–`100135`), or name heuristics from catalog |

This is **broader than orders-only** detection (see `NCS-FOLLOWUP-AUTOMATION.md` §5.1) to reduce false positives from Mindbody Classic membership buyers.

### 2.4 Client discovery (Mindbody-first)

Mindbody is the **source of truth** for NCS ownership and visit state. There is still no single Public API call that returns “all clients on service 100012,” so discovery **unions several Mindbody queries**, then confirms NCS per client via `GET /client/clientservices`.

#### Investigation summary (Public API v6)

| Endpoint | Bulk discovery? | Pagination | Date filters | In-studio NCS? |
|---|---|---|---|---|
| **`GET /client/clients`** | **Best primary** — recently touched profiles | `request.limit` + `request.offset` + `PaginationResponse.TotalResults` | **`request.lastModifiedDate`** (ISO UTC). **No creation-date filter.** Staff Bearer **required** (API-Key alone returns empty). | **Yes** — POS / in-studio sale usually updates client profile → appears in lastModified window |
| **`GET /class/classvisits`** | **Secondary** — clients with booking/attendance activity | No limit/offset in swagger; may return large payload | **`request.lastModifiedDate`** (optional `request.classID`) | **Partial** — only clients who booked or attended; misses “bought NCS, never booked” |
| **`GET /class/classes` + per-class `classvisits`** | Fallback when site-wide `classvisits` is empty | Classes: limit/offset. Then 1 call per classID (capped) | `request.startDateTime` / `request.endDateTime` on classes | Same as classvisits — activity-based |
| **`GET /client/clientpurchases`** | **No** — requires `request.clientId` | Per-client limit/offset | Per-client `startDate` / `endDate` | Used at **evaluation** only (follow-up detection), not seed discovery |
| **`GET /client/clientservices`** | **No** — requires `request.clientId` | Per-client limit/offset | Per-client `startDate` / `endDate` | **Authoritative NCS check** after seed union |
| **`GET /sale/sales`** | **Not usable** — swagger shows no date/client filters | n/a | n/a | n/a |

**Recommended discovery order (implemented):**

1. **`GET /client/clients`** paginated with `request.lastModifiedDate = now − lookback` (default 45 days, max 120).
2. **`GET /class/classvisits?request.lastModifiedDate=…`** — if zero results, fall back to **`GET /class/classes`** (date range) + **`GET /class/classvisits?request.classID=`** per class (capped by env).
3. **Supplemental:** Stripe NCS orders (`mindbody_synced`, live, same lookback) — website checkout only.
4. **Manual:** `NEW_CLIENT_SMS_SEED_CLIENT_IDS` for testing / edge cases.
5. **Deduplicate** all client IDs, then per client: `clientservices` + `clientpurchases` + `activeclientmemberships` + profile.

**Known gaps (documented in dry-run `discoveryNotes`):**

- Client bought in-studio NCS **weeks ago** with **no profile change and no booking** may fall outside both lastModified and visit discovery until they book or their package enters a trigger state that touches another record.
- `lastModifiedDate` is **not** the same as NCS purchase date or `ExpirationDate`.
- `mindbodyPurchases` in `seedSources` is always **0** at discovery time — no studio-wide purchase list exists on Public API.

#### Expected API cost (daily dry-run)

Rough formula at AMARÉ scale:

| Phase | Calls |
|---|---|
| Client lastModified pagination | 1–10 pages (200 clients/page, capped by `NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES`) |
| Class visits (primary) | 1 |
| Class schedule fallback | 1–5 class list pages + up to `NEW_CLIENT_SMS_DISCOVERY_MAX_CLASS_SCAN` classvisits (default 90) |
| Per seeded client (evaluation) | ~4 (`clients`, `clientservices`, `clientpurchases`, `activeclientmemberships`) |
| Stripe order scan | 0 Mindbody calls (local blob scan) |

**Example:** 120 deduped clients → ~10 discovery + ~480 evaluation ≈ **490 Mindbody calls/day**. Tune caps if rate limits appear. Dry-run report includes `discoveryApiCalls`, `estimatedEvaluationApiCalls`, and `estimatedTotalApiCalls`.

#### Dry-run `seedSources` shape

```json
{
  "seedSources": {
    "mindbodyClients": 84,
    "mindbodyVisits": 52,
    "mindbodyPurchases": 0,
    "stripeOrders": 11,
    "manualSeed": 0,
    "dedupedTotal": 120
  }
}
```

Counts are **per-channel before dedup** (a client can appear in multiple channels; `dedupedTotal` is the union size).

### 2.5 Segments

| Segment | ID | Default enabled | Trigger |
|---|---|---|---|
| A — 1 class remaining | `one_remaining` | yes | NCS active, not expired, `Remaining === 1`, no conversion |
| B — expires ≤ 5 days | `expiring_soon` | yes | NCS active, `0 ≤ daysToExpiry ≤ 5`, no conversion |
| C — completed, no follow-up | `completed_no_purchase` | **no** | NCS `Remaining === 0`, completed within 14 days, no conversion |
| D — ClassPass repeat | `classpass_repeat` | n/a | **Not implemented** — reserved in types/config |

**One segment per client per run:** priority A → B → C (first match wins).

### 2.6 Idempotency storage

**Store:** Netlify Blobs `new-client-sms-records` (via `new-client-sms-store.mjs`).

**Key:** `v1/{segment}/{mindbodyClientId}/{ncsClientServiceId}`

**Write timing:** only when an SMS is actually sent (not during dry-run).

Uses `atomicCreateJSON` from `blobs-conditional-create.mjs` (same SDK bug workaround as checkout idempotency).

Record schema: segment, client IDs, phone last-4, message hash, Twilio SID, status, timestamps.

Local dev: `NEW_CLIENT_SMS_STORE_LOCAL_MEMORY=1` when `NETLIFY` is unset.

### 2.7 Twilio integration

`twilio-sms-client.mjs` — thin `fetch` wrapper to `POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`.

Sending requires **all** of:

- `ENABLE_NEW_CLIENT_SMS_AUTOMATION=1`
- `NEW_CLIENT_SMS_DRY_RUN=0`
- `ENABLE_NEW_CLIENT_SMS_SENDING=1`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` set
- Segment flag enabled
- Valid E.164-capable phone
- SMS consent not explicitly denied (see §2.8)

### 2.8 SMS consent

Mindbody Public API **does not expose a reliable SMS/text opt-in field** in the client payloads we receive today (`SendPromotionalEmails` is email-only).

Behavior:

| `smsConsent` in report | Auto-send |
|---|---|
| `unknown` | **Blocked** — dry-run shows `wouldSend: false, blockReason: "sms_consent_unknown"` |
| `explicit_opt_in` | Allowed (if field ever appears, e.g. `PromotionalTextOptIn === true`) |
| `explicit_opt_out` | Blocked |

Override for staged testing only: `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT=1` (never in production without legal review).

Every message includes: `Reply STOP to opt out.`

### 2.9 Dry-run / reporting

When `NEW_CLIENT_SMS_DRY_RUN=1` (default):

- No Twilio calls
- No idempotency blob writes
- Structured JSON logs: `new_client_sms_candidate`, `new_client_sms_run_summary`
- HTTP admin response returns full report (PII-redacted: email domain only, phone last-4)

Optional future: `SMS_ADMIN_REPORT_EMAIL` — no generic email client exists yet; use Netlify log drain or manual admin HTTP response for now.

### 2.10 Schedule

Netlify scheduled function: `new-client-sms-scan.mjs`

```js
export const config = { schedule: "0 14 * * *" }; // 14:00 UTC ≈ 10:00 AM US Eastern (EDT)
```

Manual trigger: `POST /api/admin/new-client-sms/run` with header `x-admin-token: <ADMIN_DEBUG_TOKEN>`.

---

## 3. Environment variables

See `.env.example` section **New Client SMS follow-up**.

| Variable | Default | Purpose |
|---|---|---|
| `ENABLE_NEW_CLIENT_SMS_AUTOMATION` | `0` | Master switch — cron/HTTP no-op when off |
| `NEW_CLIENT_SMS_DRY_RUN` | `1` | Log/report only |
| `ENABLE_NEW_CLIENT_SMS_SENDING` | `0` | Global Twilio send gate |
| `ENABLE_SMS_SEGMENT_ONE_REMAINING` | `1` | Segment A |
| `ENABLE_SMS_SEGMENT_EXPIRING_SOON` | `1` | Segment B |
| `ENABLE_SMS_SEGMENT_COMPLETED_NO_PURCHASE` | `0` | Segment C |
| `NEW_CLIENT_SMS_COUPON_CODE` | `KEEPMOVING15` | Inserted in message body |
| `NEW_CLIENT_SMS_PRICING_URL` | `https://www.amarewellness.com/pricing` | CTA link |
| `NEW_CLIENT_SMS_TIMEZONE` | `America/New_York` | Date math |
| `NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS` | `45` | Mindbody + Stripe discovery window (hard max **120**, min **7**) |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES` | `10` | lastModified client pagination (200/page, hard max **50** pages) |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLASS_SCAN` | `90` | Per-class classvisits fallback (hard max **300**, min **10**) |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENTS` | `250` | Max deduped client IDs after discovery union (hard max **500**) |
| `NEW_CLIENT_SMS_MAX_EVALUATED_CLIENTS` | `150` | Max clients evaluated per run (hard max **300**) |
| `NEW_CLIENT_SMS_COMPLETED_GRACE_DAYS` | `14` | Segment C window after NCS ends |
| `NEW_CLIENT_SMS_MINDBODY_SERVICE_IDS` | _(unset)_ | Optional NCS ID override |
| `NEW_CLIENT_SMS_SEED_CLIENT_IDS` | _(unset)_ | Manual client ID seed |
| `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT` | `0` | Test override — do not use in prod |
| `NEW_CLIENT_SMS_STORE_LOCAL_MEMORY` | _(unset)_ | Local dev blob shim |
| `TWILIO_ACCOUNT_SID` | | Twilio |
| `TWILIO_AUTH_TOKEN` | | Twilio |
| `TWILIO_FROM_NUMBER` | | E.164 from number |
| `SMS_ADMIN_REPORT_EMAIL` | | Reserved — not wired yet |

---

## 4. Safe testing

### 4.1 Local dev

1. Copy env vars into `.env` (keep `NEW_CLIENT_SMS_DRY_RUN=1`, `ENABLE_NEW_CLIENT_SMS_SENDING=0`).
2. Set `NEW_CLIENT_SMS_STORE_LOCAL_MEMORY=1` if testing idempotency locally.
3. Set `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` if seeding from Stripe orders in dev.
4. Run unified dev: `npm run dev`.
5. Trigger manually:

```bash
curl -s -X POST "http://127.0.0.1:4321/api/admin/new-client-sms/run" \
  -H "x-admin-token: YOUR_ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" | jq .
```

6. Inspect JSON report: `candidates[]`, `skipped[]`, `summary`.
7. Cross-check flagged clients in Mindbody Manager (Client → Visits / Pricing Options).

### 4.2 Production dry-run

**Required Netlify env (safe defaults — no live SMS):**

| Variable | Value |
|---|---|
| `ENABLE_NEW_CLIENT_SMS_AUTOMATION` | `1` |
| `NEW_CLIENT_SMS_DRY_RUN` | `1` |
| `ENABLE_NEW_CLIENT_SMS_SENDING` | `0` |
| `ENABLE_SMS_SEGMENT_COMPLETED_NO_PURCHASE` | `0` (leave off) |
| `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT` | unset or `0` |
| `ADMIN_DEBUG_TOKEN` | your 16+ char token |

**Trigger after deploy:**

```bash
curl -s -X POST "https://www.amarewellness.com/api/admin/new-client-sms/run" \
  -H "x-admin-token: YOUR_ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" | jq .
```

**Inspect response:**

- `caps` — hard/configured limits for this run
- `seedSources` — discovery channel counts + `truncatedDiscovered` if capped
- `report.candidates[]` — segment matches (full field set below)
- `report.skippedClients[]` — evaluated but not SMS candidates (includes NCS package summaries when present)
- `evaluatedClients` / `truncatedEvaluation` — evaluation cap status

**Each candidate row includes:**

| Field | Meaning |
|---|---|
| `segment` | `one_remaining` / `expiring_soon` / `completed_no_purchase` |
| `seedSources` | e.g. `["mindbody_clients","stripe_ncs_order"]` |
| `mindbodyClientId` | Mindbody client ID |
| `ncsServiceId` | Pricing option ID (e.g. `100012`) |
| `ncsClientServiceId` | ClientServices instance ID (idempotency key) |
| `remainingVisits` | Mindbody `Remaining` |
| `expirationDate` | ISO expiration |
| `daysToExpiry` | Calendar days in studio TZ |
| `followUpPurchaseFound` | `false` for candidates (skipped earlier if true) |
| `activeMindbodyMembershipFound` | `false` for candidates |
| `activeStripeSubscriptionFound` | `false` for candidates |
| `wouldSend` | `false` when `blockReason` set (e.g. `sms_consent_unknown`) |
| `blockReason` | Why auto-send is blocked |
| `phoneLast4` / `emailDomain` | Redacted contact only |

In dry-run, `wouldSend: true` rows have `action: "dry_run_would_send"` — still no Twilio call.

### 4.3 Manual validation checklist (three known clients)

For controlled validation, temporarily set all three Mindbody client IDs in one env var (comma-separated):

```
NEW_CLIENT_SMS_SEED_CLIENT_IDS=<stripe_ncs_id>,<instudio_attended_id>,<instudio_never_booked_id>
```

Redeploy or update Netlify env, run the admin POST, then verify:

| Case | Expected in report | What to check |
|---|---|---|
| **1. Stripe NCS buyer** | Appears with `stripe_ncs_order` in `seedSources` | NCS `remainingVisits` / `daysToExpiry` match Mindbody; segment matches lifecycle |
| **2. In-studio NCS, attended** | `mindbody_clients` and/or `mindbody_visits` in `seedSources` | Same NCS fields; likely Segment A or B |
| **3. In-studio NCS, never booked** | May **not** appear unless in `NEW_CLIENT_SMS_SEED_CLIENT_IDS` | If seeded: should show NCS package in `skippedClients` or `candidates`; if not seeded: confirms discovery gap |

Remove `NEW_CLIENT_SMS_SEED_CLIENT_IDS` after validation.

### 4.4 Enabling live SMS (ops checklist)

- [ ] Dry-run reviewed for 3–7 days
- [ ] Twilio number provisioned + A2P 10DLC registration (if US)
- [ ] `KEEPMOVING15` active in Stripe for membership checkout
- [ ] SMS consent policy confirmed with studio legal/ops
- [ ] Set `NEW_CLIENT_SMS_DRY_RUN=0`, `ENABLE_NEW_CLIENT_SMS_SENDING=1`
- [ ] Enable Segment C only after A/B validated
- [ ] Monitor Twilio delivery logs + opt-out replies

---

## 5. File map

| File | Role |
|---|---|
| `netlify/functions/new-client-sms-lib.mjs` | Eligibility, messages, Mindbody queries |
| `netlify/functions/new-client-sms-store.mjs` | Idempotency blobs |
| `netlify/functions/twilio-sms-client.mjs` | Twilio REST wrapper |
| `netlify/functions/new-client-sms-scan.mjs` | Cron + admin HTTP handler |

---

## 6. Open limitations

1. **No studio-wide NCS query** — must union lastModified clients + visit activity, then confirm via `clientservices` per client.
2. **Never-booked in-studio NCS** may be missed if client profile unchanged since purchase and outside lookback window.
3. **SMS consent** unavailable from Mindbody API — auto-send blocked until consent field confirmed or legal approves override.
4. **ClassPass detection** (Segment D) deferred.
5. **Cross-channel dedup** with Mindbody auto-emails not implemented.
6. **Cron timezone** is UTC-fixed.

**Last updated:** 2026-05-26
