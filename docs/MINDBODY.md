# אינטגרציית Mindbody – תיעוד פנימי (Amare)

מסמך זה מתעד מה הוגדר בפרויקט `amare-site` לצורך התחלה עם ה־Public API של Mindbody, בדיקות מול **Sandbox**, ומעבר מסודר ל־**Live** מאוחר יותר.

---

## מטרות

- להפסיק הסתמכות על **iframe embedding** בעתיד, ולבנות התאמות משלנו בעזרת **REST API**.
- להריץ בדיקות **מקומיות** ללא פריסה לאתר הייצור.
- להחזיק **תיעוד אחיד** של credentials, משתני סביבה, וסקריפטים שנוספו.

---

## קישורים רשמיים (Mindbody)

| מה | כתובת |
|-----|--------|
| פורטל מפתחים | [Mindbody Developers](https://developers.mindbodyonline.com/) |
| Public API – תיעוד UI | [Public API Documentation](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/mindbody-public-api-v6-0/introduction/getting-started) |
| Webhooks API | [Webhooks Getting Started](https://developers.mindbodyonline.com/ui/documentation/webhooks-api#/http/mindbody-webhooks-api/getting-started) |
| מסמך Webhooks (HTML) | [WebhooksDocumentation](https://developers.mindbodyonline.com/WebhooksDocumentation) |

---

## Sandbox מול Live

### Sandbox

- סביבה לפיתוח: נתוני ניסוי, לרוב עם **Studio / Site ID** כמו `-99` (ודא בפורטל אם עודכן).
- מתאים לאימות שהמפתחות והקריאות עובדות, **לא** לנתוני העסק האמיתיים.

### Live (Production)

- נדרש **`Request to Go Live`** בפורטל ותהליך אימות מהצד של Mindbody.
- לאחר האישור: **להפעיל את הקישור** (`activation`) בין חשבון המפתח לעסק ב־Mindbody (מפורט בתיעוד Public API ובמסע ה־Webhooks – השלב הבא לאחר לייב).
- אז מתקבלים / פעילים **מפתחות וזהית Site אמיתית** לפרודקשן (ודא בשירות Credentails בפורטל).

כשעוברים ל־Live, לעדכן בקבצי ההגדרה:

- **`MINDBODY_SITE_ID`** – זה ל־**Site ID החי** של Amare Wellness, לא `-99`.
- ודא שה־**API Key** בשימוש הוא זה שנועד לייצור לפי המדיניות בפורטל (יצירת מפתח נפרד לפרוד הוא Best Practice אם מתאימים).

---

## סוגי Credentials (מה יש במסך Credentials)

מתוך [API Credentials](https://developers.mindbodyonline.com/Account/Credentials) בערך:

| רכיב | שימוש |
|------|--------|
| **API Key** (טבלה "API Keys") | נשלח בכותרת HTTP בשם **`API-Key`** (כפי שמתואר בתיעוד Public / Webhooks). |
| **Source Name + Source Password** | שימוש בזרימות מופעלי אימות מתקדמות (למשל אסימוני משתמש/סטף, `usertoken` וכדומה) – לפי התיעוד לכל Endpoint. |

**אזהרות אבטחה**

- **לא לשלב** את `MINDBODY_API_KEY` או הסיסמה של ה־Source בקוד שרץ בדפדפן (bundle ציבורי).
- הקובץ **`.env`** ב־**`.gitignore`** – אל תעלה לגיט.
- בשירות פרודקשן: שמירה בסודות (Hosting secrets, KMS וכדומה).

---

## הגדרות בפרויקט

### משתני סביבה

1. העתיקו **`.env.example`** ל־**`.env`** בשורש הפרויקט.
2. מלאו לפחות **`MINDBODY_API_KEY`**. ל‑Sandbox בשלב ראשון שימרו **`MINDBODY_SITE_ID=-99`** עד שהפורטל מגדיר אחרת.

תוכן ההסבר בשדות – בקובץ **`.env.example`** עצמו.

### טעינת `.env` בפרויקט

הקבצים `scripts/load-env.mjs`, `mindbody-env.mjs`, `mindbody-ping.mjs`, `local-api-server.mjs` טוענים את `.env` מקומית (גם כשלא משתמשים ב־`node --env-file`).

---

## סקריפטים (npm)

| פקודה | תיאור |
|--------|--------|
| `npm run mindbody:ping` | קריאת בדיקה ל־**`GET /public/v6/site/sites`** מול `MINDBODY_API_HOST` (ברירת מחדל `api.mindbodyonline.com`) עם **`API-Key`** ו־**`SiteId`**. פלט: קוד תשובה + JSON מהשרת או טקסט שגיאה. |
| `npm run mindbody:proxy` | שרת HTTP מקומי על **`MINDBODY_LOCAL_PORT`** (ברירת מחדל **8787**). מקבל מהדפדפן בלי מפתח, ומהצד הפנימי מוסיף את הכותרות ל־Mindbody. |

**נקודות קצה בפרוקסי**

- `GET http://127.0.0.1:8787/health` – בדיקה שהפרוקסי רץ והעתק של `SiteId`/host.
- `GET http://127.0.0.1:8787/api/mindbody/site/sites` – גילום ל־`GET /public/v6/site/sites`.
- `GET http://127.0.0.1:8787/api/mindbody/class/classes?…` – גילום ל־`GET /public/v6/class/classes` עם אותן פרמטרי Query שמקבל השרת (למשל `StartDateTime`, `EndDateTime`, `HideCanceledClasses`, `Limit`).

### דף `classes-api.html` — לוז מעוצב מול API

באתר יש העתק לדף ההזמנות (`classes.html`) בנתיב Built: **`/classes-api`** (קובץ `classes-api.html`).

- הצגת שיעורים היא מתוך **Public API v6 · Get Classes** באמצעות הפרוקסי הנ"ל — הדפדפן **לא** מחזיק `API-Key`.
- **פילטרים** (בדפדפן על הנתון שנטען): תאריך מדויק, יום בשבוע (ב־ET), חתך שעה (בוקר/אחר־צהריים/ערב), מורה, סוג שיעור, והקלדה חופשית.
- בזמן build (מקומי או CI) נטען מ־**`.env`** או מ־`process.env` המשתנה **`SCHEDULE_PROXY_BASE`** (למשל `http://127.0.0.1:8787`) ונקבע מאפיין `data-mb-proxy` בעמוד. **אחרי עדכון `.env`** יש להריץ שוב **`npm run build`** או **`npm run dev`** כדי שהערך ישולב ל־`dist`.
- בפריסה פרוד צריך מאחור דומה עם HTTPS לאותן נקודות קצה (אין להפנות דפדפן לפרוקסי `localhost`).
- ההזמנה בפועל עדיין נעשית דרך **`classes.html`** (widget Mindbody).

### כפתור Book ותיעוד Mindbody

- **להזמנה דרך Public API בתוך המוצר שלך:** Mindbody מתארים שהפעולה נעשית דרך **רישום רשמת לקוח לשיעור** (`AddClientToClass` / מסלול מקביל) עם **זהות לקוח מורשית** — לרוב עם **JWT / טוקן משתמש** לאחר שהלקוח מחובר; זה צריך לרוץ **בשרת מהימן**, לא בדף סטטי בלבד. ראו [Public API Documentation](https://developers.mindbodyonline.com/ui/documentation/public-api).
- **במשטח סטטי (כמו הדף אצלנו):** אין לקרוא לצד עם מפתח API מהדפדפן. ברירת המחדל: כפתור **Book** על כל סלוט פותח את **`classes.html`** (ווידג'ט ההזמנות).
- **קישורים ישירים לסטודיו:** Mindbody מתארים מאמר ללקוחות על **יצירת קישורי הזמנה מותאמים**: [Creating Custom Online Booking Links](https://support.mindbodyonline.com/s/article/Creating-Custom-Online-Booking-Links).

בפרויקט:

- הגדר בתוך `.env` את **`MINDBODY_BOOK_URL_TEMPLATE`** — URL מאושר בסטודיו שלך, עם הפלייסהולדרים שתועדו ב‑`.env.example` (`{classId}`, `{classScheduleId}`, `{siteId}` וכו'). אחרי שינוי – **לבנות מחדש** את האתר.
- **`MINDBODY_BOOK_FALLBACK_REL`** יגדיר לאן משתמשים עוברים כשלא הוגדר template (ברירת מחדל: `classes.html`).

הערה: הפרוקסי מיועד **לפיתוח בלבד**; בפרודקשן משתמשים בבקנד מאובטח ותקף SSL.

---

## העברת הבקשה לשרת של Mindbody (סיכום טכני)

- **פרוטוקול:** HTTPS על JSON (פרטים מלאים – בתיעוד Public API הרשמי).
- כותרות בסיס בשימוש בסקריפטים הנוכחיים:
  - **`API-Key`**: ערך `MINDBODY_API_KEY`
  - **`SiteId`**: ערך `MINDBODY_SITE_ID`
- בסיס הנתיב בדוגמה: **`/public/v6/site/sites`**, ובדף הלוח גם **`/public/v6/class/classes`** עם Query strings.

כל שינוי בגרסה או בשמות כותרות – לעדכן לפי [תיעוד Public API העדכני](https://developers.mindbodyonline.com/ui/documentation/public-api).

---

## Webhooks – מתי צריך?

- ברירת התקשורת בסקריפטים הנוכחיים היא **קריאות Active (pull)** ל־Public API.
- **Webhooks** נדרשים כשמתעדכנים אוטומטית על אירועים מהעסק (push). דורשים:
  - URL ציבורי עם **HTTPS (TLS ≥ 1.2)** ותמיכה ב־**POST** ו־**HEAD** (מתוך [WebhooksDocumentation](https://developers.mindbodyonline.com/WebhooksDocumentation)).
  - אימות חתימה **`X-Mindbody-Signature`** מול המפתח שחוזר מיצירת מנוי.
- אפשר להשתמש **במפתח API זהה** ל־Public או במפתוח ייעודי – לפי תיעוד Mindbody והחלטה פנימית.

---

## רשימת בדיקה לפני / אחרי Live

לפני Live (Sandbox)

- [ ] יש **` .env`** מקומי עם **API Key** תקף.
- [ ] `npm run mindbody:ping` מחזיר **200** עם נתון תקני (לא 401/403 בשל מפתח).
- [ ] הגדרנו **`SCHEDULE_PROXY_BASE`** ב־`.env`, בנינו את האתר, והרצנו פרוקסי + פתיחת **`/classes-api.html`** עם נתוני Sandbox תקינים.

אחרי אישור Live

- [ ] עדכון **`MINDBODY_SITE_ID`** ל־ID החי של העסק.
- [ ] יצירה/rotation של **API Keys** פרוד בעת הצורך; עדכון סודות בפריסה.
- [ ] השלמת **Activation** עם העסק בפורטל (לפי מדריך Mindbody ל־"accessing business data").
- [ ] ביקור חוזר ב־[`Allowlist`](https://developers.mindbodyonline.com/) אם בשימוש (IP / כתובות).
- [ ] אם מתחילים Webhooks – פריסת endpoint פרוד עם TLS וסקריפט אימות חתימה.

---

## מבנה קבצים רלוונטי

```
.env.example           # תבנית משתני סביבה
.env                   # לא בגיט — יוצר מקומית
scripts/load-env.mjs
scripts/mindbody-env.mjs
scripts/mindbody-ping.mjs
scripts/local-api-server.mjs
src/content/classes-api.html
src/js/classes-schedule.js
docs/MINDBODY.md       # הקובץ הזה
```

---

## תמיכה מהצד של Mindbody

אם הבקשה ל־Go Live מתעכבת או שיש בעיית credentials, בהתאם להודעות בפורטל ניתן לפנות ל־כתובת כמו **`api@mindbodyonline.com`** שמוזכרת בתהליך ה־Go Live בפורטל.

---

## עדכון המסמך

כשרכיב באינטגרציה משתנה (Endpoints חדשים, OAuth, Webhooks פרודקשן), עדכנו במקום זה וב־**.env.example** כדי שמעבר מ־Sandbox ל־Live יישאר חד משמעי לכל הצוות.
