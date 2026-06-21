# AMARÉ App — Phase 0 Implementation

> **Status:** landed in repo (backend only). Mobile UI (`amare-app/`) not started yet.

Parent plan: [`AMARE-APP-PLAN.md`](./AMARE-APP-PLAN.md) §0.4 gate.

---

## Safety model

| Control | Effect |
|---------|--------|
| `ENABLE_MOBILE_BEARER_AUTH=0` (default) | Web unchanged — only `mb_sess` cookie auth |
| `ENABLE_MOBILE_BEARER_AUTH=1` | Mobile Bearer JWT **also** accepted on consumer API routes |
| Mobile OAuth endpoints | Return **404** when flag is OFF |
| `oauth/callback` | Same behavior — refactored to shared session builder, no UX change |

**No changes** to `src/js/*`, `dist/`, or static HTML.

---

## New files

| File | Role |
|------|------|
| `netlify/functions/mobile-auth-lib.mjs` | JWT issue/verify, kill switch |
| `netlify/functions/mindbody-oauth-session-build.mjs` | Shared OAuth token → session payload |
| `netlify/functions/mindbody-oauth-mobile-exchange.mjs` | `POST …/mobile-exchange` |
| `netlify/functions/mindbody-oauth-mobile-refresh.mjs` | `POST …/mobile-refresh` |
| `netlify/functions/mindbody-oauth-mobile-revoke.mjs` | `POST …/mobile-revoke` |

## Modified files

| File | Change |
|------|--------|
| `mindbody-consumer-lib.mjs` | `resolveSessionFromRequest()` + Bearer in `getSessionWithConsumerHeaders` |
| `mindbody-oauth-callback.mjs` | Uses shared session builder (behavior preserved) |
| `mindbody-oauth-start.mjs` | `?platform=mobile` when flag + mobile redirect URI set |
| `oauth-lib.mjs` | `mobileRedirectUri()` |
| `netlify.toml` | 3 new redirects |

---

## Env vars (enable for mobile testing)

```env
ENABLE_MOBILE_BEARER_AUTH=1
MINDBODY_OAUTH_MOBILE_REDIRECT_URI=amare://oauth/callback
# Optional:
# MOBILE_JWT_SECRET=...
```

Register `MINDBODY_OAUTH_MOBILE_REDIRECT_URI` in Mindbody Developer Portal (in addition to web callback).

---

## API routes

| Method | Path | Body |
|--------|------|------|
| GET | `/api/mindbody/oauth/start?platform=mobile` | — → Mindbody authorize (query mode) |
| POST | `/api/mindbody/oauth/mobile-exchange` | `{ "code", "state" }` |
| POST | `/api/mindbody/oauth/mobile-refresh` | `{ "refreshToken" }` |
| POST | `/api/mindbody/oauth/mobile-revoke` | — |

After exchange, call existing APIs with:

```http
Authorization: Bearer <accessToken>
```

Works on all routes using `getSessionWithConsumerHeaders` / `resolveConsumerClient` (book, cancel, member/summary, etc.).

---

## Phase 0 gate checklist

- [x] `mobile-exchange` + `mobile-refresh` + `mobile-revoke`
- [x] `resolveSessionFromRequest()` — cookie **and** Bearer
- [ ] Deep link OAuth callback on device (`amare://oauth/callback`)
- [ ] E2E: login → `member/summary` → `class/book` with Bearer
- [ ] Regression: `/classes` + `/member` with cookie — **no change**

---

## Phase 1 — landed

- `amare-app/` — Capacitor + React (Schedule, My Classes, Profile)
- `GET /api/mindbody/oauth/mobile-bridge` — OAuth redirect for local dev (ngrok)

See [`amare-app/README.md`](../amare-app/README.md) for local run steps.

---

## הרצה מקומית

### מה אפשר להריץ **עכשיו**

| מה | קיים? |
|----|--------|
| **אפליקציה native** (`amare-app/`) | ❌ עדיין לא — Phase 1 |
| **האתר** (`/classes`, `/member`) | ✅ |
| **API mobile** (Bearer auth) | ✅ — Phase 0 |

### 1. הפעלת שרת פיתוח

```powershell
cd c:\Users\snir1\amare-site
npm run dev
```

ברירת מחדל: **http://127.0.0.1:4321**

- `/classes` — לוח שיעורים + בוקינג (אתר, קוקי)
- `/member` — פרופיל (אתר, קוקי)

### 2. הפעלת mobile auth (אופציונלי — לבדיקת API)

הוסף ל-`.env`:

```env
ENABLE_MOBILE_BEARER_AUTH=1
MINDBODY_OAUTH_MOBILE_REDIRECT_URI=https://YOUR-TUNNEL.ngrok-free.app/api/mindbody/oauth/callback
```

> **שימו לב:** Mindbody דוחה `http://127.0.0.1` ל-OAuth. לבדיקת login mobile צריך **ngrok** (או tunnel) שמפנה לפורט **4321** (`npm run dev`), לא 8787.

רישום ב-Mindbody Developer Portal:
- Web callback (קיים): `https://…/api/mindbody/oauth/callback`
- Mobile (לבדיקות): אותו HTTPS tunnel **או** deep link `amare://oauth/callback` (רק אחרי Phase 1 + אפליקיה)

### 3. בדיקה שהאתר לא נשבר (regression)

1. `npm run dev`
2. פתח http://127.0.0.1:4321/classes
3. Sign in with Mindbody → Book class
4. פתח http://127.0.0.1:4321/member — summary נטען

עם `ENABLE_MOBILE_BEARER_AUTH=0` (ברירת מחדל) — זה בדיוק ההתנהגות של production.

### 4. בדיקת Bearer API (בלי אפליקיה — curl / Postman)

**א.** התחברות רגילה באתר → DevTools → Application → Cookies → העתק ערך `mb_sess` (או השתמש ב-session אחרי login).

**ב.** לחלופין, flow mobile מלא (דורש tunnel + `ENABLE_MOBILE_BEARER_AUTH=1`):

1. GET `https://YOUR-TUNNEL/api/mindbody/oauth/start?platform=mobile` → עקוב אחרי redirect
2. התחבר ב-Mindbody → קבל `code` + `state` מה-callback
3. POST `/api/mindbody/oauth/mobile-exchange`:

```json
{ "code": "…", "state": "…" }
```

4. קבל `accessToken` → קרא:

```http
GET /api/mindbody/member/summary
Authorization: Bearer <accessToken>
```

### 5. מתי תהיה אפליקיה לראות על המסך?

**Phase 1** — `amare-app/` עם Capacitor:

```powershell
cd amare-app
npm install
npm run dev          # preview בדפדפן
npx cap run ios      # סימולטור iOS (Mac)
npx cap run android  # אמולטור Android
```

זה השלב הבא — עדיין לא קיים ב-repo.
