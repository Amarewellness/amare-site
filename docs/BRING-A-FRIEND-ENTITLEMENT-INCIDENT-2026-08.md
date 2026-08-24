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

- [ ] Unauthenticated `GET /api/mindbody/member/bring-a-friend/status` → **401** `not_authenticated` (not 500)
- [ ] `100002726` status (logged in) → `eligible: true`
- [ ] `100003627` Tanya status → `eligible: true` (pack tier)
- [ ] `100003514` Karina status → `eligible: true`
- [ ] `100003442` Briana status → `eligible: true`
- [ ] Tanya `/classes`: if 0 upcoming booked classes, CTA hidden — **expected**
- [ ] Drop-in / intro-only members remain `tier_not_eligible`

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
