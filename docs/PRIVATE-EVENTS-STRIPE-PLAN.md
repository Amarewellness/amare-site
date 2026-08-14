# Private Events — דף פרטים, מקדמה Stripe, וחיובים אוטומטיים

**Status:** Phase 2 implemented locally (2026-08-14) — דשבורד `/admin/events` + Confirm + חיוב תוספת שעות.  
**Last updated:** 2026-08-14  
**Scope:** אירועים פרטיים בלבד. **לא** שיעורי Mindbody, **לא** מנויים, **לא** NCS.  
**Related:** [`URL-MAP.md`](./URL-MAP.md), [`MEMBERSHIP-RECURRING-CHECKOUT.md`](./MEMBERSHIP-RECURRING-CHECKOUT.md), [`MINDBODY-CHECKOUT-OVERVIEW.md`](./MINDBODY-CHECKOUT-OVERVIEW.md)

---

## TL;DR

לקוחה מקבלת לינק לדף הסבר (לא בתפריט). היא ממלאת תאריך / אנשים / עיצוב, משלמת **$200 מקדמה פעם אחת** ב-Stripe, והכרטיס נשמר.

אחרי אישור סטודיו:

1. **יום לפני** — חיוב אוטומטי של היתרה (אותו כרטיס, בלי Checkout נוסף)
2. **אחרי האירוע** — אם נשארו יותר, הצוות לוחץ בדשבורד וחיוב $50 לכל 30 דקות

הלקוחה ממלאת פרטי אשראי **פעם אחת**. בפירוט האשראי יכולות להופיע 2–3 שורות (מקדמה / יתרה / תוספת) — זה מכוון.

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
| תוספת זמן | $50 / 30 דקות |

**דוגמאות יתרה (יום לפני, אחרי אישור):**

| הזמנה | סה״כ | מקדמה | יתרה |
|--------|------|--------|------|
| חבילה בלבד | $550 | $200 | $350 |
| Reformer + עיצוב | $700 | $200 | $500 |
| Mat + עיצוב | $750 | $200 | $550 |

עיצוב נכנס ליתרה של יום לפני. תוספת שעות נגבית **אחרי** האירוע, כי אי אפשר לדעת מראש.

היום תוספת שעות עוברת ב-Zelle ידני. המטרה: להחליף את זה בחיוב Stripe מהדשבורד.

---

## 4. זרימת הלקוחה

```
ווצאפ / אינסטגרם
        ↓
  /event-info  (הסבר + טופס)
        ↓
  תאריך, שעה, אנשים, חדר, עיצוב, וי הסכמה
        ↓
  Stripe Checkout — $200 בלבד
  (כרטיס נשמר: setup_future_usage = off_session)
        ↓
  סטטוס: deposit_paid_pending_confirm
  מייל ללקוחה + מייל לאדמין
        ↓
  צוות מאשר תאריך ב-/admin/events     ← Phase 2
        ↓
  יום לפני: חשבונית יתרה אוטומטית     ← Phase 3
        ↓
  אחרי האירוע: כפתור +30 / +60 בדשבורד ← Phase 2
```

הלקוחה **לא** נכנסת ל-Checkout שוב. היא מקבלת קבלה במייל על כל חיוב.

אם הכרטיס נדחה ביום לפני — רואים את זה **לפני** האירוע, לא בבוקר של.

---

## 5. למה לא כפתור $550 פתוח / לא פופ־אפ

- אירוע תלוי זמינות (תאריך, חדר, שיעורים במקביל, לובי). תשלום חופשי עלול לתפוס תאריך תפוס.
- המקדמה = **בקשת תאריך**. הסטטוס אחרי התשלום הוא "ממתין לאישור סטודיו". רק Confirm נועל.
- תאריך + אנשים + חדר + עיצוב + הסכמה משפטית + Stripe — יותר מדי לפופ־אפ, במיוחד ממובייל אחרי ווצאפ. לכן טופס בדף, ואז מעבר ל-Stripe.

הסכמה חובה (אותו נוסח בטופס ובשמירה):

> I authorize AMARÉ Wellness Studio to charge this card for the remaining event balance the day before the event, and $50 for every extra 30 minutes beyond the booked time.

בלי הווי הזה, חיוב off-session נחסם בקלות כ-dispute.

---

## 6. מה כבר בנוי (Phase 1 + 2)

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

אחרי תשלום מוצלח: `/event-info?reserved=1`. ביטול: `?canceled=1`.

חדר אוטומטי לפי מספר אורחים (עד 9 Reformer, אחרת Mat), עם אפשרות לבחור ידנית. Kangoo עד 10, בלי עיצוב. שבת נחסמת.

---

## 7. מה עוד לבנות

### Phase 2 — דשבורד + תוספת שעות (נחת מקומית)

כרטיס חדש ב-`/admin` → `/admin/events` (אותו טוקן `ADMIN_DEBUG_TOKEN` כמו שאר הכלים).

| חלק | איפה |
|------|------|
| דף אדמין | `src/content/admin-events.html`, `/admin/events` |
| JS | `src/js/admin-events.js` |
| API | `GET /api/admin/events/list`, `POST …/confirm`, `POST …/charge-overtime` |
| חיוב כרטיס שמור | `event-reservation-charge.mjs` (`invoice.pay` off-session) |

טבלה: קרוב / עבר, שם, תאריך, חדר, עיצוב, מקדמה, יתרה, תוספת, סטטוס.

פעולות לכל אירוע:

- **Confirm** — נועל תאריך + מייל ללקוחה; רק אז מותר חיוב יום-לפני (Phase 3)
- **Charge +30 min** / **Charge +60 min** — חשבונית $50 / $100 על הכרטיס השמור
- Refund / דחייה — אם התאריך תפוס (ידני ב-Stripe בינתיים, או כפתור בהמשך)

תוספת שעות **לא** לפי שעון אוטומטי. הצוות מאשר שנשארו.

### Phase 3 — יתרה אוטומטית יום לפני

Cron (Netlify Scheduled Function, UTC → `America/New_York`):

- רק אירועים בסטטוס `confirmed`
- יום לפני תאריך האירוע
- חשבונית על `remainingCents` (חבילה + עיצוב − $200)
- `invoice.pay({ off_session: true })`
- אם נדחה — מייל אדמין, בלי לסמן "שולם"

---

## 8. מודל סטטוסים

| סטטוס | משמעות |
|--------|--------|
| `deposit_pending` | נפתח Checkout, עוד לא שולם |
| `deposit_paid_pending_confirm` | מקדמה התקבלה; מחכים לאישור צוות |
| `confirmed` | תאריך נעול; יתרה תרוץ יום לפני |
| `expired` | Checkout פג בלי תשלום |
| `canceled` | בוטל |

שדות חשובים ברשומה: תאריך/שעה, אורחים, חדר, עיצוב, סכומים, `stripeCustomerId`, `stripePaymentMethodId`, snapshot של נוסח ההסכמה, IP, היסטוריית תשלומים (Phase 2).

---

## 9. אימיילים

| מתי | למי | תוכן |
|-----|-----|------|
| מקדמה שולמה (webhook) | לקוחה | $200 התקבלו, ממתין לאישור תאריך, סיכום חדר/עיצוב/יתרה |
| מקדמה שולמה (webhook) | אדמין (`SMS_ADMIN_REPORT_TO`) | פרטי הזמנה + לינק ל-`/admin` |
| Confirm (Phase 2) | לקוחה | התאריך משוריין; תזכורת ליתרה יום לפני |
| יתרה / תוספת (Phase 2–3) | לקוחה | קבלה מ-Stripe + שורת פירוט |

Resend, כמו שאר המיילים הפנימיים. בלי Resend / בלי webhook מקומי — התשלום עדיין נרשם, המייל לא יישלח.

---

## 10. בדיקה מקומית

1. `ENABLE_STRIPE_EVENT_DEPOSIT=1` ב-`.env`
2. `STRIPE_SECRET_KEY` (test) + `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` (כדי ש-create-session וה-webhook יחלקו את אותה זיכרון)
3. להפעיל מחדש `npm run dev` אחרי שינוי נתיבי API
4. דף: http://127.0.0.1:4321/event-info#reserve
5. כדי למלא רשומה + מיילים אחרי תשלום:  
   `stripe listen --forward-to http://127.0.0.1:4321/api/stripe/webhook`

בלי הדגל, הטופס מוצג אבל Checkout מחזיר: online deposits aren’t open yet.

**לא לפרוס ל-production** עד ש-Phase 1 עבר smoke test, והדגל כבוי ב-Netlify (`ENABLE_STRIPE_EVENT_DEPOSIT=0`) אלא אם מחליטים לפתוח.

---

## 11. מה במכוון מחוץ לסקופ

- סנכרון Mindbody (אין Pricing Option לאירוע)
- כפתור תשלום פתוח בלי טופס / בלי אישור צוות
- Hold גדול מראש כמו מלון
- חיוב אוטומטי לפי שעון בלי לחיצת צוות
- דפי אירוע לפי סוג (`/event-info/bridal`) — אפשר אחר כך, מתחילים מדף אחד
- Zelle נשאר גיבוי עד ש-Phase 2 יציב

---

## 12. סדר עבודה מוסכם

1. **Phase 1 (נחת)** — דף + טופס + מקדמה $200 + כרטיס שמור + מיילים + רשומה  
2. **Phase 2 (נחת)** — `/admin/events` + Confirm + כפתורי תוספת שעות  
3. **Phase 3** — חיוב יתרה אוטומטי יום לפני
