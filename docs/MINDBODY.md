# אינטגרציית Mindbody – תיעוד פנימי (Amare)

מסמך זה מתעד מה הוגדר בפרויקט `amare-site` לצורך התחלה עם ה־Public API של Mindbody, בדיקות מול **Sandbox**, ומעבר מסודר ל־**Live** מאוחר יותר.

---

## מטרות

- להפסיק הסתמכות על **iframe embedding** בעתיד, ולבנות התאמות משלנו בעזרת **REST API**.
- להריץ בדיקות **מקומיות** ללא פריסה לאתר הייצור.
- להחזיק **תיעוד אחיד** של credentials, משתני סביבה, וסקריפטים שנוספו.

---

## תוכנית עבודה מוצרית: פיתוח API מול הנתיבים הקיימים

**מטרת השלב הנוכחי:** לפתח ובדוק אינטגרציה עם **Mindbody Public API** (ורכיבים עתידיים שתלויים בשרת) **בלי לשלב מיד** את הפיצ’ר בעמודים הציבוריים המרכזיים של האתר.

1. **מסלול פיתוח מופרד**  
   להמשיך לעבוד בדפים ונתיבים **ייעודיים** למשימה (כיום בעיקר **`/classes-api`** וקבציו ב־`src/content`). אלה עמודי בדיקה/מוצר־Tech — לא מה שמושק כרגע לכל הגולשים דרך התפריט הראשי והמבנה הקיים של האתר.

2. **מה זה לא אומר מבחינת אבטחה**  
   עמוד שנמצא בנתיב „בלי קישור” על דומיין פרודקשן **עדיין נגיש** למי שיודע או מנחש את ה־URL. אם צריך **הגבלה אמיתית** לפני השקה — עדיף סביבת **staging / Deploy Preview** עם סיסמת גישה (למשל ב־Netlify) מאשר הסתמכות על הסתרת הנתיב בלבד.

3. **איחוד בסוף („מיזוג” עם האתר)**  
   לאחר שהלוח וה־API יציבים ומאושרים במדיניות העסק:  
   להוסיף או להחליף **קישורים ותוכן** מתוך הנתיבים הציבוריים הקיימים (תפריט, עמודי שיעורים, CTA וכו’) — **בלי להחליף עקרונית את מימוש הבקנד** לאותן נקודות קצה מאובטחות (פרוקסי / Functions), אלא בהתאם לצורך פרוד בתוספת הגנות ובדיקות.

---

## תכנון Auth (Mindbody OAuth)

ההחלטה המוצרית והטכנית לשלב ההתחברות:

1. **סוג האפליקציה בפורטל**  
   **Web** (`OAuth Client` עם `Client Secret` בשרת בלבד) — מתאים לזרימה הקיימת בפרויקט (**Netlify Functions**).

2. **Redirect URI באתר פרודקשן**  
   לרשום בפורטל Mindbody ולהגדיר ב־Netlify (משתנה **`MINDBODY_OAUTH_REDIRECT_URI`**) באותה מחרוזת מדויקת, למשל:  
   `https://www.amarewellness.com/api/mindbody/oauth/callback`  
   (או אליאס דומיין אחר פעיל — חשוב שהכתובת בפועל ובפורטל יהיו **זהים תו בתו**.)

3. **למה לא מקומי ב־`http://`**  
   במסך יצירת ה־Client, Mindbody דורשים שה־Redirect יהיה **ב־`https`**; כתובת מקומית מסוג **`http://127.0.0.1`** נדחית. לכן:  
   - **ברירת מחדל:** לבדוק Auth **מול הפריסה** (פרודקשן או preview עם HTTPS).  
   - **חלופה:** מנהרת HTTPS (נגוק / Cloudflare Tunnel וכו’) שמפנה למחשב המפתח — ואז להירשם בפורטל עם כתובת ה־`https` של המנהרה (ואופציה להוספת Redirect נוסף בפורטל ל־**Deploy Preview**, אם יש דומיין יציב או מתעדכן בתהליך).

4. **התחברות מול הנתיבים המופרדים**  
   ה־**callback תמיד** נשאר **`/api/mindbody/oauth/...`** (Functions). מקור ההתחברות יכול להיות מכל עמוד בדומיין (למשל רק **`/classes-api`** בתחילה). כשנאחד חוויה לאתר: מוסיפים כפתורים/קישורים **מבלי להחליף** את נתיב ה־callback, כל עוד נשארים על אותו **origin** (אותו דומיין + HTTPS).

5. **שלבים עתידיים אחרי Auth**  
   כפי שמפורט **להלן** בסעיף „מימוש קיים: OAuth Consumer ב־Netlify”: אחרי ש־OAuth עובד end-to-end, השלב הבא במוצר הוא **קריאות API משרת** עם Bearer של המשתמש (למשל הרשמה לשיעור) — תוך שמירה על **Book** כ־fallback (template / ווידג’ט) עד שהמסלול המלא מאושר.

---

## קישורים רשמיים (Mindbody)

| מה | כתובת |
|-----|--------|
| פורטל מפתחים | [Mindbody Developers](https://developers.mindbodyonline.com/) |
| Public API – תיעוד UI | [Public API Documentation](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/mindbody-public-api-v6-0/introduction/getting-started) |
| Consumer API – דף בסיסי בפורטל | [Consumer API (Developer Portal)](https://developers.mindbodyonline.com/ui/documentation/consumer-api) |
| Consumer Activity API (תיעוד HTML) | [ConsumerDocumentation](https://developers.mindbodyonline.com/ConsumerDocumentation) |
| תשתית התחברות / אינטגרציית OAuth (מצד המשתמש) | [Mindbody OAuth – Application integration](https://auth.mindbodyonline.com/appintegration) |
| Webhooks API | [Webhooks Getting Started](https://developers.mindbodyonline.com/ui/documentation/webhooks-api#/http/mindbody-webhooks-api/getting-started) |
| מסמך Webhooks (HTML) | [WebhooksDocumentation](https://developers.mindbodyonline.com/WebhooksDocumentation) |
| OAuth Web App לדוגמה (GitHub רשמי) | [`mindbody/PartnerOAuthWebApp`](https://github.com/mindbody/PartnerOAuthWebApp) |

**קישורי תיעוד UI (פתיחה מהירה – אותן כתובות כמו בטבלה):**

- **Public API v6 · Getting Started:** [`https://developers.mindbodyonline.com/ui/documentation/public-api#/http/mindbody-public-api-v6-0/introduction/getting-started`](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/mindbody-public-api-v6-0/introduction/getting-started)
- **Webhooks API · Getting Started:** [`https://developers.mindbodyonline.com/ui/documentation/webhooks-api#/http/mindbody-webhooks-api/getting-started`](https://developers.mindbodyonline.com/ui/documentation/webhooks-api#/http/mindbody-webhooks-api/getting-started)

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

## מדריכי Public API (Tutorial) מול מסך ה־Credentials שלכם

המסמכים שהפנית אליהם נמצאים תחת אותו **Public API v6** ב־UI:

- [Getting Started – Public API v6](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/mindbody-public-api-v6-0/introduction/getting-started)
- [Tutorial · Add a new client](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/tutorials/add-a-new-client)
- [Tutorial · Book a client into a class](https://developers.mindbodyonline.com/ui/documentation/public-api#/http/tutorials/book-a-client-into-a-class)

**מה הם מניחים בפועל (בקיצור לפי הדוגמאות בכל tutorial):**

1. **כותרות HTTP** — בדרך־כלל **`API-Key`** + **`SiteId`** (כפי שמתואר ב־Getting Started).
2. **גוף הבקשה** — בדוגמאות ל־**Add client** / **Book into class** מופיעים לרוב **`SourceCredentials`** (Source Name + Password + SiteIDs) — אלה **אותם ערכים** ממקטע **Public API Source Credentials** במסך **API Credentials** שצילמת, **לא** `MINDBODY_OAUTH_CLIENT_ID`.
3. **הרשאות מורחבות** — לפי endpoint ולמדיניות העסק, המדריך יכול לכלול גם **אימות משתמש צוות** (למשל User Token / `UserCredentials` במסלול “business”) — יש לעקוב אחרי **הדוגמה המלאה** באותו עמוד tutorial בפורטל, כי היא משתנה בין גרסאות.

**מסקנה:** העובדה שבעמוד **API Credentials** אין “עוד” רשומה בשם OAuth **לא חוסמת** את מסלול **Add Client** / **AddClientToClass** מתוך **שרת מהימן** — במסלול הזה בסיס ההרשאה הוא **מה שיש לך היום: API Key + Source**, בתוספת כל מה שהטוטוריאל מחייב (למשל staff token כשמתואר).

**OAuth נפרד** נשמר לזרימה שבה **הדפדפן/האפיקציה** מזהים **לקוח קצה** דרך [Application integration](https://auth.mindbodyonline.com/appintegration) וה־**Consumer APIs** — זה **מוצר הגדרות אחר בפורטל**, לא חלפת מסך Source ב־Public API Tutorial.

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
| `npm run dev` / **`npm run dev:full`** | **שרות פיתוח מאוחד** (`scripts/unified-local-dev.mjs`): בונה את `dist/`, משרת HTML/CSS/JS, וממפה **`/api/mindbody/*`** ללוגיקה של Netlify Functions (כולל OAuth, Sale, Member). ברירת מחדל: **`LOCAL_FULL_DEV_PORT=4321`** (ניתן לשנות ב־`.env`). **זה מה שצריך כשפותחים דפים דרך מנהרת HTTPS.** |
| `npm run dev:static` | `live-server` על קבצים סטטיים בלבד — **אין** נתיבי `/api/mindbody/*` (404). מתאים לעריכת תוכן ללא OAuth/Sale בלבד. |
| `npm run preview` | `npm run build` ואז הגשת **`dist`** על פורט **4321** — מתאים לבדוק build; ל־API צריך עדיין שרת עם handlers (לא תמיד מלא כמו `dev:full` — העדף `dev:full` לבדיקות Mindbody מקצה לקצה). |
| `npm run mindbody:ping` | קריאת בדיקה ל־**`GET /public/v6/site/sites`** מול `MINDBODY_API_HOST` (ברירת מחדל `api.mindbodyonline.com`) עם **`API-Key`** ו־**`SiteId`**. פלט: קוד תשובה + JSON מהשרת או טקסט שגיאה. |
| `npm run mindbody:proxy` | שרת HTTP מקומי על **`MINDBODY_LOCAL_PORT`** (ברירת מחדל **8787**). **רק** `GET`: health, `site/sites`, `class/classes` — לא OAuth, לא `sale/*`, לא `stored-cards`, לא checkout. |

**נקודות קצה בפרוקסי (**`8787`**)**

- `GET http://127.0.0.1:8787/health` – בדיקה שהפרוקסי רץ והעתק של `SiteId`/host.
- `GET http://127.0.0.1:8787/api/mindbody/site/sites` – גילום ל־`GET /public/v6/site/sites`.
- `GET http://127.0.0.1:8787/api/mindbody/class/classes?…` – גילום ל־`GET /public/v6/class/classes` עם אותן פרמטרי Query שמקבל השרת (למשל `StartDateTime`, `EndDateTime`, `HideCanceledClasses`, `Limit`).

### דף `classes-api.html` — לוז מעוצב מול API

באתר יש העתק לדף ההזמנות (`classes.html`) בנתיב Built: **`/classes-api`** (קובץ `classes-api.html`).

- הצגת שיעורים היא מתוך **Public API v6 · Get Classes** באמצעות הפרוקסי הנ"ל — הדפדפן **לא** מחזיק `API-Key`.
- **פילטרים** (בדפדפן על הנתון שנטען): תאריך מדויק, יום בשבוע (ב־ET), חתך שעה (בוקר/אחר־צהריים/ערב), מורה, סוג שיעור, והקלדה חופשית.
- בזמן build (מקומי או CI) נטען מ־**`.env`** המשתנה **`SCHEDULE_PROXY_BASE`**: כשהוא **ריק**, הדף משתמש ב־**יחסי** same-origin (`data-mb-proxy` ריק — המלצה ל־`dev:full`/Netlify). אם מוגדר (למשל `http://127.0.0.1:8787` במסלול פרוקסי־בלבד ישן), הערך משולב כ־**`__MB_SCHEDULE_ORIGIN__`** ב־HTML. **אחרי עדכון `.env`** יש להריץ **`npm run build`** או שה־`dev:full` יבנה מחדש כדי לעדכן את `dist`.
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

## פיתוח מאוחד, מנהרות (Tunnel), ו־`SCHEDULE_PROXY_BASE`

### למה לא מפנים ngrok ל־8787

- **`npm run mindbody:proxy` (8787)** מטפל רק ב־**GET** ציבוריים (לוח, sites).  
- **OAuth**, **`/api/mindbody/sale/*`**, **`/api/mindbody/client/stored-cards`**, **`/api/mindbody/member/*`** וכו’ ממומשים ב־**Netlify Functions** ומסולרים ב־**`dev:full`** דרך `scripts/mindbody-public-routes.mjs` (אותה לוגיקה כמו `netlify.toml`).
- אם מנהרה מצביעה על **8787** או על שרת סטטי בלי Functions — תקבלו **404** על נתיבי Sale/Checkout/כרטיסים, גם אם עמוד ה־HTML נטען.

### מה לעשות נכון עם Tunnel (ngrok, Cloudflare Tunnel, LocalTunnel…)

1. להריץ **`npm run dev:full`** (או `npm run dev`).
2. להפנות את המנהרה ל־**`LOCAL_FULL_DEV_PORT`** (ברירת מחדל **`4321`**), לא ל־8787.
3. לפתוח את האתר **רק** מכתובת ה־**HTTPS** של המנהרה (עוגיית `mb_sess` קשורה ל־host).
4. **Mindbody OAuth:** בפורטל, ה־**Redirect URI** חייב להתאים בדיוק ל־`https://<המנהרה>/api/mindbody/oauth/callback` (במקביל לפרודקשן — אפשר מספר Redirects רשומים).
5. **ngrok Free / דפדפן:** לעיתים מוחזר **HTML** (דף אזהרה) במקום JSON — אז בקונסול יופיעו שגיאות כמו **`site.webmanifest` Syntax error בשורה 1** (הדפדפן מנסה לפרסר HTML כ־JSON manifest). זה **תסמין לבעיית upstream / interstitial**, לא בהכרח קובץ manifest פגום בפרויקט. בקוד הדפדפן נשלחת כותרת **`ngrok-skip-browser-warning: true`** לבקשות API כשה־host מזוהה כ־ngrok (`src/js/pricing-api.js` וקבצים נלווים).
6. **`SCHEDULE_PROXY_BASE` בזמן מנהרה:**  
   - אם נשאר **ריק** והדפדפן נפתח מכתובת המנהרה — הקריאות ל־API הן **יחסיות** לאותו origin (נכון).  
   - אם בונים עם ערך מפורש (נדיר) — ודאו שהוא **בדיוק** בסיס ה־HTTPS של המנהרה, בלי סלאש סופי מיותר, כדי ש־`data-mb-proxy` בעמודים יתאים.

### מעבר מ־Tunnel ל־**Production ב־Netlify** (אחרי Deploy)

| נושא | Tunnel / מחשב מפתח | Netlify Production |
|------|---------------------|---------------------|
| **שרת** | `dev:full` על 4321 + מנהרה | אתר סטטי מ־`dist/` + **Functions** מתוך `netlify/functions` |
| **מיפוי API** | `scripts/mindbody-public-routes.mjs` + `unified-local-dev` | **`netlify.toml`** — `[[redirects]]` מ־`/api/mindbody/...` ל־`/.netlify/functions/...` (**חובה** שיהיו בפריסה; בלי זה — 404) |
| **`MINDBODY_OAUTH_REDIRECT_URI`** | `https://<tunnel>/api/mindbody/oauth/callback` | **`https://<דומיין פרוד אמיתי>/api/mindbody/oauth/callback`** — לעדכן בפורטל Mindbody **וב־Environment ב־Netlify** באותה מחרוזת |
| **`SCHEDULE_PROXY_BASE`** | לרוב ריק או בסיס המנהרה לבדיקות | **ריק (מומלץ)** — הדפדפן קורא ל־`/api/mindbody/...` **באותו דומיין** של האתר; ראו `scripts/build.mjs` (`MB_SCHEDULE_ORIGIN` → `__MB_SCHEDULE_ORIGIN__` / `data-mb-proxy`) |
| **סודות / מפתחות** | `.env` מקומי | **Site settings → Environment variables** ב־Netlify: `MINDBODY_API_KEY`, `MINDBODY_OAUTH_*`, `MINDBODY_SESSION_SECRET`, Source אם נדרש, וכו’ |
| **`MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT`** | לבדיקות מקומיות ב־`.env` | אם מפעילים חיוב אמיתי מ־`/pricing-api` — להגדיר ב־Netlify רק עם אישור מדיניות; ברירת מחדל ה־UX היא Dry-run / Mindbody Test |
| **בנייה** | מקומית | `npm run build` ב־CI; אופציונלי: **`SITE_URL`** לקנוניקל/Open Graph (ראו לוג הבילד — ברירת מחדל בפרויקט לדומיין Amare) |
| **משתמשים** | התחברות OAuth דרך host המנהרה | לאחר החלפת דומיין — עוגיות סשן מהמנהרה **לא** עוברות; צפו ל־**התחברות מחדש** בפרוד |
| **בדיקות אחרי Deploy** | — | לוודא `GET https://<אתר>/api/mindbody/oauth/session`, `sale/services` (דורש פונקציה + מפתח), ולוודא ש־**אין** 404 על נתיבי `/api/mindbody/*` שמופיעים ב־`netlify.toml` |

**טעות נפוצה:** פריסה שמעלה רק קבצים סטטיים (ללא Functions או בלי קובץ `netlify.toml` המעודכן) — אז בפרוד יופיעו 404 על Sale/OAuth למרות שהכל “עבד ב־tunnel”.

---

## עמוד **`/pricing-api`** — Sale Services, חוזים חודשיים, Checkout

עמוד בדיקה/מוצר (Built: **`/pricing-api`**, קובץ `pricing-api.html` + `src/js/pricing-api.js`):

| פעולה | נתיב דפדפן → פונקציה | תיאור קצר |
|--------|----------------------|-----------|
| שירותים וחבילות (מכירה און־ליין) | `GET /api/mindbody/sale/services` → `mindbody-sale-services` | טעינת טבלאות במבנה דומה ל־`pricing.html`. |
| מנויים חודשיים / חוזים | `GET /api/mindbody/sale/contracts` → `mindbody-sale-contracts` | Mindbody מפרטים תוכניות חוזיות תחת **contracts** (פרמטר `request.locationId` — ראו `MINDBODY_SALE_LOCATION_ID` ב־`.env.example`). |
| כרטיסים שמורים (Consumer) | `GET /api/mindbody/client/stored-cards` → `mindbody-client-stored-cards` | אחרי OAuth; תלוי בשדות שה־API מחזיר לסטודיו. |
| checkout / עגלה לדוגמה | `POST /api/mindbody/sale/checkout` → `mindbody-sale-checkout` | Dry-run לפי ברירת מחדל; חיוב חי עם אישורים — `MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT` (מתועד ב־.env.example). |
| warmup טוקן צוות (אופציונלי) | `POST /api/mindbody/sale/checkout-warmup` → `mindbody-sale-checkout-warmup` | אחרי OAuth בלבד — ממלא קאש בזיכרון בפונקציה חמה כדי להקל על לחיצת Buy (מ־`/pricing-api`). |

**User Token ל־Checkout:** ה־endpoint `POST …/sale/checkoutshoppingcart` ב־Public API **לא** מסתפק ב־JWT של לקוח (Consumer OAuth בלבד). השרת שולח **User Token** ברמת צוות (`Authorization: Bearer`). **במימוש הנוכחי:** מועדפת זוג **`MINDBODY_STAFF_USERNAME` + `MINDBODY_STAFF_PASSWORD`** (משתמש שירות ייעודי) — **`POST …/usertoken/issue`** לפני קריאת העגלה, עם **קאש בזיכרון** בפונקציה חמה עד קרוב ל־`exp` של ה־JWT (או TTL מ־`MINDBODY_STAFF_TOKEN_CACHE_TTL_SEC` אם אין `exp`). **נסיון חוזר אחד** לאחר 401/403 עם ניפוק מחדש. **Timeouts (שרת):** `MINDBODY_ISSUE_TOKEN_TIMEOUT_MS`, `MINDBODY_CHECKOUT_TIMEOUT_MS`. **`POST /api/mindbody/sale/checkout-warmup`** (דורש סשן לקוח) מקדים ניפוק טוקן כשפותחים את דיאלוג הרכישה ב־`/pricing-api`. אפשר גם **`MINDBODY_STAFF_USER_TOKEN`** סטטי (legacy). זהות הקונה עדיין מ־OAuth (`clientId`).

**בזמן build** (`scripts/build.mjs`): לתוך `__PRICING_API_CONFIG_JSON__` נכנסים `classicStudioId`, whitelist של מזהי prod ל־`stype=40` (`MINDBODY_CONTRACT_PRODUCT_IDS`), `saleLocationId`, ו־**fallback סטטי** לשורות חודשיות (`monthlyContractFallback`) אם **`GET /sale/contracts`** נכשל או ריק — אלא אם הוגדר `MINDBODY_DISABLE_MONTHLY_CONTRACT_FALLBACK=1` (מתועד ב־`.env.example`).

**מנויים חוזרים (recurring) וטקסט חוזה:** לעיתים Mindbody **לא** מחזירים ב־Public API מלל הסכם עקבי (`TermsAndConditions` / `MembershipTerms`). ב־`/pricing-api` הנתיב הוא **היברידי**: אם יש מלל אמיתי מה־API — מוצג הוא; אחרת — **מיפוי ידני** ב־**`src/content/mb-contract-terms.config.json`**, שמוזרק לדף בזמן Build כ־JSON (`__MB_CONTRACT_TERMS_JSON__`) ומועתק לפריסת Functions במהלך `npm run build` ל־`netlify/functions/_embedded/`. כל שינוי במדיניות — לעדכן **`contractVersion`** לפני פרסום. בלי מלל להצגה למנוי חוזר — לא מוצג Subscribe / לא נפתח checkout מהאתר; מוצגת הודעה ציבורית „זמנית לא זמין אונליין”.

**נתיב ההסכמה (electronic consent):** לזרימות מנוי חוזר, הדפדפן שולח שני הצ׳קבוקסים, שם משפטי במלואו, Snapshot HTML של ההסכם שמוצג, וגרסת נוסח (`contractVersion` ב־`mb-contract-terms.config.json`). הפונקציה `mindbody-sale-checkout` יכולה לרשום רשומת audit ל־**Netlify Blobs** עם `termsHtmlSnapshot`, `termsTextHash`, `consentId`, `mindbodySaleId` (כשמתקבל מתשובת Mindbody) — ראו `MINDBODY_MEMBERSHIP_CONSENT_BLOBS` ב־`.env.example`. גרסת נוסח **חייבת** להתעדכן בכל שינוי מדיניות (למשל `2026-05-05-v1` → `-v2`).

**בדיקה תפעולית ב‑Mindbody:** אחרי מכירת recurring, וודא בפרופיל הלקוחה ב‑Mindbody אם החוזה מופיע כמאושר (signed / agreement accepted) בממשק המותג שלהם — אם לא, מאגר ההסכמה אצלכם עדיין תיעוד הוגן במחלוקת, אך ייתכן שתצטרכו שכבת סנכרון נוספת ב‑API בעתיד.

**דיוק משתמש (Tunnel):** ב־`pricing-api.js` יש זיהוי host מנהרה (למשל ngrok): על **404** או תשובה שאינה JSON מוצגת הודעת Setup (להפנות מנהרה לפורט `dev:full`, לא ל־8787) — כדי להבדיל מבעיות „Mindbody” אמיתיות. בקונסול, שילוב עם manifest כפי שתואר לעיל.

---

## התחברות לקוח (חשבון Mindbody Consumer) והזמנה מיידית מהאתר

### האם המשתמש חייב להיות מחובר ל־Mindbody?

**למסלול "להזמין בלי לעבור לווידג'ט ובלי קישורים חיצוניים" בתוך מוצר שלכם:**

- בתיעוד ובשטח, פעולות כמו רישום לקוח קיים לשיעור דורשות **זיהוי לקוח מאושר** (למשל Bearer token משתמש/לקוח) ושהשירות הפונה ל־API רץ בסביבה מהימנה. כלומר למשתמש סוף־דרך צריך להיות **חשבון לקוח** אצל העסק ב־Mindbody (Consumer), והאפליקציה צריכה לקבל מהמערכת **הסכמת OAuth** וקבלת tokens — **לא רק** תצוגת לוח מה־Public API עם API Key של הסטודיו.

**למה שיש באתר היום (`classes-api.html`):**

- הלוז נטען עם **קריאות אנונימיות מאושרות** למסלול `class/classes` דרך **API Key (+ SiteId)** בצד פרוקסי/שרת; זה לא אומר שהדפדפן “ידע” לזהות את הגולש לקוח.
- לכן **Book** מתוכנן להעביר ל־ווידג'ט ההזמנות או ל־URL מתבנית — שם התחברות/הרשמה של הלקוח מופקדות על הפלטופורמה הרשמית של Mindbody/Branded Web, לא על האתר הסטטי שלנו בלי פיתוח נוסף.

### איך Mindbody מתארים זיהוי משתמש לצורך קונסומר‑אינטגרציה

מתוך מסיכומי הפורטל והתיעוד הציבורי (עדכנו בשטח לאחר שינויי Mindbody):

1. **רישום אפליקציה כ־OAuth Client** בסביבת הפיתוח (פרט למפתח: סוג יישום – Web / SPA וכדומה, והאם הגישה היא ל־**Consumer API**). לעיתים נדרשת פנייה לאישור מתמיכת API בהתאם לתהליכים שהפורטל מציג.
2. **זרימת OAuth 2.0 / OpenID Connect** עם נקודות כמו `authorize` ו־`token` תחת הדומיין של ההתחברות של Mindbody (למשל הנתיבים שמוזכרים בהקשר התשתיתי במסך [Application integration](https://auth.mindbodyonline.com/appintegration)).
3. **scopes** מתאימים (למשל פרופיל, `openid`, ובמקרים מתאימים **`offline_access`** לריענון טוקן ארוך מועד למשמרת סשנים בסביבת שרת).
4. **קריאות לשירותי Consumer Activity / Consumer APIs** בהתאם לתיעוד — עם **Bearer** של המשתמש, ובמימוש פרוד בתזמון בצד השרת של האתר (ולא בשילוב עם חשיפת Client Secret עבור SPA בצורה לא בטוחה).

דוגמת קוד מסודר מהצד של Mindbody (**לא** יישום בתוך `amare-site` כרגע): [`mindbody/PartnerOAuthWebApp`](https://github.com/mindbody/PartnerOAuthWebApp).

פרטים מדויקים לפרמטרים (`response_type`, PKCE בסביבת SPA, `redirect_uri`) — **מתוך מסך ה־OAuth בפורטל + המסמכים הנלווים** לכל גרסה; אל תמשכו ארגומנטים מקובץ זה בלי השוואה לתיעוד העדכני.

### מה זה מרמז על “משתמש שזוכר להתחברות הבאה” ו־User Dashboard?

אין בסיס לנחש מתוך הדף הסטטי שלנו מה Mindbody “שומרים” בדפדפן — ההתנהגות היא פרופורציונלית ל:

- מה שאחרי ההתחברות נשמר **אצלכם בשכבת שרת** (session, או טוקני ריענון בערוצים מאובטחים כמו cookies עם **`HttpOnly`**, וכו') לפי מדיניות האבטחה של האתר;
- ולתוקף ה־access token שמקבלים מ־Mindbody.

כל “דשבורד משתמש” (פרופיל עסקי, ההזמנות שלו) שנבנה בשם המותג שלכם מחובר אל **קריאות API מורשות** לאחר ההתחברות — לא מתוך `localStorage` עם Client Secret ובטח לא עם API Key שנשמר בדפדפן.

### משתמש חדש והרשמה ב־Mindbody

פתיחת משתמש **חדש** אצל העסק (Consumer) מתוארים בפורטל תחת **Consumer / Consumer signup** ובממשקי הזרימות הרשומיים — בהתאמה לכללי העסק (אישור פרוטוקול, הגבלות פרטיות, ובדיקת כפילות אימיילים). ההטמעה המומלצת: לשלב את ההרשמה כחלק מזרימת OAuth/Consumer שאושרה לכלים שלכם, ולא לממש “יצירת לקוח” ידינית מתוך הדף ללא הגבלות מתאימות.

### מתי `MINDBODY_BOOK_URL_TEMPLATE` הופך “מיותר”?

**רק לאחר שהמוצר שלכם כבר מזמין בפועל** (בשרת מאובטח, בהתאם לתיעוד Mindbody הנוכחי):

1. המשתמש עבר התחברות בזרימת **OAuth/OpenID** מאושרת.
2. לשרת יש **טוקן לקוח** (Bearer) תקף.
3. מהשרת יוצאות **קריאות API** הרשמה לשיעור / תשלום / checkout בהתאם ל־endpoints הפעילים בחוזה הפיתוח.

**כל עוד** מספר 3 לא תואם פריסה פרוד מאושר אצלכם ואצל Mindbody:

- **`MINDBODY_BOOK_URL_TEMPLATE` אינו מיותר** — אלטרנטיבה מצויה היא קישורי הזמנה מוסכמים מתמיכה בסטודיו ([Custom booking links](https://support.mindbodyonline.com/s/article/Creating-Custom-Online-Booking-Links)) בשילוב Fallback לווידג'ט **`classes.html`**.
- חברות רבות **משאירות** גם אחרי OAuth קישורים לווידג'ט בתרחישי נפילה, לגיבוי מלא, או מוצרים שלא מתאימים למסלול התחברות+הזמנה מלא מתוך API.

משתנה סביבה לדרך Consumer OAuth מתועדים ב־**`.env.example`** (סעיף Mindbody OAuth).


---

## מימוש קיים: OAuth Consumer ב־Netlify (עמוד `/classes-api`)

הוכנסה **בסיס משתמש** (ללא הזמנה ב־API עדיין):

- **Netlify Functions** תחת `netlify/functions/`: התחלה, callback, סשן קריאות, logout.
- **Client Secret** נשמר בשרת בלבד; בעוגיית **`mb_sess`** נשמר **Payload מוצפן** (refresh token כשקיים, אחרת access token) ושדות תצוגה מה־`id_token` שנקראו בצד השרת.
- **UI** ב־`classes-api.html`: פס “Sign in with Mindbody” ו־`/api/mindbody/oauth/session`.

**נתיבי API (ממופים ב־`netlify.toml`):**

| פעולה | כתובת |
|--------|--------|
| התחלת OAuth | `GET /api/mindbody/oauth/start` |
| Callback (Redirect URI בפורטל) | `GET /api/mindbody/oauth/callback` |
| סטטוס (JSON) | `GET /api/mindbody/oauth/session` |
| התנתקות | `GET /api/mindbody/oauth/logout?return=/classes-api` |

**נתיבי Sale / Member נוספים** (מיפוי מלא ב־`netlify.toml`): למשל `sale/services`, `sale/contracts`, `client/stored-cards`, `sale/checkout`, `member/summary`, `class/book` — ראו גם את סעיפי Tunnel ו־**/pricing-api** למעלה.

**משתני סביבה חובה ב־Netlify (או בקובץ סביבה ל־`netlify dev`):** ראו **`.env.example`** — `MINDBODY_OAUTH_*` ו־**`MINDBODY_SESSION_SECRET`** (אקראי, ≥ 24 תווים).

**Redirect URI** בתוך הפורטל של Mindbody חייב להיות **בדיוק** כמו  
`https://<your-site>/api/mindbody/oauth/callback` (לא לשכוח מ־`https` ובדיקת אליאס דומיין).

**Scopes** — אם **לא** מגדירים `MINDBODY_OAUTH_SCOPES`, הקוד משתמש בברירת מחדל שכוללת גם **`Mindbody.Api.Public.v6`** (נדרש לקריאות Public API עם Bearer של לקוח). אם מגדירים `MINDBODY_OAUTH_SCOPES` ידנית, **חובה** לכלול את אותו scope (אחרת מקבלים ‎401 ‎`Scope Mindbody.Api.Public.v6 is required`). ודאו שאפליקציית ה־OAuth בפורטל מאשרת את ההרשאה; אחרי שינוי scope — **התנתקות והתחברות מחדש**.

**פיתוח מקומי עם Functions (מומלץ):** **`npm run dev`** / **`npm run dev:full`** — שרות מאוחד שמשרת את `dist/` ומממש **`/api/mindbody/*`** כמו ב־Netlify (`scripts/unified-local-dev.mjs` + `scripts/mindbody-public-routes.mjs`). דורש `MINDBODY_SESSION_SECRET` ב־`.env`. **`npm run dev:static`** (live-server על סטטי בלבד) **לא** מריץ API.

**חלופה:** `netlify dev` עם אותם משתני OAuth וב־Redirect URIs להוסיף את כתובת ה־HTTPS שמחזיר ה־CLI — או **מנהרה** כמפורט בסעיף „פיתוח מאוחד, מנהרות”.

**מה עדיין לא:** כפתור **Book** עדיין משתמש ב־`MINDBODY_BOOK_URL_TEMPLATE` / ווידג'ט; שלב הבא הוא **Function שרץ עם הטוקן** (ריענון access אם נדרש) ולהקדים לקריאת ההרשמה לשיעור בהתאם לתיעוד.

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
- [ ] מסלול לוח מאוחד: **`npm run dev:full`** (או פרוקסי 8787 + `SCHEDULE_PROXY_BASE` רק למסלול ישן) — **`/classes-api`** נטען עם Sandbox תקין; Tunnel אם בשימוש — מופנה לפורט **`4321`** (לא 8787) לכל OAuth/API.
- [ ] בסביבת build לפרוד לא להשאיר ב־**`SCHEDULE_PROXY_BASE`** כתובת ngrok לקומיט/CI — בפריסת Netlify **ריק = same-origin**.

אחרי אישור Live

- [ ] עדכון **`MINDBODY_SITE_ID`** ל־ID החי של העסק.
- [ ] פריסת Netlify: **`MINDBODY_OAUTH_REDIRECT_URI`** ובפורטל Mindbody לאותו **דומיין פרודקשן** HTTPS; הפקת Deploy עם **Functions** + **`netlify.toml`** מעודכן.
- [ ] יצירה/rotation של **API Keys** פרוד בעת הצורך; עדכון סודות בפריסה.
- [ ] השלמת **Activation** עם העסק בפורטל (לפי מדריך Mindbody ל־"accessing business data").
- [ ] ביקור חוזר ב־[`Allowlist`](https://developers.mindbodyonline.com/) אם בשימוש (IP / כתובות).
- [ ] אם מתחילים Webhooks – פריסת endpoint פרוד עם TLS וסקריפט אימות חתימה.

---

## מבנה קבצים רלוונטי

```
.env.example
.env                         # לא בגיט — מקומי בלבד
scripts/load-env.mjs
scripts/mindbody-env.mjs
scripts/mindbody-ping.mjs
scripts/local-api-server.mjs # פרוקסי GET חלקי (8787 בלבד)
scripts/unified-local-dev.mjs
scripts/dev.mjs              # dev:static בלבד
scripts/mindbody-public-routes.mjs
scripts/build.mjs
netlify.toml
netlify/functions/mindbody-*.mjs
netlify/functions/oauth-lib.mjs
netlify/functions/mindbody-consumer-lib.mjs
netlify/functions/mindbody-upstream.mjs
src/content/classes-api.html
src/content/pricing-api.html
src/js/classes-schedule.js
src/js/pricing-api.js
src/js/mindbody-auth.js
src/css/components-pricing.css
src/css/components-mindbody.css
docs/MINDBODY.md              # הקובץ הזה
```

---

## תמיכה מהצד של Mindbody

אם הבקשה ל־Go Live מתעכבת או שיש בעיית credentials, בהתאם להודעות בפורטל ניתן לפנות ל־כתובת כמו **`api@mindbodyonline.com`** שמוזכרת בתהליך ה־Go Live בפורטל.

---

## עדכון המסמך

כשרכיב באינטגרציה משתנה (OAuth Consumer, **Sale / pricing-api / checkout**, מנהרות מול Netlify, Endpoints להזמנה בשרת מאובטח, Webhooks פרודקשן), עדכנו במקום זה וב־**`.env.example`** כדי שמעבר מ־Sandbox ל־Live ומ־Tunnel לפרוד יישאר חד־משמעי לכל הצוות.

### מה נשאר לשלב ההזמנה הסופי במוצר

- **Function(s) נוספות** שמחלץ/מרענן access token לפי `refresh_token`, ואז קוראות ל־endpoint ההרשמה לשיעור שמאשר Mindbody — **רק** אחרי אישור הפורטל ל־scopes ול־Go Live.
- עד אז: **Book** נשאר כפי שמתואר ב־`.env` (template / ווידג'ט).
