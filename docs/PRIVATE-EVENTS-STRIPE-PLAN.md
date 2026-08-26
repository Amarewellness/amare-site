# Private Events — דף פרטים, מקדמה Stripe, וחיובים אוטומטיים

**Status:** Phase 2 live + Aug 2026 enhancements (admin, offers, activity log, balance-now checkout).  
**Last updated:** 2026-08-26  
**Scope:** אירועים פרטיים בלבד. **לא** שיעורי Mindbody, **לא** מנויים, **לא** NCS.  
**Related:** [`URL-MAP.md`](./URL-MAP.md), [`MEMBERSHIP-RECURRING-CHECKOUT.md`](./MEMBERSHIP-RECURRING-CHECKOUT.md), [`MINDBODY-CHECKOUT-OVERVIEW.md`](./MINDBODY-CHECKOUT-OVERVIEW.md)

---

## TL;DR

לקוחה מקבלת לינק לדף הסבר (לא בתפריט). היא ממלאת תאריך / אנשים / עיצוב, משלמת **$200 מקדמה פעם אחת** ב-Stripe, והכרטיס נשמר.

אחרי אישור סטודיו:

1. **יום לפני** — חיוב אוטומטי של היתרה (אותו כרטיס, בלי Checkout נוסף) — **Phase 3**
2. **אחרי האירוע** — אם נשארו יותר, הצוות לוחץ בדשבורד וחיוב $50 לכל 30 דקות

הלקוחה ממלאת פרטי אשראי **פעם אחת**. בפירוט האשראי יכולות להופיע 2–3 שורות (מקדמה / יתרה / תוספת) — זה מכוון.

**מקדמה כבר שולמה (מזומן / Venmo / אדמין):** Send booking link גובה את **היתרה מיד** ב-Checkout (לא Setup / לא “יום לפני”), ושומר כרטיס לתוספת זמן.

---

## 1. למה שני דפים

| דף | URL | תפקיד | בתפריט? |
|----|-----|--------|---------|
| Events (שיווק + פנייה) | `/privateevents` | תמונות, השראה, טופס inquiry | כן |
| Event details (שליחה ללקוחה) | `/event-info` | הסבר, מחירים, שריון + מקדמה | לא |

`/privateevents` נשאר דף ליד. `/event-info` הוא הלינק ששולחים בווצאפ / אינסטגרם / מייל.

קישור קטן מ-Events → Event details, כדי שהצוות ימצא אותו. בלשונית Events מסומנת גם כשנמצאים ב-`/event-info`.

---

## 2. מה הלקוחה רואה ב-`/event-info`

1. **פורמט** — ציר זמן: 30 דק' עיצוב → שעת אימון → 30 דק' חגיגה (~שעתיים)
2. **חבילה** — $550 (שיעור אחרון ביום, או בוקר, כדי לא להפריע ללוח)
3. **תשלום** — $200 מקדמה לשריון; יתרה יום לפני ($350 בלי תוספות)
4. **עיצוב אופציונלי**
   - Reformer (עד 9): **$150** — בלון מעופף על כל רפורמר, שלט כניסה, בלונים סביב השלט
   - Mat (10–17): **$200** — אותה חבילה, בלונים לפי מספר המשתתפים
5. **חדרים** — Reformer 9 / Mat 17 / Kangoo 10
6. **כללים** — $50 לכל 30 דקות נוספות; נשארים בחדר אם רצים שיעורים במקביל
7. **שעות** — ראשון בבוקר עד שישי אחר הצהריים (שבת סגור)
8. **טופס שריון** — מקדמה $200 + הסכמת חיוב

אין להעתיק את כל `/terms` לדף. קישור לסעיף 15: `/terms#private-events`.

### מצבי URL ב-`/event-info`

| פרמטרים | מתי | מה מוצג |
|---------|-----|---------|
| (רגיל) | לינק booking חדש | טופס + מחירים |
| `?o=off_…` | לינק מותאם מאדמין | טופס עם שדות נעולים / מחירים מההצעה |
| `?o=off_…&book=1` | Send booking | כמו למעלה, מוכן לתשלום |
| `?reserved=1&o=off_…` | חזרה מ-Stripe אחרי מקדמה | באנר תודה + סיכום (טופס מוסתר) |
| `?reserved=1&balance=1&o=off_…` | חזרה אחרי תשלום יתרה מיידי | “Balance paid” + סיכום מלא |
| `?canceled=1` | ביטול Checkout | הודעה + אפשרות לנסות שוב |
| `?view=1&o=off_…` | כפתור **View your reservation** במייל | דף סיכום read-only (לא טופס חדש) |

**חשוב:** `view=1` ≠ `reserved=1`. המייל מוביל ל-`view=1` (צפייה באירוע קיים). `reserved=1` מיועד לדף success מיד אחרי Stripe.

---

## 3. מחירון (שרת הוא מקור האמת)

מוגדר ב-`netlify/functions/event-booking-lib.mjs` — **לא** סומכים על סכומים מהדפדפן.

| פריט | סכום |
|------|------|
| חבילת אירוע (2 שעות) | $550 |
| מקדמה (עכשיו) | $200 |
| יתרה בלי תוספות | $350 |
| עיצוב Reformer | $150 |
| עיצוב Mat | $200 |
| ניקיון (אופציונלי, אדמין) | USD חופשי עד $2,000 |
| תוספת זמן | $50 / 30 דקות |

**נוסחת יתרה:** `package + styling + cleaning − deposit`

**דוגמאות יתרה (יום לפני, אחרי אישור):**

| הזמנה | סה״כ | מקדמה | יתרה |
|--------|------|--------|------|
| חבילה בלבד | $550 | $200 | $350 |
| Reformer + עיצוב | $700 | $200 | $500 |
| Reformer + עיצוב + ניקיון $49 | $749 | $200 | $549 |
| Mat + עיצוב | $750 | $200 | $550 |

עיצוב וניקיון נכנסים ליתרה. תוספת שעות נגבית **אחרי** האירוע.

**נעילת מחירים ב-Checkout:** `event-offer-store.mjs` — `applyReservationPricingLocks`, `eventPriceOverrideFrom` — מוודא ש-Stripe משתמש באותם styling/cleaning/deposit כמו ברשומת ההזמנה.

---

## 4. זרימת הלקוחה

```
ווצאפ / אינסטגרם / מייל
        ↓
  /event-info  (הסבר + טופס, או ?o=off_… מותאם)
        ↓
  תאריך, שעה, אנשים, חדר, עיצוב, וי הסכמה
        ↓
  Stripe Checkout — $200 (או יתרה אם מקדמה כבר שולמה)
  (כרטיס נשמר: setup_future_usage = off_session)
        ↓
  סטטוס: deposit_paid_pending_confirm
  מייל ללקוחה + מייל לאדמין
        ↓
  צוות מאשר תאריך ב-/admin/events
        ↓
  יום לפני: חשבונית יתרה אוטומטית     ← Phase 3
        ↓
  אחרי האירוע: Overtime / Other בדשבורד
```

### זרימה: מקדמה כבר שולמה (אדמין)

```
Add event / Edit — ✓ Deposit already paid
        ↓
Send booking link (?o=off_…&book=1)
        ↓
לקוחה פותחת — רואה “Pay balance now”
        ↓
Stripe Checkout — יתרה מלאה (payRemainingNow=1)
        ↓
Success: ?reserved=1&balance=1
        ↓
כרטיס נשמר לתוספת זמן; remainingPaid=true
```

קבצים: `stripe-event-create-deposit.mjs`, `event-reservation-fulfill.mjs`, `event-reserve.js`.

---

## 5. למה לא כפתור $550 פתוח / לא פופ־אפ

- אירוע תלוי זמינות (תאריך, חדר, שיעורים במקביל, לובי). תשלום חופשי עלול לתפוס תאריך תפוס.
- המקדמה = **בקשת תאריך**. הסטטוס אחרי התשלום הוא "ממתין לאישור סטודיו". רק Confirm נועל.
- תאריך + אנשים + חדר + עיצוב + הסכמה משפטית + Stripe — יותר מדי לפופ־אפ, במיוחד ממובייל אחרי ווצאפ. לכן טופס בדף, ואז מעבר ל-Stripe.

הסכמה חובה (אותו נוסח בטופס ובשמירה):

> I authorize AMARÉ Wellness Studio to charge this card for the remaining event balance the day before the event, and $50 for every extra 30 minutes beyond the booked time.

(כשמקדמה כבר שולמה — הנוסח מתעדכן ל-charge balance **now**.)

בלי הווי הזה, חיוב off-session נחסם בקלות כ-dispute.

---

## 6. מה כבר בנוי

### Phase 1 — דף + מקדמה

| חלק | איפה |
|-----|------|
| דף הסבר + טופס שריון | `src/content/event-info.html`, `/event-info` |
| סגנון | `src/css/site.css` (`.event-info*`, `.event-reserve-form`) |
| JS טופס → Checkout | `src/js/event-reserve.js` |
| מחירים + ולידציה | `netlify/functions/event-booking-lib.mjs` |
| שמירת הזמנה (Blobs / memory מקומי) | `netlify/functions/event-reservation-store.mjs` |
| יצירת Checkout מקדמה + שמירת כרטיס | `netlify/functions/stripe-event-create-deposit.mjs` |
| Webhook (בלי Mindbody) | `event-reservation-fulfill.mjs` + ענף ב-`stripe-webhook.mjs` |
| מייל לקוחה + אדמין | `netlify/functions/event-reservation-emails.mjs` |
| נתיב API | `POST /api/stripe/events/create-deposit` |
| דגל | `ENABLE_STRIPE_EVENT_DEPOSIT=1` |

**לא** מסנכרנים ל-Mindbody. זה לא קרדיט שיעורים.

חדר אוטומטי לפי מספר אורחים (עד 9 Reformer, אחרת Mat), עם אפשרות לבחור ידנית. Kangoo עד 10, בלי עיצוב. שבת נחסמת.

### Phase 2 — דשבורד `/admin/events`

| חלק | איפה |
|------|------|
| דף אדמין | `src/content/admin-events.html`, `/admin/events` |
| JS | `src/js/admin-events.js` |
| CSS | `src/css/components-admin-sms.css` |
| API admin | `netlify/functions/event-reservations-admin.mjs` |
| חיוב כרטיס שמור | `event-reservation-charge.mjs` |

**תצוגות:** טבלת הזמנות · לוח שנה · טופסי inquiry מ-`/privateevents`.

**טבלה:** תאריך, לקוח, חדר, עיצוב/ניקיון, מקדמה, יתרה, תוספות, סטטוס, Actions.

**מיון:** By event date / By created (מציג “Added …”).

**עמודות תשלום:** תג **Paid** ירוק בעמודות Deposit ו-Remaining כששולם (Stripe או סימון ידני).

**Actions (לפי סטטוס והרשאות):**

| פעולה | תיאור |
|--------|--------|
| **Edit** | עריכת פרטים / מחירים (נעול אחרי remaining paid) |
| **Log** | ציר זמן פעילות (modal) |
| **Send details** | מייל “How your event works” + פורמט |
| **Send booking** / **Resend booking** | לינק מותאם `?o=off_…&book=1` |
| **Confirm** | נועל תאריך + מייל |
| **Charge remaining** | חיוב יתרה ידני (עם loader על הכפתור) |
| **Move date** | שינוי תאריך + מייל |
| **Cancel** | ביטול אירוע פעיל (deposit paid / confirmed) + מייל אופציונלי; מחזיר סטטוס `canceled` |
| **Delete** | מחיקה לצמיתות מהרשימה — **ללא מייל**; `canceled` מותר גם עם תשלומים (אחרי Cancel) |
| **Overtime / Other** | תוספת זמן / חיוב מותאם |

### Cancel vs Delete

| | **Cancel** | **Delete** |
|---|-----------|------------|
| מתי | `deposit_paid_pending_confirm` / `confirmed` | `canceled` (גם עם Paid), `deposit_pending`, `expired`, טיוטות |
| תשלומים online | מותר (הרשומה נשארת) | **canceled + paid:** מותר למחוק מהאדמין; Stripe נשאר |
| מייל ללקוחה | אופציונלי | לא |
| תוצאה | סטטוס `canceled` | הרשומה נמחקת מ-Blobs |

**כללי מחיקה** (`canPermanentlyDeleteReservation` ב-`event-booking-lib.mjs`):

- חסום אם הסטטוס `confirmed` או `deposit_paid_pending_confirm` — קודם **Cancel**
- **`canceled` — תמיד ניתן למחיקה** (גם עם deposit/remaining Paid); פופ־אפ + checkbox אישור
- אחרת: חסום אם יש תשלומים online; מותר ל-expired / deposit_pending / טיוטות ללא תשלום

API: `POST /api/admin/events/delete` — body: `{ id, confirmDelete: true }`  
Store: `event-reservation-store.mjs` → `remove(id)` (מוחק reservation + session index)

**הוספה ידנית:** Add to Reservations — מקדמה/יתרה “already paid”, ניקיון, Send booking link.

**Activity log:** `event-reservation-activity.mjs` — `GET /api/admin/events/activity?id=`

נרשם: created, booking link sent/opened, checkout started/completed/canceled, deposit, balance, overtime, custom charge, confirm, cancel, reschedule, emails.

**Personalized offers:** `event-offer-store.mjs` — `GET /api/events/offer?o=`

- `track=1` — פתיחת לינק (dedupe 2 דק')
- `afterCheckout=1` — קריאה אחרי Stripe success (offer used)
- `view=1` — צפייה מאייל “View your reservation” (offer used, לא expired check)
- **Fallback:** אם blob של ה-offer חסר — API בונה offer מה-reservation לפי `offerId` (`findByOfferId`)

**נעילת עיצוב ללקוח:** `lockStyling` על offer — checkbox styling נעול בדף הלקוח.

### Phase 3 — יתרה אוטומטית יום לפני

**עדיין לא.** Charge remaining קיים ידנית בדשבורד.

---

## 7. מודל סטטוסים

| סטטוס | משמעות |
|--------|--------|
| `deposit_pending` | נפתח Checkout, עוד לא שולם |
| `deposit_paid_pending_confirm` | מקדמה התקבלה; מחכים לאישור צוות |
| `confirmed` | תאריך נעול; יתרה תרוץ יום לפני |
| `expired` | Checkout פג בלי תשלום |
| `canceled` | בוטל |

שדות חשובים: תאריך/שעה, אורחים, חדר, styling, `cleaningCents`, סכומים, `offerId`, `stripeCustomerId`, `stripePaymentMethodId`, `depositPaid`, `remainingPaid`, `activityLog[]`, snapshot הסכמה.

---

## 8. אימיילים

| מתי | למי | תוכן |
|-----|-----|------|
| מקדמה שולמה (webhook) | לקוחה | סיכום + CTA **View your reservation** (אם יש `offerId`) |
| מקדמה שולמה (webhook) | אדמין | פרטים + Open event admin |
| Confirm | לקוחה | תאריך משוריין + CTA view |
| Charge remaining | לקוחה | קבלה + CTA view |
| Reschedule | לקוחה | תאריך חדש + CTA view |
| Cancel | לקוחה | ביטול + Contact |
| Send details (ידני) | לקוחה | פורמט + timeline + policies |
| Send booking (ידני) | לקוחה | לינק `?o=…&book=1` |
| Overtime / custom | לקוחה | פירוט חיוב + Contact |

**CTA במיילים אחרי תשלום:**

- **יש `offerId`:** `https://www.amarewellness.com/event-info?view=1&o=off_…` — כפתור **View your reservation**
- **אין offer** (הזמנה ישירה מ-`/event-info`): **אין כפתור** — כל הפרטים בגוף המייל (לא מוביל לטופס booking)

Resend, כמו שאר המיילים. בלי Resend / webhook — התשלום נרשם, המייל לא יישלח.

---

## 9. API routes (events)

| Method | Path | תפקיד |
|--------|------|--------|
| POST | `/api/stripe/events/create-deposit` | Checkout מקדמה / יתרה |
| GET | `/api/events/offer` | קריאת offer ציבורית |
| GET | `/api/admin/events/list` | רשימת הזמנות |
| GET | `/api/admin/events/forms` | inquiries |
| GET | `/api/admin/events/activity` | activity log |
| POST | `/api/admin/events/confirm` | אישור תאריך |
| POST | `/api/admin/events/charge-overtime` | תוספת זמן |
| POST | `/api/admin/events/charge-custom` | חיוב Other |
| POST | `/api/admin/events/charge-remaining` | יתרה ידנית |
| POST | `/api/admin/events/cancel` | ביטול (מייל אופציונלי) |
| POST | `/api/admin/events/delete` | מחיקה לצמיתות |
| POST | `/api/admin/events/reschedule` | שינוי תאריך |
| POST | `/api/admin/events/update` | עריכה |
| POST | `/api/admin/events/send-details` | מייל פרטים |
| POST | `/api/admin/events/send-booking` | שליחת booking link |
| POST | `/api/admin/events/manual` | הוספה ידנית |
| POST | `/api/admin/events/offers` | יצירת offer |

---

## 10. בדיקה מקומית

1. `ENABLE_STRIPE_EVENT_DEPOSIT=1` ב-`.env`
2. `STRIPE_SECRET_KEY` (test) + `STRIPE_ORDER_STORE_LOCAL_MEMORY=1`
3. `npm run dev` (port 4321) — להפעיל מחדש אחרי שינוי API
4. דף: http://127.0.0.1:4321/event-info#reserve
5. Webhook: `node scripts/start-stripe-listen-local.mjs` → `http://127.0.0.1:4321/api/stripe/webhook`
6. נתונים מקומיים: `data/event-reservations/local-store.json`, `data/event-offers/local-store.json`

**View reservation (מייל):**  
`http://127.0.0.1:4321/event-info?view=1&o=off_<ID מלא>` — חייב ID מלא, לא `off_…`

**טיפ:** קישורי production (`amarewellness.com`) עובדים רק **אחרי deploy**. לבדיקה מקומית השתמש ב-`127.0.0.1:4321`.

**טיפ:** אחרי שינוי backend — Regenerate **Copy link** / Send booking לאירועים קיימים.

בלי הדגל, Checkout מחזיר: online deposits aren’t open yet.

---

## 11. מה במכוון מחוץ לסקופ / backlog

- סנכרון Mindbody
- כפתור תשלום פתוח בלי טופס / בלי אישור צוות
- Hold גדול מראש כמו מלון
- חיוב אוטומטי לפי שעון בלי לחיצת צוות
- דפי אירוע לפי סוג (`/event-info/bridal`)
- **Phase 3** — cron יום-לפני

---

## 12. סיכום שינויי Aug 2026

| נושא | קבצים עיקריים |
|------|----------------|
| מקדמה שולמה → יתרה מיידית | `stripe-event-create-deposit.mjs`, `event-reservation-fulfill.mjs` |
| דף success / view reservation | `event-reserve.js`, `event-info.html`, `event-offer-public.mjs` |
| מייל View your reservation | `event-reservation-emails.mjs` → `?view=1&o=off_…` |
| Fallback offer מ-reservation | `offerFromReservation`, `findByOfferId` |
| Activity log | `event-reservation-activity.mjs`, כפתור Log באדמין |
| מיון By created | `admin-events.js`, `admin-events.html` |
| תג Paid (Deposit + Remaining) | `admin-events.js` |
| Loader Charge remaining | `admin-events.js`, CSS |
| ניקיון + lock styling | admin + checkout pricing locks |
| **מחיקה לצמיתות** | `event-booking-lib.mjs`, `event-reservation-store.remove`, admin Delete |

---

## 13. סדר עבודה

1. **Phase 1** — דף + טופס + מקדמה $200 + כרטיס שמור + מיילים + רשומה ✅  
2. **Phase 2** — `/admin/events` + Confirm + overtime + remaining + offers + activity + cleaning + balance-now + delete ✅  
3. **Phase 2b** — `view=1` summary page ✅  
4. **Phase 3** — חיוב יתרה אוטומטי יום לפני
