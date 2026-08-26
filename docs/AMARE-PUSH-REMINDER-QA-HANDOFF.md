# AMARÉ Push — Reminder QA handoff

**Date frozen:** 22 Aug 2026, ~01:07 IDT  
**Purpose:** continue reminder E2E tomorrow without re-litigating accepted work.  
**Branch:** `main`  
**Site:** `silly-bubblegum-ad7f6c` / `https://www.amarewellness.com`

---

## Start here tomorrow

1. Do **not** enable `ENABLE_AMARE_PUSH=1`.
2. Do **not** modify Book / Cancel / Class-cancelled pipelines.
3. Do **not** fake FCM or manually invoke the reminder worker to prove send.
4. Do **not** start waitlist production E2E.
5. Do **not** use `netlify deploy --prod` from CLI (drops Neon DB bindings). Deploy only via **git push → Netlify auto-deploy**.
6. Book via **website** if the app Book button still errors.
7. Pick a class that starts in **25–40 minutes** (more than 10 minutes, not days away).
8. After booking, verify webhook → reminder row with **10-minute QA lead** → wait for the scheduled worker → exactly one `class_reminder` on S25.

The Sunday Perreo booking is **not** the phone E2E. Its reminder is due **Sun 30 Aug 2026, 8:20 AM** studio time.

---

## Accepted — do not reopen

| Item | Status |
|---|---|
| S25 visual QA / notification branding | PASS — do not change icons/colors/channel |
| Production FCM transport (Netlify → HMAC → Cloud Run → FCM) | PASS |
| BOOKING AUTO PUSH | PASS |
| CANCELLATION AUTO PUSH | PASS |
| CLASS CANCELLED PUSH | PASS |
| Class name / title enrichment | PASS — never `itemName` |
| Mindbody webhook signature (official Base64 HMAC) | PASS |
| Waitlist implementation | READY — production E2E **DEFERRED** |

---

## Reminder worker — current production

| Field | Value |
|---|---|
| REMINDER WORKER | READY |
| COMMIT | `545f6f1` |
| WORKER DEPLOY | `6a88c9519229080008ee2f40` |
| WORKER FUNCTION | `amare-notification-reminder-scan` |
| WORKER CADENCE | every 10 minutes (`*/10 * * * *` in `netlify.toml`) |
| PRODUCTION REMINDER LEAD | **1440** minutes |
| QA REMINDER LEAD | **10** minutes |
| QA USER RESTRICTION | PASS |
| REMINDER ATOMIC CLAIM | PASS (unit + store) |
| DUPLICATE PROTECTION | PASS (unit) |
| CANCEL SUPPRESSION | PASS (unit) |
| CLASS CANCEL SUPPRESSION | PASS (unit) |
| TIME CHANGE RESCHEDULE | PASS (unit) |
| RETROACTIVE REMINDER SUPPRESSION | PASS (unit) |
| CLASS NAME ENRICHMENT | PASS |
| REMINDER AUTO PUSH FOR NORMAL USERS | OFF |
| ENABLE_AMARE_PUSH | `0` |
| ENABLE_AMARE_PUSH_TEST | `1` |
| Physical S25 reminder E2E | **NOT DONE** |

Send path (unchanged, proven):

```
Netlify worker → Cloud Run amare-push-relay → FCM → S25
```

Cloud Run: `https://amare-push-relay-xzwxurau3a-uc.a.run.app`  
HMAC headers: `X-Amare-Relay-Timestamp` + `X-Amare-Relay-Signature`  
Do **not** create/export a Google SA JSON key. `FIREBASE_SERVICE_ACCOUNT_JSON` stays UNSET.

---

## QA identity

| Field | Value |
|---|---|
| Email | `snir5@pic-smart.com` |
| Mindbody client | `100002726` |
| AMARÉ user | `usr_WHB3H2RMWAMGC7S8YYTXTG` |
| Android package | `com.amarewellness.app` |
| Last known installation | `ins_c69859dd04d23f6b8021d6fd` — android, permission granted, active, token present, owner match |
| Last seen (at freeze) | `2026-08-21T20:48:29.104Z` |

Stay signed in on the S25. Logout revokes the installation.

QA lead gate (do not change global 1440):

- Default: `reminderLeadMinutes()` = **1440** (`AMARE_CLASS_REMINDER_LEAD_MINUTES` or code default).
- QA override: if `ENABLE_AMARE_PUSH_TEST=1` and `ENABLE_AMARE_PUSH≠1`, user `usr_WHB3H2RMWAMGC7S8YYTXTG` gets **10** minutes.
- Optional env (not set in Netlify Production at freeze; fallback above is live):
  - `AMARE_PUSH_QA_REMINDER_USER_ID`
  - `AMARE_PUSH_QA_REMINDER_LEAD_MINUTES`
- After public release: remove the 10-minute override. Do **not** leave it on.

Worker send gate during this QA:

- May deliver `class_reminder` **only** for the QA user.
- Normal users: listed/claimed/sent = no.
- Book/Cancel/Class-cancel auto-deliver stays as already accepted. Do not reopen.

---

## Reminder copy (final production)

- **Title:** `Class tomorrow ✨`
- **Body:** `{Class Name} · {formatted America/New_York date/time}`
- **Data:** `kind=class_reminder`, `path=/my-classes`, `classId=<classId>`
- Same class-name enrichment as Book/Cancel/Class-cancelled.
- Never `itemName` (that is the pricing option).

---

## State rules (already implemented)

**Booking created**

- Class start more than lead minutes away → one `scheduled` reminder.
- Class start already within lead → `suppressed` (no retroactive reminder).

**Booking cancelled**

- Pending reminder → `cancelled`.
- Worker must never send it.

**Class cancelled**

- All pending reminders for that class → `cancelled`.

**Class start time changed**

- Recompute `scheduledFor` from the new `classStartDateTime`.
- If new due is already past → `suppressed` (no retroactive send).

**Waitlist**

- Waitlist-only → no reminder.
- Promotion → reminder only if the new due time is still in the future.
- Production waitlist E2E remains deferred.

Worker runtime checks before send:

1. Find due (`status=scheduled` AND `scheduled_for <= now`)
2. Atomic claim `scheduled → due`
3. Re-check booking still booked
4. Class still active
5. Not already sent
6. `class_reminders` preference on
7. Current **owned** active installation (owner must still match)
8. Send via relay
9. Mark `sent` + `sentAt` exactly once

Second worker tick must not resend.

---

## Current live booking (not the phone E2E)

Website book of **Perreo Sculpt (Not heated but spicy)** — Sun 30 Aug 2026, 8:30 AM ET.

| Field | Value |
|---|---|
| Booking | `26350` |
| Class | `17324` |
| Status | `booked` |
| Owner | QA user match |
| Class name persisted | `Perreo Sculpt (Not heated but spicy)` |
| Webhook | `classRosterBooking.created` `Ji8RXtJ76GvH4JEMGdRaGj` processed `2026-08-21T22:01:17Z` |
| Reminder | `rem_48d4d60aece64666a3c805b0` |
| Reminder status | `scheduled` |
| `classStartAt` | `2026-08-30T12:30:00.000Z` |
| `scheduledFor` | `2026-08-30T12:20:00.000Z` (**10 min lead — QA correct**) |
| `claimedAt` / `sentAt` | null |
| `class_reminder` candidate | none yet (correct — not due) |
| `booking_created` candidate | delivered (existing Book QA — ignore) |

Older cancelled QA bookings still show **1440** lead because they were created **before** `545f6f1`. That is expected.

This Sunday reminder will sit until 30 Aug 08:20 AM ET. Keep or cancel it; it does not block a nearer QA booking.

---

## App Book error

The S25 app Book button failed. The Perreo reservation was created on the **website**. Website book is valid for reminder QA because Mindbody still emits `classRosterBooking.created`.

Do **not** debug app Book as part of reminder E2E unless the user asks. If debugging later: do not change Book/Cancel Push pipelines.

---

## Tomorrow — first physical reminder E2E

### User

1. Stay signed in on S25 (`snir5@pic-smart.com`).
2. Book **one** future class via website (or app if Book works).
3. Class start must be **> 10 minutes** away so the reminder is `scheduled`, not `suppressed`.
4. Prefer **25–40 minutes** away so the 10-minute worker can send the same evening.
5. Not waitlist.

### Agent (after user says they booked)

Use `scripts/_tmp-inspect-reminder-qa-booking.mjs` (gitignored) or the same read-only DB inspect pattern.

Confirm:

- [ ] Inbox: `classRosterBooking.created` processed
- [ ] Roster row: `booked`, owner = QA user, real class name (not `itemName`)
- [ ] Reminder: `scheduled`, lead = **10** minutes (`scheduledFor = classStartAt − 10m`)
- [ ] `claimedAt` / `sentAt` still null before due
- [ ] No `class_reminder` / `class_reminder_due` candidate before due
- [ ] Worker logs (`amare-notification-reminder-scan`) do not send before due
- [ ] After due + next 10-minute tick: exactly **one** send
- [ ] Reminder `status=sent`, `sentAt` set
- [ ] Candidate `class_reminder_due` delivered once
- [ ] Relay / Cloud Run / FCM path — no manual FCM
- [ ] Second worker tick does not resend

Then **STOP** so the user can confirm on S25:

- one notification
- title `Class tomorrow ✨`
- body `{Class Name} · {studio-local time}`
- tap opens My Classes

### Do not do tomorrow until the first send passes

- Cancel-before-due safety test
- Enable `ENABLE_AMARE_PUSH=1`
- Remove the 10-minute QA override
- Waitlist promotion E2E
- Another generic `push_test`

---

## Later — cancel-before-due (not tomorrow’s first step)

New QA booking → reminder `scheduled` → user cancels **before** due → reminder `cancelled` → wait past QA due → **zero** reminder Push.

---

## After all reminder QA

Do **not** leave the 10-minute override on for public release.

Final production:

- Reminder lead: **1440**
- Worker cadence: **10 minutes**
- Then enable the V1 set: `booking_created`, `booking_cancelled`, `class_cancelled`, `class_reminder`
- Waitlist promotion stays implemented, E2E deferred

---

## Key files

| File | Role |
|---|---|
| `netlify/functions/amare-notification-reminder-scan.mjs` | Scheduled worker (modern runtime, no named `handler`) |
| `netlify/functions/amare-notification-reminder-send.mjs` | Claim / checks / relay send / mark sent |
| `netlify/functions/amare-notification-lib.mjs` | Reminder planning on webhook state |
| `netlify/functions/amare-notification-copy.mjs` | Reminder copy |
| `netlify/functions/amare-notification-store.mjs` | Due list, atomic claim, `sent_at` |
| `netlify/functions/amare-notification-auto-deliver.mjs` | Book/Cancel QA only — **do not change** |
| `netlify/database/migrations/20260821221000_amare_reminder_send.sql` | `claimed_at`, `sent_at` (already applied) |
| `scripts/qa-amare-notifications-reminder.mjs` | Unit/integration checks |
| `scripts/_tmp-inspect-reminder-qa-booking.mjs` | Read-only prod inspect (gitignored) |

Inspect command:

```bash
node scripts/_tmp-inspect-reminder-qa-booking.mjs
```

Worker logs:

```bash
npx netlify logs --source functions --function amare-notification-reminder-scan --since 2h --json
npx netlify logs --source functions --function mindbody-webhooks-schedule --since 1h --json
```

Never print FCM tokens, relay secrets, webhook keys, or `FIREBASE_SERVICE_ACCOUNT_JSON`.

---

## Hard constraints (carry forward)

- Named `handler` export forces Netlify runtime v1 and drops Neon bindings. Auth/DB functions use `export async function lambdaHandler` + `export default withLambda(...)`.
- `itemName` on roster webhooks is the pricing option, never the class name.
- Mindbody Reservation Reminder **email** is separate. AMARÉ owns native Push timing from `classStartDateTime`.
- Org policy blocks SA JSON key creation. Keyless Cloud Run + HMAC stays required.

---

## Tomorrow return (after user books a near class)

Fill this only after inspect — do not invent:

```
BOOKING WEBHOOK: PASS/FAIL
REMINDER ROW: scheduled / suppressed / missing
QA LEAD MINUTES: <n>
DUE AT: <ISO>
WORKER SENT YET: YES/NO
CLASS_REMINDER CANDIDATE: none / pending / delivered
SAFE TO WAIT FOR WORKER: YES/NO
```
