# Mindbody Consumer ↔ Studio Link — Diagnosis & Support

Status: **Implemented** (OAuth callback ensure-client + association probe, session flags, booking guard, schedule UI).  
Related: [`MINDBODY-CHECKOUT-OVERVIEW.md`](MINDBODY-CHECKOUT-OVERVIEW.md), [`MINDBODY.md`](MINDBODY.md), [`URL-MAP.md`](URL-MAP.md).

---

## Problem summary

**A Mindbody Studio Client with credits is not enough for website booking.** The currently authenticated **Consumer Identity** must also be **associated with the AMARÉ studio**.

Symptoms that point here (not Stripe, not “class full”, not missing `clientId`):

- Member has **passes / purchases** in Mindbody Business Mode.
- **`/api/mindbody/class/book`** returns **401** with Mindbody message:  
  `Consumer identity authentication failed. Consumer not associated with studio.`  
  Code: **`DeniedAccess`**.
- Mindbody client profile may show **“Connect Mindbody Account”**.
- Netlify logs show **`class_book_resolved_client`** (site found `clientId`) immediately before **`class_book_response` `ok: false`**.

**This issue is not fixed by buying again.** A second Stripe purchase can add another sale and credit without linking Consumer ↔ studio (see Desiree case below).

---

## Key distinction

| Concept | What it is | How it is created at AMARÉ | What it enables |
|--------|------------|----------------------------|-----------------|
| **Studio Client** | Site-scoped client row (`clientId`, e.g. `100002835`) | Stripe webhook (`addclient` / email match), staff, optional OAuth ensure | Credits, sales, staff manual booking |
| **Consumer Identity** | Global Mindbody login (“Sign in with Mindbody”, OAuth) | `mindbody-oauth-*` | Consumer API: `clientcompleteinfo`, **`addclienttoclass`** (self-serve book) |

**Booking on amare-site is allowed only when:**

```text
clientExists === true  AND  consumerAssociated === true  →  bookingAllowed === true
```

Do **not** treat “we resolved `clientId`” as “ready to book”. Mindbody can reject the Consumer token even when Staff APIs already show credits on that `clientId`.

---

## Desiree Lara — timeline (production, 2026-05-27)

Reference: `deslara2016@gmail.com`, Mindbody `clientId` **100002835**, class **6794**, SKU `drop_in_single_class`.

| Time (log TZ) | Event | Meaning |
|---------------|--------|---------|
| 19:39 | OAuth callback: `stripe_oauth_client_id_unresolved`, email search **0 rows**, `clientcompleteinfo` **401** | Signed in with Consumer **before** any Studio Client at AMARÉ |
| 19:39 | `oauth_session_authenticated`, `cookieClientId: null` | Site session live, no studio client in cookie |
| 19:40 | OAuth callback again — still 0 email matches | Still no Studio Client |
| 19:41 | `stripe_checkout_session_created`, `knownClient: false` | Purchased while OAuth email in cookie but **no** `clientId` |
| 19:42 | `stripe_order_synced_to_mindbody` → `clientId: 100002835` | Staff path created/found client + credit |
| 19:42:55 | `oauth_session_authenticated`, `cookieClientId: 100002835` | Site first stored `clientId` |
| 19:43 | `class_book_*` ×5: `class_book_resolved_client` then **`DeniedAccess` / not associated with studio** | **Credits OK, Consumer BOOK not authorized** |
| 19:43:41 | OAuth: `stripe_oauth_client_id_resolved_via_fallback` → `100002835`, auto-merge OK | Site mapping fixed; **Mindbody Consumer association still not fixed** |
| 19:43–19:44 | Second Stripe checkout (`knownClient: true`) + second sync | Extra purchase; **did not fix association** |

**Proof in one line:** The site mapped email → `100002835` and Mindbody showed credits, but **`addclienttoclass` failed because the Consumer token was not studio-associated** — not because of missing credits.

Example log line (booking):

```json
{"event":"class_book_response","classId":6794,"clientId":100002835,"ok":false,"status":401,
 "mindbodyErrorCode":"DeniedAccess",
 "mindbodyErrorMessage":"Consumer identity authentication failed. Consumer not associated with studio."}
```

---

## Why most buyers succeed vs “Sign in first” failure

| Flow | Order | Result |
|------|--------|--------|
| **A — Anonymous purchase (healthy)** | Buy → webhook creates Studio Client + credits → Sign in → Consumer links to **existing** client → BOOK OK | Recommended for new clients |
| **B — Existing studio client** | Already client at AMARÉ → Sign in → probe 200 → BOOK OK | Returning members |
| **C — Broken (Desiree)** | Sign in **before** Studio Client → Consumer “in air” → Stripe creates client via Staff → site gets `clientId` → BOOK still **401 not associated** | Timing + missing association |

Critical difference:

```text
Healthy:  Studio Client exists first  →  Consumer connects to it
Broken:   Consumer connects first     →  Studio Client created later (Staff)  →  association not guaranteed
```

Staff API can create clients and attach credits; **Consumer API** still requires Mindbody to treat the logged-in Identity as **associated with this site**.

---

## Correct product model (flags)

Do **not** use `clientId` alone as “booking-ready”.

| Field | Meaning |
|-------|---------|
| `clientExists` | Studio Client row resolved for this email / session |
| `consumerAssociated` | Consumer token probe succeeded (`clientcompleteinfo` **200**) |
| `bookingAllowed` | `consumerAssociated === true` (only then call `addclienttoclass`) |
| `linkStatus` | `ready` \| `not_associated` \| `no_studio_client` \| `ambiguous_studio_client` \| `apple_relay_email` \| `incomplete_profile` |

Stored in sealed **`mb_sess`** after OAuth; exposed on **`GET /api/mindbody/oauth/session`** for `/classes` UI.

---

## Implemented behavior (code map)

| Area | Behavior |
|------|----------|
| **`mindbody-oauth-callback`** | After OAuth: `tryResolveClientId` → **`resolveExistingStudioClientForOAuth`** (Stripe-grade: `pickCanonicalClient` on email, unique name only) → if missing and `MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT` ≠ `0`, `ensureStudioClientForOAuthProfile` (no `addclient` when **ambiguous** or **Apple relay**). Then **`probeConsumerStudioAssociation`**. Persist flags in cookie. |
| **`probeConsumerStudioAssociation`** | [`mindbody-consumer-lib.mjs`](../netlify/functions/mindbody-consumer-lib.mjs) — returns `{ ok, httpStatus }`; does not mutate Mindbody. |
| **`computeOAuthStudioLinkState`** | Same file — orchestrates ensure + probe + `link_status`. |
| **`mb_sess` fields** | `client_id`, `client_exists`, `consumer_associated`, `booking_allowed`, `link_status` |
| **`mindbody-oauth-session`** | Returns `clientId`, `clientExists`, `consumerAssociated`, `bookingAllowed`, `linkStatus`. Legacy cookies without flags get a **one-time re-probe** on session load. |
| **`mindbody-class-book`** | If `bookingAllowed === false` → **403** `studio_not_linked` (no `addclienttoclass`). Log: `class_book_studio_not_linked`. |
| **`classes-schedule.js`** | If signed in and `bookingAllowed === false`, blocks book dialog with message keyed on `linkStatus` (`ambiguous_studio_client`, `apple_relay_email`, default). Handles 403 from API. |
| **`resolveExistingStudioClientForOAuth`** | [`stripe-mindbody-sync-lib.mjs`](../netlify/functions/stripe-mindbody-sync-lib.mjs) — shared with Stripe `pickCanonicalClient`; **2+ email matches → no create**. |
| **OAuth profile for create** | [`oauth-lib.mjs`](../netlify/functions/oauth-lib.mjs) `profileForStudioClientCreate` — email + name from claims; phone optional. **No extra form** by default. |

### Environment

| Variable | Default | Effect |
|----------|---------|--------|
| `MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT` | `1` | Create Studio Client on OAuth when email search returns 0. Set `0` to disable create (only probe/link flags). |

### Log events to grep

| Event | When |
|-------|------|
| `oauth_studio_client_resolved` | Existing client picked via email/name (no create) |
| `oauth_studio_client_ensured` | Created or found client during OAuth ensure |
| `oauth_profile_shape` | `hasPhone` / name flags before ensure (no PII values) |
| `oauth_studio_client_ensure_failed` | Includes `reason`, `mindbody` (`httpStatus`, `message`, `code`) |
| `oauth_link_state_summary` | End of OAuth callback: `linkStatus`, `clientId`, flags |
| `oauth_consumer_studio_association_probe` | After probe; includes `consumerAssociated`, `httpStatus` |
| `oauth_session_authenticated` | Includes `bookingAllowed`, `linkStatus` |
| `class_book_studio_not_linked` | Server blocked book before Mindbody |
| `class_book_response` + `DeniedAccess` | Legacy path if probe/session bypassed |

---

## Required QA scenarios (before / after deploy)

| ID | Steps | Expected |
|----|--------|----------|
| **A** | Brand-new email → Sign in with Mindbody **before** any purchase → (ensure creates client if flag on) → probe → buy drop-in → BOOK | If probe **200** after ensure: BOOK OK. If probe still **401**: `bookingAllowed: false`, UI message, no blind BOOK. |
| **B** | Anonymous Stripe buy → webhook sync → Sign in → probe 200 → BOOK | Must stay OK (regression). |
| **C** | Existing linked member → Sign in → probe 200 → BOOK | Must stay OK. |
| **D** | Desiree-like: `clientId` + credits but probe **401** | `linkStatus: not_associated`, `bookingAllowed: false`, 403 / UI block — **not** “no credits” messaging. |
| **E** | Email with **2+** Studio Clients at OAuth | `linkStatus: ambiguous_studio_client`, no `addclient`, contact-studio UI. |
| **F** | Sign in with Apple **privaterelay** email, no unique match | `linkStatus: apple_relay_email`, no auto-create; contact studio with real AMARÉ email. |

---

## OAuth vs Stripe duplicate policy (aligned)

| Step | Stripe checkout webhook | OAuth ensure (current) |
|------|-------------------------|-------------------------|
| Known `clientId` | Session metadata | `tryResolveClientId` + JWT |
| Email search | `searchClientsByEmail` + **`pickCanonicalClient`** (phone tie-break) | Same |
| 2+ same email | **No create** (`manual_review`) | **`ambiguous_studio_client`** — no `addclient` |
| Name search | N/A in webhook | Only if directory returns **exactly one** row |
| Apple relay | N/A | Skip auto-create; `apple_relay_email` |
| Create | `addclient` + conflict retry | Same, only after unambiguous miss |

---

## Support playbook

**If the client has credits but cannot book on the website:**

1. Check Mindbody: passes active on correct `clientId`.
2. Check site session / logs: `linkStatus`, `consumerAssociated`, `bookingAllowed` (not only `clientId`).
3. If **`not_associated`**:
   - Do **not** send another purchase link as the primary fix — **buying again does not fix association** (Desiree bought twice).
   - Do **not** tell them they have no credits.
   - Do: **Connect Mindbody Account** in Mindbody (client profile), or **Sign out → Sign in** with studio email, or **staff manual book** into the class using existing credits.
4. If **`no_studio_client`**: buy on `/pricing` first (creates client via webhook) then Sign in, or staff create client.
5. If **`ambiguous_studio_client`**: staff merge duplicates in Mindbody, then client signs out/in — do not auto-pick a client id.
6. If **`apple_relay_email`**: client must sign in with the **same email as the AMARÉ profile** or staff links manually.
7. Escalate to Mindbody support if Connect + re-sign-in still yields probe **401** with valid credits.

**User-facing line (EN):**

> Your payment and class credits are on your account. Your Mindbody login still needs to be fully linked to AMARÉ before you can book here — contact the studio and we can connect your account or book you into class.

---

## Investigation checklist (avoid wrong rabbit holes)

| Check | Relevant? |
|-------|-----------|
| Stripe webhook / order synced | Credits only — does not prove BOOK |
| `clientId` in `class_book_resolved_client` | Site mapping only |
| Class capacity / waitlist | Separate errors |
| `client_not_linked` (400) | No studio client resolved at all — different from `studio_not_linked` (403) |
| `Consumer not associated with studio` (401) | **This doc** |

---

## Related code & docs

- Checkout flows: [`MINDBODY-CHECKOUT-OVERVIEW.md`](MINDBODY-CHECKOUT-OVERVIEW.md) (anonymous buy → sign in)
- Guest-pass warning on Consumer vs studio client: [`bring-a-friend-guest-pass-plan.md`](bring-a-friend-guest-pass-plan.md) § duplicate / consumer merge
- Functions: `mindbody-oauth-callback.mjs`, `mindbody-oauth-session.mjs`, `mindbody-class-book.mjs`, `mindbody-consumer-lib.mjs`, `stripe-mindbody-sync-lib.mjs` (`ensureStudioClientForOAuthProfile`)

---

*Last updated: 2026-05-27 — Desiree Lara production incident + association-aware booking guard.*
