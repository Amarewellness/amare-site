# Class booking — credits not consumed / Unpaid Visits (diagnosis)

**Status:** Open — compare prod vs local before deploy; post-book verify added as safety guard.  
**Last updated:** 2026-06-24 (SendEmail:false on staff fallback; success only after paymentVerified)

---

## Production vs local — what changed (git `HEAD` vs working tree)

Compared against committed `netlify/functions/mindbody-class-book.mjs` (what Netlify production runs today unless a newer deploy landed).

| Topic | **Production (HEAD)** | **Local (current target)** |
|-------|----------------------|----------------------------|
| **`showActiveOnly`** | `true` | **`false`** (monthly buckets visible; aligns with `/member/summary`) |
| **First book attempt** | Consumer, **no** `ClientServiceId` | **Same** |
| **`RequirePayment`** | **Never sent** | **Never sent** |
| **Consumer CS fallback** | When body CS null | Loops all `bookableIds` |
| **Staff fallback** | On payment error + **`tryBookWith(staff, undefined)`** | With `ClientServiceId` only; **`SendEmail: false`** until verify |
| **Preflight 402** | None | Yes — only when no bookable credits |
| **Success criteria** | HTTP 200 only | **200 only after `paymentVerified: true`** |
| **Misleading email** | Staff 200 sends Mindbody email even if Unpaid | **Staff path: no email until verify passes**; rollback on fail |
| **Packages UI on fail** | From Mindbody message | **Only when no credits** — not when 5/5 exists |

### Audit production logs

```bash
netlify logs:function mindbody-class-book --site <site-id> | node scripts/audit-production-class-book-logs.mjs
```

For each successful monthly book in production, check:

| Log field | Healthy monthly book | snir5 regression |
|-----------|---------------------|------------------|
| `attemptedStaffPaymentFallback` | **`false`** (ideal) | **`true`** |
| `class_book_addclienttoclass_attempt` | `authMode: consumer`, `sendEmail: true` | consumer fails → staff `sendEmail: false` |
| Mindbody Manager | Remaining 5→4, no Unpaid | 5/5 unchanged or Unpaid |

**Open question:** Does production succeed on **consumer without staff**, or does it rely on staff fallback and silently create Unpaid Visits? Production has **no post-book verify**, so staff 200 may look “successful” while credits never drop.

### Why snir5 broke on local but may work on production

Production sequence for monthly member (no `clientServiceId` in POST body):

```text
1. POST addclienttoclass  consumer  ClientServiceId: (omitted)  RequirePayment: (omitted)
2. If fail → consumer loops GET clientservices (showActiveOnly:true may miss monthly — separate issue)
3. If payment error → staff with ids, then staff WITHOUT ClientServiceId  ← Unpaid risk
```

Local Phase 1.2 sequence (regression):

```text
1. POST addclienttoclass  consumer  ClientServiceId: 9800  RequirePayment: true  → payment error
2. POST addclienttoclass  staff     ClientServiceId: 9800  RequirePayment: true  → HTTP 200, Unpaid Visit
```

**Hypothesis:** Production paid path is **consumer auto-pay** (step 1 without `ClientServiceId`), not staff fallback. Local forced `ClientServiceId` on first try, pushed into staff fallback, which does not consume monthly credits.

**Verify on production:** grep logs for `class_book_staff_payment_fallback` on a successful monthly book — should be **`false`**.

---

## Executive summary

Manual QA on **snir5@pic-smart.com** (monthly member, **AMARÉ Monthly 5 Classes**, `ClientServiceId` **9800**, `ProductId` **100133**) shows:

| Layer | What happens |
|-------|----------------|
| **Frontend** | `book_block_variant: none`, wallet **5/5**, Confirm booking allowed — **correct given wallet data** |
| **Consumer API** | First `addclienttoclass` with `ClientServiceId: 9800` **fails** (payment required) |
| **Staff fallback** | Second `addclienttoclass` with staff token returns **`ok: true`, HTTP 200**, `visitId` returned |
| **Mindbody Manager** | Visit appears under **Unpaid Visits** → **Service category: Unpaid Group Classes** |
| **Wallet after book + refresh** | Still **5/5** — credits were **never deducted** |

**This is not a cookie/session bug.** Session flags are healthy (`linkStatus: ready`, `consumerAssociated: true`, `bookingAllowed: true`). The failure is **how Mindbody applies (or ignores) payment** on the staff retry path.

### Misleading Mindbody email (visit 12729 — fixed)

Staff `addclienttoclass` with `SendEmail: true` sent **"You're booked"** before post-book verify; verify failed → rollback removed the visit, but the email could not be recalled.

**Fix:** staff fallback now uses **`SendEmail: false`**. HTTP 200 is only returned to the browser after **`paymentVerified: true`**. Failed verify → rollback → **402** (no "You're booked" in UI).

**Deploy gate (snir5):** 5/5 → Book → **4/5**, no Unpaid Visit, **no confirmation email** on failed verify.

---

## Repro account — snir5 (2026-06-24)

| Field | Value |
|-------|--------|
| Email | `snir5@pic-smart.com` |
| Mindbody `clientId` | `100002726` |
| Entitlement | `AMARÉ Monthly 5 Classes` (`monthly_5`, product **100133**) |
| Active `ClientServiceId` | **9800** (5 remaining) |
| OAuth | `consumerAssociated: true`, `bookingAllowed: true`, phone on file |

### Log sequence (class **13631**, visit **12728**)

```text
class_book_request                    classId: 13631, clientServiceIdProvided: null
class_book_resolved_client            clientId: 100002726
class_book_staff_payment_fallback_start   serviceIds: [9800], consumerTriedServiceIds: [9800]
class_book_staff_payment_fallback_ok      clientServiceId: 9800
class_book_response                   ok: true, visitIdReturned: 12728, attemptedStaffPaymentFallback: true
```

**Interpretation:**

1. Consumer already tried **9800** and failed (payment error — not logged explicitly today; inferred from fallback).
2. Staff retry with the **same** `ClientServiceId` returned **success**.
3. No `class_book_unpaid_visit_detected` in logs → post-book validation did **not** flag the response (see § Detection gap).
4. Frontend called `refreshWalletFromMemberSummary()` but Mindbody still reports **5/5** because the visit is **unpaid**, not paid from the monthly bucket.

Earlier repro on class **14186** / visit **12726** showed the same pattern.

---

## What Mindbody’s Public API says (developer docs)

Sources: [Public API v6 — Class API](https://www.rubydoc.info/gems/mindbody-api-v6/1.0.0/SwaggerClient/ClassApi), [AddClientToClassRequest](https://www.rubydoc.info/gems/mindbody-api-v6/1.0.0/SwaggerClient/AddClientToClassRequest), [Tutorial — Book a client into a class](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/tutorials/book-a-client-into-a-class), internal [`MINDBODY.md`](MINDBODY.md).

### Endpoint

`POST /public/v6/class/addclienttoclass`

### Auth modes (critical)

| Mode | Headers | Typical use at AMARÉ |
|------|---------|----------------------|
| **Consumer (Identity)** | `Authorization: Bearer` (OAuth access token) + `API-Key` + `SiteId` | Member self-serve book on `/classes` — **intended** path |
| **Staff / Business** | Staff **User Token** (Bearer) or legacy `SourceCredentials` + `UserCredentials` | Webhook sync, Bring-a-Friend guest book, staff ops |

Mindbody docs and community notes: **Consumer mode** enforces payment rules strictly. **Staff/Business mode** can complete a booking **without** consuming a pricing option when payment is not required — creating an **Unpaid Visit** roster row.

### Request fields that matter

| Field | Meaning |
|-------|---------|
| `ClientId` | Studio client to book |
| `ClassId` | Class instance |
| `ClientServiceId` | ID of the **purchased pricing option** (from `GET client/clientservices`) to pay for this visit |
| `RequirePayment` | When **`true`**, client must have an active usable pricing option. When **`false` or omitted`**, booking can complete **without** applying a pricing option → **Unpaid Visit** |
| `CrossRegionalBooking` | Cross-site pricing option lookup (not used today) |

**Key doc sentence:** `ClientServiceId` is *“the pricing option … you want to use to pay for this booking, **if payment is required at the time of the update**.”*

So sending `ClientServiceId` **alone** is not enough if `RequirePayment` is false/omitted in staff mode — Mindbody may still book unpaid.

### Intended booking workflow (Mindbody tutorial)

For an **existing** pricing option on the client account:

```text
GET client/clientservices  →  pick ClientServiceId
POST class/addclienttoclass  →  ClientId + ClassId + ClientServiceId (+ RequirePayment as appropriate)
```

For a **new** purchase at book time, Mindbody steers integrators to **`POST sale/checkoutshoppingcart`** instead of bare `addclienttoclass`.

### Consumer Identity vs Studio Client (AMARÉ model)

From [`MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md`](MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md):

- **Studio Client + credits** ≠ **Consumer authorized to book**
- snir5 passes **both** — association is not the issue here
- This incident is **payment application**, not `DeniedAccess` / `studio_not_linked`

---

## How our flow differs from “healthy” pack booking

### Flow A — works (e.g. snir26 **first** book, comp class)

```text
Consumer addclienttoclass + ClientServiceId  →  ok:true  →  Remaining decreases  →  wallet updates
```

No staff fallback. Visit paid from package.

### Flow B — broken (snir5 monthly, snir26 **second** book historically)

```text
Consumer addclienttoclass + ClientServiceId  →  FAIL (ClassRequiresPayment / no available payments)
Staff addclienttoclass + ClientServiceId     →  ok:true BUT Unpaid Visit in Manager
Wallet unchanged. UI shows "You're booked".
```

### Flow C — broken (snir30, zero credits — pre–Phase 1.2)

```text
Staff addclienttoclass WITHOUT ClientServiceId  →  ok:true, Unpaid Visit
```

Phase 1.2 removed the explicit `tryBookWith(staffHeaders, undefined)` path but **staff retry after consumer payment failure** can still produce the same **business outcome** if Mindbody ignores payment on staff success.

---

## Timeline of code changes (why behavior shifted)

| Phase | Backend behavior | snir5 effect |
|-------|------------------|--------------|
| **Pre–1.2** | Consumer try → staff fallback → **`tryBookWith(staff, undefined)`** if still failing | Unpaid when no service; with service, staff **might** still unpaid |
| **1.2 preflight** | Block when `bookableIds.length === 0` | snir5 passes (has 9800) |
| **1.2 staff retry fix** | Retry same `ClientServiceId` on staff after consumer payment fail | Booking **appears** to succeed (200) — **Unpaid Visit** |
| **1.2 + RequirePayment** (in repo) | `RequirePayment: true` on all `tryBookWith`; unpaid response scan + rollback | **Not verified in latest logs** — see below |

---

## Why wallet stays 5/5 (frontend is not broken)

1. **`/api/mindbody/member/summary`** reads `GET client/clientservices` — **Remaining** only drops when Mindbody **deducts** from the pricing option.
2. Unpaid roster visits **do not** consume `ClientServiceId` **9800**.
3. `refreshWalletFromMemberSummary()` after book is working — it correctly shows Mindbody’s truth (still 5/5).
4. Local enrollment UI may flip to **Cancel** because we got a `visitId` — that reflects **roster membership**, not **paid** status.

**Past “instant wallet update”** on `/classes` happened when **consumer book paid from a pack** (Flow A). Monthly members hitting staff fallback (Flow B) never had a working credit decrement in this integration.

---

## Detection gap (why `class_book_unpaid_visit_detected` did not fire)

Current guard in `mindbody-class-book.mjs` scans **`addclienttoclass` response body** for visit rows whose name/category contains `"unpaid"`.

**Observed:** Mindbody returns HTTP **200** + `visitId` but the **JSON body may not label** the visit “Unpaid Group Classes” — that label appears only in **Mindbody Manager** (Account Details → Unpaid Visits).

**Result:** False negative → we return `ok: true` to the browser.

**Required hardening (not yet shipped):**

1. After book, **`GET client/clientvisits`** for the new `visitId` and check payment / service category fields.
2. Or compare **`clientservices` Remaining** before vs after book.
3. Or reject any **`attemptedStaffPaymentFallback: true`** success for members where **`consumerIds.length > 0`** until consumer path is fixed.

---

## Hypothesis — why consumer fails for monthly 5 but wallet shows credits

Not proven with Mindbody support ticket yet; ranked by likelihood:

| # | Hypothesis | Notes |
|---|------------|-------|
| H1 | **Staff success without payment** even with `ClientServiceId` when `RequirePayment` was omitted (fixed in repo, needs retest after server restart) | Matches Manager “Unpaid Group Classes” |
| H2 | **Consumer token cannot apply recurring membership visit buckets** the same way as drop-in/pack `ClientServiceId` — returns `ClassRequiresPayment` despite visible Remaining | Needs Mindbody confirmation |
| H3 | **Service category mismatch** — class type not covered by product **100133** for consumer API (staff still adds to roster unpaid) | Check class description vs membership service categories in Manager |
| H4 | Wrong **`ClientServiceId`** selected (only one row today — less likely for snir5) | `9800` matches wallet row |

---

## Comparison table — Mindbody doc vs AMARÉ implementation

| Topic | Mindbody documented intent | AMARÉ today (`mindbody-class-book.mjs`) | Gap |
|-------|---------------------------|----------------------------------------|-----|
| Pay with existing option | `ClientServiceId` + payment required | Sends `ClientServiceId`; **`RequirePayment: true` added in repo** | Must confirm deployed + MB honors on staff token |
| Consumer self-serve | Consumer Bearer on `addclienttoclass` | First attempt uses consumer headers | Fails for snir5 monthly |
| Staff book | Business mode; can book unpaid if payment not required | Staff fallback after consumer payment error | **Created Unpaid Visits** in QA |
| Success criteria | Pricing option Remaining decreases | We treat HTTP 200 + `visitId` as success | **Too weak** — must verify payment |
| No credits | Should fail / prompt purchase | Phase 1.2 frontend blocks at Confirm when wallet 0 | OK for zero-credit; **not** OK for “has credits but unpaid book” |

---

## Recommended product rules (until fixed)

1. **Do not treat `class_book_staff_payment_fallback_ok` as production success** for members with **`consumerIds.length > 0`** unless post-book payment is verified.
2. **Cancel test visits** in Mindbody Manager for snir5: visits **12726**, **12728** (and any other QA unpaid rows).
3. **Retest after dev server restart** with latest `mindbody-class-book.mjs` (RequirePayment + rollback).
4. If consumer still fails for monthly members: **escalate to Mindbody API support** with `clientId`, `ClientServiceId`, `classId`, consumer error body, and staff success body.
5. **Do not deploy** wide Book API for monthly SKUs until **C5-style QA** passes: book → **4/5** wallet → **no** Unpaid Visit row.

---

## QA matrix (addition to Phase 1.2)

| ID | Account | Action | Expected | snir5 2026-06-24 |
|----|---------|--------|----------|------------------|
| **C5** | Monthly member, credits | Confirm book | Paid visit; wallet **−1**; no Unpaid row | **FAIL** — 5/5, Unpaid Visit |
| **C6** | Pack / comp (snir26 1st) | Confirm book | Paid visit; wallet updates | PASS (historical) |
| **C7** | Monthly member | Book API response | Must **not** return `ok:true` if visit unpaid | **FAIL** — returns 200 |
| **C8** | Any | Staff fallback | Never `ClientServiceId: undefined` | PASS (Phase 1.2) |

---

## Log events to grep

| Event | Meaning |
|-------|---------|
| `class_book_staff_payment_fallback_start` | Consumer payment failed; trying staff + `bookableIds` |
| `class_book_staff_payment_fallback_ok` | Staff HTTP success — **verify payment in Manager** |
| `class_book_unpaid_visit_detected` | Response scan caught unpaid (may not trigger — see gap) |
| `class_book_unpaid_visit_rollback` | Auto-cancel attempted |
| `class_book_consumer_payment_failed` | Blocked staff retry (staff-only path variant) |
| `class_book_no_bookable_credits` | Preflight 402 |

---

## Related code

| File | Role |
|------|------|
| `netlify/functions/mindbody-class-book.mjs` | Book API, consumer/staff attempts, RequirePayment, unpaid guard |
| `netlify/functions/mindbody-member-summary.mjs` | Wallet / `clientservices` merge (staff + consumer) |
| `src/js/classes-schedule.js` | Book block, Confirm, `refreshWalletFromMemberSummary` |
| `src/js/mindbody-wallet-widget.js` | Punch card UI (Remaining / total) |

---

## Immediate cleanup (manual)

For **snir5@pic-smart.com** in Mindbody Manager:

1. Open client **100002726** → **Unpaid Visits** (or class roster).
2. Remove / resolve unpaid visits from QA (**12726**, **12728**, etc.).
3. Confirm **AMARÉ Monthly 5 Classes** still shows **5/5** (or expected count after cleanup).

---

*Next engineering step: post-book payment verification via `clientvisits` + block staff-fallback success unless Remaining decreases or visit carries a non-unpaid payment reference.*
