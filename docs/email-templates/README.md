# AMARÉ — Mindbody Email Templates

תבניות HTML מעוצבות לכל ה‑automated emails ש‑Mindbody שולח. כל קובץ כאן הוא **HTML מוכן להדבקה** ב‑Mindbody source view של ה‑template המתאים.

## איך לעדכן template ב‑Mindbody

1. Mindbody Manager → **Studio Settings** → **Communications** → **Email templates**
2. לחץ על שם ה‑template (למשל "Schedule | Reservation Confirmations (Single)").
3. לחץ על כפתור **Source / `<>`** (תצוגת HTML, לא WYSIWYG).
4. **שמור גיבוי** — העתק את כל ה‑HTML הקיים לקובץ מקומי לפני שתחליף.
5. החלף את התוכן ב‑HTML מהקובץ המתאים כאן.
6. שמור → **Send Test Email** לעצמך.
7. בדוק ב‑Gmail Web + Gmail iOS + Apple Mail → אם נראה תקין, ה‑template חי.

## אינדקס

| # | קובץ | Mindbody template |
|---|---|---|
| 0 | [`00-welcome.html`](./00-welcome.html) | Account / Welcome to `<STUDIONAME>` |
| 1 | [`01-reservation-single.html`](./01-reservation-single.html) | Schedule \| Reservation Confirmations (Single) |
| 2 | [`02-reservation-multiple.html`](./02-reservation-multiple.html) | Schedule \| Reservation Confirmations (Multiple) |
| 3 | [`03-cancellation.html`](./03-cancellation.html) | Schedule \| Class & Event Cancellation Notifications (Early) |
| 4 | [`04-waitlist-added.html`](./04-waitlist-added.html) | Schedule \| Added to Waitlist |
| 5 | [`05-waitlist-promoted.html`](./05-waitlist-promoted.html) | Schedule \| Promoted from Waitlist |
| 6 | [`06-class-reminder.html`](./06-class-reminder.html) | Schedule \| Class Reminder |
| 7 | [`07-autopay-failure.html`](./07-autopay-failure.html) | Sales \| Auto‑Pay Failure (Credit Card Declined) |
| 8 | [`08-membership-renewal.html`](./08-membership-renewal.html) | Sales \| Membership Renewal Notice |
| 9 | [`09-cancellation-late.html`](./09-cancellation-late.html) | Schedule \| Class & Event Cancellation Notifications (Late) |
| 10 | [`10-pricing-visits-low.html`](./10-pricing-visits-low.html) | Promotions \| Series Notification - Visits Remaining Low |
| 11 | [`11-pricing-time-low.html`](./11-pricing-time-low.html) | Promotions \| Series Notification - Time Running Out |
| 12 | [`12-teacher-sub-reminder.html`](./12-teacher-sub-reminder.html) | Operations \| Teacher Sub Reminder Email |
| 13 | [`13-no-show-notification.html`](./13-no-show-notification.html) | Schedule \| No Show Notification Emails |
| 14 | [`14-lapsed-win-back.html`](./14-lapsed-win-back.html) | **Marketing Suite** → Code your own (lapsed / win-back) |

## כללים קבועים בכל template

- **רוחב card**: 600px, רקע `#ffffff`, border `1px rgba(43,38,34,0.08)`, radius 8px.
- **רקע body**: `#faf3eb` (cream).
- **אקצנט CTA**: `#1a1816` עם טקסט `#faf3eb`.
- **פונטים**: `Fraunces` לכותרות + `DM Sans` לגוף, עם fallbacks ל‑Georgia / Helvetica (בלי טעינת web fonts — Mindbody ב‑production לא טוען אותם בכל מקרה).
- **placeholders ב‑`<head>`**: לא משתמשים ב‑`<style>`, ה‑`<head>` ריק (Mindbody עורך מסיר את התוכן בכל מקרה). כל ה‑CSS inline.
- **`href` בכפתורים**: תמיד URL מוקשח (`https://www.amarewellness.com/...`) — אסור placeholder בתוך `href`, זה שובר את ה‑Mindbody substitution. ראה [`docs/EMAIL-DESIGN-SYSTEM.md`](../EMAIL-DESIGN-SYSTEM.md) → "אזהרה — אל תשים placeholder בתוך `href`".
- **`<CLIENTFORMS>`**: למיילים שמקבלים waiver injection (Reservation, Promoted from Waitlist) — תמיד מעל ה‑card, בלי לעטוף ב‑styling שלנו. Mindbody מזריק שם HTML שלם של טפסים.
- **Preview text**: שורה ראשונה אחרי `<body>` — `<div>` מוסתר עם הטקסט שיופיע ליד הנושא ב‑inbox.

## CTA targets (מאיפה הוחלט)

| Template | CTA URL | למה |
|---|---|---|
| Welcome | `/classes` | להוביל לפעולה הראשונה — הזמנת שיעור |
| Reservation (Single+Multi) | `/classes` | לראות את הלו"ז ולנהל הזמנות |
| Cancellation (Early) | `/classes` | להציע לבחור שיעור חלופי |
| Cancellation (Late) | `/classes` | קדימה — לבחור שיעור הבא, לא להעניש את הקשר |
| Waitlist Added | `/classes` | לראות סטטוס וטיפול ברשימה |
| Waitlist Promoted | `/classes` | לראות את ההזמנה החדשה |
| Class Reminder | `/classes` | לבטל אם לא מתאים, או לראות פרטים |
| Auto‑Pay Failure | `/member` | לעדכן אמצעי תשלום (Member dashboard) |
| Membership Renewal | `/member` | לנהל מנוי |
| Pricing — Visits Low | `/pricing` | לראות חבילות לפני שנגמרים ה‑visits (New Client conversion!) |
| Pricing — Time Running Out | `/pricing` | לראות חבילות לפני expiry (New Client conversion) |
| Teacher Sub Reminder (staff) | `/contact` | ליצור קשר עם הסטודיו אם המשמרת לא מתאימה |
| No Show Notification | `/classes` | להזמין שוב בלי לעניש את הקשר (כמו Late Cancel) |

## Placeholders — אזהרה כללית

Mindbody לא חושף רשימה רשמית מלאה של placeholders זמינים בכל template. הרשימה משתנה בין template ל‑template. **לפני production**, פתח כל template ב‑Mindbody Manager → לחץ על "Available Placeholders" / "Insert Field" → תחת התצוגת editor יופיעו ה‑placeholders הספציפיים לאותו template. השווה לאלה שב‑HTML שלי. אם יש placeholder שלא קיים — הוא יוצג ריק (ולפעמים שובר טקסט). תקן בהתאם.

ה‑placeholders שאני מסתמך עליהם בכל template נמצאים ב‑comment בראש כל קובץ HTML.

## בדיקות לפני production

לכל template חדש:

- [ ] Test Send לעצמך מ‑Mindbody.
- [ ] בדיקה ב‑**Gmail Web** (Chrome) — לא ב‑Promotions tab.
- [ ] בדיקה ב‑**Gmail iOS** + **Gmail Android**.
- [ ] בדיקה ב‑**Apple Mail (macOS)** + **iOS Mail**.
- [ ] **כל ה‑placeholders מוחלפים** בפועל (אין `<...>` שנשארו כטקסט).
- [ ] **הקישור ב‑CTA עובד** ומוביל ל‑URL הנכון (אין placeholder בתוך `href`).
- [ ] **`<CLIENTFORMS>` מוצג נכון** (אם קיים) — בלי לשבור את ה‑layout.
- [ ] **Preview text** מופיע ב‑inbox לצד שורת הנושא.
