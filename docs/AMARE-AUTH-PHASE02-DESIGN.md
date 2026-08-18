# AMARÉ Auth — Phase 2 Design Contract

**Status:** APPROVED — Phase 2 Design Contract (2026-08-16).  
**Parent:** [`AMARE-AUTH-PHASE01-DESIGN.md`](./AMARE-AUTH-PHASE01-DESIGN.md) (PHASE 0+1 COMPLETE)  
**Implementation plan:** [`AMARE-AUTH-PHASE2A-IMPLEMENTATION-PLAN.md`](./AMARE-AUTH-PHASE2A-IMPLEMENTATION-PLAN.md) (2A complete locally; **2B member-read implemented locally behind `ENABLE_AMARE_MEMBER_READ`**; production flags OFF; Book / Cancel / Waitlist mutation auth unchanged).  
**Does not change:** live Book / Waitlist / Cancel authorization.  
**Does not remove:** Mindbody OAuth, `mb_sess`, or existing Consumer compatibility paths.

Phase 1 proved the identity store and both unique indexes, including Deploy Preview ≠ production.  
Phase 2 designs how a person signs in to AMARÉ and how that person is later allowed to act on a Mindbody `clientId`.  
Those are two different risks. They must not ship in the same PR as a Book change.

---

## Hebrew brief

AMARÉ מחזיקה את הזהות הראשית.  
השקה ראשונה: Email OTP ראשי; Mindbody משני / legacy; Google מיושם ומוסתר; Apple נדחה.  
אין “משתמש Email” או “משתמש Google”. יש רק `amare_user_id` + כמה identities + association אחד לאתר.  
Phase 2A = מי המשתמש. Phase 2B = האם מותר לפעול על `clientId`.  
Staff Book עדיין בחוץ. `mb_sess` נשאר מקור האמת החי ל־Book עד ש־2A ו־2B מוכחים בנפרד.

---

# 0. Split (locked)

| Phase | Question | In scope | Out of scope |
|-------|----------|----------|----------------|
| **2A — Authentication** | Do we know who this person is? | Apple, Google, Email OTP, Mindbody as **legacy identity**, `amare_user` + identity attach, `amare_sess` issue/read, `mb_sess` claim, conflict handling, login UX hierarchy | `linked`, Staff Book, changing live Book gates, removing Mindbody OAuth |
| **2B — Authorization transition** | May this person operate this `clientId`? | `verified` → `linked`, `amare_sess` resolves `clientId` from the association row, dual-session conflict rules | Staff live Book, removing `consumerAssociated` as a global gate, Stripe `amare_user_id`, app store launch |

**Still later (Phase 3+):** Book uses AMARÉ identity; Staff `addclienttoclass` for live Book; `amare-app/` auth migration; any UI retirement of Mindbody login.

```text
2A proven  →  2B proven  →  only then Book may leave mb_sess
```

Email OTP is the **launch primary** login method (D27). Google is implemented and proven but hidden at launch. Apple is deferred. Mindbody remains fallback / legacy. This is sequencing, not a second identity model.

---

# 1. Locked decisions (Phase 2)

Phase 1 D1–D17 remain in force unless a row below explicitly supersedes them for a later phase.

| # | Decision | Locked value |
|---|----------|--------------|
| D18 | Primary vs secondary login | **Primary:** Apple, Google, Email OTP. **Secondary / legacy:** Mindbody. Do not show four equal buttons. |
| D19 | One person | There is only an **AMARÉ user**. Google / Apple / Email / Mindbody are identities on that user. No “Google user” / “Mindbody user” account types. |
| D20 | Mindbody storage | `amare_identities.provider = mindbody`, `provider_sub =` Mindbody OIDC `sub`. Studio `clientId` stays only on `amare_studio_associations`. Never store `mindbody_client_id` on an identity row. |
| D21 | Session coexistence | `amare_sess` = primary AMARÉ identity. `mb_sess` = legacy identity / migration proof. If they resolve to different Studio Clients → **CONFLICT**. Do not silently pick one. Live Book stays on `mb_sess` through 2A and 2B. |
| D22 | Email is not a merge key | Same email on Google and a Studio Client = `candidate` at most. Never “same AMARÉ user” automatically. |
| D23 | Mindbody OAuth preservation | Do not redesign or remove start / callback / refresh / `mb_sess` / association probe / logout / Consumer compatibility unless a later approved phase says so. |
| D24 | Link Account | Keeping Mindbody login does **not** keep `consumerAssociated` as a permanent global requirement. Staff-backed AMARÉ use (later) must not require Consumer Link Account. |
| D25 | Retirement | Hide or retire Mindbody login only from measured usage, not a guessed date. OAuth stays available as rollback/recovery until a later product decision. |
| D26 | Auth ≠ studio claim | Creating or finding an AMARÉ user from a verified provider identity proves **only** authentication. It does **not** claim or verify a Mindbody Studio Client. Association must independently pass the claim state machine and explicit confirmation before status may become `verified`. Applies equally to `google`, `apple`, `email`, and `mindbody`. |
| D27 | Launch login sequence | **Initial production UI:** Email OTP primary; Mindbody fallback / legacy / recovery. **Google:** backend ready, real-E2E proven, **hidden** (flag off, no launch button). **Apple:** deferred (identity model still allows `provider=apple`). Google and Apple may later be enabled as additional identities on the same `amare_user_id`. Does not create separate “Email users” / “Google users”. D18’s architectural primary set is unchanged; D27 locks **launch sequencing only**. |
| D28 | Brand-new Email OTP Studio profile | Brand-new Email OTP customers with no matching Studio Client use **AMARÉ-owned profile creation**. After verified Email OTP and a **successful** Staff-backed exact-email search returning zero matches, AMARÉ collects first name, last name, and mobile phone, then creates a Mindbody **Studio** Client via Staff API for the current `amare_user_id`. No Mindbody Consumer account, username/password, Link My Account, `mb_sess`, or `consumerAssociated` is required. Existing-client claim rules (D22 / D26) are unchanged. **ConfirmAccount / “Finish creating your account” is Mindbody Consumer Identity site mail, not an AddClient flag.** Suppress it in Manager with **Suppress Consumer Identity Emails**. Do not change D28 code to work around it. |
| D29 | Anonymous-purchase Email OTP auto-link | Narrow Email-OTP-only exception to the candidate **UI** confirm step after an anonymous Stripe purchase. A trusted server `OrderRecord` may confirm the unique Studio candidate. Not a new claim hierarchy. Google / Apple / Mindbody do not use this path. `order=` is a lookup hint only. Production stays OFF. |

`promoteAssociationToLinked()` stays forbidden until a 2B implementation PR updates the Phase 1 store on purpose.

**Change Email (future, not now):** because `provider=email` uses `provider_sub =` normalized verified email, AMARÉ will need a verified Change Email flow that keeps the same `amare_user_id`. Do not implement it in 2A.5.

### D26 — authentication is not studio ownership

```text
verified Google / Apple / Email / Mindbody sub
        ↓
create/find amare_user_id
        ↓
AUTHENTICATION PROVEN

does NOT imply:

amare_user_id owns Mindbody clientId 84521
```

Studio Client path remains:

```text
candidate
   ↓
explicit confirmation
   ↓
verified
```

A provider callback may create/attach an identity. It must not silently confirm studio ownership.

### D28 — brand-new Email OTP customers create a Studio Client without Consumer OAuth

```text
verified Email OTP
        ↓
SUCCESSFUL Staff exact-email search
        ↓
0 matches → needs_profile (not “Sign in with Mindbody”)
        ↓
explicit “Create my profile”
        ↓
Staff addclient (Studio Client only)
        ↓
candidate → verified → linked
claim_method = new_profile_created
```

Search **failure** is not zero matches. A generic `unlinked` row is not `needs_profile`.

The verified email is bound by a short-lived sealed `amare_profile_tx` from **this** OTP, not by `listIdentities`.

One customer action. Login still does not own an **existing** Studio client (D26).

### D29 — anonymous-purchase Email OTP auto-link (locked 2026-08-17)

General exact-email match still requires explicit confirm (D22 / D26). This path does **not** auto-link every unique email match.

```text
LOCKED INVARIANTS:
1. Staff Studio email search returns EXACTLY ONE match
2. candidate.clientId === order.resolvedMindbodyClientId
   (knownMindbodyClientId is not proof)
3. 24h window uses fulfillmentSyncedAt, then updatedAt, then createdAt
4. order.amareUserId is null OR equals the current amare_user_id;
   a different amareUserId blocks auto-link

order=                    lookup hint only; never ownership
spoofed / missing order=  cannot establish ownership; falls back to candidate confirm
Apple / Google            do not call this path
Apple relay email         never auto-links
"This isn't my profile"   UI-only; never AddClient / profile/create
PRODUCTION                OFF
```

No additional architecture. Do not widen this to Google, Apple, Mindbody OAuth, or all exact-email candidates.

### D28 — ConfirmAccount / Consumer Identity emails (locked 2026-08-17)

Mindbody Support confirmed the unwanted password-setup mail is **expected by design** when Consumer Identity is enabled and a staff-created client profile includes an Email.

```text
CONFIRMACCOUNT ROOT CAUSE:
Mindbody Consumer Identity automatic activation

TRIGGER:
Staff AddClient + real Email
(even with no purchase, no book, no sendpasswordresetemail)

SUPPORTED SUPPRESSION:
Mindbody Manager → Suppress Consumer Identity Emails = ON

ADDCLIENT SUPPRESS FLAG:
NONE

D28 CODE CHANGE REQUIRED:
NO

MINDBODY CONSUMER ACCOUNT REQUIRED BY AMARÉ:
NO

PRODUCTION:
OFF
```

That site setting suppresses:

- “Finish creating your account” / “Finish creating your Mindbody account”
- “Add [business name] to your Mindbody account”

It is **not** controlled by:

- New Client / Welcome Emails (BUSINESS MODE)
- New Client / Welcome Emails (CONSUMER MODE)
- `SendAccountEmails` / `SendScheduleEmails` / `SendPromotionalEmails`
- undocumented AddClient `SendEmail` assumptions

Do **not** implement AddClient without Email, fake/synthetic email, UpdateClient workarounds, or password-reset suppression. D28 still creates a Studio Client with the verified real Email.

**Side effect (acceptable):** the setting is site-wide. It may also suppress those Identity invitation emails for clients created manually by staff in Manager, not only API-created D28 clients. AMARÉ remains the primary customer account; Mindbody Consumer login stays optional.

**Follow-up:** after Manager enables the setting, run one isolated new-customer registration (unique email, `/login` → OTP → D28 profile → stop; no Stripe; no Book) and confirm the system ConfirmAccount mail is absent.

---

# 2. Login hierarchy (UX requirement — launch UI is 2A.7)

D18 remains the **architectural** provider set. D27 is the **launch sequencing** override. Do not read this section as “ship four equal buttons.”

```text
ARCHITECTURAL PROVIDERS (D18 / D19):
email | google | apple | mindbody
        ↓
same amare_user_id
        ↓
Studio association (separate)

INITIAL LAUNCH UI (D27):
Email OTP     = primary
Mindbody      = fallback / legacy / recovery
Google        = implemented, hidden (no launch button)
Apple         = deferred (no launch button; provider=apple stays in the model)
```

Conceptual **initial** launch UI (not built until 2A.7):

```text
Welcome to AMARÉ

Email
[________________]

[ Continue ]

------------------------

Already use Mindbody with AMARÉ?
Sign in with Mindbody
```

No Google button at initial launch.  
No Apple button at initial launch.  
Google and Apple may be added later as additional identities on the same `amare_user_id`.

A new customer must not wander into Consumer → Link Account because Mindbody was drawn as an equal primary button.  
Mindbody is for people who already use it, plus recovery.

Later, if metrics justify it, the same Mindbody control may move under `Other sign-in options` or `Having trouble signing in?`. That is not an implementation task now.

---

# 3. One AMARÉ user

```text
                    AMARÉ USER
                    amare_user_id
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     Google            Apple           Email OTP
        │                │                │
        └────────────────┼────────────────┘
                         │
                    same user
                         │
              Mindbody legacy identity
              (provider=mindbody, OIDC sub)
                         │
                         ▼
              studio association
                         │
                 Mindbody clientId
```

Do not create parallel account types.  
Attaching a second provider is an **explicit link / claim**, never “emails matched so merge.”

---

# 4. Phase 2A — AMARÉ Authentication

## Purpose

Create and recognize an AMARÉ person. Attach Apple / Google / Email / optional Mindbody identities. Confirm an existing studio profile when proof exists. Issue `amare_sess` as the AMARÉ identity cookie.

## In

- Email OTP as **launch primary** (implemented / proven; production flag OFF until rollout)
- Sign in with Mindbody as **launch fallback / legacy** — same `amare_user_id` model (2A.6 bridge)
- Google as an implemented, proven, **hidden** provider (no launch button)
- `createAmareUser` + `attachIdentity` from a verified provider `sub`
- Existing `mb_sess` as **claim proof**, never a silent bind
- Conflict when sessions or proofs disagree
- Schema expansion: allow `provider = mindbody` on `amare_identities` (Phase 1 CHECK is `google|apple|email` only; 2A.1 landed)
- Login-provider observability (see §7)
- `ENABLE_AMARE_SESS_ISSUE` becomes a 2A ship flag for AMARÉ pages that are **not** Book

## Out

- `linked`
- Staff Book
- Changing Book / Waitlist / Cancel / Dashboard authorization
- Changing `/oauth/session` JSON that the schedule uses for `bookingAllowed`
- Removing or rewriting Mindbody OAuth
- Implementing Apple now (deferred; `provider=apple` remains in the model)
- Exposing Google in the initial launch UI
- App store / `amare-app/` auth migration
- Production `amare_sess` as Book source of truth

## 2A success

Launch authentication is Email OTP primary plus Mindbody as fallback/legacy, both resolving to the **same** `amare_user_id` model. Google is implemented and proven but hidden. Apple is deferred. A person may optionally claim an existing studio profile through the claim state machine.  
Live Book still uses `mb_sess` and still 403s on `studio_not_linked` exactly as today.

**Implementation status (do not treat Apple as a 2A completion blocker):**

| Provider | Status |
|----------|--------|
| Email OTP | Implemented / real E2E proven / launch primary / production flag OFF |
| Google | Implemented / real E2E proven / hidden at launch / production flag OFF |
| Mindbody bridge | Implemented (2A.6) — web-callback additive identity only; OAuth preserved; production flag OFF |
| Apple | Deferred |

---

# 5. Phase 2B — Authorization transition

## Purpose

Decide when a verified mapping becomes the mapping later phases may operate on, and what happens when `amare_sess` and `mb_sess` disagree.

## In

- Explicit `verified` → `linked` (not automatic on Google, Apple, Email, or Mindbody login)
- Lookup: `amare_user_id` → active association → `clientId`
- Dual-session rules below, for **non-Book** surfaces first

| Condition | 2B (non-Book) | Book / Waitlist / Cancel / Dashboard through 2B |
|-----------|---------------|--------------------------------------------------|
| Only `mb_sess` | Today’s behavior (legacy) | Today’s behavior |
| Only `amare_sess` + `linked` | Signed in as AMARÉ user; `clientId` from association | Still `mb_sess` required until a later Book PR |
| Both, same `clientId` as linked/verified mapping | Align. `amare_sess` is the AMARÉ identity. `mb_sess` is leftover proof. | Auth still `mb_sess` |
| Both, different `clientId` | **CONFLICT.** Refuse privileged actions. No silent pick. | **CONFLICT** for privileged actions that would use either id. Do not book as A or B. |
| `amare_sess` valid, no linked/verified row | Signed in as a person, not authorized for studio ops | Logged-in AMARÉ person does not unlock Book |

## Out

- Live Book / Waitlist / Cancel switching off `mb_sess`
- Removing `consumerAssociated` / `bookingAllowed` gate
- Staff `addclienttoclass` for the public Book button

## 2B success

`linked` can be written by an explicit promotion path. A later Book PR would have a real `clientId` to resolve. That Book PR is **not** 2B.

---

# 6. Mindbody as Legacy Identity Provider

This section is the product/architecture lock. Implementation PRs must not invent a second account type.

Mindbody OAuth is **not** removed. It is demoted.

```text
AMARÉ owns the primary identity.

Architectural providers: email | google | apple | mindbody.

Launch UI (D27): Email OTP primary; Mindbody fallback / legacy;
Google hidden; Apple deferred.

Mindbody remains supported as a secondary legacy identity,
migration bridge, and recovery/claim mechanism.

All providers ultimately resolve to the same amare_user_id.
```

Future responsibilities:

1. **Existing customer login** — “Sign in with Mindbody” for people who already use it.  
2. **Migration bridge** — a valid `mb_sess` is strong proof when the customer later continues with Apple/Google/Email.  
3. **Recovery / compatibility** — keep the option available; do not decide removal now.

Keeping this option does **not** mean AMARÉ Auth users must Link Account with Mindbody.

```text
Google / Apple / Email user
        ↓
AMARÉ identity
        ↓
linked Studio association   (2B+, explicit)
        ↓
Staff-backed AMARÉ functionality   (later than 2B)
```

No Consumer Link Account for normal AMARÉ use once Staff-backed operations are approved.  
Mindbody-login users may still use Consumer association during compatibility mode.  
`consumerAssociated` must not remain a permanent global requirement merely because Mindbody login still exists.

## 6.1 How does a Mindbody OAuth login find or create an `amare_user_id`?

Use the **existing** OAuth start → callback → session build. Do not replace it.

After a successful Mindbody OAuth completion, the server already has (from `buildSessionPayloadFromOAuthTokens`):

- OIDC `sub` (may be null)
- email / name
- resolved Studio `client_id` (may be null)
- link flags (`client_exists`, `consumer_associated`, `link_status`)
- tokens sealed into `mb_sess` as today

Then, **additive** 2A logic (new library path, not a rewrite of callback):

```text
1. Keep writing mb_sess exactly as today.

2. If OIDC sub is missing or empty:
     do not invent a sub from clientId or email
     do not insert amare_identities
     customer still has today’s mb_sess compatibility session
     log mindbody_identity_sub_missing

3. Lookup amare_identities
     WHERE provider = 'mindbody' AND provider_sub = sub
   → hit: that amare_user_id. Stop searching by email.

4. If no mindbody identity row:
     if session.client_id is a verified/linked association for this site:
       that row’s amare_user_id is the attach target
       do NOT create a second user
       require explicit confirm before attachIdentity(mindbody, sub)
     else:
       apply Phase 1 claim hierarchy (email / phone / ambiguous / relay)
       if hierarchy names an existing amare_user_id: confirm, then attach
       if no existing user: createAmareUser + attachIdentity(mindbody, sub)

5. Association is separate.
     clientId → propose/confirm via claim rules
     never copy clientId onto the identity row
     never auto-write verified without explicit confirm
```

First-time Mindbody login with a new `sub` and no existing mapping **may** create an AMARÉ user. That user is still an AMARÉ user who happens to have a Mindbody identity — not a “Mindbody account type.”

## 6.2 How is Mindbody OIDC `sub` represented?

```text
amare_identities.provider      = 'mindbody'
amare_identities.provider_sub  = Mindbody OIDC sub
```

Source of `sub` today: `id_token` / `userinfo` / access-token claims, normalized by `profileFromClaims()` and already stored on `mb_sess` as `sub`.

Rules:

- `provider_sub` is the OIDC subject string, not the Studio `clientId`, not the email.  
- If `sub` is absent, skip the identity row (see 6.1 step 2).  
- UNIQUE `(provider, provider_sub)` already prevents one Mindbody subject from attaching to two AMARÉ users.  
- Phase 1 CHECK must be expanded in a 2A migration:

```text
provider IN ('google', 'apple', 'email', 'mindbody')
```

Do not implement that migration in this design task.

## 6.3 How does it relate to the existing Studio `clientId`?

```text
amare_identities          → WHO authenticated (Mindbody Consumer / OIDC)
amare_studio_associations → WHICH Studio Client this user may manage
```

`clientId` is resolved the way it is today (claims, then existing fallbacks) and stored only on the association.  
A Mindbody identity without a resolvable `clientId` is a signed-in person with `unlinked` / no active association — same as today’s “OAuth succeeded, studio not linked,” except they now also have an `amare_user_id` once `sub` exists.

## 6.4 How does an existing `mb_sess` help claim a new Google / Apple / Email identity?

Phase 1 hierarchy rank 2 stays locked. Never silent.

```text
existing valid mb_sess
        ↓
Mindbody clientId = 84521
        ↓
customer chooses Continue with Google (or Apple / Email)
        ↓
Google identity authenticated
        ↓
AMARÉ detects existing studio profile
        ↓
show explicit confirmation:

"We found your existing AMARÉ profile"

[ Continue with this profile ]

        ↓
Google identity attaches to the same amare_user_id
        ↓
same association → clientId 84521
```

If that `clientId` already has a verified/linked AMARÉ user, attach Google to **that** user after confirm.  
If the Google `(provider, sub)` already belongs to a **different** `amare_user_id`, that is a conflict — do not merge, do not steal.

Shared-computer rule from Phase 1 remains: the dialog must show which studio profile will be connected.

## 6.5 What happens if `mb_sess` and `amare_sess` disagree?

Do not delete `mb_sess` support when AMARÉ Auth launches.

```text
amare_sess = primary AMARÉ identity
mb_sess    = legacy identity / migration proof
```

| Resolve | Action |
|---------|--------|
| Only one cookie | Use that cookie’s role (see §5). Book still `mb_sess` through 2B. |
| Both, same Studio `clientId` as the user’s verified/linked row | Align. Log `amare_sess_aligns_mb_sess`. |
| Both, different Studio Clients | **CONFLICT.** Log `amare_sess_conflicts_mb_sess`. Privileged actions must not silently use A or B until the customer or staff resolves it. |
| `amare_sess` user has no association; `mb_sess` has a `clientId` | Claim candidate (rank 2). Explicit confirm. Not a silent attach. |

Phase 1 “`mb_sess` always wins and conflict is only logged” is the **dark** rule.  
Phase 2 **designs** the transition above. Book does not adopt `amare_sess` in 2A or 2B.

## 6.6 What happens if Mindbody email and Google / Apple email disagree?

Email is evidence, not identity.

- Same email on Google and a Studio Client → `candidate` only (D10 / D22).  
- Different emails + valid `mb_sess` for one `clientId` → rank 2 candidate; still explicit confirm; do not reject solely because emails differ; do not auto-bind.  
- Different emails + no `mb_sess` + two studio rows → `ambiguous`.  
- Existing verified mapping says client A; new proof says client B → `conflict`.  
- Apple private relay → no automatic bind, no automatic Studio Client create (D9).

Never: “emails match ⇒ same `amare_user_id`.”

## 6.7 Can a Mindbody user later attach Google / Apple / Email?

Yes. Same person, second identity, explicit confirm.

The customer already has `amare_user_id` from `(mindbody, sub)` (or from a prior claim).  
Continue with Google/Apple/Email attaches `(google|apple|email, sub)` to **that** user after the claim UI.  
If that social `sub` is already on another user → refuse / conflict. Do not merge by email.

## 6.8 Can a Google / Apple / Email user later attach Mindbody?

Yes. “Sign in with Mindbody” or a later “Add Mindbody sign-in” is `attachIdentity(mindbody, sub)` on the current `amare_user_id`, plus the normal association claim if a `clientId` appears.

If `(mindbody, sub)` already belongs to a different user → conflict.  
If the Mindbody session’s `clientId` is already verified to a different user → D17 unique index wins; write fails; surface conflict. Do not steal.

## 6.9 When is explicit confirmation required?

Always, before `verified` (Phase 1 D8). Including:

- valid `mb_sess` + Continue with Google/Apple/Email  
- Sign in with Mindbody when attaching to an already-verified studio mapping  
- unique verified email match  
- email + phone match  
- attaching a second provider onto an existing `amare_user_id`

Closing the dialog leaves `candidate` / no bind.  
`linked` is never written in 2A.

## 6.10 What remains available for rollback?

- All current Mindbody OAuth routes and `mb_sess` unseal  
- Consumer association probe and `bookingAllowed` / `studio_not_linked` Book gate  
- `ENABLE_AMARE_SESS_ISSUE=0` returns AMARÉ session issue to dark  
- Identity tables can be ignored by live Book (Phase 1 additive contract)  
- No requirement to invalidate existing `mb_sess` cookies

Rollback = stop issuing / trusting `amare_sess` for product surfaces. Mindbody path still works as today.

## 6.11 Which existing Mindbody OAuth routes remain untouched?

Do not redesign these unless a later approved phase lists them:

| Route | Role |
|-------|------|
| `/api/mindbody/oauth/start` | Authorization redirect |
| `/api/mindbody/oauth/callback` | Code / `id_token` exchange, `mb_sess` set |
| `/api/mindbody/oauth/session` | Session probe for schedule / member UI |
| `/api/mindbody/oauth/logout` | Clear `mb_sess` |
| `/api/mindbody/oauth/complete-studio-profile` | Existing studio-client completion |
| `/api/mindbody/oauth/mobile-exchange` | App token exchange |
| `/api/mindbody/oauth/mobile-refresh` | App refresh |
| `/api/mindbody/oauth/mobile-revoke` | App revoke |
| `/api/mindbody/oauth/mobile-bridge` | App bridge |

2A may **call into** session-build after callback to attach identities. It must not replace token refresh, cookie format, or the session JSON the schedule already consumes, until a later phase says so.

## 6.12 How do we prevent creating two AMARÉ users for the same person?

- UNIQUE `(provider, provider_sub)` — one OIDC subject, one user.  
- Lookup mindbody `sub` and social `sub` **before** `createAmareUser`.  
- If `clientId` is already verified/linked, attach the new provider to that user after confirm — do not create user B and then collide.  
- Never merge two existing `amare_user_id`s because email matched.  
- Shared-computer confirm prevents “browser has Jane’s `mb_sess`, John signs in with Google” from silently fusing them (conflict / no steal).

We cannot perfectly detect “same human, two unused emails, no `mb_sess`.” That stays `candidate` / `ambiguous` / staff, not auto-merge.

## 6.13 How do we prevent one Studio `clientId` from being attached to two AMARÉ users?

Phase 1 D17, already proven on real Postgres:

- UNIQUE `(site_id, client_id)` WHERE `verified`/`linked`  
- UNIQUE `(amare_user_id, system, site_id)` WHERE `verified`/`linked`  
- `candidate` / `ambiguous` do not take the slot  
- `confirmAssociation` fails on collision; caller marks `conflict`

## 6.14 How will provider usage be measured?

Emit (no PII beyond ids already used in identity logs):

```text
login_provider = google | apple | email | mindbody
```

Also:

| Event | Meaning |
|-------|---------|
| `login_mindbody_already_linked` | Mindbody login, user already had verified/linked association |
| `login_mindbody_claim_success` | Mindbody login or `mb_sess` claim confirmed onto an AMARÉ user |
| `claim_conflict` | Sessions or proofs disagreed |
| `claim_ambiguous` | Two or more studio clients |
| `identity_attached_after_mindbody` | Google/Apple/Email attached onto a user who already had `mindbody` |
| `identity_attached_mindbody_after_social` | Mindbody attached onto a user who already had Google/Apple/Email |

Derived (batch, not a live gate):

```text
percent of active users whose only amare_identities row is provider=mindbody
```

Do not put `clientId` in these events beyond existing association logs.

## 6.15 Under what future conditions could Mindbody be hidden or retired?

Not now. Not on a calendar.

A later product decision may hide the button under “Other sign-in options” or recovery-only when **all** of the following stay true for a measured window:

- Mindbody-only identity share of active users is sustainably low  
- New successful claims that *need* Mindbody login (not just leftover `mb_sess`) are rare  
- Recovery volume does not spike when the button is de-emphasized  
- Staff still have a manual claim path

Even then: do not delete OAuth routes or `mb_sess` in the same change. Retirement of **code** is a later phase than retirement of **primary UI**.

---

# 7. Claim rules (unchanged, restated)

```text
1. Existing AMARÉ mapping (verified or linked) wins. Do not re-search email.
2. Valid mb_sess (unseal + refresh + client_id) = strong candidate. Confirm required.
3. Unique verified email match = candidate. Not auto-bind.
4. Email + phone on that same client = stronger candidate. Confirm required.
5. Duplicates / disagreeing emails without stronger proof = ambiguous or conflict.
6. Apple relay = no automatic bind, no automatic Studio Client create.
7. Social login alone never creates a Studio Client.
```

---

# 8. Two risks (do not solve in one booking PR)

```text
Authentication risk     Who is the user?
Authorization risk      May they act on this clientId?
Booking risk            Does the live class mutation use the new path?
```

2A answers the first, including legacy Mindbody as one more identity.  
2B answers the second.  
A future Book PR answers the third, after both are proven.

---

# 9. Intentionally open (only these)

| Item | Why it can wait |
|------|-----------------|
| Apple Services ID / Sign in with Apple | Deferred. Not a launch blocker. |
| Exact copy / placement of “Already use Mindbody with AMARÉ?” | 2A.7 launch UI, after Email OTP + Mindbody bridge |
| Whether launch UI first ships on `/login` only or also `/classes` | UX, 2A.7 — Book CTAs stay Mindbody |
| When production identity schema is published | After auth PRs merge; not required to finish this design |
| Waitlist Staff add/remove | Still unknown; still not a Phase 2 blocker |
| Calendar date to hide Mindbody | Forbidden; use §6.15 metrics |
| Later enablement of Google / Apple launch buttons | Future product decision; architecture already supports both |

**No longer open:**

- Google OAuth console / redirect configuration — locked and real-E2E proven. Production Google flag stays OFF; launch UI stays hidden.
- Email OTP vendor — locked and proven: Resend (`resend-email-client.mjs`).
- ConfirmAccount / “Finish creating your account” — locked 2026-08-17: Consumer Identity site activation, suppressed only by Manager **Suppress Consumer Identity Emails**. No AddClient flag. No D28 code change.
- Anonymous-purchase Email OTP auto-link — locked 2026-08-17 (D29). Production stays OFF.

---

# 10. Current scope boundary

This document remains the Phase 2 **design contract**. Google and Email OTP implementations have landed (production flags OFF). The current boundary is:

Do not:

- expose Google in the initial launch UI  
- implement Apple now  
- change live Book / Waitlist / Cancel / Dashboard  
- change app auth  
- issue production `amare_sess` as a Book source of truth  
- promote associations to `linked`  
- remove `consumerAssociated`  
- change Stripe  
- remove or redesign Mindbody OAuth  
- delete `mb_sess` support  

---

```text
DOCUMENT TYPE: DESIGN CONTRACT — APPROVED
IMPLEMENTATION: 2A.1–2A.3 + 2A.5 landed; 2A.6 Mindbody bridge next; Apple deferred; 2A.7 UI after 2A.6 review
GOOGLE: implemented, hidden at launch, production flag OFF
APPLE: deferred (provider=apple remains in the model)
LIVE BOOKING CHANGES: NONE
MINDBODY OAUTH: PRESERVED, DEMOTED TO LEGACY

LAUNCH PRIMARY: Email OTP
LAUNCH FALLBACK: Mindbody
GOOGLE: implemented, hidden at launch
APPLE: deferred
ONE PERSON: amare_user_id
IDENTITIES: google | apple | email | mindbody
ASSOCIATION: site + clientId (never on the identity row)

PHASE 2A: authentication (who)
PHASE 2B: authorization transition (may they)
STAFF BOOK: NOT IN 2A OR 2B
```
