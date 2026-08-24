# Bring a Friend entitlement incident — August 2026

**Fix commit:** `f40dedf` — restore monthly entitlement fallbacks in `guest-pass-lib.mjs`  
**Deploy scope:** `netlify/functions/guest-pass-lib.mjs`, `scripts/qa-monthly-membership-entitlement.mjs` only  
**Out of scope:** auth, OTP, Bearer, CORS, OAuth, mobile, session, env

---

## 1. What `f40dedf` fixes

A **partial entitlement gap** introduced in `4465875` (`monthlyMembershipWindowActive` required both `ActiveDate` and `ExpirationDate`).

**Still required when both dates exist:** studio calendar window (unchanged).

**Restored fallbacks when `ActiveDate` is absent** (only for rows that already map to a BAF monthly SKU via product ID or name):

| Source | Fallback |
|--------|----------|
| ActiveClientMemberships | `Active=true` + unexpired `ExpirationDate` |
| ClientServices (monthly) | `Remaining > 0` + unexpired `ExpirationDate` |

**Not expanded:** intro offers, drop-ins, NCS, guest-pass rows, or other non-monthly SKUs. Flexible 10/20 packs use the existing pack path unchanged.

---

## 2. What this is not

- **Not a global BAF outage.** Production invite confirmed for Monthly 8 member `100002726` (`snir5@pic-smart.com`) before and independent of this fix.
- **Not an auth/OTP regression.** `200 { eligible: false, error: "tier_not_eligible" }` means session resolution succeeded; failure is inside `resolveGuestPassEntitlement()`.
- **Not confirmed for all customer reports.** See §3.

---

## 3. Reported customers — not current ActiveDate-regression examples

Staff-token Mindbody probe on **2026-08-25** (pre-deploy baseline; entitlement logic unchanged by auth path):

| Client | Name | Actual plan (Mindbody) | Entitled today? | ActiveDate on match? | ActiveDate bug? |
|--------|------|------------------------|-----------------|----------------------|-----------------|
| 100002726 | Snir (working) | Monthly 8 | Yes | Yes | No — reference |
| 100003627 | Tanya Cohen | **10-pack** (not monthly) | Yes (`pack_10_classes`) | Yes | **No** |
| 100003514 | Karina Vargas | Monthly 8 | Yes | Yes | **No** |
| 100003442 | Briana Morales | Monthly Unlimited | Yes | Yes | **No** |

**Do not cite Tanya, Karina, or Briana as confirmed ActiveDate-regression cases.** Their current Mindbody rows all match on production logic (full date windows or pack path).

### Likely reasons they reported issues

1. **Plan timing / sync** — entitlement start (`ActiveDate` or pack purchase) later than studio “joined” date; correctly ineligible before sync.
2. **No upcoming booked class** — BAF requires member booked + ≥2 open spots; `/classes` CTA hidden even when `eligible: true` (see Tanya below).
3. **Session / client mismatch** — if still seeing `tier_not_eligible` while logged in, investigate cookie/`clientId` resolution separately (not this entitlement fix).

### Tanya Cohen — UI note (expected, not a bug)

- `GET /api/mindbody/member/bring-a-friend/status` may return `eligible: true`, `status: "available"`.
- **`/classes` invite CTA stays hidden** when `upcomingBookedClasses.length === 0` (no self-booked class with ≥2 spots).
- At time of probe: 0 eligible upcoming classes → CTA hidden despite entitlement.

---

## 4. Working reference (100002726)

- **Match:** `consumer_clientservices`, ProductId `100134`, Monthly 8
- **Row:** `ActiveDate` + `ExpirationDate`, `Remaining: 7`
- **Why it works on production without fallback:** full date window present

---

## 5. Post-deploy verification checklist

**Deploy:** `f40dedf` + `4a3e5cd` (incident notes) pushed to `main` 2026-08-25.

| Check | Result |
|-------|--------|
| Unauthenticated BAF status → 401 not 500 | **PASS** — `401 {"ok":false,"error":"not_authenticated"}` |
| `100002726` entitlement (Monthly 8) | **PASS** — `eligible: true`, `monthly_8`, 2 upcoming classes |
| `100003627` Tanya entitlement | **PASS** — `eligible: true`, `pack_10_classes` |
| `100003514` Karina entitlement | **PASS** — `eligible: true`, `monthly_8`, 1 upcoming class |
| `100003442` Briana entitlement | **PASS** — `eligible: true`, `monthly_unlimited`, 5 upcoming classes |
| Tanya `/classes` CTA with 0 upcoming booked classes | **Expected hidden** — `shortCircuitReason: no_upcoming_classes`, 0 dropdown rows |
| Drop-in / intro-only remain ineligible | Unchanged (QA case M; intro row on Tanya has `monthlySku: null`) |

**Note:** Entitlement rows above use `guest-pass-diagnose-client.mjs` (same `resolveGuestPassEntitlement` as production status once `clientId` resolves). Authenticated browser `fetch(..., { credentials: "include" })` per member still recommended for session-path confirmation.

Staff-side entitlement probe (no member cookie):

```bash
node scripts/guest-pass-diagnose-client.mjs --client-id=100002726
node scripts/guest-pass-diagnose-client.mjs --client-id=100003627
node scripts/guest-pass-diagnose-client.mjs --client-id=100003514
node scripts/guest-pass-diagnose-client.mjs --client-id=100003442
```

Browser (member session):

```javascript
fetch("/api/mindbody/member/bring-a-friend/status", { credentials: "include" })
  .then(r => r.json())
  .then(console.log);
```

---

## 6. Guest reuse duplicate safety (not deployed)

**Scope:** `netlify/functions/mindbody-guest-client-lib.mjs` only — no entitlement, auth, CORS, mobile, or env changes.

**Problem:** When Mindbody `addclient` fails with a duplicate-like message, retry only re-searched email. If lookup missed an existing client and `addclient` returned 200 anyway, a second profile could be created and booked.

**Fix (local, pending deploy):**

- **A.** On duplicate `addclient` failure: re-run exact email lookup, then phone lookup; reuse only on exactly one match; `guest_lookup_ambiguous` on 2+.
- **B.** After `addclient` 200: re-search email (and phone when provided); block with `guest_lookup_ambiguous` when 2+ share email/phone or when the sole match is a different `clientId` than the create response.

**QA:** `node scripts/qa-guest-client-lookup.mjs` (mocked); `node scripts/qa-guest-client-lookup.mjs --live` for read-only duplicate probe.

**Known duplicate (staff cleanup required):** `snir1212@pic-smart.com` has clients `100003807` and `100003809` — lookup correctly returns `guest_lookup_ambiguous` until Mindbody duplicate is merged/deactivated.

**Pass slot on ambiguity:** BAF POST calls `failGuestPassSlot({ restore: true })` for `guest_lookup_ambiguous` before comp sale / class booking / `confirmGuestPassSlot`.

---

## 7. Early-cancel restore policy (Commit 1 — backend)

**Policy change (2026-08):**

| Cancel timing | BAF pass |
|---------------|----------|
| Early (>12h before class, class not started) | **Restored** — cap keys deleted, audit `guestPassAudit:restored_early_cancel:{guestBookingId}` |
| Late (within 12h) | **Consumed** — `confirmed_cancelled` (unchanged) |
| Class already passed | **Not restored** — `confirmed_cancelled` |
| Guest attended / cannot be removed safely | **Not restored** — `502 mindbody_guest_cancel_failed` |

**Implementation:** `restoreGuestPassSlotAfterEarlyCancel()` in `guest-pass-lib.mjs`; `mindbody-class-cancel.mjs` branches on `guestPassCancelTiming()`. Cancel response: `guestPassReturned: true|false`.

**QA:** `node scripts/qa-guest-pass-early-cancel-restore.mjs`

**Stuck `confirmed_cancelled` from old policy:** Early cancels under the prior MVP spec remain consumed until staff runs `resetGuestPassPeriodUsage()` for that member/period (after verifying guest visit is cancelled in Mindbody).
