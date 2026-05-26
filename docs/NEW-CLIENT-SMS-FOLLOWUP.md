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
| `GET /client/clients?request.clientIDs=` / `searchText` | Profile + **`SendPromotionalTexts`** consent; phone/email lookup for Series Expirations matching |
| `GET /client/clientservices?request.clientIds[]` | **Batched** NCS remaining / expiration / instance ID (see §2.4.1) |
| `GET /client/clientpurchases?request.clientId=` | Follow-up purchase detection (post-NCS date) |
| `GET /client/activeclientmemberships?request.clientId=` | Skip clients with active Mindbody-native membership |
| `GET /client/clientvisits?request.clientId=` | Per-client visit history with `ServiceId` / `ProductId` — evaluation supplement only (not bulk discovery) |
| `GET /client/clientcompleteinfo?request.clientId=` | Same consent fields as `GetClients` — optional; not required when profile fetch succeeds |

Per-client evaluation uses staff Bearer auth. **`ClientServices` are prefetched in batches** before the evaluation loop (`NEW_CLIENT_SMS_CLIENTSERVICES_BATCH_SIZE`, default 50, max 100).

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

### 2.4 Client discovery (Mindbody Series Expirations report — primary)

Mindbody is the **source of truth** for NCS ownership and visit state. The studio report **Series Expirations** (date range export) lists pricing options nearing expiration — the recommended primary seed.

**Important:** Mindbody “Export to Excel” for this report produces an **HTML file with a `.xls` extension**, not a binary Excel workbook. The parser detects `<table>` markup automatically.

#### Discovery priority (implemented)

1. **Mindbody Series Expirations `.xls` (HTML)** — primary seed; filter to NCS pricing option (default **`New Client - 3 pack`**).
2. **Stripe NCS orders** — supplemental (website checkout only).
3. **Mindbody recent clients / class visits** — **fallback only** when `NEW_CLIENT_SMS_ENABLE_MINDBODY_FALLBACK=1` (never auto-enabled when report missing — avoids 504 timeouts).
4. **Legacy “Expiring intro offers” CSV** — still supported if path/body contains true CSV text.
5. **Manual** — `NEW_CLIENT_SMS_SEED_CLIENT_IDS` for testing only.

After seed union, **every client is confirmed** via Mindbody API (`GET /client/clientservices`, etc.). Report rows alone never trigger SMS.

#### Series Expirations columns (detected)

| Column | Use |
|---|---|
| Client | Report + row identity (`csvClientName`) — **not** used for matching |
| Pricing Options/Memberships | Filter to NCS name; report (`csvIntroOffer`) |
| Payment Ref # | Report (`csvPaymentRef`) |
| Activation Date | Report (`csvActivationDate`) |
| Expiration Date | Report (`csvExpiration`) |
| Paid | Report only |
| Remaining | Report (`csvRemaining`) — cross-check vs API |
| Active | Report (`csvActive`) |
| Rep 1 | Report only |
| Phone # | **Primary match key** (exact last 10 digits) |

**Matching rules (Series Expirations):**

- Match by **phone only** (exact last-10 digits on Mindbody profile).
- Missing phone → `unmatched`.
- Multiple phone hits → `ambiguous` — row skipped, listed in `report.csvAmbiguousRows`.
- **No email or name matching** for this report format.

#### Where to place the report (local dev)

```
data/mindbody/series-expirations.xls
```

Copy your Mindbody export there (any filename is fine if env path matches). Example:

```
NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT_PATH=./data/mindbody/series-expirations.xls
```

This folder is **gitignored** (PII). Only `data/mindbody/.gitkeep` is tracked.

#### Report input sources

| Context | How |
|---|---|
| **Local dry-run** | Save `.xls` under `data/mindbody/` + set `NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT_PATH` |
| **Admin page (recommended)** | `/admin/new-client-followup` — upload `.xls`, persist to Blob, run dry-run in browser |
| **Admin POST** | JSON `{ "seriesExpirationReport": "…", "persistSeedReport": true }`, multipart file field `report`, or raw body `Content-Type: text/html` |
| **Scheduled cron** | Upload once via admin page (or POST with persist), then `NEW_CLIENT_SMS_SEED_REPORT_FROM_BLOB=1` |

#### Admin upload page (studio ops)

Protected internal page: **`/admin/new-client-followup`** (not linked from public nav; `noindex`).

1. Open the page and enter `ADMIN_DEBUG_TOKEN` (stored in **sessionStorage for this tab only** — not localStorage, no report PII cached in the browser).
2. Export **Series Expirations** from Mindbody (see below).
3. Choose the `.xls` file → **Upload report & run dry-run** — persists to Netlify Blob (`seed-report/latest` + metadata) and runs the scan immediately.
4. Review the on-page summary + candidates table (redacted phone/email only).
5. **Run dry-run from saved report** reuses the last uploaded Blob (same as daily cron) without re-uploading.

Status endpoint (requires `x-admin-token`):

`GET /api/admin/new-client-sms/seed-report/status` → `{ exists, uploadedAt, filename, size, totalRows, ncsRows, reportDateRange }`

After a successful dry-run, the internal Resend admin email still sends when `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=1`.

**Recommended refresh cadence:** upload a fresh export **2× per week** while validating; **weekly** once counts look stable. Replace the Blob whenever the Mindbody date range rolls forward (e.g. today → +60 days).

**Safety:** dry-run only — `NEW_CLIENT_SMS_DRY_RUN=1`, `ENABLE_NEW_CLIENT_SMS_SENDING=0`, Segment C off, no `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT`. No SMS is sent from this page.

#### Exporting from Mindbody

1. Mindbody **Manager** → **Reports** → **Series Expirations** (or Series and Membership Expiration).
2. Set date range: **today through +60 days** (adjust seasonally).
3. **Generate**, then **Export** / **Excel** — saves as `.xls` (HTML).
4. Upload via **Admin page** (production) or copy to `data/mindbody/series-expirations.xls` (local dev path env).

#### Dry-run `seedSources` shape

```json
{
  "seedSources": {
    "mindbodySeriesExpirationRows": 42,
    "mindbodySeriesExpirationNcsRows": 6,
    "mindbodySeriesExpirationMatched": 5,
    "mindbodySeriesExpirationUnmatched": 1,
    "mindbodySeriesExpirationAmbiguous": 0,
    "mindbodyIntroOffersCsv": 0,
    "stripeOrders": 1,
    "mindbodyClients": 0,
    "mindbodyVisits": 0,
    "dedupedTotal": 5
  }
}
```

When Series Expirations is primary, `mindbodyClients` / `mindbodyVisits` are **0** unless fallback env is on.

#### Candidate / skipped report fields

Each evaluated client from the report includes:

| Field | Example |
|---|---|
| `csvExpiration` | `5/26/2026` |
| `csvActivationDate` | `5/1/2026` |
| `csvIntroOffer` | `New Client - 3 pack` |
| `csvRemaining` | `1` |
| `csvActive` | `Yes` |
| `csvMatchedBy` | `phone` |
| `csvMatchStatus` | `matched` |

Compare `csvRemaining` / `csvExpiration` to API `remainingVisits` / `expirationDate`.

#### Legacy bulk discovery (fallback)

When no CSV is provided (or CSV is empty), the job falls back to:

1. **`GET /client/clients`** paginated with `request.lastModifiedDate`.
2. **`GET /class/classvisits`** (+ class schedule fallback).

This path is **noisy** at AMARÉ scale (hundreds of clients, few NCS). Prefer the CSV workflow.

**Known gaps (documented in dry-run `discoveryNotes`):**

- Client bought in-studio NCS **weeks ago** with **no profile change and no booking** may fall outside bulk fallback until CSV includes them.
- `mindbodyPurchases` in `seedSources` is always **0** at discovery time — no studio-wide purchase list exists on Public API.

#### Mindbody Client endpoint investigation (AMARÉ live probe — 2026-05-26)

Probe script: `node scripts/mindbody-sms-endpoint-probe.mjs`

| Endpoint | Finding | SMS use |
|---|---|---|
| **Get Client Services** | ✅ `request.clientIds[]` works (batch). Single `clientId` still supported. Rows include `ClientID`, `ProductId`, `Remaining`, `ExpirationDate`. | **Implemented:** batched prefetch before evaluation (`NEW_CLIENT_SMS_CLIENTSERVICES_BATCH_SIZE=50`, hard max 100). 21 clients → **1** API call instead of 21. |
| **Get Client Visits** | Requires **`request.clientId`** (singular). `request.clientIds` → **400**. Supports **`startDate` / `endDate`**. Visit rows include `ServiceName`, `ServiceId`, nested `Service.ProductId` (e.g. **100012**), `TypeTaken`, `SignedIn`. | **Does not replace** studio-wide `class/classvisits` (different endpoint). Useful **per seeded client** to confirm NCS attendance / which pricing option paid for a visit — **not implemented in v1** (Series Expirations report + `clientservices` sufficient). |
| **Get Client Complete Info** | Returns **`SendPromotionalTexts`**, `SendAccountTexts`, `SendScheduleTexts` (booleans). No `SMSOptIn` / `PromotionalTextOptIn` on AMARÉ. Test client had all text flags `false`. | **Implemented:** `readSmsConsent()` maps `SendPromotionalTexts === true` → opt-in, `false` → opt-out. Conversion SMS treated as promotional. |
| **Get Clients** | `request.searchText` + exact phone filter works (1 match in probe). Same consent fields as Complete Info. `request.clientIDs` for profile by ID. | **Already used** for Series Expirations phone matching. Email search works when email present. |
| **Get Custom Client Fields** | **0** field definitions on AMARÉ site. | No SMS consent custom fields. |
| **Get Required Client Fields** | **`MobilePhone`**, **`Email`** required. | High confidence phone/email matching when report includes phone. |
| **Get Contact Logs** | Works (`request.clientId`); empty for probe client. | **Deferred** — could log manual SMS outreach later to avoid duplicate contact. |

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

Mindbody Public API v6 exposes text preferences on **`GET /client/clients`** and **`GET /client/clientcompleteinfo`** (AMARÉ live probe, May 2026):

| Field | Meaning |
|---|---|
| `SendPromotionalTexts` | **Primary gate for conversion SMS** — marketing / promotional texts |
| `SendAccountTexts` | Transactional account texts |
| `SendScheduleTexts` | Schedule / booking texts |

Behavior (`readSmsConsent` in `new-client-sms-lib.mjs`):

| `SendPromotionalTexts` | `smsConsent` in report | Auto-send |
|---|---|---|
| `true` | `explicit_opt_in` | Allowed (if other gates pass) |
| `false` | `explicit_opt_out` | **Blocked** — `blockReason: "sms_consent_opt_out"` |
| missing / null | `unknown` | **Blocked** — `blockReason: "sms_consent_unknown"` |

Legacy opt-in key names (`PromotionalTextOptIn`, etc.) are checked as fallback if present on other sites.

Override for staged testing only: `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT=1` (**never in production** without legal review).

Every message includes: `Reply STOP to opt out.`

### 2.9 Dry-run / reporting

When `NEW_CLIENT_SMS_DRY_RUN=1` (default):

- No Twilio calls
- No idempotency blob writes
- Structured JSON logs: `new_client_sms_candidate`, `new_client_sms_run_summary`
- HTTP admin response returns full report (PII-redacted: email domain only, phone last-4)

#### Internal admin email (Resend) — dry-run only

After each **successful dry-run**, optionally email an internal task list to the AMARÉ team via [Resend](https://resend.com).

**Safety:** Resend is **not** used for client-facing marketing in this phase. Only `SMS_ADMIN_REPORT_TO` (studio inbox) receives the report.

| Variable | Default | Purpose |
|---|---|---|
| `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL` | `0` | Master switch for admin report email |
| `RESEND_API_KEY` | _(unset)_ | Resend API bearer token |
| `SMS_ADMIN_REPORT_FROM` | `AMARÉ Reports <reports@amarewellness.com>` | Verified sending address / domain |
| `SMS_ADMIN_REPORT_TO` | _(unset)_ | Comma-separated internal recipients |

Sent only when all of: `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=1`, `RESEND_API_KEY` set, `SMS_ADMIN_REPORT_TO` set, and run is `dryRun: true`.

**Subject:** `AMARÉ New Client Follow-Up Report — {N} candidates` (including `0 candidates`).

**Includes:** run stats, Series Expirations counts, consent/block summaries, candidates table (redacted PII), recommended manual actions. Unmatched/ambiguous row **counts only** — full details stay in JSON.

**DNS:** Verify the sending domain in Resend (DKIM + SPF on the subdomain Resend provides) before enabling in production. Until verified, leave `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=0`.

**Example report (abbreviated):**

```
Run: May 26, 2026, 10:15 AM (America/New_York)
Dry-run: yes · SMS sent: 0
Series: 277 rows · 25 NCS · 21 matched · 3 unmatched · 1 ambiguous
Candidates: 7 (one_remaining: 6, expiring_soon: 1)
Consent: explicit_opt_out: 6, explicit_opt_in: 1
Unmatched/ambiguous: review full dry-run JSON
```

**Disable:** set `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL=0` (or unset `RESEND_API_KEY` / `SMS_ADMIN_REPORT_TO`).

### 2.10 Schedule

Netlify scheduled function: `new-client-sms-scan.mjs`

```js
export const config = { schedule: "0 14 * * *" }; // 14:00 UTC ≈ 10:00 AM US Eastern (EDT)
```

Manual trigger: `POST /api/admin/new-client-sms/run` with header `x-admin-token: <ADMIN_DEBUG_TOKEN>`, or use **`/admin/new-client-followup`** in the browser.

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
| `NEW_CLIENT_SMS_SEED_LOOKBACK_DAYS` | `45` | Stripe + bulk Mindbody fallback window (hard max **120**, min **7**) |
| `NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT_PATH` | _(unset)_ | Local path to Mindbody Series Expirations `.xls` (HTML) |
| `NEW_CLIENT_SMS_SERIES_EXPIRATION_NCS_NAMES` | `New Client - 3 pack` | Filter report rows to these pricing options |
| `NEW_CLIENT_SMS_INTRO_OFFERS_CSV_PATH` | _(unset)_ | Optional legacy CSV intro-offers export |
| `NEW_CLIENT_SMS_INTRO_OFFERS_CSV` | _(unset)_ | Inline CSV string (small exports) |
| `NEW_CLIENT_SMS_INTRO_OFFERS_CSV_FROM_BLOB` | `0` | Read persisted CSV from Netlify Blobs (scheduled cron) |
| `NEW_CLIENT_SMS_ENABLE_MINDBODY_FALLBACK` | `0` | When `1`, also run bulk lastModified/visits scan even if CSV loaded |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES` | `10` | lastModified client pagination (200/page, hard max **50** pages) |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLASS_SCAN` | `90` | Per-class classvisits fallback (hard max **300**, min **10**) |
| `NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENTS` | `250` | Max deduped client IDs after discovery union (hard max **500**) |
| `NEW_CLIENT_SMS_MAX_EVALUATED_CLIENTS` | `150` | Max clients evaluated per run (hard max **300**) |
| `NEW_CLIENT_SMS_CLIENTSERVICES_BATCH_SIZE` | `50` | Clients per batched `GET clientservices` call (hard max **100**) |
| `NEW_CLIENT_SMS_COMPLETED_GRACE_DAYS` | `14` | Segment C window after NCS ends |
| `NEW_CLIENT_SMS_MINDBODY_SERVICE_IDS` | _(unset)_ | Optional NCS ID override |
| `NEW_CLIENT_SMS_SEED_CLIENT_IDS` | _(unset)_ | Manual client ID seed |
| `NEW_CLIENT_SMS_ALLOW_UNKNOWN_CONSENT` | `0` | Test override — do not use in prod |
| `NEW_CLIENT_SMS_STORE_LOCAL_MEMORY` | _(unset)_ | Local dev blob shim |
| `TWILIO_ACCOUNT_SID` | | Twilio |
| `TWILIO_AUTH_TOKEN` | | Twilio |
| `TWILIO_FROM_NUMBER` | | E.164 from number |
| `ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL` | `0` | Internal Resend report after dry-run |
| `RESEND_API_KEY` | | Resend API key (admin report only) |
| `SMS_ADMIN_REPORT_FROM` | `AMARÉ Reports <reports@…>` | Verified sender |
| `SMS_ADMIN_REPORT_TO` | | Internal inbox(es), comma-separated |

---

## 4. Safe testing

### 4.1 Local dev

1. Copy env vars into `.env` (keep `NEW_CLIENT_SMS_DRY_RUN=1`, `ENABLE_NEW_CLIENT_SMS_SENDING=0`).
2. Export **Series Expirations** from Mindbody → save as `data/mindbody/series-expirations.xls`.
3. Set `NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT_PATH=./data/mindbody/series-expirations.xls`.
4. Set `NEW_CLIENT_SMS_STORE_LOCAL_MEMORY=1` if testing idempotency locally.
5. Set `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` if seeding from Stripe orders in dev.
6. Run unified dev: `npm run dev`.
7. Open **`http://127.0.0.1:4321/admin/new-client-followup`**, enter `ADMIN_DEBUG_TOKEN`, upload the Series Expirations `.xls`, and run dry-run — **or** trigger via curl:

**Option A — admin page (recommended for studio ops)**

See §2.4 **Admin upload page**.

**Option B — curl / JSON POST:**

```bash
curl -s -X POST "http://127.0.0.1:4321/api/admin/new-client-sms/run" \
  -H "x-admin-token: YOUR_ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" | jq .
```

**Option B — POST CSV in body:**

```bash
curl -s -X POST "http://127.0.0.1:4321/api/admin/new-client-sms/run" \
  -H "x-admin-token: YOUR_ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<EOF
{"introOffersCsv":"$(cat data/expiring-intro-offers.csv | sed 's/"/\\"/g' | tr '\n' '\\n')"}
EOF
```

On Windows PowerShell, prefer env path or save JSON with embedded CSV manually.

8. Inspect JSON report:
   - `seedSources.mindbodyIntroOffersCsv*` — CSV row counts
   - `report.candidates[]` / `report.skippedClients[]` — API-verified rows with `csvExpiration`, `csvVisits`, etc.
   - `report.csvUnmatchedRows` / `report.csvAmbiguousRows` — rows that did not seed
9. Cross-check: compare each candidate’s `csvVisits` / `csvExpiration` to `remainingVisits` / `expirationDate` in Mindbody Manager.

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

**If production returns HTTP 504:** bulk fallback scans are slow. With **CSV primary**, runs should finish in seconds — ensure CSV is provided (POST body or blob). If using bulk fallback only, lower caps on Netlify:

```
NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENT_PAGES=3
NEW_CLIENT_SMS_DISCOVERY_MAX_CLIENTS=80
NEW_CLIENT_SMS_MAX_EVALUATED_CLIENTS=40
```

Function timeout is set to **60s** in `netlify.toml` (Netlify Pro max for synchronous functions).

**Trigger after deploy:**

1. Open **`https://www.amarewellness.com/admin/new-client-followup`**
2. Enter `ADMIN_DEBUG_TOKEN`
3. Upload the latest Series Expirations `.xls` → **Upload report & run dry-run**
4. Confirm on-page summary + Resend inbox email

**Alternative — curl POST (automation / debugging):**

```bash
curl -s -X POST "https://www.amarewellness.com/api/admin/new-client-sms/run" \
  -H "x-admin-token: YOUR_ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

`payload.json`:

```json
{
  "introOffersCsv": "Expiration,Client Name,Email,Phone,Intro Offer,Visits,Next Visit\n...",
  "persistIntroOffersCsv": true
}
```

Set `NEW_CLIENT_SMS_INTRO_OFFERS_CSV_FROM_BLOB=1` on Netlify so the **scheduled cron** reuses the last uploaded CSV without POSTing each time.

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
| `netlify/functions/new-client-sms-intro-csv.mjs` | Legacy Expiring intro offers CSV parse + email/phone match |
| `netlify/functions/new-client-sms-series-expiration.mjs` | Series Expirations HTML/.xls parse + phone match |
| `netlify/functions/new-client-sms-seed-report.mjs` | Report path / POST / blob resolution |
| `netlify/functions/new-client-sms-store.mjs` | Idempotency blobs |
| `netlify/functions/twilio-sms-client.mjs` | Twilio REST wrapper |
| `netlify/functions/resend-email-client.mjs` | Resend REST wrapper (admin report only) |
| `netlify/functions/new-client-sms-admin-report.mjs` | Internal Resend dry-run report |
| `netlify/functions/new-client-sms-admin-auth.mjs` | Shared `x-admin-token` gate + CORS |
| `netlify/functions/new-client-sms-seed-status.mjs` | `GET …/seed-report/status` (Blob metadata) |
| `netlify/functions/new-client-sms-scan.mjs` | Cron + admin HTTP handler |
| `src/content/admin-new-client-followup.html` | Admin upload UI (content partial) |
| `src/js/admin-new-client-followup.js` | Admin page client logic |
| `src/css/components-admin-sms.css` | Admin page styles |

---

## 6. Open limitations

1. **No studio-wide NCS API query** — CSV report + per-client `clientservices` confirmation is the supported path; bulk lastModified scan remains fallback only.
2. **CSV must be refreshed** — export from Mindbody before each dry-run or persist via blob for cron.
3. **`SendPromotionalTexts`** must be `true` for auto-send — most NCS clients probed had `false` until they opt in via Mindbody.
4. **ClassPass detection** (Segment D) deferred.
5. **Cross-channel dedup** with Mindbody auto-emails not implemented.
6. **Cron timezone** is UTC-fixed.

**Last updated:** 2026-05-26
