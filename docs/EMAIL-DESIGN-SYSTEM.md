# Email design system — AMARÉ

מדריך עיצוב לכל ה‑emails שיוצאים מ‑AMARÉ — Mindbody templates, Netlify Functions, מערכות עתידיות.
המטרה: מותג עקבי בכל תיבת דואר, תאימות לכל לקוחות email, וסיכוי גבוה להגיע ל‑Inbox (לא Promotions/Spam).

## מקור האמת

הצבעים והפונטים מתאימים ל‑[`src/css/tokens.css`](../src/css/tokens.css) (האתר) ול‑[`docs/DESIGN-SYSTEM.md`](./DESIGN-SYSTEM.md) (פלטפורמה).
כל email חייב להיות תואם — אין "סגנון email נפרד".

---

## פלטה (HEX קשיח, ללא משתני CSS)

לקוחות email לא מעבדים `var(--color-page)` — חייבים HEX מפורש בכל מקום.

| תפקיד | HEX | מקביל ב‑`tokens.css` | היכן להשתמש |
|---|---|---|---|
| **רקע עמוד** | `#faf3eb` | `--color-page` | רקע מחוץ לכרטיס, רקע ה‑Login box |
| **רקע משני** | `#f2ede6` | `--color-page-2` | hover states, alternate rows |
| **כרטיס/Card** | `#ffffff` | `--color-elev` | רקע התוכן הראשי |
| **דיו ראשי** | `#2b2622` | `--color-ink` | טקסט גוף |
| **דיו רך** | `#5c5650` | `--color-ink-soft` | סאב‑טקסט, חתימה |
| **דיו מטושטש** | `#7a726a` | `--color-ink-mute` | תוויות, footer, helper text |
| **אקצנט (כפתורים, כותרות)** | `#1a1816` | `--color-accent` | רקע כפתור CTA, צבע כותרת H1 |
| **קו הפרדה** | `rgba(43,38,34,0.12)` | `--color-line` | hairlines בין סקציות |
| **חול** | `#c8c2bc` | `--color-sand` | אזורי הירו (אם רלוונטי) |
| **זהב לכוכבים** | `#8b6914` | `--star-gold` | סימון מיוחד / ratings |

---

## טיפוגרפיה

### Stack מלא לכל role

```
Display (כותרות, חתימה):
  'Fraunces', 'Cormorant Garamond', Georgia, 'Times New Roman', serif

Body (פסקאות, תוויות):
  'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif

Mono (credentials, tracking codes):
  'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace
```

### טעינת web fonts (Apple Mail, iOS Mail, Samsung Mail, mobile Gmail, Yahoo Web)

ב‑`<head>` של ה‑email, **שתי שיטות במקביל** (כי לקוחות שונים מכבדים שיטה שונה):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=DM+Sans:wght@400;500&display=swap"
      rel="stylesheet" type="text/css" />

<style type="text/css">
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=DM+Sans:wght@400;500&display=swap');
</style>
```

**Outlook (כל הגרסאות) ו‑Gmail Web עוברים ל‑fallback** (Georgia / Helvetica) — וזה נראה טוב גם.

### מאזניים (sizes) ו‑letter-spacing

| Role | Size | Weight | Line-height | Letter-spacing |
|---|---|---|---|---|
| H1 (Welcome, …) | 30px / 24px במובייל | 400 | 1.2 | -0.4px |
| H2 (כותרות משנה) | 22px | 400 | 1.3 | -0.2px |
| Body | 16px | 400 | 1.6 | 0 |
| Body small / helper | 14px | 400 | 1.6 | 0 |
| Footer | 12px | 400 | 1.7 | 0.3px |
| תווית uppercase | 11px | 500 | — | 1.6–1.8px |
| Credential (mono) | 15px | 400 | — | 0 |
| כפתור CTA | 13px | 500 | — | 1.8px (uppercase) |

---

## רכיבים סטנדרטיים

### Card (מעטפת התוכן)

```html
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
       style="max-width:600px;width:100%;background-color:#ffffff;
              border:1px solid rgba(43,38,34,0.08);border-radius:8px;">
  <!-- שורות התוכן -->
</table>
```

- רוחב מקסימלי 600px (תקן email)
- בורדר רך 1px
- `border-radius:8px` עובד ברוב הלקוחות; Outlook יציג כריבוע — וזה גם בסדר

### Hairline (קו הפרדה)

```html
<tr>
  <td style="padding:0 32px;">
    <div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div>
  </td>
</tr>
```

ה‑`&nbsp;` נחוץ — Outlook קורס שורות ריקות.

### CTA Button (Bulletproof)

```html
<tr>
  <td align="center" style="padding:30px 32px 8px 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" bgcolor="#1a1816" style="background-color:#1a1816;border-radius:4px;">
          <a href="https://example.com"
             style="display:inline-block;padding:15px 38px;
                    font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;
                    font-size:13px;font-weight:500;letter-spacing:1.8px;
                    text-transform:uppercase;color:#faf3eb;text-decoration:none;
                    background-color:#1a1816;border-radius:4px;mso-padding-alt:0;">
            Action label
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

- `bgcolor` + `background-color` כפולים — תאימות ל‑Outlook
- `mso-padding-alt:0` — פותר באג padding באאוטלוק
- צבע טקסט `#faf3eb` (קרם) על רקע `#1a1816` (כהה) — ניגוד מקסימלי
- **`href` תמיד עם URL מוקשח קנוני** (`https://www.amarewellness.com/...` — עם `www`). Mindbody מחליפה placeholders כמו `<STUDIOURL>` ב‑HTML שלם (`<a href="...">amarewellness.com</a>`), מה ששובר את התגית כשהיא בתוך attribute. ראה "אזהרה — אל תשים placeholder בתוך href" בקטע Welcome New Client.

### Highlight box (login details / order summary)

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#faf3eb;border-radius:6px;">
  <tr>
    <td style="padding:22px 24px;font-family:'DM Sans',...;">
      <p style="margin:0 0 4px 0;font-size:11px;font-weight:500;letter-spacing:0.8px;
                text-transform:uppercase;color:#7a726a;">Label</p>
      <p style="margin:0;font-family:'SFMono-Regular',...;font-size:15px;color:#1a1816;
                word-break:break-all;">
        VALUE_HERE
      </p>
    </td>
  </tr>
</table>
```

- רקע `#faf3eb` (cream)
- תוויות uppercase מטושטשות, ערכים ב‑monospace
- `word-break:break-all` — שמות email ארוכים לא יישברו את הקופסה במובייל

---

## Mobile responsive (חובה!)

תוסף לאחר טעינת הפונטים ב‑`<style>`:

```html
<style type="text/css">
/* Email reset */
body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
a { text-decoration:none; }

/* Mobile */
@media only screen and (max-width:520px) {
  .am-h1 { font-size:24px !important; line-height:1.25 !important; }
  .am-pad { padding-left:22px !important; padding-right:22px !important; }
  .am-cta a { padding:14px 28px !important; font-size:13px !important; }
  .am-credential { font-size:14px !important; }
}
</style>
```

ושים את ה‑classes (`am-h1`, `am-pad`, `am-cta`, `am-credential`) על האלמנטים הרלוונטיים.

---

## אנטי‑ספאם (חיוני!)

| ✅ עושים | ❌ לא עושים |
|---|---|
| יחס טקסט/HTML גבוה (≥ 60% טקסט) | רוב התוכן בתמונות בלבד |
| מילים נורמליות, נטולות "FREE", "URGENT", "100%" | "WIN A FREE …", "CLICK NOW!!!" |
| משפט אחד או שניים של preview text מוסתר | preview ריק / ללא placeholder |
| `<a href="https://...">` עם פרוטוקול מלא | `<a href="example.com">` חצי קישור |
| 1 כפתור CTA ראשי | 5 כפתורים שונים מתחרים |
| Plain text + HTML version (Mindbody תומך) | רק HTML |
| List‑Unsubscribe header (Mindbody מטפל) | בלי אפשרות הסרה מרשימה |
| Sender domain מוודא (SPF/DKIM/DMARC) | שליחה מ‑gmail.com גנרי |

### Preview text (חובה!)

```html
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf3eb;">
  קצר וברור — מה ההזמנה הייתה / מה יש בפנים.
</div>
```

זה הטקסט שמופיע ליד שורת הנושא ב‑inbox preview של Gmail/Apple Mail. בלעדיו, Gmail יקח את התוויות הראשונות של ה‑HTML — סביר ש"<STUDIOLOGO>" או טקסט מאקרו — ייראה רע.

---

## תאימות ללקוחות email — מה לבדוק

| לקוח | חשיבות | הערות |
|---|---|---|
| Gmail Web (Chrome) | קריטי | Web fonts לא תמיד נטענים; נופל ל‑fallback |
| Gmail iOS / Android | קריטי | Web fonts עובדים; media queries עובדים |
| Apple Mail (macOS) | חשוב | מצוין — תומך בכל הפיצ'רים |
| iOS Mail | חשוב | מצוין — תומך בכל הפיצ'רים |
| Outlook 2016/2019 (Windows) | חשוב | אין web fonts, אין media queries, אין border-radius |
| Outlook.com Web | בינוני | תומך טוב |
| Yahoo Mail | בינוני | תומך בwebfonts |
| Samsung Mail | משני | תומך טוב |

**המלצה**: השתמש ב‑[Litmus](https://litmus.com) או [Email on Acid](https://www.emailonacid.com) לבדיקה אוטומטית בכל הלקוחות. אופציה חינמית: [Mail-Tester](https://www.mail-tester.com) לבדיקת Spam Score (יעד: 9+/10).

---

## טמפלייטים מתועדים

> **כל ה‑HTML המוכן להדבקה ב‑Mindbody נמצא ב‑[`docs/email-templates/`](./email-templates/)**.
> שם תמצאו קובץ נפרד לכל template (Welcome, Reservation, Cancellation, Waitlist, Reminder, Auto‑Pay Failure, Membership Renewal). [קרא את ה‑README](./email-templates/README.md) להוראות עדכון, אינדקס מלא, ו‑CTA targets לכל template.

הסעיפים בהמשך הסעיף הזה מתעדים את הפילוסופיה של ה‑Welcome template (ה‑pattern המרכזי) — שאר ה‑templates נבנים ממנו עם variations.

### 1. Welcome New Client (Mindbody)

קובץ: [`docs/email-templates/00-welcome.html`](./email-templates/00-welcome.html). מוגדר ב‑Mindbody Manager → Studio Settings → Communications → Email templates → "Welcome to <STUDIONAME>".

**Use case**: לקוח חדש שנרשם דרך הסטודיו או דרך Stripe → Mindbody anonymous flow.

**🔐 סיסמה / Mindbody login — לא ב‑Welcome (D27):**

לקוחות שנוצרים דרך **Public API** (`POST /client/addclient`) — כולל Stripe anonymous purchase — **אינם** מקבלים סיסמה זמנית. `<CLIENTPASSWORD>` יוחלף ב‑string ריק. אל תכלול אותו.

השקת AMARÉ Auth: Email OTP הוא המסלול הראשי. המייל מסביר קוד 6 ספרות, לא “Sign in with Mindbody” ולא “set your password”.

**אל תדביק את העותק הזה ל‑Mindbody Manager החי** עד ש‑`ENABLE_AMARE_AUTH_UI` דולק בפרודקשן. התבנית אתר‑רחבה: שינוי עכשיו ישבור לקוחות חיים שעדיין נכנסים עם Mindbody.

**Placeholders זמינים** (Mindbody auto‑inject):
- `<STUDIOLOGO>` — לוגו הסטודיו (תמונה)
- `<STUDIONAME>` — "Amare Wellness Studio"
- `<STUDIOURL>` — "amarewellness.com" (טקסט בלבד; ראה אזהרה למטה)
- `<STUDIOPHONE>` — "(954) 258-9238"
- `<CLIENTFIRSTNAME>` — שם פרטי
- `<CLIENTEMAIL>` — Username (ה‑email)
- ~~`<CLIENTPASSWORD>`~~ — ריק ל‑clients שנוצרו ב‑API. **אל תשתמש**.

**⚠️ אזהרה — אל תשים placeholder בתוך `href`:**
Mindbody מחליפה `<STUDIOURL>` (וכנראה גם placeholders אחרים) בתוך `<a>` element שלם, לא ב‑URL string בלבד. כתוצאה מכך:
```html
<a href="https://<STUDIOURL>/classes">  →  שובר את התגית, הקישור לא עובד
<a href="https://www.amarewellness.com/classes">  →  עובד תקין
```
**הכלל:** ב‑`href` של CTA‑ים תמיד הקשח את ה‑URL המלא והקנוני (`https://www.amarewellness.com/...` — שים לב ל‑`www` כי זה ה‑canonical שהאתר משתמש בו). placeholders של Mindbody מתאימים רק לטקסט גוף רגיל ולתוכן של תגיות (לא ל‑attributes).

**HTML מלא** (העתק‑הדבק ל‑Mindbody בHTML/Source view):

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
<title>Welcome to <STUDIONAME></title>

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet" type="text/css" />

<style type="text/css">
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=DM+Sans:wght@400;500&display=swap');

body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
a { text-decoration:none; }

@media only screen and (max-width:520px) {
  .am-h1 { font-size:24px !important; line-height:1.25 !important; }
  .am-pad { padding-left:22px !important; padding-right:22px !important; }
  .am-cta a { padding:14px 28px !important; font-size:13px !important; }
  .am-step-num { width:28px !important; height:28px !important; line-height:28px !important; font-size:13px !important; }
}
</style>
</head>

<body style="margin:0;padding:0;background-color:#faf3eb;color:#2b2622;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;">

<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf3eb;">
  Welcome to <STUDIONAME>. Sign in with a 6-digit code to book.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf3eb;">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid rgba(43,38,34,0.08);border-radius:8px;">

        <tr>
          <td align="center" class="am-pad" style="padding:36px 32px 20px 32px;">
            <STUDIOLOGO>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:0 32px;">
            <div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:36px 32px 8px 32px;">
            <h1 class="am-h1" style="margin:0 0 18px 0;font-family:'Fraunces','Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:30px;font-weight:400;line-height:1.2;color:#1a1816;letter-spacing:-0.4px;">
              Welcome, <CLIENTFIRSTNAME>.
            </h1>
            <p style="margin:0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">
              Thank you for joining <STUDIONAME>. Your purchase is already on your account. Sign in with a 6-digit code — no password needed — then book.
            </p>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:32px 32px 8px 32px;">
            <p style="margin:0 0 18px 0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">
              Getting started
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="top" width="44" style="padding:0 14px 0 0;">
                  <div class="am-step-num" align="center" style="width:32px;height:32px;line-height:32px;text-align:center;background-color:#faf3eb;border-radius:999px;font-family:'Fraunces','Cormorant Garamond',Georgia,serif;font-size:14px;color:#1a1816;">1</div>
                </td>
                <td valign="top" style="padding:4px 0 14px 0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2b2622;">
                  Click the button below to sign in.
                </td>
              </tr>
              <tr>
                <td valign="top" width="44" style="padding:0 14px 0 0;">
                  <div class="am-step-num" align="center" style="width:32px;height:32px;line-height:32px;text-align:center;background-color:#faf3eb;border-radius:999px;font-family:'Fraunces','Cormorant Garamond',Georgia,serif;font-size:14px;color:#1a1816;">2</div>
                </td>
                <td valign="top" style="padding:4px 0 14px 0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2b2622;">
                  Enter <strong style="color:#1a1816;"><CLIENTEMAIL></strong>. We will email you a 6-digit code. No password needed.
                </td>
              </tr>
              <tr>
                <td valign="top" width="44" style="padding:0 14px 0 0;">
                  <div class="am-step-num" align="center" style="width:32px;height:32px;line-height:32px;text-align:center;background-color:#faf3eb;border-radius:999px;font-family:'Fraunces','Cormorant Garamond',Georgia,serif;font-size:14px;color:#1a1816;">3</div>
                </td>
                <td valign="top" style="padding:4px 0 4px 0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2b2622;">
                  Pick the class you want and book your spot.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" class="am-pad am-cta" style="padding:28px 32px 8px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td align="center" bgcolor="#1a1816" style="background-color:#1a1816;border-radius:4px;">
                  <a href="https://www.amarewellness.com/login?return=/classes"
                     style="display:inline-block;padding:15px 38px;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#faf3eb;text-decoration:none;background-color:#1a1816;border-radius:4px;mso-padding-alt:0;">
                    Sign in &amp; book a class
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:14px 32px 32px 32px;">
            <p style="margin:0;text-align:center;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#7a726a;">
              Coming for the first time? <a href="https://www.amarewellness.com/first-visit" style="color:#5c5650;text-decoration:underline;">What to expect on your first visit</a>.<br /><br />Use the same email you used at checkout. Already use Mindbody with AMARÉ? You can still sign in that way from the login page.
            </p>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:0 32px;">
            <div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div>
          </td>
        </tr>

        <tr>
          <td class="am-pad" style="padding:24px 32px 32px 32px;">
            <p style="margin:0;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#2b2622;">Hope to see you soon,</p>
            <p style="margin:6px 0 0 0;font-family:'Fraunces','Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:17px;font-style:italic;font-weight:400;color:#5c5650;letter-spacing:0.2px;">The <STUDIONAME> Team</p>
          </td>
        </tr>

      </table>

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td align="center" style="padding:20px 16px 8px 16px;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:#7a726a;letter-spacing:0.3px;">
            <a href="https://www.amarewellness.com" style="color:#7a726a;text-decoration:none;">amarewellness.com</a>
            &nbsp;&middot;&nbsp;
            <span style="color:#7a726a;"><STUDIOPHONE></span>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>

</body>
</html>
```

---

## איך להתאים את התבנית ל‑emails אחרים

### Emails שכבר מעוצבים (זמינים ב‑[`docs/email-templates/`](./email-templates/))

| Mindbody template | קובץ |
|---|---|
| Account / Welcome to `<STUDIONAME>` | [`00-welcome.html`](./email-templates/00-welcome.html) |
| Schedule \| Reservation Confirmations (Single) | [`01-reservation-single.html`](./email-templates/01-reservation-single.html) |
| Schedule \| Reservation Confirmations (Multiple) | [`02-reservation-multiple.html`](./email-templates/02-reservation-multiple.html) |
| Schedule \| Class & Event Cancellation Notifications (Early) | [`03-cancellation.html`](./email-templates/03-cancellation.html) |
| Schedule \| Added to Waitlist | [`04-waitlist-added.html`](./email-templates/04-waitlist-added.html) |
| Schedule \| Promoted from Waitlist | [`05-waitlist-promoted.html`](./email-templates/05-waitlist-promoted.html) |
| Schedule \| Class Reminder | [`06-class-reminder.html`](./email-templates/06-class-reminder.html) |
| Sales \| Auto‑Pay Failure (Credit Card Declined) | [`07-autopay-failure.html`](./email-templates/07-autopay-failure.html) |
| Sales \| Membership Renewal Notice | [`08-membership-renewal.html`](./email-templates/08-membership-renewal.html) |
| Schedule \| Class & Event Cancellation Notifications (Late) | [`09-cancellation-late.html`](./email-templates/09-cancellation-late.html) |
| Promotions \| Series Notification - Visits Remaining Low | [`10-pricing-visits-low.html`](./email-templates/10-pricing-visits-low.html) |
| Promotions \| Series Notification - Time Running Out | [`11-pricing-time-low.html`](./email-templates/11-pricing-time-low.html) |
| Promotions \| First Visit Email (Reservation) | [`16-first-visit-reservation.html`](./email-templates/16-first-visit-reservation.html) |

### First Visit Email (Reservation) — סגנון מייל אישי (חריג)

קובץ: [`docs/email-templates/16-first-visit-reservation.html`](./email-templates/16-first-visit-reservation.html). **פעיל ב‑production** ב‑Mindbody Manager → Promotions → First Visit Email (Reservation).

**למה זה חריג מהמערכת הרגילה:** המטרה היא שירגיש כמו מייל ידני מ‑Shirley, לא כמו קמפיין או template ממותג. לכן **אין** רקע קרם, card לבן, כותרת Fraunces, כפתור CTA, לוגו, או placeholders של סטודיו בגוף המייל.

| פרמטר | ערך |
|---|---|
| Subject | `<CLIENTFIRSTNAME>, how was your first class at AMARÉ?` |
| Preview text | `We wanted to check in and hear how your first class felt.` |
| Placeholders | `<CLIENTFIRSTNAME>` בלבד (אין `<CLASSNAME>` / `<INSTRUCTOR>` בתבנית זו) |
| פונט | Arial / Helvetica, 15px, line-height 1.65 |
| רקע | `#ffffff` |
| רוחב | max 600px |
| CTA | לינק מוטמע: "book your next class **here**" → `https://www.amarewellness.com/classes` |
| חתימה | Shirley, Owner, AMARÉ Wellness Studio |
| מתי נשלח | בלילה, יום אחרי הביקור הראשון בכיתה (פעם אחת ללקוח) |

### Emails נוספים שצריך לעצב בעתיד (Mindbody Manager)

- **Sales Receipt** — קבלה אחרי רכישה (Sales | Standard Receipt)
- **Birthday Greeting** — ברכת יום הולדת (אם פעיל)
- **Password Reset** — איפוס סיסמה (Mindbody לרוב מנהל את זה במערכת אחרת — לבדוק)

### צ'ק‑ליסט להמרת template קיים לסגנון AMARÉ

1. **שמור גיבוי** של התבנית הקיימת לפני שתחליף.
2. **העתק את ה‑skeleton** מ‑"Welcome New Client" למעלה.
3. **החלף את התוכן באמצע**:
   - כותרת H1 — תאר את האירוע ("Booking confirmed", "Receipt for your purchase")
   - פסקת פתיחה — 1‑2 משפטים נטרליים
   - **Highlight box** — הפרטים הרלוונטיים (פרטי שיעור / סכום קבלה / תאריך חידוש)
   - **CTA** — פעולה אחת ראשית ("View my schedule", "Manage subscription")
   - Helper text — קצר, נטול ספאם
   - חתימה זהה
4. **שמור על ה‑placeholders של Mindbody** הרלוונטיים לכל template — הם שונים בכל אחד. רשימה ב‑[Mindbody API docs](https://developers.mindbodyonline.com/PublicDocumentation/V6).
5. **בדוק** ב‑Test Send + Mail‑Tester לפני production.

### Emails ב‑Netlify Functions (אם נוסיף בעתיד)

אם נשלח email ישירות מ‑Function (למשל דרך SendGrid/Resend/Postmark API), כל ה‑skeleton הזה תקף — פשוט החלף את ה‑Mindbody placeholders במשתני template של מי שתבחר (Handlebars, Liquid, וכו').

**ספריות מומלצות**:
- [MJML](https://mjml.io/) — DSL שמקמפל ל‑HTML email בטוח. מאוד מומלץ לבנייה מורכבת.
- [react-email](https://react-email.dev/) — JSX → HTML email. נוח אם אנחנו ב‑React.
- [maizzle](https://maizzle.com/) — Tailwind-style ל‑emails.

---

## בדיקות לפני פרודקשן (לכל email חדש)

- [ ] **Test Send** ב‑Mindbody (אם זה Mindbody template) או ב‑staging Function.
- [ ] **בדיקה ב‑Gmail Web** (Chrome) — Inbox, לא Promotions.
- [ ] **בדיקה ב‑Gmail iOS** + **Gmail Android**.
- [ ] **בדיקה ב‑Apple Mail (macOS)** + **iOS Mail**.
- [ ] **בדיקה ב‑Outlook** (אם יש לך גישה — או דרך Litmus).
- [ ] **Mail‑Tester score ≥ 9/10**.
- [ ] **כפתור CTA לחיץ** ומוביל ליעד הנכון.
- [ ] **כל ה‑placeholders מוחלפים** בפועל (אין `<CLIENTPASSWORD>` שנשאר כטקסט).
- [ ] **תצוגה במצב dark mode** של Apple Mail (הצבעים שלנו עובדים יפה גם בכהה — לבן ייהפך כהה אוטומטית).

---

## שדרוגים עתידיים (לא קריטי עכשיו)

- **Plain‑text version** — חשוב להסרה מ‑Promotions ב‑Gmail. Mindbody Manager מאפשר להגדיר "Plain text alternative" לצד ה‑HTML.
- **List‑Unsubscribe header** — Mindbody מוסיף בעצמו, אבל אם נשלח דרך Function נצטרך להוסיף ידנית.
- **A/B testing של נושאים** — לבדוק איזה subject line נותן open rate גבוה יותר.
- **Dark mode optimization** — להוסיף `<meta name="color-scheme" content="light">` כדי לאלץ Light mode (אם העיצוב הכהה לא מתאים).
