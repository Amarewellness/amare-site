# מדריך SEO — AMARÉ (מצב נוכחי ורשימת משימות)

מסמך זה מתאר **מה מוגדר היום** בפרויקט (לאחר `npm run build`, פלט `dist/`) ומה כדאי **לסדר לפני או מיד אחרי מעבר דומיין** ל-Netlify (או סביבה אחרת).

קישורים: [`scripts/build.mjs`](../scripts/build.mjs), [`public/_redirects`](../public/_redirects), [`docs/LAUNCH.md`](LAUNCH.md), [`docs/URL-MAP.md`](URL-MAP.md).

---

## Favicon, Apple Touch Icon ושאר “ברנדינג טאב”

### מה המצב כרגע בפרויקט

הכל נטען מהדומיין של האתר (קבצים תחת `public/favicon/` ונתיבים ב־`BRAND` ב־`build.mjs`), לא מ-Wix.

| פריט | מצב |
|------|-----|
| `link rel="icon"` | קיים — `/favicon/favicon.ico`, PNG 16×16 ו־32×32 |
| `link rel="apple-touch-icon"` | קיים — `/favicon/apple-touch-icon.png` |
| אנדרואיד / PWA | `/favicon/site.webmanifest` עם אייקוני chrome |
| `meta name="theme-color"` | קיים (`#faf3eb`) |
| `/favicon.ico` בשורש | הפניה **301** מ־`/favicon.ico` ל־`/favicon/favicon.ico` ב־`public/_redirects` |
| `mask-icon` (Safari pinned tab) | **לא** — אופציונלי |

---

## סיכום טכני SEO — מה כבר מוגדר

| נושא | מצב |
|------|-----|
| `meta charset`, `viewport`, `lang="en"` | מלא בכל עמוד |
| `title`, `meta description` | לכל עמוד מ־`PAGES`; דפי מוצר עם **`metaDescription`** ייחודי לכל SKU ב־`build.mjs` |
| `link rel="canonical"` | כן — לפי `SITE_URL` + נתיב לוגי |
| `robots.txt` | נוצר בבילד — `Allow: /` + שורת Sitemap |
| `sitemap.xml` | נוצר בבילד — כל העמודים והמוצרים; **`lastmod`** בתאריך הבנייה (`YYYY-MM-DD`) |
| הפניות מ-Wix | `public/_redirects` — שכתובי נתיבים + 301 לדפים ישנים / מוצרים |
| Open Graph | `og:title`, `og:description`, `og:url`, **`og:image`** + **`og:image:alt`**; **`og:type`**: `website` או **`product`** בדפי מוצר |
| Twitter | `twitter:card` (`summary_large_image`), **`twitter:title`**, **`twitter:description`**, **`twitter:image`** — בתיאום עם OG |
| ברירת מחדל לתמונת שיתוף | דפים שאינם מוצר: **`/images/products/cover/sockscover.webp`** (קבוע כ־`DEFAULT_OG_IMAGE` ב־`build.mjs`) |
| JSON-LD — דף הבית | **`HealthAndBeautyBusiness`**: `logo`, `image` (מערך), כתובת, **`telephone`** (+19542589238), **`geo`** (קואורדינטות משוערות להולנדאל ביץ’ — ניתן לדייק), **`sameAs`** (אינסטגרם), **`postalCode`** |
| JSON-LD — מוצר | **`Product`** + `offers.url` לכתובת **`SITE_URL/product/...`** |
| JSON-LD — FAQ | **`FAQPage`** בדף `/faq` בלבד — רשימת שאלות/תשובות ב־`FAQ_SCHEMA_ITEMS` ב־`build.mjs` (**לסנכרן עם תוכן `src/content/faq.html`** בעת עריכות) |
| ניווט ראשי | Home, Pricing & Membership, Book a class, Events, Products, **About us** (`/about`), Treatment room, First visit, FAQ, Contact |
| בריחת תווים במטא | **`escapeHtmlAttr`** לכותרות ותיאורים ב־`<title>` ובתגי OG/Twitter |
| משתנה סביבה | **`SITE_URL`** חייב להיות מוגדר לפני בילד בפרודקשן (canonical, sitemap, robots, OG מוחלטים). אופציונלי: **`GA_MEASUREMENT_ID`** — ראו סעיף **Google Analytics (GA4)** למטה |

---

## Google Analytics (GA4)

### איך זה עובד בפרויקט

- התג (**`gtag.js`**) נכנס ל־`<head>` של **כל העמודים** רק כשמריצים **`npm run build`** (או CI) **עם** משתנה הסביבה **`GA_MEASUREMENT_ID`** מוגדר לערך תקף בפורמט **`G-XXXXXXXXXX`**.
- **אין להדביק** את בלוק הקוד מהממשק של Google Analytics נוסף על האוטומציה — זה עלול ליצור **כפילות** וספירה כפולה.
- המימוש נמצא ב־[`scripts/build.mjs`](../scripts/build.mjs) (פונקציה `ga4HeadSnippet`).

### הגדרה ב-Netlify

1. **Admin → Project / Site configuration → Environment variables**.
2. **Add a single variable**:  
   - **Key:** `GA_MEASUREMENT_ID`  
   - **Value:** המזהה המלא מ־Analytics (מתחיל ב־`G-`).
3. להריץ **Deploy** כך ש־Netlify מריצה **פקודת בנייה** (`npm run build` לפי [`netlify.toml`](../netlify.toml)) — אז התג נרשם בתוך קבצי ה־HTML ב־`dist/`.

### Netlify Drop (העלאת `dist` ידנית)

אם מפרסמים רק קבצים סטטיים בלי בנייה על השרת, **משתני סביבה ב-Netlify לא מריצים את `build.mjs`**. במצב כזה:

- **לשאוף:** לחבר ריפו ל-Git ולתת ל-Netlify לבנות עם `npm run build`, **או**
- לבנות **מקומית** עם המשתנה ואז להעלות את `dist`:

```powershell
$env:GA_MEASUREMENT_ID="G-XXXXXXXXXX"; npm run build
```

### אימות שהמעקב פעיל

- ב־GA4: **Reports → Realtime** — גלישה לאתר החי אמורה להופיע תוך דקות.
- בדף האתר: **View source** — חיפוש `googletagmanager` ו־`gtag/js?id=` — חייב להתאים ל־**אותו** `G-…` כמו בזרם הנתונים.
- דוחות סטנדרטיים (לא Realtime) עלולים להתעדכן עם **עיכוב של עד כ־24 שעות** — זה נורמלי.
- הודעות כמו „Data collection isn’t active” או „No data received” בזרם לפעמים מופיעות זמנית גם כש־Realtime כבר מראה נתונים; עדיפות ל־**Realtime** כאינדיקציה מיידית.

### השוואה קצרה ל־Search Console

| כלי | מתאים ל־ |
|-----|----------|
| **Search Console** | אינדוקס, חיפוש אורגני, סטטוס כיסוי, Core Web Vitals בקשר לתוצאות חיפוש |
| **GA4** | תנועה באתר, עמודים, מקורות תנועה, התנהגות — בלי תלות רק בגוגל |

---

## מה עדיין כדאי (מחוץ לקוד או משלים)

### לפני / אחרי חיבור דומיין ייצור

1. **`SITE_URL`** ב-Netlify (או CI) — למשל `https://www.amarewellness.com` — זהה לדומיין הקנוני.
2. **תמונת OG ברירת המחדל**: כרגע `sockscover.webp`; אם תרצו תמונה רחבה יותר (יחס ~1.91:1) מותאמת לשיתופים — להחליף קובץ ו/או את `DEFAULT_OG_IMAGE`.
3. **קואורדינטות `geo`** בסכימת העסק — לעדכן לפי קובץ מקום מדויק בגוגל מפות אם צריך.
4. **`openingHoursSpecification`** ב־JSON-LD של העסק — מוגדר ב־`build.mjs` לפי דף Contact; לעדכן אם שעות הפעילות משתנות לפי יום.

### מיד אחרי השקה

5. **Google Search Console** + הגשת `sitemap.xml`; בדיקת כיסוי אינדוקס ו־301 מהדומין הישן.
6. **סנכרון FAQ**: כל שינוי בתוכן ב־`faq.html` — לעדכן את **`FAQ_SCHEMA_ITEMS`** באותו קובץ בילד.

### תוכן ומדיה

7. תמונות וטקסטים שעדיין נטענים מ־**`wixstatic.com`** בחלק מדפי התוכן (`studio`, `instructors`, `pricing` וכו’) — לאיכות וביצועים, להמשיך להחליף לקבצים תחת **`public/`** ככל שנכנסים נכסים.

### ביצועים

8. Lighthouse (LCP / CLS); טעינת פונטים מ־Google Fonts — **`preload`** ל־DM Sans ו־**`display=optional`** בקישור הפונטים (ראו `build.mjs`).

---

## ציון לדוגמה (סיכום)

**בערך 8–8.5 / 10**: בסיס טכני חזק — canonical, sitemap עם `lastmod`, OG/Twitter מלאים, סכימות (עסק + מוצר + FAQ), תיאורי מטא למוצרים, הפניות מ-Wix; נשארים שיפורי תוכן/מדיה מקומיים ושקיפות עסקית (שעות וכו’) לפי צורך.

---

## גרסה

נכון לעדכון קוד ב־`scripts/build.mjs` ותוכן ב־`src/content/`; עדכנו מסמך זה כשמשנים תבנית `<head>`, סכימות, רשימת FAQ, Analytics או נתיבי נכסים.
