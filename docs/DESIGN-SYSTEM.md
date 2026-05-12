# Design system (code — מקביל ל־Figma)

המקור הוויזואלי מגיע מאותו קו של ה־embeds (DM Sans + Fraunces, רקע חם, נגיעות `sand`).  
במאגר ה־**CSS** הוא מקור האמת לפיתוח.

## קבצים

| קובץ | תפקיד |
|------|--------|
| [`../src/css/tokens.css`](../src/css/tokens.css) | משתנים: צבע, טיפוגרפיה fluid, מרווח, צל, רדיוס |
| [`../src/css/site.css`](../src/css/site.css) | layout גלובלי, header/footer, hero, cards, reviews, prose, FAQ, טפסים |
| [`../src/css/components-mindbody.css`](../src/css/components-mindbody.css) | מעטפת ל־Mindbody (`.mb-wrap`, `.mb-frame`, פס מיתוג עליון) |

## רכיבים

- **Header**: sticky, `backdrop-filter`, nav עם `.nav__link` ו־`is-active` (נבנה ב־`build.mjs` לפי עמוד).
- **Primary CTA**: `.btn` (מלא); `.btn--ghost` (מסגרת).
- **כרטיסים**: `.card` בתוך `.grid-3` (2–3 עמודות, עמודה אחת במובייל).
- **גלילה**: `[data-reveal]` + `main.js` + `IntersectionObserver` (מכובה ב־`prefers-reduced-motion`).
- **Mindbody**: `.mb-wrap` + `.mb-frame` + `.mindbody-widget` (ה־`data-widget-id` ב־[`classes` content](../src/content/classes.html)).

## פיגמה

כשמייצרים Figma, יבואו **את אותם טוקנים** (HEX, גדלים) ו־**אותה היררכיית רכיבים** כפי שמופיעה כאן.

## Email design system

עיצוב emails (Mindbody templates ו־transactional emails עתידיים) משתמש באותם טוקנים — צבעים, פונטים, היררכיה — אבל ב‑HEX קשיח ו‑inline CSS (לקוחות email לא מעבדים `var(--…)`).
מדריך מלא כולל skeleton, רכיבים, ו־HTML מוכן ל‑Mindbody:

[`./EMAIL-DESIGN-SYSTEM.md`](./EMAIL-DESIGN-SYSTEM.md)
