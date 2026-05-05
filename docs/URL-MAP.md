# מפת URL ו-301 (Amare — אתר Netlify / סטטי)

בסיס יעד: קבצים ב-`dist/` (או שורש אתר) עם שמות ידידותיים. ניתן להפעיל **Pretty URLs** ב-Netlify (מסוף `/` → `index.html` או rewrites) — כאן מתועדים **הנתיבים הלוגיים** ו-**Wix הישנים** להפניה.

## דפי ליבה (אתר חדש)

| נתיב לוגי | קובץ build | הערה |
|-----------|------------|------|
| `/` | `index.html` | בית |
| `/classes` | `classes.html` | לוח Mindbody (embed) |
| `/classes-api` | `classes-api.html` | לוח דרך Public API (פיתוח) |
| `/member` | `member.html` | אזור חבר (OAuth + סיכום מתוך Mindbody) — `noindex`, בלי קישור מהתפריט הראשי |
| `/login` | `login.html` | התחברות לקוח Mindbody (OAuth) — דף בדיקה, בלי קישור מהתפריט הראשי כרגע, `noindex` |
| `/pricing` | `pricing.html` | קישורים ל-Mindbody |
| `/products` | `products.html` | קטלוג קל / קישורי MB |
| `/privateevents` | `privateevents.html` | אירועים + treatment room |
| `/first-visit` | `first-visit.html` | חדש |
| `/faq` | `faq.html` | חדש |
| `/contact` | `contact.html` | חדש + Netlify Form |
| `/about` | `about.html` | About us — גלריה סטודיו |
| `/instructors` | `instructors.html` | חדש; קישור בניווט הראשי |
| `/privacy` | `privacy.html` | תקציר + קישור ל-[מדיניות Wix](https://www.amarewellness.com/privacy-policy) עד מיזוג מלא |
| `/terms` | `terms.html` | קישור ל-[תנאים](https://www.amarewellness.com/terms-conditions) |
| `/accessibility` | `accessibility.html` | קישור ל-[הצהרה](https://www.amarewellness.com/accessibility-statement) |
| `/shipping` | `shipping.html` | קישור ל-[משלוחים](https://www.amarewellness.com/shippingpolicy) |
| `/returns` | `returns.html` | קישור ל-[החזרים](https://www.amarewellness.com/return-policy) |

**הפניות:** `/studio`, `/studio/` ו-`/studio.html` מופנים ב-301 ל-`/about` (SEO וסימניות).

## Mindbody API (אותה מקור / Netlify Functions)

כל נקודות ה-JSON הרלוונטיות ל־OAuth ול־Member יושבות תחת **`/api/mindbody/`** — **לא** תחת `/member/`.

| נתיב | תיאור |
|------|--------|
| `GET /api/mindbody/member/summary` | סיכום אזור חבר (דרוש קוקי `mb_sess`; אחרי התחברות). |
| `GET /api/mindbody/member/summary?trace=1` | כמו למעלה + **`linkDiag`** לאבחון קישור לקוח ו־Mindbody Public API. |
| `GET /api/mindbody/oauth/start` | מתחיל התחברות Mindbody |

**למה מתקבל "Not found":** גלישה ל־`/member/summary` או דומה זה לא אותה נגזרת מהפונקציה — הפונקציה היא **`/api/mindbody/member/summary`**. דוגמה מלאה (לאחר התחברות + ngrok):  
`https://<הטונל שלך>/api/mindbody/member/summary?trace=1`.

מיפוי ל־`/.netlify/functions/…`: ראו **`netlify.toml`**.

## Wix (ישן) → חדש (301)

הגדרה ב-[`netlify.toml`](../netlify.toml) או [`public/_redirects`](../public/_redirects) — ערכים **יש לוודא** מול רשימת URL אחרי סריקה (ה-sitemap באתר דיווח 500).

| מקור (דוגמא) | יעד | הערה |
|----------------|------|------|
| `https://www.amarewellness.com/privateevents` | `/privateevents` | אם הנתיב החדש בלי `.html` — ראו rewrites |
| `https://www.amarewellness.com/pricing` | `/pricing` | |
| `https://www.amarewellness.com/classes` | `/classes` | |
| `https://www.amarewellness.com/category/all-products` | `/products` | או /products#קטלוג |
| `https://www.amarewellness.com/privacy-policy` | `/privacy` או ישירות Wix | עד לטקסט מלא באתר החדש |
| `.../terms-conditions` | `/terms` | |
| `.../accessibility-statement` | `/accessibility` | |
| `.../shippingpolicy` | `/shipping` | |
| `.../return-policy` | `/returns` | |

**בתוך `public/_redirects`:**  
שימוש בדפוסי Netlify:  
`/old-path   /new-path   301`

**שורש דומיין:** אם האתר החדש ב-netlify.app זמנית, לפני cutover: אל תפרסם 301 מ-Wix עד ש-DNS מצביע ל-Netlify; או השתמש ב-staging.

## בדיקת URL חיים (ידני)

הרץ: `curl.exe -sI https://www.amarewellness.com/<path>`  
עדכן את הטבלאות לעיל אם Wix שינו נתיבים.
