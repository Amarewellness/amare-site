# NCS Follow-up Automation — Design & Decisions Log

> **Status:** planning — analysis complete, **no code written yet**.
> Pending answers on 6 open questions before implementation begins.
>
> See also: `docs/STRIPE-MINDBODY-QUESTIONS.md` (existing Stripe → Mindbody flow),
> `docs/MINDBODY-CHECKOUT-OVERVIEW.md` (Mindbody catalog & sale model),
> `.env.example` (env-var registry).

---

## 1. Goal

For clients who purchased the **New Client Special** (NCS) through our own
Stripe checkout, automatically check their remaining credits in Mindbody.
When `remainingCredits === 1`, create a unique Stripe Promotion Code and
email it to the client to encourage conversion to a regular package.

**Why now:** Stripe coupons + Mindbody `DiscountAmount` sync are now verified
end-to-end (see `docs/STRIPE-MINDBODY-QUESTIONS.md` Q-on-Promotion-Codes), so
we have a working discount engine. This feature is the first **outbound**
automation that uses it.

## 2. Architecture pillars

| System | Role |
|---|---|
| Mindbody | **Source of truth** for remaining credits per client / service |
| Stripe | Discount engine (Coupons + Promotion Codes) — also the existing checkout for the resulting package purchase |
| Netlify Blobs | Idempotency layer (separate store from `stripe-mindbody-orders`) |
| Resend | Transactional email delivery (new dependency — no email infra exists today) |
| Netlify scheduled function | Daily trigger (cron) |

## 3. Version 1 scope

| In | Out (deferred) |
|---|---|
| Clients who bought NCS through our Stripe checkout | Clients who bought NCS off-Stripe (Mindbody walk-in, classic POS) |
| Trigger: `remainingCredits === 1` | Trigger: expiring soon, post-completion, win-back |
| Single base Stripe Coupon (env-configured) | Per-client custom coupons |
| Reusable promo with `max_redemptions: 1` + 14-day expiry | Stripe-customer-restricted codes |
| English email | Localization |
| Idempotency: `mindbodyClientId + triggerType + ncsServiceId` | Cross-channel suppression (e.g., already got SMS) |
| Dry-run mode default | Auto-rollout to live |

## 4. Codebase fit — what already exists

### 4.1 Order store — ✅ ready
`netlify/functions/stripe-order-store.mjs` exposes `listByStatus(status, opts)`
which paginates Netlify Blobs:

```339:368:netlify/functions/stripe-order-store.mjs
  async function listByStatus(status, opts) {
    if (!stores) return [];
    if (!isValidOrderStatus(status)) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 500);
    /** @type {OrderRecord[]} */
    const out = [];
    /** Netlify Blobs `list({ paginate: true })` returns an async iterable of pages. */
    const pages = stores.orders.list({ paginate: true });
    let scanned = 0;
    const SCAN_CAP = 5000;
```

**Caveat:** scan cap is 5000 records, max page is 500. Fine at AMARÉ scale for
years; revisit if order volume grows. Could later be optimized with a SKU
secondary index.

### 4.2 Mindbody `Remaining` field — ✅ confirmed
Pattern already used in `netlify/functions/mindbody-class-book.mjs`:

```37:43:netlify/functions/mindbody-class-book.mjs
  for (const raw of arr) {
    const s = /** @type {Record<string, unknown>} */ (raw);
    const rem = s.Remaining ?? s.remaining;
    if (typeof rem === "number" && rem > 0) {
      const sid = s.Id ?? s.id;
      if (sid != null && Number.isFinite(Number(sid))) return Number(sid);
    }
  }
```

So `ClientServices[i].Remaining` is the right field. Mindbody also returns
`Active`, `ExpirationDate`, `Count` — we will need these too. Dry-run logging
will validate the exact shape before live rollout.

### 4.3 NCS service IDs — ✅ already in catalog
The catalog already maps the NCS SKU to its Mindbody service ID:

```12:13:netlify/functions/_embedded/stripe-mindbody-catalog.config.json
      "mindbodyItemType": "Service",
      "mindbodyServiceId": 100012,
```

**Decision:** treat `NCS_MINDBODY_SERVICE_IDS` env as an **optional override**.
When unset, derive the list from catalog entries with `kind === "newClient"`.
Single source of truth; the env exists only so ops can patch without a deploy.

### 4.4 Mindbody NCS history helper — ⚠️ exists but not directly reusable
`fetchClientNcsHistory` in `stripe-mindbody-sync-lib.mjs` matches by **keyword
on service name** (used today to *block* duplicate NCS purchases). For this
feature we need a **service-id-based lookup** that also returns
`Remaining`/`Active`/`ExpirationDate`.

**Decision:** add a new helper, e.g., `fetchClientServicesByIds(headers,
clientId, serviceIds[])` that returns the raw matching service rows. Keep the
existing keyword helper as-is — different concern.

### 4.5 Resend / transactional email — ❌ does not exist
Codebase search confirms only `sendNewClientPasswordSetupEmail` exists, which
calls Mindbody's `/client/sendpasswordresetemail` (Mindbody-driven, not
generic). No Resend / SendGrid / Mailgun integration yet.

**Decision:** call Resend's REST API directly with `fetch` (no new npm
dependency). Keeps dependency footprint minimal — current direct deps are only
`@netlify/blobs` and `stripe`.

### 4.6 Netlify scheduled functions — ❌ not in use today
Search confirms no `export const config = { schedule: ... }` anywhere. We will
introduce the first scheduled function with this feature. Pattern is simple:
add the export to a regular Netlify function file.

## 5. Gaps & risks identified

### 5.1 "Already converted" detection has a known false-positive class
The user's spec says: scan our orders to detect post-NCS conversion. **But
Mindbody-Classic memberships and contract-purchases do _not_ go through our
order store** — they go through `mindbody-sale-purchase-contract.mjs`, which
does not write to `stripe-mindbody-orders`.

**Implication:** a client who buys NCS via Stripe + monthly membership via
Mindbody Classic will _not_ appear in our orders → could receive a coupon
despite already being converted.

**Three options:**

| Option | Complexity | False-positive rate |
|---|---|---|
| A. Orders-only (per spec) | Low | Medium (depends on % of memberships sold via Classic) |
| B. Orders + Mindbody `clientpurchases` after NCS date | Medium | Low |
| C. Orders + `clientpurchases` + `activeclientmemberships` | High | Lowest |

**Recommendation:** start with **A** in dry-run, observe the first 5–10
candidates manually. Promote to B only if the dry-run shows false positives.

### 5.2 Missing `resolvedMindbodyClientId`
Some `mindbody_synced` orders may have a missing client id (data anomaly).
**Decision:** skip with reason `skipped_no_mindbody_client_id`.

### 5.3 Test-vs-Live order mixing
The order blob store contains both Stripe test and live orders (e.g., the
`Snir17` regression order from sandbox). Without filtering, a live cron run
could try to email a test client.

**Decision:** filter `stripeLivemode === true` in candidate selection.

### 5.4 Expired NCS at `Remaining === 1`
A client used 2/3 visits and the 21-day window passed. Their `Remaining` is
still 1 in Mindbody but the service is unusable. Should we email?

**Recommendation (pending Q1):** require `Active === true` AND
`ExpirationDate` in the future. Skip with reason `skipped_ncs_expired`
otherwise.

### 5.5 Promo race / duplicate creation
If we create a Stripe Promotion Code, then the blob `put` fails, the next run
might create another promo. Mitigation:

1. `put` uses an "only if new" semantic on the idempotency key.
2. Even if a stray promo gets orphaned in Stripe, `max_redemptions: 1` +
   `expires_at: 14d` bound the impact to "one unused expired code".

### 5.6 Email failure must NOT trigger code regeneration
Per the spec: if the email fails, the same saved code must be reused on the
next run. Implementation: persist the record with `emailStatus: "pending" |
"sending" | "sent" | "failed"`. The next run looks up the record by
idempotency key and if it finds `failed` (or `sending`, indicating a crash),
it re-sends with the existing `promotionCode` instead of creating a new one.

## 6. Proposed file structure

| File | Lines (est.) | Responsibility |
|---|---|---|
| `netlify/functions/email-client.mjs` | ~50 | Single function `sendEmail({to, from, subject, html, text, replyTo, idempotencyKey, tags})`. Wraps Resend REST. Returns `{ ok, messageId, error }`. |
| `netlify/functions/ncs-followup-store.mjs` | ~180 | Netlify Blobs adapter modeled on `stripe-order-store.mjs`. Store name: `ncs-followup-records`. Key: `v1/${mindbodyClientId}_${triggerType}_${ncsServiceId}`. Methods: `get`, `putIfNew`, `patch`, `listByEmailStatus`. |
| `netlify/functions/ncs-followup-lib.mjs` | ~200 | Pure helpers: `fetchClientServicesByIds`, `extractRemainingCredits`, `extractServiceExpiration`, `generatePromotionCode`, `buildFollowupEmailHtml`, `buildFollowupEmailText`, `findLaterNonNcsOrders`. |
| `netlify/functions/ncs-followup-scan.mjs` | ~250 | Handler + `export const config = { schedule: "..." }`. Pure orchestration, no business logic. Also routable as `/api/admin/ncs-followup/run-now` for manual dry-runs. |
| `netlify.toml` | +5 | Redirect for the manual run-now admin endpoint. |
| `.env.example` | +10 | Document the new env vars. |

## 7. End-to-end flow

```
ncs-followup-scan.handler()
  ├── 0. gate: ENABLE_NCS_FOLLOWUP_AUTOMATION === "1"  → else log + 200 OK
  ├── 1. resolveNcsServiceIds(env, catalog)            → number[]
  ├── 2. acquireStaffHeaders()                         → reuse staffHeadersForSync()
  ├── 3. orderStore.listByStatus("mindbody_synced", { limit: 500 })
  │       filter: catalog[localSku].kind === "newClient"
  │       filter: stripeLivemode === true
  │       filter: createdAt >= now - 35 days  (NCS = 21d valid + grace)
  │       filter: resolvedMindbodyClientId != null
  │
  ├── 4. for each candidate:
  │     ├── a. fetchClientServicesByIds(headers, clientId, ncsServiceIds)
  │     ├── b. extract { remaining, active, expirationDate, raw }
  │     │       in DRY-RUN: log raw object so we can verify field names
  │     ├── c. trigger checks (first-fail wins):
  │     │       • !active                              → skipped_ncs_inactive
  │     │       • expirationDate < now                 → skipped_ncs_expired
  │     │       • remaining !== TRIGGER_REMAINING (1)  → skipped_remaining_not_trigger
  │     ├── d. findLaterNonNcsOrders(...)              → skipped_already_converted_after_ncs
  │     ├── e. followupStore.get(idempotencyKey)
  │     │       • exists & emailStatus === "sent"      → skipped_already_sent
  │     │       • exists & emailStatus === "failed"    → retry-email branch (h)
  │     │       • not exists                           → continue to (f)
  │     ├── f. if NCS_FOLLOWUP_DRY_RUN === "1":
  │     │       log dry_run_would_send  (raw service object + planned promo metadata)
  │     │       continue (NO promo, NO email)
  │     ├── g. createStripePromotionCode()             → log stripe_promo_created
  │     │       followupStore.putIfNew(record)         → status: "pending"
  │     └── h. patch status: "sending"  →  emailClient.sendEmail(...)
  │             ok    → patch emailStatus="sent" + sentAt + messageId
  │                     → log email_sent
  │             fail  → patch emailStatus="failed" + errorMessage
  │                     → log email_failed (no promo recreate next run)
  │
  └── 5. summary log: { scanned, eligible, skipped: {by_reason}, sent, failed }
```

## 8. Stripe Promotion Code generator

```js
function generateFollowupCode() {
  // Excludes 0/O/I/1/L to avoid customer typing confusion.
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `AMARE-NEXT-${random}`;
}
```

6 chars over a 30-letter alphabet ≈ 729M combinations → collision probability
trivial at AMARÉ scale.

**Promotion Code parameters:**

| Field | Value |
|---|---|
| `coupon` | `process.env.NCS_FOLLOWUP_COUPON_ID` (single shared base coupon) |
| `code` | `AMARE-NEXT-XXXXXX` (generated) |
| `max_redemptions` | `1` |
| `expires_at` | `now + NCS_FOLLOWUP_CODE_EXPIRY_DAYS * 86400` |
| `metadata` | `{ source: "ncs_followup", triggerType: "last_credit", mindbodyClientId, email, localSku }` |
| `customer` | **NOT set in V1** (no Stripe-customer restriction) |

## 9. Idempotency record schema

```ts
{
  // Identity (idempotency key components)
  mindbodyClientId: number,
  triggerType: "last_credit",      // V1 only
  ncsServiceId: number,

  // Targeting
  email: string,                    // lowercased
  firstName: string,

  // Snapshot at decision time
  remainingCreditsAtTrigger: number,
  ncsExpirationDate: string | null,

  // Stripe artifacts
  stripePromotionCodeId: string,    // promo_xxx
  promotionCode: string,            // AMARE-NEXT-XXXXXX
  couponId: string,                 // coupon_xxx (denormalized from env)
  expiresAt: string,                // ISO8601

  // Lifecycle
  emailStatus: "pending" | "sending" | "sent" | "failed",
  emailMessageId: string | null,    // Resend message id when sent
  emailError: string | null,
  emailAttempts: number,
  createdAt: string,
  sentAt: string | null,
  lastAttemptAt: string,
}
```

## 10. Email template (V1 — `last_credit`)

**Subject:**

```
Your intro special is almost over 🤍
```

**Body (HTML + plaintext):**

```
Hi {{firstName}},

You're almost done with your New Client Special — and we'd love to keep you
moving with us.

Here's a little next-step gift from us:

Use code {{promoCode}} for {{discountText}} off your next package.

Your code is valid for {{expiryDays}} days and can be used toward any regular
class package.

Continue here:
{{checkoutLink}}

Can't wait to see you back in the studio 🤍
AMARÉ Wellness Studio
```

Compliance footer: studio physical address + `reply_to` set via env. Resend's
default unsubscribe handling per Resend dashboard config.

## 11. Logging events (structured JSON)

```
candidate_found
skipped_no_mindbody_client_id
skipped_no_matching_ncs_service
skipped_ncs_inactive
skipped_ncs_expired
skipped_remaining_not_trigger
skipped_already_converted_after_ncs
skipped_already_sent
dry_run_would_send
stripe_promo_created
email_sent
email_failed
ncs_followup_run_summary    // { scanned, eligible, skipped: { ... }, sent, failed, durationMs }
```

Each event is a single `console.log(JSON.stringify(...))` so Netlify log
search works the same way it does for `stripe_order_synced_to_mindbody`.

## 12. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ENABLE_NCS_FOLLOWUP_AUTOMATION` | `0` | Master kill-switch. **Off by default.** |
| `NCS_FOLLOWUP_DRY_RUN` | `1` | Default ON. No promo created, no email sent — log only. |
| `NCS_MINDBODY_SERVICE_IDS` | _(unset)_ | Optional comma-separated override. Defaults to catalog items with `kind === "newClient"`. |
| `NCS_FOLLOWUP_COUPON_ID` | _(required when DRY_RUN=0)_ | Stripe Coupon id reused by every generated promo. |
| `NCS_FOLLOWUP_CODE_EXPIRY_DAYS` | `14` | Promo `expires_at` window. |
| `NCS_FOLLOWUP_DISCOUNT_TEXT` | `"$20 off"` | Human-facing discount label rendered in the email. |
| `NCS_FOLLOWUP_TRIGGER_REMAINING` | `1` | Numeric trigger value. Future expansion. |
| `NCS_FOLLOWUP_CHECKOUT_URL` | `https://amarestudio.com/pricing` | CTA link in the email. |
| `NCS_FOLLOWUP_MAX_PER_RUN` | `5` (suggested for early rollout) | Hard cap to prevent runaway sends. Remove or raise after stage 4. |
| `RESEND_API_KEY` | _(required when DRY_RUN=0)_ | Resend bearer token. |
| `EMAIL_FROM` | `"AMARÉ Wellness Studio <hello@amarestudio.com>"` | RFC-5322 from-line. |
| `NCS_FOLLOWUP_REPLY_TO` | `hello@amarestudio.com` | Reply-to for staff visibility. |

## 13. Phased rollout

| Stage | Duration | Settings | Goal |
|---|---|---|---|
| 0. Implementation | ~1 day of work | code merged with `ENABLE=0` | safe ship to prod |
| 1. Dry-run | 3–7 days | `ENABLE=1, DRY_RUN=1` | confirm Mindbody field shape via logs; eyeball candidates |
| 2. Manual verification | 1 day | call `/api/admin/ncs-followup/run-now` | validate first 3 candidates by hand against Mindbody UI |
| 3. Live limited | ~1 week | `DRY_RUN=0, MAX_PER_RUN=5` | watch for delivery / formatting / customer reply issues |
| 4. Live full | ongoing | `MAX_PER_RUN` lifted | normal operation |

## 14. Open questions — must answer before coding

1. **Expired NCS handling.** Client used 2/3 and the 21-day window passed:
   send the coupon anyway, or skip? _(Recommendation: skip with
   `skipped_ncs_expired` — coupon for a finished journey is low-conversion.)_

2. **Resend domain readiness.** Is `hello@amarestudio.com` already verified in
   Resend with DKIM + SPF? **Operational prerequisite — must precede live
   stage.**

3. **Cron schedule.** Daily — at what UTC hour? _(Recommendation: 14:00 UTC =
   09:00 EST.)_

4. **Stripe environment for cron.** Will the scheduled function run with
   `sk_live_…` or `sk_test_…`? _(Recommendation: live only — sandbox dry-run
   should not produce real codes.)_

5. **Stripe Coupon identity.** Reuse the existing `AMARE20` coupon, or create
   a dedicated `NCS_FOLLOWUP_BASE` coupon? _(Recommendation: dedicated coupon
   — cleaner reporting in Stripe Dashboard.)_

6. **Email language.** Spec is English. Confirm we stay English-only for V1.

## 15. Out of scope (future versions)

- Multiple trigger types (`expiring_soon`, `post_completion`, `win_back_30d`).
- Cross-channel suppression (SMS, push).
- Per-client custom coupon amounts.
- Stripe-customer-restricted promotion codes.
- Localization.
- A/B testing of subject lines / discount amounts.
- Direct Mindbody-side already-converted detection (`activeclientmemberships`
  + `clientpurchases`).
- Webhook-driven trigger ("when Remaining drops to 1") instead of polling —
  Mindbody public API does not currently emit such an event.

---

**Last updated:** 2026-05-14 (planning phase).
**Owner:** Engineering — ping before resuming implementation so the open
questions in §14 can be unblocked first.
