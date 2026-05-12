# מפת URL ו-301 (Amare — אתר Netlify / סטטי)

בסיס יעד: קבצים ב-`dist/` (או שורש אתר) עם שמות ידידותיים. ניתן להפעיל **Pretty URLs** ב-Netlify (מסוף `/` → `index.html` או rewrites) — כאן מתועדים **הנתיבים הלוגיים** ו-**Wix הישנים** להפניה.

## דפי ליבה (אתר חדש)

| נתיב לוגי | קובץ build | הערה |
|-----------|------------|------|
| `/` | `index.html` | בית |
| `/classes` | `classes.html` | לוח שיעורים API (Mindbody Public API) — Sign in + Book בעמוד; ה‑legacy `/classes-api` עושה 301 לכאן |
| `/member` | `member.html` | אזור חבר (OAuth + סיכום מתוך Mindbody) — `noindex`, בלי קישור מהתפריט הראשי |
| `/login` | `login.html` | התחברות לקוח Mindbody (OAuth) — דף בדיקה, בלי קישור מהתפריט הראשי כרגע, `noindex` |
| `/pricing` | `pricing.html` | תצוגת מחירים מ‑Public Sale API + Stripe Express checkout (NCS / drop‑in / packs) ו‑Classic Mindbody fallback. ה‑legacy `/pricing-api` עושה 301 לכאן |
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
`/classes-api`, `/classes-api.html`, `/pricing-api`, `/pricing-api.html` מופנים ב-301 ל‑`/classes` ו‑`/pricing` בהתאמה (`public/_redirects`). זה תופס גם bookmarks ישנים, מסמכים פנימיים, ומיילים שכבר נשלחו לפני המיזוג.

## Mindbody API (אותה מקור / Netlify Functions)

כל נקודות ה-JSON הרלוונטיות ל־OAuth ול־Member יושבות תחת **`/api/mindbody/`** — **לא** תחת `/member/`.

| נתיב | תיאור |
|------|--------|
| `GET /api/mindbody/member/summary` | סיכום אזור חבר (דרוש קוקי `mb_sess`; אחרי התחברות). |
| `GET /api/mindbody/member/summary?trace=1` | כמו למעלה + **`linkDiag`** לאבחון קישור לקוח ו־Mindbody Public API. |
| `GET /api/mindbody/sale/services` | שירותים / חבילות Sell Online (`mindbody-sale-services`). |
| `GET /api/mindbody/sale/contracts` | מנויים חוזיים / חודשיים (`mindbody-sale-contracts`). |
| `GET /api/mindbody/client/stored-cards` | כרטיסים שמורים מאושרים ל-Consumer API (`mindbody-client-stored-cards`). |
| `POST /api/mindbody/sale/checkout` | checkout / עגלה לדוגמה (`mindbody-sale-checkout`). |
| `POST /api/mindbody/sale/checkout-warmup` | Prefetch staff token בקאש (אחרי OAuth; `mindbody-sale-checkout-warmup`). |
| `GET /api/mindbody/class/book` | הזמנה לשיעור בצד שרת (כשמופעל). |
| `GET /api/mindbody/oauth/start` | מתחיל התחברות Mindbody |

**למה מתקבל "Not found":** גלישה ל־`/member/summary` או דומה זה לא אותה נגזרת מהפונקציה — הפונקציה היא **`/api/mindbody/member/summary`**. דוגמה מלאה (לאחר התחברות + ngrok):  
`https://<הטונל שלך>/api/mindbody/member/summary?trace=1`.

**Tunnel:** המנהרה חייבת להיות מופנית לשרת הפיתוח **המאוחד** (`npm run dev:full`, פורט **4321** כברירת מחדל), **לא** לפרוקסי Mindbody‑only על ‎8787 — אחרת `sale/*` ו־`stored-cards` יחזירו **404**. אחרי Deploy ל־**Netlify** אותם נתיבים עובדים **same-origin** על דומיין האתר (נדורש שהפריסה כוללת Functions + `netlify.toml`).

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
