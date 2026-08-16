# AMARÉ Auth — Phase 0 + Phase 1 Design Contract

**Status:** PHASE 0+1 COMPLETE (2026-08-16).  
**Parent:** [`MINDBODY-AUTH-MIGRATION-AUDIT.md`](./MINDBODY-AUTH-MIGRATION-AUDIT.md)  
**Implementation:** additive identity store + session capability + observability only. No live booking change.

This document answers the identity / claim / session contracts.  
If a later PR disagrees with a locked decision, it must update this file first — not invent a second boolean.

---

## Hebrew brief

Phase 1 בונה זהות AMARÉ **ליד** Mindbody, לא במקומה.  
`mb_sess` נשאר מקור האמת החי. `amare_sess` יכול להיות מונפק/נקרא בטסטים וב־dark mode — **אסור** שישמש להזמנה, דשבורד או ביטול.  
Google sub = מי האדם. Mindbody `clientId` = איזה רשומה תפעולית מותר לנהל. אלה שתי ישויות.  
Claim לא silent: גם עם `mb_sess` תקין נדרשת לחיצה אחת.  
Apple relay לא יוצר Studio Client.  
Waitlist Staff add/remove לא ב־scope.  
Identity DB: **Netlify Database** (Postgres מנוהל באותו פרויקט). לא Blobs. לא Neon חיצוני כברירת מחדל.

---

# 0. Locked decisions (read this first)

| # | Decision | Locked value |
|---|----------|--------------|
| D1 | Live authorization source (Phase 1) | **`mb_sess` only** |
| D2 | `amare_sess` in Phase 1 | Capability + tests / dark flag. **Not** source of truth. If both cookies exist, **`mb_sess` wins**. Conflict is **logged**, not acted on. |
| D3 | Identity ≠ studio record | Separate tables/entities. `mindbody_client_id` is **not** a field on a Google identity. |
| D4 | One person | One `amare_user_id`. Many auth providers. At most one **verified/linked** Mindbody client per site. |
| D5 | Association states | `unlinked` \| `candidate` \| `ambiguous` \| `verified` \| `linked` \| `conflict` |
| D6 | Only status later phases may Staff-operate on | `linked` |
| D7 | Phase 1 may persist up to | `verified` (mapping stored, unused by live APIs) |
| D8 | Claim | Never silent. Valid `mb_sess` = strong candidate + one-click confirm. |
| D9 | Apple relay | Do **not** auto-create a Studio Client. Do **not** auto-bind. |
| D10 | Email-only unique match | Candidate only. Not automatic bind. |
| D11 | Identity datastore | **PostgreSQL**. Default host: **Netlify Database**. Alternative: external Neon / Supabase / RDS only if future needs require it. **Not** Netlify Blobs. |
| D12 | Google / Apple / Email OTP | **Not** in Phase 1. Slots exist in the model only. |
| D13 | App / Mindbody OAuth / `consumerAssociated` gate | **Unchanged** |
| D14 | Waitlist Staff add/remove | **Unknown**. Out of Phase 0+1. Does not block this contract. |
| D15 | Stripe | Unchanged. `amare_user_id` on orders is Phase 2+. |
| D16 | Identity write HTTP | **None.** Create/confirm association is library + tests only. No `/api/amare/*` write route. No `netlify.toml` redirect. No Function `handler` that mutates identity. |
| D17 | Association unique indexes | **Both** required: `(site_id, client_id)` WHERE verified/linked; **and** `(amare_user_id, system, site_id)` WHERE verified/linked. |

---

# 1. Purpose and non-goals

## Purpose

Define a durable AMARÉ person, how login providers attach to that person, how a Mindbody Studio Client is attached, what proves ownership, which session wins, what Phase 1 may write, and how to roll back.

## Non-goals (explicit)

- Implementing Google, Apple, or Email OTP
- Creating OAuth clients in Google/Apple consoles
- Changing `amare-app/`
- Changing live Book / Waitlist / Cancel / Dashboard authorization
- Removing Mindbody OAuth or the `bookingAllowed` / `consumerAssociated` 403
- Staff-primary live booking
- Deciding Waitlist Staff add/remove (probe later, before Phase 4)
- Moving Stripe fulfillment onto `amare_user_id`

---

# 2. What is an AMARÉ user?

An **AMARÉ user** is the durable person record AMARÉ owns.

It is **not**:

- a Mindbody Consumer login
- a Mindbody Studio Client
- a Stripe Customer
- an email string
- a browser cookie

```text
amare_user_id = usr_<opaque>
```

Format: `usr_` + 22-char Crockford base32 (or equivalent unguessable id).  
Never a Mindbody `clientId`. Never a Google `sub`. Never an email.

### What uniquely identifies an AMARÉ user?

**Primary key:** `amare_user_id`.

A user is **found** by exactly one of:

1. An attached identity: `(provider, provider_sub)`  
2. Later: a verified-email login method (OTP) — slot only in Phase 1  
3. Not by Mindbody `clientId` alone (that is the association, looked up the other way)

Creating a user **does not** create a Mindbody client.

---

# 3. Identity vs studio association

These are different relations. Do not collapse them.

```text
AMARÉ USER
  amare_user_id

        │
        ├── identities                  ← who authenticated
        │     ├── google → provider_sub
        │     ├── apple  → provider_sub
        │     └── email  → verified email   (OTP; not built in Phase 1)
        │
        └── studio_associations         ← what operational record they may manage
              └── MINDBODY
                    site_id
                    client_id
                    status
                    claimed_at
                    claim_method
                    claim_proof_ref
```

| Concept | Answers | Example |
|---------|---------|---------|
| Identity | Who just signed in? | Google `sub=1129…` |
| User | Which AMARÉ person is that? | `usr_8271` |
| Association | Which AMARÉ studio row may they operate? | Mindbody site `123` / client `873921` |

Google/Apple **never** “have” a `clientId`.  
The **user** may have a Mindbody association.  
Staff APIs (later) receive `client_id` from a **`linked` association**, not from the IdP token.

One site today (`MINDBODY_SITE_ID`). The row is still `(site_id, client_id)` so a second site cannot silently reuse the same column.

---

# 4. How multiple auth providers attach

Table **`amare_identities`** (logical):

| Column | Rule |
|--------|------|
| `amare_user_id` | FK to user |
| `provider` | `google` \| `apple` \| `email` |
| `provider_sub` | IdP subject. For `email`, the verified address (normalized). |
| `email` | Last seen email (nullable for Apple relay) |
| `email_verified` | boolean |
| `is_private_relay` | true if `@privaterelay.appleid.com` |
| `created_at` | |

**UNIQUE** `(provider, provider_sub)`.

Rules:

- One user may have Google + Apple + email.  
- The same `(provider, provider_sub)` cannot attach to two users.  
- Attaching a second provider is an **explicit link** (future), not “email matched so merge.”  
- Phase 1 does **not** implement provider attach in production UI. The schema must allow it.

---

# 5. How a Mindbody client is attached

Table **`amare_studio_associations`** (logical):

| Column | Rule |
|--------|------|
| `id` | Surrogate |
| `amare_user_id` | FK |
| `system` | `mindbody` (only value for now) |
| `site_id` | Mindbody site id string |
| `client_id` | Studio Client id, nullable while `unlinked` / `ambiguous` |
| `status` | See §6 |
| `claim_method` | See §7 |
| `claim_proof_ref` | Opaque: hash of session `sub` / cookie `at`, not raw tokens |
| `candidate_client_ids` | JSON array when `ambiguous` |
| `block_reason` | `apple_relay` \| `email_mismatch` \| `duplicate_clients` \| `session_conflict` \| null |
| `claimed_at` | Set when entering `verified` or `linked` |
| `updated_at` | |

**Both** partial unique indexes are mandatory (implementation must not ship only one):

```sql
-- A studio client cannot be verified/linked to two AMARÉ users
UNIQUE (site_id, client_id)
  WHERE status IN ('verified', 'linked') AND client_id IS NOT NULL

-- A user cannot have two active associations on the same site
UNIQUE (amare_user_id, system, site_id)
  WHERE status IN ('verified', 'linked')
```

A `candidate` or `ambiguous` row **must not** take either unique slot.

A user may have a prior `conflict` row retained for audit.

Creating or updating an association **does not** call Mindbody `addclient` in Phase 1.

---

# 6. Association state machine

Do not store “has clientId” as a boolean. Status is mandatory.

```text
                    ┌──────────┐
                    │ unlinked │
                    └────┬─────┘
                         │
            lookup / claim attempt
                         │
         ┌───────────────┼────────────────┐
         ▼               ▼                ▼
   ┌───────────┐  ┌───────────┐   ┌────────────┐
   │ candidate │  │ ambiguous │   │  unlinked  │
   │ (exactly  │  │  (2+)     │   │ + block_   │
   │  one)     │  └───────────┘   │   reason   │
   └─────┬─────┘                  │ apple_relay│
         │                        └────────────┘
         │ explicit confirm
         │ + unique write
         ▼
   ┌──────────┐
   │ verified │   ← Phase 1 terminal for a successful claim
   └────┬─────┘     (stored, unused by live APIs)
        │
        │ Phase 2+ promotion only
        ▼
   ┌──────────┐
   │  linked  │   ← only status Staff ops may use later
   └──────────┘

Any verified/linked + disagreeing new proof
        ▼
   ┌──────────┐
   │ conflict │
   └──────────┘
```

| Status | Meaning | User confirmed? | Unique bind? | Live Book (Phase 1) | Later Staff ops |
|--------|---------|-----------------|--------------|---------------------|-----------------|
| `unlinked` | No usable studio row | No | No | `mb_sess` as today | No |
| `candidate` | Exactly one studio client proposed | No | No | `mb_sess` as today | **No** |
| `ambiguous` | Two or more studio clients | No | No | `mb_sess` as today | **No** |
| `verified` | Strong proof + explicit confirm + unique row written | Yes | Yes | **Still `mb_sess`** | **No** (Phase 1) |
| `linked` | Association authorized for AMARÉ Staff operations | Yes | Yes | N/A in Phase 1 | **Yes** (Phase 2+) |
| `conflict` | Two sources disagree, or unique bind would collide | — | Existing bind kept | `mb_sess` as today | **No** until resolved |

### Transitions (allowed)

| From | To | Trigger |
|------|----|---------|
| `unlinked` | `candidate` | Hierarchy step 3 or 4 produced exactly one client; not confirmed |
| `unlinked` | `ambiguous` | Two or more studio clients |
| `unlinked` | `unlinked` + `block_reason=apple_relay` | Apple private relay; **no** `addclient` |
| `candidate` | `verified` | Explicit confirm + unique insert succeeds |
| `candidate` | `ambiguous` | Re-lookup now finds 2+ |
| `candidate` | `unlinked` | Re-lookup finds 0 or relay |
| `verified` | `linked` | **Phase 2+ only.** Flag/promotion. Not Phase 1. |
| `verified` or `linked` | `conflict` | New proof points at a different `client_id`, or another user already holds unique bind |
| `conflict` | `verified` / `linked` | Staff/manual resolution only |

### Forbidden transitions

- `unlinked` / `candidate` / `ambiguous` → `linked` (skip `verified`)  
- Any status → `verified` without explicit confirm  
- `ambiguous` → `verified` by picking a client automatically  
- Apple relay → `candidate` or `verified`  
- Phase 1 code → `linked`

This replaces the trap of a new `consumerAssociated`-style boolean.

---

# 7. What proves ownership before attachment

Proof is ranked. **Lower rank never overwrites a higher-rank bind.**

### Claim hierarchy (locked)

```text
1. Existing AMARÉ mapping (verified or linked)
   → use it. Do not re-search email.

2. Valid mb_sess
   (unseal + Mindbody refresh succeeds + session.client_id present)
   → strong claim CANDIDATE
   → show confirm UI
   → on click: verified

3. Verified auth email exactly matches ONE Mindbody studio client
   → CANDIDATE only
   → not automatic bind

4. Verified auth email + verified phone match that same single client
   → stronger CANDIDATE
   → still requires explicit confirm
   → then verified

5. Multiple matches / auth email ≠ studio email / mb_sess client ≠ email match
   → ambiguous or conflict
   → do not auto-bind

6. Apple Hide My Email (privaterelay.appleid.com)
   → unlinked + block_reason=apple_relay
   → do not create another Mindbody client
   → do not bind
```

### Claim methods (enum)

| `claim_method` | When |
|----------------|------|
| `none` | `unlinked` / `candidate` / `ambiguous` |
| `mb_sess_confirmed` | Hierarchy 2 + user clicked continue |
| `email_unique_confirmed` | Hierarchy 3 + user clicked continue |
| `email_phone_confirmed` | Hierarchy 4 + user clicked continue |
| `staff_manual` | Support tool (not Phase 1 UI) |

Raw Mindbody `access_token` / `refresh_token` are **never** stored on the association.  
`claim_proof_ref` may store a hash of `mb_sess.sub` + `client_id` + timestamp.

### Confirm UX (locked)

Not silent, even with a valid `mb_sess`.

```text
Continue with Google   (future phase — UI not built in Phase 1)
        ↓
server: valid legacy mb_sess + resolvable client_id
        ↓
We found your existing AMARÉ profile:
  Sarah M.
  s••••@gmail.com
  [Continue with this profile]
        ↓
Google sub → amare_user_id → association verified (client_id)
```

One click. The click is the attachment.  
If the user closes the dialog: stay `candidate` or no row; **do not** bind.

Phase 1 implements the **server confirm function** and can drive it from tests.  
Phase 1 does **not** ship the Google button.

### Shared-computer rule

`mb_sess` + a different person’s Google account in the same browser is the takeover case.  
That is why confirm is required and why the dialog must show **which** studio profile will be connected.  
Phase 1 tests must include: `mb_sess` client A + attempted bind to user B → `conflict`, no steal.

---

# 8. Sessions — who wins

| Cookie | Phase 1 role |
|--------|----------------|
| `mb_sess` | **Source of truth** for every live member API (book, cancel, waitlist, summary, benefits, sale, complete-profile) |
| `amare_sess` | Optional sealed blob of `{ amare_user_id, at }`. Issuable when `ENABLE_AMARE_SESS_ISSUE=1` (default **0**). |

### Winner (Phase 1)

```text
ALWAYS mb_sess for authorization.
amare_sess is ignored by resolveConsumerClient / getSessionWithConsumerHeaders.
```

### If both present

| Condition | Phase 1 behavior |
|-----------|------------------|
| Only `mb_sess` | Today’s behavior |
| Only `amare_sess` | Treat as **logged out** for live member APIs |
| Both, same `client_id` as `verified` mapping | Log `amare_sess_aligns_mb_sess`. Auth still `mb_sess`. |
| Both, different `client_id` | Log `amare_sess_conflicts_mb_sess`. Auth still `mb_sess`. **Do not** change Book UX. **Do not** prefer `amare_sess`. |
| `amare_sess` valid, `mb_sess` missing | Logged out for live APIs |

Phase 2 (not this document) will switch to: `amare_sess` preferred; refuse privileged actions on conflict.

### `amare_sess` shape (capability)

Sealed like `mb_sess` (AES-256-GCM) with **`AMARE_SESSION_SECRET`** (separate from `MINDBODY_SESSION_SECRET`).

```text
{ amare_user_id, at }
```

No Mindbody tokens. No `client_id` inside the cookie.  
`client_id` is loaded from a `verified`/`linked` row when a later phase needs it.

Default production: **do not Set-Cookie `amare_sess`.**

---

# 9. Datastore — Blobs vs relational (decision)

Identity is not an order-status blob. It needs uniqueness and a single atomic bind.

The database is **logically separate** from Functions. Functions stay stateless. Postgres is durable storage. The browser **never** talks to Postgres.

```text
Browser / App
      ↓  HTTPS
Netlify Functions
      ↓  verify cookie (later: amare_sess)
      ↓  SQL
Netlify Database  (managed PostgreSQL)
      ↓  amare_user_id → association
Mindbody Staff API   (later phases)
```

Never: Browser → Postgres.  
DB credentials stay server-side only.

| Requirement | Netlify Blobs | PostgreSQL (Netlify Database) |
|-------------|---------------|-------------------------------|
| `(provider, provider_sub)` UNIQUE | Application-only; race creates duplicates | Native UNIQUE |
| `(site_id, client_id)` UNIQUE for verified/linked | Same | Partial unique index |
| Atomic “insert user + identity + association” | Best-effort etag; already known-fragile (`blobs-conditional-create.mjs`) | Single transaction |
| Conflict if two claims hit the same client | Easy to lose | `ON CONFLICT` / serialization |
| Deploy Preview isolation | Shared blob store unless we invent namespacing | Native DB branch per preview; production deploy is the only one on the main DB |
| Schema sync | Manual | Migrations in `netlify/database/migrations` applied on preview + before production publish |
| Backups | Blob-versioning only | Daily + on production publish (Pro: 30-day scheduled, last 10 publish backups) |
| New vendor dashboard | None | **None** — same Netlify project |

**Locked: PostgreSQL.**

**Default host: Netlify Database** (managed Postgres built into the Netlify project; GA 2026-04-28; engine is Neon, provisioned and branched by Netlify — no external Neon/Supabase/RDS account for AMARÉ Auth).

**Alternative (not default):** external Neon / Supabase / RDS only if a future requirement cannot be met in-platform.

**Not allowed:** implementing the identity store on `@netlify/blobs`.

### Why not a separate Neon project

Neon still works with Netlify Functions (pooled connections). Adding it now creates a second vendor, a second dashboard, and separate credential/branching. Netlify Database already gives UNIQUE, transactions, preview branches, deploy-tied migrations, and backups inside the project we already use.

### What we store there (Phase 1)

Only the three identity tables. Not images, schedules, Mindbody dumps, Stripe ledgers, or high-volume logs.

~20k studio clients later is still a tiny Postgres workload. The hot path (Phase 2+) is one indexed lookup:

```sql
SELECT client_id
FROM amare_studio_associations
WHERE amare_user_id = $1
  AND system = 'mindbody'
  AND site_id = $2
  AND status = 'linked';
```

`amare_sess` stays a sealed cookie `{ amare_user_id, at }`. No DB hit on every page load. Query only when an authenticated action needs the association.

### Operational notes (not blockers)

- **Credit-based Netlify plan** is required for Netlify Database.
- **Sleep on inactivity** defaults to 5 minutes; first query after sleep pays wake-up latency. On Pro, set a longer timeout or **Always on** for production Auth/Book if that latency is felt.
- **Autoscaling:** Pro can set compute range (docs: up to 16 units). AMARÉ identity traffic will not be the limiter.
- Access from Functions through a small adapter (`amare-identity-store`). SQL stays in one module.
- Local: Netlify CLI / `@netlify/database` connection, or `DATABASE_URL` to a local Postgres with the same schema. No in-memory identity store in production paths.

Stripe orders **remain** on Blobs. Do not move commerce blobs to Postgres because we added an identity DB.

---

# 10. What gets logged

Structured JSON only. No tokens, no raw email in full if avoidable (hash or domain + last-2 local). Prefer `amare_user_id`, `client_id`, `status`, `claim_method`.

| Event | When |
|-------|------|
| `amare_user_created` | Insert user |
| `amare_identity_attached` | `(provider, sub)` attached |
| `amare_association_proposed` | → `candidate` or `ambiguous` |
| `amare_association_blocked_relay` | Apple relay |
| `amare_association_confirmed` | → `verified` |
| `amare_association_conflict` | → `conflict` |
| `amare_sess_issued` | Cookie/JWT issued (should be rare in prod Phase 1) |
| `amare_sess_aligns_mb_sess` | Dual cookie, same client |
| `amare_sess_conflicts_mb_sess` | Dual cookie, different client |
| `amare_sess_ignored_live_api` | Request had `amare_sess` and live API used `mb_sess` or 401 |

### Phase 0 observability (allowed, separate PR)

Live `/classes` book-block should log (even while Auth is unchanged):

`book_block_variant`, `clientExists`, `hasPhone`, `walletLoadState`, `hasActiveCredits`, `consumerAssociated`, `selectedCTA`

This is **not** the identity store. It must not wait for Postgres.  
It must not change Book outcomes — log only, or restore the documented matrix **without** removing the `bookingAllowed` gate.

---

# 11. What Phase 1 may write

Allowed:

- Postgres schema + migrations for `amare_users`, `amare_identities`, `amare_studio_associations`  
- Store adapter + unit/integration tests against a non-prod database  
- Library functions that create users / propose / confirm associations, callable from **tests only** (D16: no public HTTP write surface)  
- Seal/unseal helpers for `amare_sess`  
- Dual-cookie **detection + logs** on an existing session probe **without** changing the JSON contract the frontend uses for Book  
- Phase 0 book-block **logs**  
- `.env.example` keys: `AMARE_SESSION_SECRET`, `ENABLE_AMARE_SESS_ISSUE=0` (DB URL comes from Netlify Database / CLI; do not invent a second Neon project)  
- Migration files under `netlify/database/migrations` for the three identity tables only  
- This document

Phase 1 **write ceiling:** association status `verified`. Never `linked`.

---

# 12. Explicitly forbidden from changing (Phase 1)

| Forbidden | Why |
|-----------|-----|
| Google / Apple OAuth credentials or buttons | Contract first; IdP later |
| Email OTP implementation | Slot only |
| `amare-app/` auth | App stays on Mindbody until website identity is real |
| `resolveConsumerClient` / `getSessionWithConsumerHeaders` switching to `amare_sess` | Would make dark session live |
| `mindbody-class-book.mjs` `bookingAllowed` 403 | Still protects Consumer path |
| Waitlist / cancel / member-summary auth | Same |
| Mindbody OAuth start/callback/logout behavior | Rollback surface |
| Auto `addclient` on Apple relay or Google first login | Duplicate factory |
| Auto-bind on email-only match | Takeover / wrong client |
| Putting `client_id` on `amare_identities` | Collapses identity and association |
| Identity store on Netlify Blobs | No real unique/atomic guarantees |
| Promoting `verified` → `linked` | Phase 2+ |
| Adding `amare_user_id` as required Stripe metadata | Phase 2+ |
| Using association `candidate` for any Staff write | Candidate is not ownership |

---

# 13. Rollback

Phase 1 is additive. Live paths do not read the new tables.

| Lever | Effect |
|-------|--------|
| `ENABLE_AMARE_SESS_ISSUE=0` | No `amare_sess` cookies |
| Stop deploying identity Functions | Website unchanged |
| Drop/ignore Postgres | No customer impact; `mb_sess` never needed it |
| Do not delete Mindbody clients | Credits untouched |

No customer “migration” to undo.  
Do not backfill production users in Phase 1.

---

# 14. Waitlist (out of scope — recorded so it cannot stall this phase)

| Action | Evidence today |
|--------|----------------|
| Staff **read** waitlist | Proven — `GET class/waitlistentries` (consumer 400) in `mindbody-member-summary.mjs` |
| Staff **add** waitlist | Unknown — only Consumer `AddClientToClass` + `Waitlist: true` |
| Staff **remove** waitlist | Unknown — only Consumer `removefromwaitlist` |

Phase 0+1 does not probe or implement these.  
A later Staff waitlist probe (sandbox) is a Phase 4 input.  
If add/remove cannot be Staff, Waitlist may stay on a compatibility path. That is **not** a reason to keep Mindbody as the identity provider.

---

# 15. Phase 2+ preview (not authorized to build)

Listed only so Phase 1 does not paint us into a corner:

1. Google + Apple (Apple required if Google is shown on iOS).  
2. Confirm UI for `mb_sess` claim.  
3. Promote `verified` → `linked`.  
4. Live APIs accept `amare_sess` and resolve `client_id` from `linked` only.  
5. Conflict: refuse Book/Cancel/Wallet until resolved.  
6. Staff live Book behind flag; then drop `consumerAssociated` gate.  
7. Optional `amare_user_id` on Stripe orders.  
8. App auth switch **after** website `linked` path is proven.

---

# 16. Approval checklist

Approve this document only if all are true:

- [ ] Live Book still means `mb_sess` after Phase 1  
- [ ] `amare_sess` cannot become source of truth by accident (`ENABLE_AMARE_SESS_ISSUE` default 0 + live APIs ignore it)  
- [ ] Identity and Mindbody association are separate  
- [ ] Association has a real state machine, not a boolean  
- [ ] Claim is never silent  
- [ ] Email-only match is not auto-bind  
- [ ] Apple relay does not create a Studio Client  
- [ ] Identity store is Postgres on **Netlify Database**, not Blobs, not a new Neon project by default  
- [ ] No Google/Apple credentials or app work in Phase 1  
- [x] Waitlist unknown does not block Phase 1  
- [x] No public identity-write Function  
- [x] Both association unique indexes present  

---

# 17. Intentionally open (only these)

| Item | Why it can wait |
|------|-----------------|
| Who enables Netlify Database on the AMARÉ site (and Pro sleep/always-on) | Hosted DB provisioned 2026-08-16 via draft deploy (not `--prod`). Production migration still pending publish. Sleep/always-on still a plan choice. |
| SQL migration filenames / ORM vs `pg` | Implementation detail |
| Crockford vs `nanoid` for `usr_` | Any unguessable generator |
| Masking width in claim dialog (`s••••@`) | UX copy, Phase 2 |
| Staff waitlist add/remove | Probe before Phase 4 |
| Email OTP vendor | Not Phase 1 |

Nothing else in §§0–13 is optional.

---

```text
DOCUMENT TYPE: DESIGN CONTRACT — PHASE 0+1 COMPLETE
LIVE BOOKING CHANGES: NONE (observability logs only)
GOOGLE/APPLE CREDENTIALS: NONE
APP CHANGES: NONE
PUBLIC IDENTITY WRITE HTTP: NONE

PHASE 1 SOURCE OF TRUTH: mb_sess
PHASE 1 WRITE CEILING: association status = verified
PHASE 1 FORBIDDEN STATUS: linked

IDENTITY STORE: PostgreSQL
DEFAULT HOST: Netlify Database
NOT: Netlify Blobs

LANDED:
  netlify/database/migrations/20260816000100_amare_identity.sql
  netlify/functions/amare-identity-policy.mjs
  netlify/functions/amare-identity-store.mjs
  netlify/functions/amare-sess-lib.mjs
  scripts/qa-amare-identity-phase01.mjs
  scripts/qa-amare-identity-db.mjs
  scripts/qa-amare-identity-preview-isolation.mjs

DB ACTIVATION (2026-08-16):
  Local Netlify Database: migration applied; both partial unique indexes enforced by real writes
  Hosted Netlify Database: provisioned (not production publish)
  Hosted production schema: pending — do not publish to prove migrations
  Hosted preview isolation: preview applied 20260816000100; production pending; QA row preview-only
  ENABLE_AMARE_SESS_ISSUE: unset / default off
```
