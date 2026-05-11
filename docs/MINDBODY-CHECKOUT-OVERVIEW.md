# סיכום: Mindbody Sale Checkout ו־`/pricing-api`

מסמך זה מתאר את שינויי האינטגרציה שנוספו למכירת חבילות ומנויים דרך **Mindbody Public API**, דרך האתר (בעיקר דף **`/pricing-api`**), ובאמצעות **Netlify Functions**.

לפרטי תפעול ארוכים (משתני סביבה, Sandbox מול Live, טונלים): **`MINDBODY.md`**.  
מפת נתיבי API ודפים: **`URL-MAP.md`**.  
מיפוי ל־Functions: **`netlify.toml`**.

---

## מה התווסף בתכלס

- **דף `pricing-api`** — קטלוג מתוך `GET /api/mindbody/sale/services` (+ חוזים בעת הצורך), כפתור רכישה, דיאלוג checkout.
- **`POST /api/mindbody/sale/checkout`** — עטיפה ל־`POST …/sale/checkoutshoppingcart` עם **User Token ברמת צוות** (משתני `MINDBODY_STAFF_*`), זהות קונה מ־**OAuth לקוח**.
- **`POST /api/mindbody/sale/purchase-contract`** — מנויים מסוג חוזה (recurring) כאשר הזרימה המתאימה מופעלת (לא `CheckoutShoppingCart` רגיל בשורת Service בלבד).
- **`GET /api/mindbody/sale/services`**, **`GET /api/mindbody/sale/contracts`** — פרוקסי למקטעי Sale ב־Mindbody.
- **`GET /api/mindbody/client/stored-cards`** — כרטיסים שמורים לאחר OAuth (לזרימות שדורשות כרטיס אצל Mindbody).
- **`POST /api/mindbody/sale/checkout-warmup`** — ניפוק/קאש מקדים לטוקן צוות כדי לזרז לחיצת Buy.
- תמיכה אופציונלית ב־**blobs** להסכמות מנוי ו־**idempotency** לניסיונות checkout — לפי משתני הסביבה (מפורט ב־`.env.example` וב־`MINDBODY.md`).
- **בנייה** — `mb-contract-terms.config.json` לנוסחי מנוי חוזר + הטמעה דרך הפונקציה `load-mb-contract-terms`.

---

## זרימת המשתמש (תמצית)

1. המשתמש נכנס ל־`/pricing-api` (לאחר build/פריסה).
2. בעת פתיחת checkout, הדפדפן בודק סשן ו־stored cards בנתיבים תחת **`/api/mindbody/…`** (same origin בפרודקשן או דרך טונל לשרת המאוחד).
3. **Dry run** (ברירת מחדל) — `Test: true` ו־שורת **`Comp`** מתאימה לסכום אחרי פרומו בעגלה.
4. **חיוב חי** — רק כאשר ה־UI מאשר ולשרת מוגדר **`MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT=1`** וקיימת מדיניות ברורה; נדרש כרטיס שמור אצל Mindbody.

---

## בעיות שטופלו (חשוב להבין)

### כפילות שורות בעגלה (פעמיים אותו SKU, סכום כפול)

בהודעת JSON ל־**CheckoutShoppingCart** נשלחו במקביל **`items` + `Items`** ובתוך כל שורה גם **`item` + `Item`** (ועוד כפילויות דומות). בחלק מה־deserializers של Mindbody אלו נספרים כ־**שתי שורות נפרדות**, למשל חבילת $30 שנקנתה כ־**$60**.

**הפתרון במימוש:** גוף הבקשה בנוי ב־**PascalCase אחיד** לרשימת פריטים ולתשלומים (`Items`, `Payments`), **שורת עגלה אחת**, בלי כפילות מפתחות מקבילים.

### קוד קופון (במיוחד 100% הנחה)

- Mindbody משווה את **סכום שורות התשלום** ל־**GrandTotal אחרי פרומו**.
- אם המחירון לפני הנחה הוא 30 והפרומו מוריד ל־0, בשלב dry run נדרש להתאים את סכום ה־Comp (או **`Comp` בסכום 0**).
- **אסור** לשלוח `Payments` ריק — Mindbody מחזירה **`Payments is a required parameter`**; במקרה של עגלה ל־**$0** נשלחת שורת **`Comp` עם Amount 0**.
- מנגנון ניסיון חוזר על השרת מנתח טקסט שגיאה מסוג *payment total … does not match … calculated total …* ומתקן את סכום התשלום פעם נוספת כשצריך.

### תצוגת הנחה בתשובת Mindbody

בתשובת `ShoppingCart`, `SubTotal` עשוי להישאר מחיר המחירון, בעוד שההנחה מופיעה ב־**`DiscountTotal`** והתוצאה ב־**`GrandTotal`**. פרומו “עבר” גם כש־**`DiscountAmount` בשורה** הוא 0 — חשוב להסביר למפעילים שזה נורמלי.

---

## שינויי UX בדיאלוג checkout (`pricing-api`)

- בעת טעינה אחרי פתיחת המודל: **ספינר + “Checking your account…”** (עד סיום `fetchSession` + `stored-cards`).
- הוסרו פיסקאות ארוכות שניסחו Dry run מול Live ואת ההפניה ל־Mindbody checkout “לפתוח פרטי תשלום” (נשארים כפתורים/קישורים קלאסיים בסוף במידת הצורך).

ודאיכות שגיאות ב־`pricing-api.js` ל־Mindbody **`checkout_failed`**: פרומו, intro packs, התאמת סכומים, 404 פרוקסי, וכדומה — כדי שהמשתמש יקבל הקשר בעברית/אנגלית במקום “Unexpected error” חדגוני כשמתאים לפנייה.

---

## פיתוח מקומי וטונל

- הפקודות **`npm run dev`** / **`dev:full`** מריצות את **`scripts/unified-local-dev.mjs`** — **אותו קוד Functions** שהולך ל־Netlify, בדרך־כלל על פורט **4321**.
- **מנהרה (ngrok וכדומה) חייבת להצביע אל פורט זה**, לא אל פרוקסי Mindbody-only על **8787** בלבד — אחרת `POST /api/mindbody/sale/checkout` ודומים יחזירו **404** או HTML במקום JSON.

---

## פריסה (Netlify)

לאחר `git push`, ודאו ש־**Build** כולל את **`netlify.toml`** המעודכן (redirects ל־`sale/checkout`, `sale/purchase-contract`, `client/stored-cards`, וכו’) וש־**Functions** נבנות מ־`netlify/functions/`.

---

## קבצים מרכזיים (הפניה מהירה)

| אזור | קבצים |
|------|--------|
| UI + לוגיקת דיאלוג | `src/js/pricing-api.js`, `src/content/pricing-api.html` |
| עיצוב pricing + loader | `src/css/components-pricing.css` |
| Checkout / purchase contract | `netlify/functions/mindbody-sale-checkout.mjs`, `mindbody-sale-purchase-contract.mjs` |
| הסכמות מנוי | `netlify/functions/mindbody-membership-electronic-consent.mjs` |
| שרת פיתוח מאוחד | `scripts/unified-local-dev.mjs` |

---

*עודכן כמסמך סיכום לשינויי האינטגרציה; לשינויים עתידיים עדכנו כאן או הפנו מכאן ל־`MINDBODY.md`.*
