# AMARÉ email — mobile playbook (Gmail Android)

מדריך ליישום מובייל על תבניות Mindbody נוספות, לפי מה שעבד ב־**Reservation Confirmation (Single)**.

תבנית ייחוס חיה: [`01-reservation-single.html`](./01-reservation-single.html).

בסיס ויזואלי לרוחב הכרטיס: [`10-pricing-visits-low.html`](./10-pricing-visits-low.html) (Low Visit).

זה **כיול מובייל**, לא רידיזיין. דסקטופ נשאר premium AMARÉ.

---

## מה למדנו מ־Reservation

| בעיה ב־Gmail Android | סיבה | פתרון |
|---|---|---|
| פרטי שיעור דחוסים, שם ארוך נשבר רע | טבלת 2 עמודות עם `width="120"` לתווית | **Stack**: תווית מעל ערך |
| טיפוגרפיה גדולה יותר מ־Low Visit | `viewport` / מייל קצר גורמים ל־Gmail לצייר `30px` כפיקסלים אמיתיים, בזמן ש־Low Visit בלי `viewport` מצטמצם כפריסת 600px | **לא** להקטין פונטים בדסקטופ. שולטים במובייל עם `@media` + classes |
| כרטיס לבן צר | padding חיצוני 16px + פנימי 32px + עוד 24px בקופסה | במובייל: גטר חיצוני **8px**, תוכן **20px**, קופסה פנימית **18px** |
| `-webkit-text-size-adjust: 100%` | לא שינה את הסקייל הוויזואלי ב־Gmail Android | מותר להשאיר; **לא** לסמוך עליו |

`text-size-adjust` לבדו לא פותר את הפער מול Low Visit. הסקייל הסופי מגיע מ־**font-size + padding ב־media query**.

---

## כללי ברזל

1. Tables בלבד. בלי flex, grid, או JavaScript.
2. דסקטופ לא משתנה: H1 `30px`, גוף `16px`, ערכים `15–16px`, תוויות `11px`, padding כרטיס `32px`.
3. מובייל רק דרך classes + `@media only screen and (max-width: 480px)` עם `!important`.
4. לא לכווץ את כל התבנית גלובלית.
5. לא להחזיר טבלת label/value עם עמודה קבועה (`100` / `120`).
6. Placeholders של Mindbody נשארים בדיוק כמו שהם (`<CLASSNAME>`, לא `{{className}}`).
7. בלי הערות HTML שמכילות `<PLACEHOLDER>` — Mindbody מפרסר אותן ושובר שליחה.
8. הדבקה ל־Mindbody: Source / `<>` בלבד, מ־`<!DOCTYPE` עד `</html>`, ואז Save במצב HTML.

---

## מעטפת (desktop + mobile)

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style type="text/css">
/* paste the mobile block from below */
</style>
</head>
<body>
  <table width="100%" style="background-color:#faf3eb;" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td class="outer-pad" style="padding:32px 16px;" align="center">
        <!-- optional CLIENTFORMS sibling table -->
        <table width="600" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid rgba(43,38,34,0.08);border-radius:8px;" border="0" cellspacing="0" cellpadding="0">
          <!-- card -->
        </table>
        <!-- footer sibling: same width="600" + max-width:600px; width:100% -->
      </td>
    </tr>
  </table>
</body>
</html>
```

- כרטיס: `width="600"` ל־Outlook + `style="width:100%;max-width:600px;"`.
- בלי `width` קבוע שכופה גלילה אופקית מעבר ל־viewport.
- `viewport` חובה אם רוצים ש־Gmail Android יכבד את ה־media query בפיקסלים אמיתיים.

### `<CLIENTFORMS>`

לא מוחקים ולא מעצבים את ה־placeholder.

ההורה:

- טבלה אחות **מעל** הכרטיס הלבן
- `width="100%"` + `max-width:600px`
- `width="600"` ל־Outlook מותר
- בלי padding אופקי מיותר שיכול להרחיב את המייל

---

## סקייל טיפוגרפיה

| Role | Desktop (inline) | Mobile (`max-width: 480px`) | Class |
|---|---|---|---|
| H1 | 30px | **20px** / line-height 1.2 | `mobile-h1` |
| גוף ראשי | 16px | **12px** / 1.45 | `mobile-body` |
| ערכי פרטים / שם שיעור | 15–16px | **12px** / 1.4 | `mobile-detail` |
| תווית uppercase | 11px | **8px** | `mobile-label` |
| חתימה serif | 17px | **13px** | `mobile-sig` |
| Fallback + footer | 12–13px | **10px** | `mobile-footer` |
| כפתור CTA | 13px / padding 15×38 | **11px** / padding 12×24 | `mobile-cta` |

הגדלים האלה כוילו מול Low Visit ב־Gmail Android אחרי כמה סבבים. לא לרדת מתחת לזה בלי בדיקה — 8px לתוויות כבר גבולי.

---

## Padding

| אזור | Desktop | Mobile | Class |
|---|---|---|---|
| גטר קרם חיצוני | 32px 16px | אופקי **8px** (קרם נשאר כמסגרת דקה) | `outer-pad` |
| תוכן כרטיס, CTA, פוטר פנימי | 32px | אופקי **20px** | `mobile-pad` |
| קופסת פרטים פנימית (`#faf3eb`) | 22px 24px | אופקי **18px** | `mobile-card-inner` |

לא לשכפל 32px + 24px + 16px אחד בתוך השני במובייל. זה מה שצר את עמודת התוכן.

---

## בלוק CSS להעתקה

לשים ב־`<head>`. Mindbody עלול למחוק את ה־`<head>` אם שומרים מ־WYSIWYG — תמיד Source.

```css
html, body, table, td, p, a {
  -webkit-text-size-adjust: 100%;
  -ms-text-size-adjust: 100%;
}

@media only screen and (max-width: 480px) {
  .outer-pad {
    padding-left: 8px !important;
    padding-right: 8px !important;
  }
  .mobile-pad {
    padding-left: 20px !important;
    padding-right: 20px !important;
  }
  .mobile-card-inner {
    padding-left: 18px !important;
    padding-right: 18px !important;
  }
  .mobile-h1 {
    font-size: 20px !important;
    line-height: 1.2 !important;
  }
  .mobile-body {
    font-size: 12px !important;
    line-height: 1.45 !important;
  }
  .mobile-detail {
    font-size: 12px !important;
    line-height: 1.4 !important;
  }
  .mobile-label {
    font-size: 8px !important;
  }
  .mobile-sig {
    font-size: 13px !important;
  }
  .mobile-footer {
    font-size: 10px !important;
    line-height: 1.45 !important;
  }
  .mobile-cta {
    font-size: 11px !important;
    padding: 12px 24px !important;
  }
}
```

ה־inline styles נשארים בערכי הדסקטופ. ה־class רק דורס במובייל.

---

## פרטי שיעור / חבילה — תמיד stacked

**לא:**

```text
CLASS        Perreo Sculpt (Not heated but spicy)
INSTRUCTOR   Paola K
```

**כן:**

```text
CLASS
Perreo Sculpt (Not heated but spicy)

INSTRUCTOR
Paola K

WHEN
Friday, 8/28/2026
11:00 AM

STUDIO
Amare Wellness Studio
```

כל תווית: `mobile-label` + הסגנון uppercase הקיים.  
כל ערך: `mobile-detail` מתחת לתווית, באותה `<td>` מלאה.

אותו כלל לכל קופסת `#faf3eb` עם שדות (intro package, membership, reminder details).

---

## איך להעביר תבנית אחרת

1. להשאיר copy, links, placeholders, ועיצוב דסקטופ.
2. להוסיף `viewport` + בלוק ה־CSS למעלה.
3. `outer-pad` על ה־`<td>` החיצוני (`padding: 32px 16px`).
4. `mobile-pad` על כל שורות התוכן בכרטיס הלבן.
5. `mobile-h1` / `mobile-body` / `mobile-label` / `mobile-detail` / `mobile-sig` / `mobile-footer` / `mobile-cta` לפי התפקיד.
6. להחליף כל טבלת 2 עמודות (`width="100"` / `120`) ב־stack.
7. אם יש `<CLIENTFORMS>` — מעטפת אחות מעל הכרטיס, לא בתוכו.
8. Test Send → Gmail Android לצד Low Visit או Reservation שעובד.

לא לגעת ב־SendEmail, booking API, Auth, או טריגרים של Mindbody. HTML בלבד.

---

## QA מובייל

לבדוק ב־**320 / 375 / 390 / 430**. בדסקטופ ~600px חייב להישאר כמו היום.

- [ ] אין גלילה אופקית
- [ ] הכרטיס הלבן ממלא כמעט את הרוחב, עם מסגרת קרם דקה
- [ ] לוגו לא נחתך
- [ ] H1 נכנס בלי להרגיש "מוגדל" מול Reservation / Low Visit
- [ ] שם שיעור / ערך ארוך נשבר על רוחב מלא
- [ ] תוויות + ערכים קריאים ב־stack
- [ ] CTA נכנס
- [ ] URL הגיבוי לא שובר את הכרטיס
- [ ] פוטר נכנס
- [ ] `<CLIENTFORMS>` לא כופה 600px קשיח
- [ ] אחרי Save ב־Mindbody, ה־`<style>` עדיין ב־Source (לא נמחק)

---

## מה לא לעשות

- לא לפתור מובייל בהקטנת כל ה־`font-size` inline.
- לא להמיר את המייל לתבנית פשוטה / plain.
- לא לסמוך רק על media query — ה־HTML חייב להיות קריא גם אם Gmail/Mindbody זורקים את ה־`<style>` (stack + `width:100%` + `max-width:600px`).
- לא להדביק בלוק HTML עם `<!-- ... <CLASSNAME> ... -->` מעל ה־DOCTYPE.

---

## קבצים

| קובץ | תפקיד |
|---|---|
| [`00-welcome.html`](./00-welcome.html) | Welcome — כיול מובייל; שלבי 1–2–3 נשארים עם עיגול 32px |
| [`01-reservation-single.html`](./01-reservation-single.html) | ייחוס מובייל מכויל — להעתיק ממנו מעטפת, classes, ו־stack |
| [`03-cancellation.html`](./03-cancellation.html) | Early cancellation — אותו כיול מובייל כמו Reservation |
| [`09-cancellation-late.html`](./09-cancellation-late.html) | Late cancellation — אותו כיול + שורת Status ב־stack |
| [`10-pricing-visits-low.html`](./10-pricing-visits-low.html) | ייחוס רוחב כרטיס / צפיפות דסקטופ (עדיין בלי כיול המובייל הזה) |
| [`README.md`](./README.md) | אינדקס תבניות + הדבקה ל־Mindbody |
| [`../EMAIL-DESIGN-SYSTEM.md`](../EMAIL-DESIGN-SYSTEM.md) | פלטה, רכיבים, אנטי־ספאם |
