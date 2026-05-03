# Checklist — השקה (Netlify + דומיין)

## לפני חיבור דומיין

1. **Build**: `npm run build` (פלט: `dist/`).
2. **Netlify site**: New site from Git, או deploy ידני ל־`dist`.
3. **הגדרת build**: `npm run build`, publish = `dist` (רואים ב־[`netlify.toml`](../netlify.toml)).
4. **משתנה סביבה** `SITE_URL` ב־Netlify: כתובת הייצור הסופית (למשל `https://www.amarewellness.com` או תת-דומיין staging). משפיע על `canonical`, `sitemap.xml`, `robots.txt`, ו־JSON-LD.
5. **טפסים**: אחרי deploy ראשון, ודאו ב־Netlify > Forms ש־`contact` מופיע. הוסיפו התראת אימייל / Slack. בדקו submission מ־[contact](https://YOUR_SITE/contact).
6. **הפניות** [`public/_redirects`](../public/_redirects): עברו על כל שורה מול Wix. נתיבי `/privacy-policy` מופנים ל־HTML המקומי; אם הטקסט המשפטי עדיין ב־Wix, שמרו לינק "live" בדפי המשפטי.
7. **301 מ-Wix**: כש־**DNS** מצביע ל־Netlify, ב־Wix (או ב־registrar) או הפנית דומיין, ודאו שאין שני A records סותרים.

## אחרי go-live

1. **Search Console**: אימות ownership, שליחת sitemap: `https://YOUR_DOMAIN/sitemap.xml`.
2. **בדיקה ידנית**: דף בית, שיעורים (Mindbody נטען), מחירים/מוצרים (לינקים ל־Wix אם placeholder), Contact (טופס), מובייל/טאבלט/דסקטופ.
3. **404**: נווטו ל־URL שלא קיים; ודאו עמוד Netlify default או redirect לבית.
4. **Core Web Vitals**: Lighthouse; החליפו `hero__placeholder` בתמונות/וידאו אמיתי.

## אנליטיקה

- אופציונלי: `window.AMARE_GA4_ID` (ב־`main.js`) — הזינו script ב־`index`/layout או דרך tag manager אחרי אישור עוגיות.

## QA מכשירים

- iOS Safari, Chrome Android, דסקטופ רחב (1920+), הדמיית 375px.
- נגישות: Tab דרך ניווט, `Skip to content`, `prefers-reduced-motion`.
