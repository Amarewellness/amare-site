# AMARÉ Private Events — Production Readiness Audit

**Date:** 2026-08-26  
**Scope:** Private Events payment system only (excludes Mindbody classes, memberships, NCS, class checkout, Phase 3 auto day-before charge)  
**Mode:** READ-ONLY — no deploys, no production data changes, no live Stripe charges, no env changes, no source fixes  
**Baseline commit:** `9ff6cc537cfff33d16238d20ba1b9dd3c8e236fa`  
**Auditor note:** Code on disk includes uncommitted working-tree changes; audit reflects **current code as authoritative**, not documentation.

---

## 1. VERDICT

**PRODUCTION BLOCKED**

Two P0 findings block safe production use as implemented: (1) concurrent **Charge remaining** can double-charge the same balance, and (2) **deploy previews / branch deploys share production Netlify Blob stores** with no server-side isolation guard.

---

## 2. P0 — FINANCIAL / SECURITY BLOCKERS

### P0-001 — Concurrent Charge Remaining double-charge

| Field | Detail |
|-------|--------|
| **File + function** | `netlify/functions/event-reservations-admin.mjs` — `/charge-remaining` handler (~L788–837); `netlify/functions/event-reservation-charge.mjs` — `chargeSavedEventCard` (~L22–109) |
| **Scenario** | Two admins (or double-click + network retry) POST `/api/admin/events/charge-remaining` for the same reservation before either write completes. |
| **Current behavior** | Both requests read `remainingPaid !== true` (L795–797). Each generates a **new** `chargeId` via `randomUUID()` (L812) → **different** Stripe idempotency keys (`evt-${chargeId}`, L825). Both call Stripe off-session invoice pay. First success sets `remainingPaid: true` (L833–837); second may already be in-flight at Stripe → **two charges for the same remaining balance**. |
| **Expected behavior** | Exactly one remaining-balance charge per reservation; concurrent retries must noop or share a stable idempotency key tied to `reservationId + operation`, with atomic claim-before-Stripe. |
| **Impact** | Customer double-charged for event balance. |
| **Reproducibility** | HIGH — send two concurrent POSTs with valid admin token while `status=confirmed`, `remainingPaid=false`, saved PM. |
| **Confidence** | **HIGH** |

### P0-002 — Deploy preview / branch deploy mutates production blob data

| Field | Detail |
|-------|--------|
| **File + function** | `netlify/functions/event-reservation-store.mjs` — `openStores` (~L196–208); `netlify/functions/event-offer-store.mjs` — `openBlobStore` (~L102); `netlify/functions/event-inquiry-store.mjs` |
| **Scenario** | Netlify deploy preview or branch deploy runs with `ADMIN_DEBUG_TOKEN` + production-scoped env vars (or linked site blobs). |
| **Current behavior** | Store names are site-wide: `amare-event-reservations`, `amare-event-offers`, `amare-event-reservations-by-session`. Uses `getStore({ name })` — **not** `getDeployStore()`. No `CONTEXT` guard anywhere in event code. Admin endpoints (confirm, charge, cancel, delete) operate on the same blob namespace as production. |
| **Expected behavior** | Non-production deploy contexts must not read/write/delete production financial records or create live checkout against production reservations. |
| **Impact** | Preview QA can cancel, delete, charge, or corrupt production private-event reservations; combined with live Stripe key = real money movement against prod records. |
| **Reproducibility** | HIGH — standard Netlify preview against linked production site. |
| **Confidence** | **HIGH** (matches Netlify Blobs site-wide semantics; contrast `stripe-order-store.mjs` which documents QA suffix pattern). |

---

## 3. P1 — PRODUCTION RELIABILITY ISSUES

### P1-001 — Webhook fulfillment ignores canceled reservation status

| Field | Detail |
|-------|--------|
| **File + function** | `netlify/functions/event-reservation-fulfill.mjs` — `fulfillEventDepositSession` (~L17–154) |
| **Scenario** | Admin cancels while `checkout.session.completed` webhook is in flight (Race C). |
| **Current behavior** | No check for `rec.status === "canceled"`. Fulfillment sets `depositPaid: true`, `status: deposit_paid_pending_confirm` (or preserves `confirmed`), overwriting cancel. |
| **Expected** | Either reject fulfillment on canceled, or define explicit “paid but canceled” policy with admin visibility. |
| **Impact** | State machine corruption; support confusion; cancel does not reliably stop payment recording. |
| **Confidence** | **HIGH** |

### P1-002 — No Stripe `payment_status` verification on fulfillment

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservation-fulfill.mjs` — `fulfillEventDepositSession` |
| **Scenario** | `checkout.session.completed` delivered with non-`paid` payment status (async methods edge case). |
| **Current behavior** | Trusts event type only; never reads `session.payment_status`. |
| **Expected** | Fulfill only when `payment_status === "paid"` (or `async_payment_succeeded` path with paid PI). |
| **Impact** | Theoretical false `depositPaid` / `remainingPaid` without successful payment. |
| **Confidence** | **MEDIUM** (low for card-only checkout; higher if async PMs enabled). |

### P1-003 — No durable Stripe Event ID dedupe for private events

| Field | Detail |
|-------|--------|
| **File + function** | `netlify/functions/stripe-webhook.mjs` (~L2156–2196); `event-reservation-fulfill.mjs` |
| **Scenario** | Stripe retries same `checkout.session.completed` before noop guards persist. |
| **Current behavior** | Application-level noops (`remainingPaid`, PM present, status guards) only. No `evt.id` store (unlike some membership paths in same webhook file). |
| **Expected** | Durable processed-event ledger or idempotent fulfillment keyed by session + transition. |
| **Impact** | Duplicate deposit emails / activity entries; race window before guards visible on eventual reads. |
| **Confidence** | **MEDIUM** |

### P1-004 — Delete reservation while webhook in flight → orphaned Stripe payment

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservation-store.mjs` — `remove` (~L418–431); `event-reservation-fulfill.mjs` (~L26–34) |
| **Scenario** | Admin deletes (allowed for `canceled` + paid) while webhook retrying. |
| **Current behavior** | Delete removes reservation + session index. Webhook returns `reservation_missing`, `retryable: true` (503). Stripe charge already succeeded. |
| **Expected** | Reconciliation path or soft-delete; webhook must be able to reconstruct or refuse delete when payment pending. |
| **Impact** | Money captured with no local reservation — manual Stripe Dashboard reconciliation required. |
| **Confidence** | **HIGH** |

### P1-005 — Overtime / custom charges allow duplicate clicks (new idempotency key each time)

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservations-admin.mjs` — `/charge-overtime` (~L640–654), `/charge-custom` (~L721–735) |
| **Scenario** | Admin double-clicks or concurrent overtime charge for same reservation. |
| **Current behavior** | New `randomUUID()` per request → separate Stripe charges; both appended to `overtimeCharges` / `customCharges`. |
| **Expected** | Idempotency per admin action intent or client-supplied idempotency token with server-side dedupe window. |
| **Impact** | Duplicate overtime/custom charges (real money). |
| **Confidence** | **HIGH** |

### P1-006 — Stale customer page vs authoritative checkout (display drift)

| Field | Detail |
|-------|--------|
| **File + function** | `event-offer-public.mjs` — `enrichOfferFromReservation`; `stripe-event-create-deposit.mjs` — `eventPriceOverrideFrom` + `balanceDueCents`; `src/js/event-reserve.js` — client display |
| **Scenario** | Admin edits pricing/date after customer opened link; customer pays without refresh. |
| **Current behavior** | **Checkout uses latest linked reservation** (`eventPriceOverrideFrom`, `existing.remainingCents` for balance-now). **UI may show stale offer** from initial page load. |
| **Expected** | Intentional policy with UI matching Stripe, or block checkout until client refetches. |
| **Impact** | Customer sees $X, charged $Y — dispute risk even if server is “correct”. |
| **Confidence** | **HIGH** |

### P1-007 — `balanceDueCents` vs patch `remainingCents` split on balance-now checkout

| Field | Detail |
|-------|--------|
| **File + function** | `stripe-event-create-deposit.mjs` (~L224–227, ~L304, ~L372) |
| **Scenario** | Admin changes pricing between reservation read for `balanceDueCents` and `validateEventReservationInput` patch fields. |
| **Current behavior** | Stripe `unit_amount` uses `existing.remainingCents`; patch writes `parsed.remainingCents`. Normally aligned via same `linkedReservation` read; not atomic. |
| **Expected** | Single read + single computed amount used for both Stripe and persistence. |
| **Impact** | Stripe amount ≠ stored `remainingCents` under admin-edit race. |
| **Confidence** | **MEDIUM** |

### P1-008 — Eventual blob reads for financial guards

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservation-store.mjs` — `BLOBS_EVENTUAL` (~L17, ~L206–208) |
| **Scenario** | Guard reads stale `remainingPaid=false` on eventual consistency. |
| **Current behavior** | All reads use `consistency: "eventual"`. CAS on `patch` mitigates lost updates but not stale guard reads. |
| **Expected** | Strong read before money movement or atomic claim in patch mutator. |
| **Impact** | Amplifies P0-001 / P1-005. |
| **Confidence** | **MEDIUM** |

### P1-009 — Offer store blind last-write-wins (no CAS)

| Field | Detail |
|-------|--------|
| **File + function** | `event-offer-store.mjs` — `put` (~L166–168) |
| **Scenario** | Concurrent webhook marks offer `used` while admin send-booking updates same offer. |
| **Current behavior** | Unconditional `setJSON`. |
| **Expected** | CAS or merge strategy. |
| **Impact** | Offer/reservation drift; wrong offer status for customer link. |
| **Confidence** | **MEDIUM** |

### P1-010 — Admin auth: single long-lived bearer token, CORS `*`

| Field | Detail |
|-------|--------|
| **File + function** | `new-client-sms-admin-auth.mjs` — `adminAuthorized`; `event-reservations-admin.mjs` (~L209) |
| **Scenario** | Token leak via XSS, shared credential, or browser sessionStorage. |
| **Current behavior** | All 15 money-moving admin routes gated by same static token; CORS allows any origin with header. |
| **Expected** | Scoped sessions, rotation, CSRF-safe cookie auth for financial endpoints. |
| **Impact** | Full admin financial API compromise from token leak. |
| **Confidence** | **HIGH** (auth exists; model is weak for money-moving API). |

### P1-011 — No livemode / test-key guard on admin Stripe charges

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservations-admin.mjs` — charge handlers; `stripeLivemode` stored on fulfill (~L151) but never enforced |
| **Scenario** | Preview deploy with live `STRIPE_SECRET_KEY` charges test reservation record or vice versa. |
| **Current behavior** | Mode entirely from env var; no comparison to `rec.stripeLivemode`. |
| **Impact** | Wrong-environment charges / reconciliation mismatch. |
| **Confidence** | **MEDIUM** |

### P1-012 — `findByOfferId` capped scan (2000 blobs)

| Field | Detail |
|-------|--------|
| **File + function** | `event-reservation-store.mjs` (~L391–414) |
| **Scenario** | >2000 reservations; offer blob missing; `view=1` fallback. |
| **Current behavior** | Scan stops at 2000; may return 404 for valid paid reservation. |
| **Impact** | Customer “link not valid” after payment. |
| **Confidence** | **MEDIUM** (scale-dependent). |

---

## 4. P2 — UX / MAINTAINABILITY ISSUES

| ID | Issue |
|----|-------|
| P2-001 | Pricing formulas duplicated across server, `event-reserve.js`, `admin-events.js` (display only, but drift risk). |
| P2-002 | Delete reservation does not remove orphaned offer blobs (`remove` ~L418–431). |
| P2-003 | Session index `indexSession` is blind write (no CAS) — stale session→reservation mapping possible. |
| P2-004 | Activity log dedupe is in-process only (`dedupeMs`); not cross-instance. |
| P2-005 | Public offer returns full PII to link holder (by design); forwarding link = data leak. |
| P2-006 | `ENABLE_STRIPE_EVENT_DEPOSIT=1` gates public checkout only; admin charges ignore flag (undocumented asymmetry). |
| P2-007 | No automated tests for idempotency, concurrency, webhook ordering, or admin auth. |

---

## 5. FINANCIAL INVARIANTS

| Invariant | PASS/FAIL | Evidence |
|-----------|-----------|----------|
| Server owns all charge amounts sent to Stripe | **PASS** | `validateEventReservationInput` + `eventPriceOverrideFrom` in `stripe-event-create-deposit.mjs` (~L196–205, ~L372, ~L401); admin charges use `rec.remainingCents` / server parsers only (`event-reservations-admin.mjs` ~L805, ~L639, ~L704). Client POST has no amount fields (`event-reserve.js` ~L849–860). |
| No duplicate deposit checkout charge | **PASS** (with retry caveat) | Stable idempotency key `event-deposit-${id}` (`stripe-event-create-deposit.mjs` ~L422–424). |
| No duplicate remaining balance charge | **FAIL** | P0-001 — random idempotency key per admin charge; non-atomic guard. |
| No duplicate overtime/custom charge | **FAIL** | P1-005 — each click new UUID. |
| Paid state only after Stripe success / authorized manual | **PASS** (mostly) | `depositPaid`/`remainingPaid` set in webhook fulfill (`event-reservation-fulfill.mjs` ~L142–146) or admin after `chargeSavedEventCard` returns `paid` (~L833–837). Manual entry can toggle paid flags on `/update` when `manualEntry` (~L1065–1077) — intentional. **FAIL edge:** no `payment_status` check (P1-002). |
| Success URL params never authority for paid state | **PASS** | `reserved=1` / `balance=1` only affect UI (`event-reserve.js` ~L33–34, ~L710); state from GET offer API enrichment. |
| No stale amount reaches Stripe (server-side) | **PASS** (checkout) / **PARTIAL** (display) | Checkout reads linked reservation at POST time. Stale **display** possible (P1-006). |
| Reservation / Stripe amount reconcile | **PARTIAL** | Webhook logs `remainingCents` from record, not Stripe line item (`event-reservation-fulfill.mjs` ~L157–162). Admin charge uses stored cents. |
| Post-payment records cannot be destructively edited/deleted | **PARTIAL** | `/update` locks pricing when `remainingPaid` (~L1015–1057). Delete blocked for `confirmed` / `deposit_paid_pending_confirm`; **canceled + paid deletable** (by design). |
| Failed charge never displays Paid | **PASS** | `chargeSavedEventCard` checks `paid.status !== "paid"` (~L88–94); admin returns 402 on failure (~L827–829). |

---

## 6. CONCURRENCY / IDEMPOTENCY

| Check | PASS/FAIL | Evidence |
|-------|-----------|----------|
| Stripe idempotency strategy (deposit checkout) | **PASS** | `event-deposit-${id}` / `event-remaining-checkout-${id}` |
| Stripe idempotency strategy (admin charges) | **FAIL** | New `randomUUID()` per request (`event-reservations-admin.mjs` ~L640, ~L721, ~L812) |
| Webhook dedupe | **FAIL** | No `evt.id` store for events; field-level noops only |
| Webhook ordering handling | **PARTIAL PASS** | `expireEventDepositSession` only if `deposit_pending` (~L239); completed after expired OK. Canceled + completed = P1-001. |
| Blob consistency mode | **eventual** | `event-reservation-store.mjs` ~L17 |
| Blob CAS / ETag / locking | **PARTIAL** | `patch` → `atomicUpdateJSON` with `onlyIfMatch` (`blobs-conditional-create.mjs` ~L190–279). Offer `put` = blind. `indexSession` = blind. |
| Lost-update risk on reservation `patch` | **PASS** (mitigated) | CAS + 5 retries |
| Lost-update risk on read-then-charge guards | **FAIL** | Guards not in same atomic transaction as Stripe call |
| Simultaneous admin mutation behavior | **FAIL** | Race B double charge; Race C cancel/pay |

---

## 7. ENVIRONMENT ISOLATION

| Environment | Blob namespace/store | Stripe mode | Can mutate production data? | Safeguards |
|-------------|---------------------|-------------|----------------------------|------------|
| **Local** (`NETLIFY` unset) | File fallback: `data/event-reservations/local-store.json`, `data/event-offers/local-store.json` | From local env / dev script | **No** (isolated files) | `useLocalFallback()` ~L75–77 |
| **Deploy preview** | Site-wide `amare-event-*` via `getStore()` | Env-scoped (often prod keys if misconfigured) | **YES** | None in code |
| **Branch deploy** | Same as preview | Env-scoped | **YES** | None in code |
| **Production** | Same store names | `STRIPE_SECRET_KEY` from prod env | N/A (is prod) | `ENABLE_STRIPE_EVENT_DEPOSIT=1` for public checkout only |

---

## 8. FLOW CONSISTENCY MATRIX

Amounts shown as **package / deposit / styling / cleaning / remaining / charged**.

| Flow | Admin | Offer | Event page | Stripe | Reservation | Email |
|------|-------|-------|------------|--------|-------------|-------|
| 1. Direct booking ($200 deposit) | — | — | Client display $200 dep (`event-reserve.js`) | `parsed.depositCents` | `validateEventReservationInput` | Deposit emails post-webhook |
| 2. Personalized offer | `/offers` sets cents | Offer blob | `toPublicOffer` + enrich | Server override from offer/rec | Same | Offer email |
| 3. Styling locked offer | `lockStyling` on offer | `styling: true` | Locked checkbox | Server `stylingCentsForRoom` | `stylingCents` field | Included in summary |
| 4. Cleaning charge | `/manual`, `/update`, `/offers` | `cleaningCents` | From offer enrich | In `remaining`/balance calc | `cleaningCents` | `eventEmailSummary` |
| 5. Deposit payment | — | — | $200 display | $200 `unit_amount` | `depositPaid`, status → `deposit_paid_pending_confirm` | Client + admin deposit |
| 6. Deposit manual → balance now ($549 ex.) | `depositPaid=true`, send-booking | `depositPaid: true` | "Pay balance" label | `balanceDueCents` = `existing.remainingCents` | `remainingPaid` on webhook | Balance email |
| 7. Checkout cancel → retry | — | Open offer | cancel URL | New session; idempotent key same `id` | `expired` if session expires | — |
| 8. Success return `reserved=1` | — | `afterCheckout=1` fetch | Summary from API | — | From enrich | — |
| 9. View reservation `view=1` | — | enrich / fallback | Summary mode | — | Canonical rec | Email CTA link |
| 10. Admin Confirm | `/confirm` | — | — | — | `confirmed` | Confirm email |
| 11. Admin Edit | `/update` recalc | **Not auto-updated** until re-send | enrich on GET | — | Updated rec | — |
| 12. Charge remaining | `rec.remainingCents` | — | — | Same cents | `remainingPaid` after Stripe | Remaining email |
| 13–14. Overtime / custom | Server parse minutes/USD | — | — | Parsed cents | Append charge arrays | Overtime/custom email |
| 15. Reschedule | `/reschedule` | Stale until re-send | enrich date | — | Updated date | Reschedule email |
| 16. Cancel | `/cancel` | — | — | — | `canceled` | Optional cancel email |
| 17. Delete | `/delete` | Orphan offer may remain | — | — | Removed | — |
| 18. Resend booking | `/send-booking` syncs offer from rec | Fresh blob | — | — | `offerId` | Booking email |
| 19. Missing offer blob | — | `offerFromReservation` | `view=1` / `afterCheckout=1` | — | rec fields | — |

**Mismatch highlight:** Flow 11 — admin edit updates reservation but not offer blob; customer stale page (P1-006). Flow 17 — offer orphan.

**Edit-after-link policy (Part 10):** **Latest linked reservation wins at checkout POST** (`eventPriceOverrideFrom`, `applyReservationPricingLocks`, `balanceDueCents`). Offer blob is snapshot until `send-booking` re-syncs. GET `/api/events/offer` merges reservation via `enrichOfferFromReservation`.

---

## 9. STATE MACHINE

**States:** `deposit_pending` | `deposit_paid_pending_confirm` | `confirmed` | `canceled` | `expired`

### Allowed transitions (server-enforced)

| Transition | API | Enforced |
|------------|-----|----------|
| → `deposit_pending` | Checkout create (normal) | Yes |
| → `deposit_paid_pending_confirm` | Webhook fulfill / manual add | Yes |
| → `confirmed` | `/confirm` from `deposit_paid_pending_confirm` | Yes (~L590–595) |
| → `canceled` | `/cancel` from paid active | Yes (~L872–877) |
| → `expired` | Webhook `checkout.session.expired` if `deposit_pending` | Yes (~L239) |
| Pricing edit | `/update` if not `expired`, locks if `remainingPaid` | Yes |

### Rejected transitions (verified)

| Attempt | Result |
|---------|--------|
| `deposit_pending` → `/confirm` | 409 `not_confirmable` |
| `canceled` → `/confirm` | 409 |
| `expired` → `/update` | 409 `not_editable` |
| `confirmed` → `/delete` | 409 `not_deletable` |
| `deposit_paid_pending_confirm` → `/delete` | 409 |
| `canceled` + online paid → `/delete` | **Allowed** (current code) |
| `remainingPaid` → edit package/styling/cleaning | Blocked (~L1015–1057) |
| `canceled` → `/charge-remaining` | 409 `not_confirmed` |
| `deposit_pending` → `/charge-overtime` | 409 `not_chargeable` |
| Duplicate `/confirm` | 200 noop |
| Duplicate `/cancel` | 200 noop |

### Gap

| Attempt | Result |
|---------|--------|
| `canceled` + webhook completed | **Fulfillment proceeds** — overwrites to paid active (P1-001) |

---

## 10. TEST RESULTS

| Command | Result |
|---------|--------|
| `npm run build` | **PASS** — `Built to dist/ with SITE_URL = https://www.amarewellness.com` |
| `node scripts/qa-event-offer-schedule.mjs` | **PASS** — schedule parsing, cleaning cents, `validateEventReservationInput`, fulfill mock, email summary, client string checks |

**No dedicated automated tests** for: double charge, webhook replay, blob races, admin auth, environment isolation, state machine matrix, legacy records.

**Event-related test gap:** `package.json` has no `test:private-events` script; only `scripts/qa-event-offer-schedule.mjs` (manual/CI-invoked).

**Shared webhook isolation:** `stripe-webhook.mjs` routes `isEventDepositSession` **before** opening order/subscription stores (~L2152–2204) — private events isolated from class/membership fulfillment paths.

---

## 11. MISSING TESTS

Required before production (none currently automated):

1. Concurrent `/charge-remaining` (expect single Stripe charge)
2. Duplicate webhook delivery (expect single financial transition)
3. Cancel + webhook race
4. Deposit balance-now amount parity ($549 scenario) end-to-end
5. Edit-after-link stale UI vs Stripe amount
6. Unauthorized admin API (401)
7. Preview context cannot write prod blobs (after fix)
8. Legacy reservation missing `cleaningCents`, `remainingPaid`, `offerId`
9. Card decline / `requires_action` off-session
10. Delete + webhook retry reconciliation
11. `findByOfferId` beyond scan cap
12. Saturday / room capacity server rejection without client JS

---

## 12. PRODUCTION GO/NO-GO CHECKLIST

| Gate | Status |
|------|--------|
| Server-side pricing authority | **PASS** |
| Deposit checkout idempotency | **PASS** |
| Remaining charge idempotency | **FAIL** |
| Overtime/custom duplicate protection | **FAIL** |
| Webhook signature verification | **PASS** |
| Webhook financial dedupe | **FAIL** |
| Blob CAS for reservation updates | **PASS** |
| Blob environment isolation | **FAIL** |
| Admin API auth on all money endpoints | **PASS** |
| Admin auth strength | **FAIL** |
| Paid state not from success URL alone | **PASS** |
| Cancel/delete financial safety | **PARTIAL** |
| Edit-after-link policy documented & consistent | **PARTIAL** |
| Email failure doesn't roll back payment | **PASS** |
| Observability / reconciliation fields | **PASS** (logs include reservationId, sessionId, invoiceId) |
| Automated regression suite | **FAIL** |
| Phase 3 auto day-before charge | **NOT VERIFIED** (excluded — not implemented) |
| `ENABLE_STRIPE_EVENT_DEPOSIT` prod flag | **NOT VERIFIED** (ops/env) |

---

## 13. MINIMAL FIX PLAN

*(Do not implement in this audit.)*

### Fix P0-001 — Atomic remaining charge

| Item | Detail |
|------|--------|
| Root cause | Read-check-write outside Stripe; random idempotency keys |
| Smallest safe change | In `/charge-remaining`, use `store.patch` mutator to atomically set `remainingChargeInFlight` or flip `remainingPaid` **only after** Stripe success; use stable idempotency key `evt-remaining-${reservationId}`. Better: claim flag in CAS patch **before** Stripe, clear on failure. |
| Files | `event-reservations-admin.mjs`, possibly `event-reservation-store.mjs` |
| Regression risk | Medium — must not block legitimate retry after failure |
| Tests | Concurrent POST integration test |

### Fix P0-002 — Blob environment isolation

| Item | Detail |
|------|--------|
| Root cause | Site-wide `getStore()` names |
| Smallest safe change | Adopt `getDeployStore()` or `-qa` suffix pattern (see `stripe-order-store.mjs`); block admin money routes when `CONTEXT !== 'production'` unless explicit override env. |
| Files | `event-reservation-store.mjs`, `event-offer-store.mjs`, `event-reservations-admin.mjs` |
| Regression risk | Medium — local dev must keep file fallback |
| Tests | `qa-event-preview-isolation` script mirroring identity QA |

### Fix P1-001 — Cancel vs fulfill

| Item | Detail |
|------|--------|
| Root cause | Fulfill ignores `canceled` |
| Smallest safe change | Early return noop/error in `fulfillEventDepositSession` if `rec.status === "canceled"` (define refund policy separately) |
| Files | `event-reservation-fulfill.mjs` |
| Tests | Race integration test |

### Fix P1-003 — Webhook dedupe

| Item | Detail |
|------|--------|
| Root cause | No processed event store for events |
| Smallest safe change | Record `evt.id` in reservation or small dedupe blob before side effects |
| Files | `stripe-webhook.mjs`, new helper or reservation field |
| Tests | Replay same evt.id twice |

---

## 14. FINAL ONE-LINE DECISION

**PRIVATE EVENTS PRODUCTION READINESS: BLOCKED — concurrent Charge remaining can double-charge; deploy previews share production Blob stores**

---

## Audit integrity

| Check | Result |
|-------|--------|
| Application source mutated during audit | **NO** (only this report file added) |
| Deploy / prod data / live charges | **NONE** |
| Baseline commit | `9ff6cc537cfff33d16238d20ba1b9dd3c8e236fa` |

---

## Appendix A — Flow map (code-derived)

```
Customer / Admin
    │
    ├─ GET /api/events/offer?o= ──► event-offer-public.mjs
    │       ├─ offer store.get
    │       ├─ reservation enrich / findByOfferId fallback
    │       └─ toPublicOffer (display)
    │
    ├─ POST /api/stripe/events/create-deposit ──► stripe-event-create-deposit.mjs
    │       ├─ validateEventReservationInput (authoritative $)
    │       ├─ reservation put/patch (deposit_pending)
    │       ├─ Stripe Checkout (idempotent key per evt id)
    │       └─ indexSession
    │
    ├─ Stripe webhook checkout.session.completed ──► stripe-webhook.mjs
    │       └─ fulfillEventDepositSession
    │               ├─ patch depositPaid / remainingPaid / PM
    │               ├─ emails (after patch)
    │               └─ offer put used
    │
    ├─ POST /api/admin/events/* ──► event-reservations-admin.mjs (adminAuthorized)
    │       ├─ confirm / cancel / update / delete / reschedule
    │       └─ charge-remaining | charge-overtime | charge-custom
    │               └─ chargeSavedEventCard (Stripe invoice)
    │
    └─ Admin UI / event-reserve.js (display; POST without amounts)
```

**Paid-state authority:** Stripe webhook `fulfillEventDepositSession` or admin `chargeSavedEventCard` success + patch. Never URL params alone.

---

## Appendix B — Part 11 manual deposit example ($549)

| Layer | $550 pkg + $150 styling + $49 cleaning − $200 deposit |
|-------|------------------------------------------------------|
| Server formula | `validateEventReservationInput`: 55000+15000+4900−20000 = **57525** remaining |
| QA script | `scripts/qa-event-offer-schedule.mjs` asserts 57525 with cleaning 7525 |
| Balance-now Stripe | `balanceDueCents = existing.remainingCents` |
| Email | `eventEmailSummary` uses stored `rec.*` cents |

*(User example used $49 cleaning = 4900 cents → remaining $575.25; verify admin entered $49 not $75.25 in QA script.)*

---

## Appendix C — Git status proof

Recorded before audit: commit `9ff6cc537cfff33d16238d20ba1b9dd3c8e236fa`, working tree had pre-existing modifications to event files (not introduced by this audit).

After audit: only `docs/PRIVATE-EVENTS-PRODUCTION-AUDIT.md` added.
