# AMARÉ Wellness — static site (Netlify-ready)

This folder implements the site plan (see [docs/CONTENT-SOURCE.md](docs/CONTENT-SOURCE.md), [URL-MAP.md](docs/URL-MAP.md), [DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)).

## Commands

```bash
npm run build
```

Output: `dist/`. Set environment variable `SITE_URL` to your production origin (e.g. `https://www.amarewellness.com`) before build so `sitemap.xml`, `robots.txt`, and `canonical` links are correct. Optional: `GA_MEASUREMENT_ID` (`G-…`) enables GA4 via the build script — full setup, Netlify vs Drop, and verification: [docs/SEO.md](docs/SEO.md) (section **Google Analytics (GA4)**). Optional: `META_PIXEL_ID` (numeric Facebook Pixel ID) injects Meta Pixel on every page via the same build script.

## Stack

- Plain HTML built by `scripts/build.mjs` from `src/content/*.html` fragments
- CSS: `src/css/tokens.css`, `site.css`, `components-mindbody.css`
- Netlify: `netlify.toml`, `public/_redirects` (copied to `dist`)
- Contact form: Netlify Forms (`name="contact"` in `src/content/contact.html`)
- Mindbody: schedules widget in `src/content/classes.html` (`data-widget-id` is editable)

## Deploy

Connect the repo to Netlify or use Netlify Drop with `dist` after a local build. See [docs/LAUNCH.md](docs/LAUNCH.md).
