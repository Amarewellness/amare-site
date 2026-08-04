# AMARÉ Wellness — static site (Netlify-ready)

This folder implements the site plan (see [docs/CONTENT-SOURCE.md](docs/CONTENT-SOURCE.md), [URL-MAP.md](docs/URL-MAP.md), [DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)).

## Commands

```bash
npm run build
```

Output: `dist/`. Set environment variable `SITE_URL` to your production origin (e.g. `https://www.amarewellness.com`) before build so `sitemap.xml`, `robots.txt`, and `canonical` links are correct. Optional build-time analytics env vars (all injected by `scripts/build.mjs`): `GA_MEASUREMENT_ID` (`G-…`) — [docs/SEO.md](docs/SEO.md); `META_PIXEL_ID` (numeric Facebook Pixel); `OPENAI_PIXEL_ID` + `OPENAI_PIXEL_DEBUG` (OpenAI Ads Measurement Pixel — see **OpenAI Ads** in [docs/SEO.md](docs/SEO.md)).

## Stack

- Plain HTML built by `scripts/build.mjs` from `src/content/*.html` fragments
- CSS: `src/css/tokens.css`, `site.css`, `components-mindbody.css`
- Netlify: `netlify.toml`, `public/_redirects` (copied to `dist`)
- Contact form: Netlify Forms (`name="contact"` in `src/content/contact.html`)
- Mindbody: schedules widget in `src/content/classes.html` (`data-widget-id` is editable)

## Deploy

Connect the repo to Netlify or use Netlify Drop with `dist` after a local build. See [docs/LAUNCH.md](docs/LAUNCH.md).
