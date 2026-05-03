# מפת URL ו-301 (Amare — אתר Netlify / סטטי)

בסיס יעד: קבצים ב-`dist/` (או שורש אתר) עם שמות ידידותיים. ניתן להפעיל **Pretty URLs** ב-Netlify (מסוף `/` → `index.html` או rewrites) — כאן מתועדים **הנתיבים הלוגיים** ו-**Wix הישנים** להפניה.

## דפי ליבה (אתר חדש)

| נתיב לוגי | קובץ build | הערה |
|-----------|------------|------|
| `/` | `index.html` | בית |
| `/classes` | `classes.html` | לוח Mindbody (embed) |
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
