# בלבול מותג: AMARÉ Wellness (FL) vs AMARE PILATES NYC

> **סטטוס:** מסמך תיעוד פנימי — ינואר–יוני 2026  
> **מטרה:** לרכז את כל הממצאים מהחקירה (SMS, קודי הנחה, מקורות מערכת, מותג מתחרה, trademark) ולהכין חומר לעו"ד / לצוות תפעול.  
> **לא ייעוץ משפטי** — להחלטות משפטיות יש להתייעץ עם עורך דין סימני מסחר בארה"ב.

---

## 1. תקציר מנהלים

| נושא | מסקנה |
|---|---|
| האם האתר/Netlify שולח SMS ללקוחות? | **לא** — Twilio מחובר בקוד אך **כבוי** (dry-run). |
| האם Mindbody שולח SMS? | **כן** — בעיקר אישורי הזמנה ותזכורות שיעור. |
| SMS עם WELCOME10 ללקוחה Rima | **לא** מ-Mindbody, **לא** מ-Stripe, **לא** מ-Twilio שלנו — **Klaviyo** של **amarepilates.com** (NYC). |
| קשר לרכישת Monthly 5 | **אין** — רכישה ב-$125 ללא הנחה. |
| WELCOME10 אצלנו | **לא קיים** ב-Mindbody Promotions וב-Stripe Coupons. |
| סטודיו מתחרה | **AMARE PILATES NYC** — Amare by Marina LLC (DE), פעיל מ-~2022, trademark USPTO הוגש 04/2026. |
| אנחנו פעילים מ- | **2024** — חלש לטיעון "שימוש קודם" מול ההתנגדות שלהם. |
| פעולה מומלצת עכשיו | הבחנה מותגית, תיעוד בלבול, שקילת רישום trademark משלנו, ייעוץ עו"ד. |

---

## 2. מערכות SMS — מה שולח מה

### 2.1 Twilio (אתר amarewellness.com / Netlify)

**מיקום בקוד:** `netlify/functions/twilio-sms-client.mjs`, `netlify/functions/new-client-sms-scan.mjs`

שליחה חסומה אלא אם **כל** התנאים מתקיימים:

| משתנה | ברירת מחדל (`.env.example`) |
|---|---|
| `ENABLE_NEW_CLIENT_SMS_AUTOMATION` | `0` |
| `NEW_CLIENT_SMS_DRY_RUN` | `1` |
| `ENABLE_NEW_CLIENT_SMS_SENDING` | `0` |
| `TWILIO_ACCOUNT_SID` / `AUTH_TOKEN` / `FROM_NUMBER` | ריקים |

קוד קופון ב-SMS שלנו (אם יופעל): **`KEEPMOVING15`** (`NEW_CLIENT_SMS_COUPON_CODE`).

**מסקנה:** לא נשלחו SMS שיווקיים ללקוחות דרך המערכת שלנו.

### 2.2 Mindbody Notifications

מסך **Settings → Notifications** (יוני 2026):

| Notification | SMS MTD (חודש נוכחי) |
|---|---|
| Reservation Confirmations (Single) | 11 |
| Reservation Reminder | 4 |
| רוב שאר הסוגים | 0 |

- **Follow-up Dashboard** — report-only, ללא Twilio.
- **Staff Schedule** — אימייל בלבד (MVP).
- **Admin UI** (`/admin/new-client-followup`) — "Copy message", לא שליחה.

**מסקנה:** Mindbody שולח SMS **טרנזקציוניים** (הזמנות/תזכורות), לא קמפיין "הקוד שלך עומד לפוג".

### 2.3 מקורות אחרים

| מקור | הערה |
|---|---|
| **Klaviyo** | Short links `kla4.io` — **לא** חלק מה-repo שלנו. |
| **Attentive** | שותף SMS שיווקי רשמי של Mindbody — לא אומת אם מחובר אצלנו. |
| **Stripe** | קופונים ב-checkout — **לא** שולח SMS. |

---

## 3. מקרה ללימוד: Rima Witcher

### 3.1 הרכישה (Mindbody → Purchases)

| שדה | ערך |
|---|---|
| Sale ID | **12523** |
| תאריך | **06/04/2026** |
| אמצעי תשלום | Stripe |
| תיאור | AMARÉ Monthly 5 Classes |
| מיקום | Online Store |
| Price | **$125.00** |
| Discount | **$0.00** |
| Amount Paid | **$125.00** |
| Payment Ref | 9503 |

**אין קוד הנחה ברכישה.**

### 3.2 ה-SMS שהתקבל

טקסט (בערך):

> Amare Pilates: Your promo code is expiring soon! Use **WELCOME10** to redeem your offer today. https://kla4.io/... Text STOP to opt-out

### 3.3 ממצאי חקירה

| בדיקה | תוצאה |
|---|---|
| `kla4.io/H4bSNc` | מפנה ל-**amarepilates.com** (Shopify, Tribeca NYC, Marina) — **לא** amarewellness.com |
| WELCOME10 ב-Mindbody Promotions | **לא קיים** |
| WELCOME10 ב-Stripe Coupons | **לא קיים** |
| קשר ל-Sale 12523 | **אין** |
| Contact Logs (Rima) | פילטר "Non-system generated" — לא מציג הודעות מערכת; לא נמצא log ל-SMS זה |

### 3.4 מסקנה למקרה

ה-SMS נשלח מ-**אוטומציית Klaviyo** של **AMARE PILATES NYC**, לא ממערכות AMARÉ Wellness.

---

## 4. מפת קודי הנחה — AMARÉ Wellness

### 4.1 Mindbody → Promotions

| קוד | הערה |
|---|---|
| amare15 | 15% |
| staff discount | צוות |
| 100% | פנימי / בדיקות |
| אל על | מיוחד |

**אין:** WELCOME10, AMARE10, KEEPMOVING

### 4.2 Stripe → Product catalog → Coupons

| קוד | תנאים | שימושים (נכון לתיעוד) |
|---|---|---|
| Mindbody | 15% off once | 5 |
| KEEPMOVING15 | 15% off once | 0/50 |
| KEEPMOVING | 10% off once | 0/50 |
| WEMISSYOU | 10% off once, expires May 31 | 0/100 |
| snir test | 99% off once | 3 |

**אין:** WELCOME10

### 4.3 מיפוי שימוש מתוכנן (מה-repo)

| קוד | איפה | מטרה |
|---|---|---|
| amare15 | Mindbody checkout | הנחה בקופה MB |
| Mindbody (Stripe) | checkout באתר | 15% — מסונכרן עם MB |
| KEEPMOVING / KEEPMOVING15 | תבניות אימייל MB + (עתידי) SMS שלנו | המרת NCS |
| WEMISSYOU | win-back email + Stripe | לקוחות שלא חזרו |
| WELCOME10 | **לא אצלנו** | מוזכר ב-docs לבדיקות sandbox בלבד; מופיע ב-SMS של NYC |

---

## 5. שני עסקים — השוואה

| | **AMARÉ Wellness Studio** | **AMARE PILATES NYC** |
|---|---|---|
| אתר | [amarewellness.com](https://www.amarewellness.com) | [amarepilates.com](https://www.amarepilates.com) |
| מיקום | Hallandale Beach, **Florida** | Tribeca, **NYC** |
| כתובת (מהאתר שלנו) | 501 N Dixie Hwy, Hallandale Beach, FL 33009 | — |
| אינסטגרם | @amare__wellness | — |
| ישות משפטית | — (לתעד) | **Amare by Marina LLC** (Delaware) |
| תאריך רישום LLC | — | **14/10/2022** |
| שיווק באתר | — | "est 2021" |
| פעילות שלנו | **מ-2024** | לפנינו (2022+) |
| שיווק SMS | כבוי (Twilio) | Klaviyo (`kla4.io`) |
| קשר ב-repo | **אין** קישור ל-amarepilates.com | — |

---

## 6. Trademark USPTO — AMARE PILATES NYC

### 6.1 בקשות (מחיפוש USPTO)

| Serial | סוג | סטטוס (נכון לתיעוד) |
|---|---|---|
| **99737663** | Wordmark — AMARE PILATES NYC | LIVE / **PENDING** |
| **99737701** | Logo + AMARE PILATES NYC | LIVE / **PENDING** |

**בעלים:** Amare by Marina LLC (Delaware, USA)

**Goods & Services (תמצית):**

- **IC 025:** Sport socks; Hoodies; Socks
- **IC 041:** Pilates instruction; (המשך בבקשה המלאה)

### 6.2 Prosecution History (מתוך TSDR)

| תאריך | תיאור |
|---|---|
| 2026-04-01 | NEW APPLICATION ENTERED |
| 2026-04-01 | APPLICATION FILING RECEIPT MAILED |
| 2026-04-05 | NEW APPLICATION OFFICE SUPPLIED DATA ENTERED |

**עדיין לא:** פרסום ב-Official Gazette, חלון Opposition, אישור סופי.

### 6.3 ציר זמן משפטי-מסחרי

```
2021 (שיווק)     AMARE PILATES NYC — "est 2021" באתר
2022-10-14       Amare by Marina LLC — רישום Delaware
2024             AMARÉ Wellness Studio — תחילת פעילות שלנו
2026-04-01       הגשת trademark USPTO (הם)
2026-06          חקירת SMS Rima — זיהוי Klaviyo → amarepilates.com
???              Publication for Opposition (צפוי סוף 2026 / 2027)
```

---

## 7. ניתוח אפשרויות (לא ייעוץ משפטי)

### 7.1 Opposition ל-USPTO בלי trademark רשום משלנו

**אפשר טכנית** — לא חייבים רישום כדי להתנגד.

**עילות אפשריות:**

- Common law trademark — שימוש מסחרי קודם
- Likelihood of confusion
- Unfair competition

**מצבנו (פעילים מ-2024, הם מ-2022):**

| טיעון | עוצמה |
|---|---|
| שימוש קודם (Prior Use) | **חלש** — הם לפנינו |
| בלבול בפועל (Rima, FL ← SMS NYC) | **בינוני** |
| שווקים נפרדים (FL vs NYC) | **מסייע לנו** |
| שמות שונים (AMARÉ Wellness vs AMARE PILATES NYC) | **מסייע לנו** |

**Opposition יקר** ($5K–$20K+) — שווה רק אם עו"ד רואה עילה מעבר ל"היינו ראשונים".

### 7.2 פעולות מעשיות (מומלץ)

1. **הבחנה מותגית** — תמיד "AMARÉ Wellness Studio · Hallandale Beach, Florida"
2. **תיעוד בלבול** — כל מקרה (SMS, שיחות, ביקורות, הזמנות שגויות)
3. **רישום trademark משלנו** — "AMARÉ Wellness Studio" (שם מלא)
4. **מעקב TSDR** — [tsdr.uspto.gov](https://tsdr.uspto.gov) עד **"Published for Opposition"**
5. **ייעוץ עו"ד** — Cease & Desist על בלבול, לא רק Opposition
6. **Wayback Machine** — ארכיון amarewellness.com / amarepilates.com לציר זמן

### 7.3 מה לא מספיק לבד

- "הם מעתיקים צבעים" — קשה להגנה בלי שילוב שם + מראה + בלבול
- "AMARE זה שלנו" — מילה גנרית; הגנה על **שם מלא**
- רישום שלהם ל-"AMARE PILATES NYC" — לא בהכרח חוסם "AMARÉ Wellness" ב-FL

---

## 8. צ'קליסט ראיות לעו"ד / לתיעוד פנימי

### 8.1 בלבול צרכנים

- [ ] צילום SMS מלא (Rima) — שולח, תאריך, טקסט, `kla4.io`
- [ ] אישור שהלינק מוביל ל-amarepilates.com (לא אלינו)
- [ ] תיעוד Sale 12523 — $125, ללא הנחה
- [ ] מקרים נוספים של בלבול (אם יש)
- [ ] תלונות לקוחות / שאלות "אתם גם ב-NYC?"

### 8.2 ציר זמן שלנו

- [ ] תאריך פתיחה רשמי (2024 — לפרט: חודש)
- [ ] Google Business — תאריך ראשון
- [ ] Mindbody — תאריך פתיחת חשבון
- [ ] Wayback — amarewellness.com snapshots
- [ ] אינסטגרם — פוסט ראשון
- [ ] רישיון עסק פלורידה / חוזה שכירות

### 8.3 ציר זמן שלהם

- [x] Delaware LLC — 14/10/2022 (File #7089246)
- [ ] Wayback — amarepilates.com
- [x] USPTO filing — 01/04/2026
- [ ] צילום מסך trademark search (99737663, 99737701)

### 8.4 מערכות שלנו (לשלילת מקור SMS)

- [x] אין WELCOME10 ב-Mindbody Promotions
- [x] אין WELCOME10 ב-Stripe
- [x] Twilio כבוי — `.env.example` + `twilio-sms-client.mjs`

---

## 9. הפניות ב-repo

| נושא | קובץ |
|---|---|
| Twilio gates | `netlify/functions/twilio-sms-client.mjs` |
| New Client SMS | `docs/NEW-CLIENT-SMS-FOLLOWUP.md` |
| תבניות אימייל Mindbody | `docs/email-templates/README.md` |
| קופונים Stripe / WELCOME10 בבדיקות | `docs/MEMBERSHIP-RECURRING-CHECKOUT.md` |
| Follow-up dashboard (ללא SMS) | `docs/FOLLOW-UP-DASHBOARD.md` |
| env defaults | `.env.example` |

---

## 10. שאלות פתוחות

| # | שאלה | סטטוס |
|---|---|---|
| 1 | האם Rima נרשמה אי פעם לרשימת amarepilates.com? | לשאול לקוחה |
| 2 | האם Attentive מחובר ב-Mindbody שלנו? | לבדוק Settings → Integrations |
| 3 | חודש פתיחה מדויק של AMARÉ Wellness (2024) | לתעד |
| 4 | האם יש לנו ישות משפטית / רישום עסק ב-FL? | לתעד לעו"ד |
| 5 | תאריך Publication for Opposition (USPTO) | מעקב TSDR |

---

## 11. היסטוריית עדכונים

| תאריך | עדכון |
|---|---|
| 2026-06-05 | יצירת מסמך — ריכוז שיחת חקירה SMS, Rima, קודים, trademark NYC |

---

*מסמך פנימי — AMARÉ Wellness Studio / amare-site*
