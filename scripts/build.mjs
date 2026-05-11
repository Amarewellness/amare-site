import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const src = path.join(root, "src");
const pub = path.join(root, "public");

function readDotEnvValue(rootDir, key) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return "";
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (k !== key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val;
  }
  return "";
}

/** Where the browser resolves `/api/mindbody/…` when `SCHEDULE_PROXY_BASE` is set. Empty ⇒ same-origin relative URLs in the HTML/JS. */
const MB_SCHEDULE_ORIGIN = (
  process.env.SCHEDULE_PROXY_BASE ||
  readDotEnvValue(root, "SCHEDULE_PROXY_BASE") ||
  ""
).trim();

const MB_BOOK_FALLBACK_REL = (
  process.env.MINDBODY_BOOK_FALLBACK_REL ||
  readDotEnvValue(root, "MINDBODY_BOOK_FALLBACK_REL") ||
  "classes.html"
).trim();

/**
 * Params for Mindbody Classic storefront links (`/classic/ws?studioid&stype&prodid`) — aligned with `pricing-api.js` `buyHref`.
 */
function readMindbodyClassicLinkConfig() {
  const classicStudioId = (
    process.env.MINDBODY_CLASSIC_STUDIO_ID ||
    readDotEnvValue(root, "MINDBODY_CLASSIC_STUDIO_ID") ||
    "5744068"
  ).trim();
  const rawIds = (
    process.env.MINDBODY_CONTRACT_PRODUCT_IDS ?? readDotEnvValue(root, "MINDBODY_CONTRACT_PRODUCT_IDS") ?? ""
  ).trim();
  /** Mindbody Classic recurring links use stype=40 + prodId (pricing.html prodid 100, 101, 102). */
  const monthlyProductIds =
    rawIds === ""
      ? ["100", "101", "102"]
      : rawIds === "none"
        ? []
        : rawIds.split(/[\s,]+/).filter(Boolean);
  return {
    classicStudioId,
    monthlyProductIds,
    packageSaleType: "43",
    contractSaleType: "40",
  };
}

/**
 * Embed for `/sale/contracts` (location + static monthly fallback) — aligned with `mbPricingApiConfigJson`.
 */
function readMindbodyContractsEmbedConfig() {
  const saleLocationId = (
    process.env.MINDBODY_SALE_LOCATION_ID ||
    readDotEnvValue(root, "MINDBODY_SALE_LOCATION_ID") ||
    "1"
  ).trim();

  const disableMonthlyFallbackRaw = (
    process.env.MINDBODY_DISABLE_MONTHLY_CONTRACT_FALLBACK ?? readDotEnvValue(root, "MINDBODY_DISABLE_MONTHLY_CONTRACT_FALLBACK") ?? ""
  )
    .trim()
    .toLowerCase();
  const disableMonthlyFallback =
    disableMonthlyFallbackRaw === "1" || disableMonthlyFallbackRaw === "true" || disableMonthlyFallbackRaw === "yes";

  /**
   * Shown only when `/sale/contracts` fails (404 static host / old deploy / wrong tunnel port) or returns no rows.
   * `checkoutServiceId` = Mindbody ContractItems[].Id (pricing option); `contractProductId` = Classic ws prodid (`stype=40`).
   * Update if studio reconfigures recurring packages.
   */
  const monthlyContractFallback = disableMonthlyFallback
    ? []
    : [
        { name: "Recurring 5", contractProductId: 101, checkoutServiceId: 100129, price: 125 },
        { name: "Recurring 8", contractProductId: 102, checkoutServiceId: 100130, price: 179 },
        { name: "Unlimited", contractProductId: 100, checkoutServiceId: 100056, price: 229 },
      ];

  return { saleLocationId, monthlyContractFallback };
}

function mbScheduleConfigJson() {
  const siteId = (
    process.env.MINDBODY_SITE_ID ||
    readDotEnvValue(root, "MINDBODY_SITE_ID") ||
    "-99"
  ).trim();
  const bookUrlTemplate = (
    process.env.MINDBODY_BOOK_URL_TEMPLATE ||
    readDotEnvValue(root, "MINDBODY_BOOK_URL_TEMPLATE") ||
    ""
  ).trim();
  const bookingWidgetHref = MB_BOOK_FALLBACK_REL || "classes.html";
  const signupUrl = (
    process.env.MINDBODY_CONSUMER_SIGNUP_URL ||
    readDotEnvValue(root, "MINDBODY_CONSUMER_SIGNUP_URL") ||
    ""
  ).trim();
  const classic = readMindbodyClassicLinkConfig();
  const contractsEmbed = readMindbodyContractsEmbedConfig();
  return JSON.stringify({
    siteId,
    bookUrlTemplate,
    bookingWidgetHref,
    signupUrl,
    classicStudioId: classic.classicStudioId,
    packageSaleType: classic.packageSaleType,
    contractSaleType: classic.contractSaleType,
    monthlyProductIds: classic.monthlyProductIds,
    saleLocationId: contractsEmbed.saleLocationId,
    monthlyContractFallback: contractsEmbed.monthlyContractFallback,
  }).replace(/</g, "\\u003c");
}

function mbPricingApiConfigJson() {
  const classic = readMindbodyClassicLinkConfig();
  const classicStudioId = classic.classicStudioId;
  const monthlyProductIds = classic.monthlyProductIds;
  const contractsEmbed = readMindbodyContractsEmbedConfig();
  const saleLocationId = contractsEmbed.saleLocationId;
  const monthlyContractFallback = contractsEmbed.monthlyContractFallback;

  return JSON.stringify({
    classicStudioId,
    packageSaleType: classic.packageSaleType,
    contractSaleType: classic.contractSaleType,
    staticPricingHref: "pricing.html",
    monthlyProductIds,
    saleLocationId,
    monthlyContractFallback,
  }).replace(/</g, "\\u003c");
}

/** Manual recurring / membership terms when Mindbody `GET /sale/contracts` omits textual terms (see docs/MINDBODY.md). */
function mbContractTermsConfigJson() {
  const fp = path.join(src, "content", "mb-contract-terms.config.json");
  if (!fs.existsSync(fp)) return "{}";
  try {
    const raw = fs.readFileSync(fp, "utf8");
    JSON.parse(raw);
    return raw.trim().replace(/</g, "\\u003c");
  } catch (e) {
    console.warn("[build] mb-contract-terms.config.json:", e?.message ?? e);
    return "{}";
  }
}

const SITE_URL = (process.env.SITE_URL || "https://www.amarewellness.com").replace(/\/$/, "");

/** GA4 Measurement ID (`G-XXXXXXXXXX`). Set `GA_MEASUREMENT_ID` in Netlify (Site → Environment variables) so builds inject the tag. */
const GA_MEASUREMENT_ID = (process.env.GA_MEASUREMENT_ID || "").trim();

/**
 * Product checkout UX — “Add to cart” buttons + Wix-oriented catalog note are gated until non-Wix URLs are wired.
 * Flip to `true` after replacing each entry’s `wixUrl` in `PRODUCTS` (see `scripts/build.mjs`).
 * Details: `docs/products-checkout.md`.
 */
const SHOW_PRODUCT_PURCHASE_BUTTONS = false;

/** Used in LocalBusiness JSON-LD (matches accessibility.html). */
const SITE_PHONE_E164 = "+19542589238";

/** Approximate coordinates for 501 N Dixie Hwy area, Hallandale Beach FL — refine via Maps if needed. */
const SITE_GEO = { latitude: 25.9872, longitude: -80.1486 };

/** Default Open Graph / Twitter image when page has no dedicated hero (products use main.webp). */
const DEFAULT_OG_IMAGE = "/images/products/cover/sockscover.webp";

/** Homepage OG/Twitter preview — studio/class imagery (aligned with hero on home.html). */
const HOME_OG_IMAGE = "/images/home-member/wellnessstudioworkout.webp";

const OG_SITE_NAME = "AMARÉ Wellness Studio";
const OG_LOCALE = "en_US";

/**
 * Optional TikTok profile URL (Netlify env `SITE_TIKTOK_URL`).
 * TikTok link previews use Open Graph (`og:*`), not `twitter:*` tags; adding the URL helps JSON-LD `sameAs`.
 */
const SITE_TIKTOK_URL = (process.env.SITE_TIKTOK_URL || "").trim().replace(/\/$/, "");

/**
 * Brand marks under `public/logo/` → `/logo/*`. Favicons under `public/favicon/` → `/favicon/*`.
 */
const BRAND = {
  /** Horizontal logo only (nav + hero wordmark slot). */
  wordmark: "/logo/logo-amare-black2.png",
  /** Icon mark (hero only). */
  mark: "/logo/logo-mark.png",
  /** Logo + “Wellness Studio” tagline — header bar + footer + JSON-LD logo. */
  logoStacked: "/logo/logo-amare-wellness-studio.png",
  faviconIco: "/favicon/favicon.ico",
  favicon32: "/favicon/favicon-32x32.png",
  favicon16: "/favicon/favicon-16x16.png",
  appleTouch: "/favicon/apple-touch-icon.png",
};

/** Relative links between built pages (some legacy images still use Wix CDN in content HTML). */
const H = {
  home: "index.html",
  events: "privateevents.html",
  pricing: "pricing.html",
  pricingApi: "pricing-api.html",
  classes: "classes.html",
  classesApi: "classes-api.html",
  login: "login.html",
  member: "member.html",
  products: "products.html",
  about: "about.html",
  treatmentRoom: "treatment-room.html",
  firstVisit: "first-visit.html",
  faq: "faq.html",
  contact: "contact.html",
  privacy: "privacy.html",
  terms: "terms.html",
  accessibility: "accessibility.html",
  shipping: "shipping.html",
  returns: "returns.html",
  instagram: "https://www.instagram.com/amare__wellness/",
};
const PAGES = [
  {
    file: "index.html",
    path: "/",
    content: "home.html",
    title: "Reformer & Mat Pilates in Hallandale | AMARÉ Wellness Studio",
    description:
      "A modern wellness space in Hallandale designed to strengthen, sculpt, and restore. Reformer Pilates, Mat, Kangoo Jumps, and more. Book classes and become your best self.",
    nav: "home",
  },
  {
    file: "privateevents.html",
    path: "/privateevents",
    content: "privateevents.html",
    title: "Private events & room rental | AMARÉ Wellness Studio",
    description:
      "Bridal showers, bachelorettes, workshops, and treatment room rental in our Hallandale wellness studio.",
    nav: "privateevents",
  },
  {
    file: "pricing.html",
    path: "/pricing",
    content: "pricing.html",
    title: "Pricing and membership | AMARÉ Wellness Studio",
    description:
      "Choose the right plan. Pilates made affordable and accessible. Purchase packages via Mindbody.",
    nav: "pricing",
  },
  {
    file: "classes.html",
    path: "/classes",
    content: "classes.html",
    title: "Book a class | AMARÉ Wellness Studio",
    description: "View the schedule and book Reformer, Mat, Kangoo, and more in Hallandale, FL.",
    nav: "classes",
  },
  {
    file: "classes-api.html",
    path: "/classes-api",
    content: "classes-api.html",
    title: "Class schedule (Mindbody API) | AMARÉ Wellness Studio",
    description:
      "Browse live class times powered by Mindbody. Book anytime through our standard scheduling page when you are ready.",
    nav: "classes",
  },
  {
    file: "pricing-api.html",
    path: "/pricing-api",
    content: "pricing-api.html",
    title: "Pricing (Mindbody API checkout preview) | AMARÉ Wellness Studio",
    description:
      "Pricing layout synced with the live page; Sell Online catalog from Mindbody. Signed-in members can test CheckoutShoppingCart (stored card) on-domain.",
    nav: false,
    noindex: true,
    excludeFromSitemap: true,
  },
  {
    file: "login.html",
    path: "/login",
    content: "mindbody-login.html",
    title: "Client sign-in | AMARÉ Wellness Studio",
    description:
      "Sign in with your Mindbody account (member login). Internal testing page before linking from the main site.",
    nav: false,
    noindex: true,
    excludeFromSitemap: true,
  },
  {
    file: "member.html",
    path: "/member",
    content: "mindbody-member.html",
    title: "Member area | AMARÉ Wellness Studio",
    description:
      "Mindbody sign-in: your profile, packages, and remaining visits. Shared by direct link only (not in main navigation).",
    nav: false,
    noindex: true,
    excludeFromSitemap: true,
  },
  {
    file: "products.html",
    path: "/products",
    content: "products.html",
    title: "All products | AMARÉ Wellness Studio",
    description:
      "Shop AMARÉ grip socks and studio essentials. Browse styles, then check out on the AMARÉ store—pickup and shipping available.",
    nav: "products",
  },
  {
    file: "first-visit.html",
    path: "/first-visit",
    content: "first-visit.html",
    title: "First visit | AMARÉ Wellness Studio",
    description: "What to bring, parking, and studio etiquette for your first class at AMARÉ.",
    nav: "first-visit",
  },
  {
    file: "faq.html",
    path: "/faq",
    content: "faq.html",
    title: "FAQ | AMARÉ Wellness Studio",
    description: "Answers about classes, booking, ClassPass, Kangoo, and policies.",
    nav: "faq",
  },
  {
    file: "contact.html",
    path: "/contact",
    content: "contact.html",
    title: "Contact | AMARÉ Wellness Studio",
    description: "Address, map, and contact form. AMARÉ Wellness in Hallandale, Florida.",
    nav: "contact",
  },
  {
    file: "about.html",
    path: "/about",
    content: "about.html",
    title: "About us | AMARÉ Wellness Studio",
    description:
      "About AMARÉ Wellness Studio in Hallandale — our space, Reformer & Mat Pilates community, atmosphere, and team.",
    nav: "about",
  },
  {
    file: "treatment-room.html",
    path: "/treatment-room",
    content: "treatment-room.html",
    title: "Treatment room rental | AMARÉ Wellness Studio",
    description:
      "Rent AMARÉ’s treatment room on a fixed weekday with a monthly minimum. Facials, massage, lash lifts, and beauty services in Hallandale.",
    nav: "treatment-room",
  },
  {
    file: "privacy.html",
    path: "/privacy",
    content: "privacy.html",
    title: "Privacy policy | AMARÉ Wellness Studio",
    description: "How AMARÉ Wellness Studio collects, uses, and protects your personal information.",
    nav: "legal",
  },
  {
    file: "terms.html",
    path: "/terms",
    content: "terms.html",
    title: "Terms and conditions | AMARÉ Wellness Studio",
    description: "Terms and conditions for using AMARÉ Wellness Studio’s website and services.",
    nav: "legal",
  },
  {
    file: "accessibility.html",
    path: "/accessibility",
    content: "accessibility.html",
    title: "Accessibility statement | AMARÉ Wellness Studio",
    description: "Accessibility statement for AMARÉ Wellness Studio’s website and studio.",
    nav: "legal",
  },
  {
    file: "shipping.html",
    path: "/shipping",
    content: "shipping.html",
    title: "Shipping policy | AMARÉ Wellness Studio",
    description: "Shipping policy for AMARÉ retail orders within the United States.",
    nav: "legal",
  },
  {
    file: "returns.html",
    path: "/returns",
    content: "returns.html",
    title: "Return & refund policy | AMARÉ Wellness Studio",
    description: "Return and refund policy for AMARÉ retail products; class packages and memberships are separate.",
    nav: "legal",
  },
];

/** Absolute URL for meta/schema (SITE_URL + root-relative path). */
function absoluteSiteUrl(rootRelativePath) {
  const p = rootRelativePath.startsWith("/") ? rootRelativePath : `/${rootRelativePath}`;
  return `${SITE_URL}${p}`;
}

/** Escape single quotes for safe embedding inside inline script strings. */
function escapeJsSingleQuoted(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** GA4 gtag snippet — only emitted when ID matches `G-xxxxxxxxxx`. */
function ga4HeadSnippet(measurementId) {
  const id = measurementId.trim();
  if (!/^G-[A-Z0-9]+$/i.test(id)) return "";
  const idAttr = escapeHtmlAttr(id);
  const idJs = escapeJsSingleQuoted(id);
  return `
  <link rel="preconnect" href="https://www.googletagmanager.com" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=${idAttr}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag("js", new Date());
    gtag("config", "${idJs}");
  </script>
`;
}

/** Escape attribute values for meta / OG tags. */
function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Folder names under `public/images/products/` — each folder needs `main.webp` plus `2.webp` … `5.webp` for the gallery.
 */
const PRODUCT_MEDIA_DIR = {
  "grip-socks-cutie-with-a-booty": "AMARÉ Grip Socks - Cutie With A Booty",
  "grip-socks-pilates-princess": "princes",
  "grip-socks-black-white": "bow",
  "grip-socks-hearts": "hearts",
  "grip-socks-grip-me-baby": "grip me baby",
  "grip-socks-matcha": "matcha",
};

function productMediaBase(slug) {
  const dir = PRODUCT_MEDIA_DIR[slug];
  if (!dir) throw new Error(`Missing PRODUCT_MEDIA_DIR for slug: ${slug}`);
  return `/images/products/${encodeURIComponent(dir)}`;
}

function productLocalImage(slug) {
  return `${productMediaBase(slug)}/main.webp`;
}

const PRODUCT_COPY = {
  long:
    "Meet your new studio essential. AMARÉ Grip Socks are designed for secure traction and comfort, so you feel stable through every reformer and mat session. Soft, breathable, and made to stay in place—because confidence starts from the ground up. And yes… they’re seriously cute. A clean, flattering look that makes you feel put-together the second you step into the studio.",
  care:
    "Machine wash cold. Wash inside out. Air dry recommended. Do not bleach or iron.",
  returns:
    "Returns accepted within 30 days for unused items in original packaging. Socks and towels are final sale for hygiene reasons.",
  notes: "Colors may look slightly different in person due to lighting and screen settings.",
};

const PRODUCTS = [
  {
    slug: "grip-socks-cutie-with-a-booty",
    name: "AMARÉ Grip Socks - Cutie With A Booty",
    metaDescription:
      "Cutie With A Booty grip socks by AMARÉ — playful reformer-ready traction for Pilates and mat in Hallandale FL. Sale pricing; pickup at the studio or ship via our store checkout.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-cutie-with-a-booty",
    price: 19.99,
    compareAt: 24.99,
  },
  {
    slug: "grip-socks-pilates-princess",
    name: "AMARÉ Grip Socks - Pilates Princess",
    metaDescription:
      "Pilates Princess grip socks by AMARÉ — cute reformer traction for Hallandale classes. Soft grip and breathable fabric; compare-at pricing with pickup or shipping.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-pilates-princess",
    price: 19.99,
    compareAt: 24.99,
  },
  {
    slug: "grip-socks-black-white",
    name: "AMARÉ Grip Socks - Black &amp; White",
    metaDescription:
      "Black & White AMARÉ grip socks with bow detail — classic grippy soles for reformer Pilates in Hallandale. Browse pricing and checkout on the AMARÉ store.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-black-white",
    price: 19.99,
    compareAt: 24.99,
  },
  {
    slug: "grip-socks-hearts",
    name: "AMARÉ Grip Socks - Hearts",
    metaDescription:
      "Hearts-pattern AMARÉ grip socks — reliable traction for reformer and studio workouts at AMARÉ Wellness in Hallandale FL. Available via store checkout.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-hearts",
    price: 19.99,
    compareAt: 24.99,
  },
  {
    slug: "grip-socks-grip-me-baby",
    name: "AMARÉ Grip Socks - Grip Me Baby",
    metaDescription:
      "Grip Me Baby socks by AMARÉ — bold grip for Pilates and reformer sessions in Hallandale. Secure comfort; local pickup or shipping through our online store.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-grip-me-baby",
    price: 19.99,
    compareAt: 24.99,
  },
  {
    slug: "grip-socks-matcha",
    name: "AMARÉ Grip Socks - Matcha",
    metaDescription:
      "Matcha-tone AMARÉ grip socks — fresh grip for reformer Pilates at AMARÉ Wellness Studio in Hallandale. Sale pricing; cart and pickup options on our store.",
    wixUrl: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks",
    price: 19.99,
    compareAt: 24.99,
  },
].map((p) => ({
  ...p,
  image: productLocalImage(p.slug),
  gallery: [2, 3, 4, 5].map((n) => `${productMediaBase(p.slug)}/${n}.webp`),
}));

const PRODUCT_PAGES = PRODUCTS.map((product) => ({
  file: path.join("product", `${product.slug}.html`),
  path: `/product/${product.slug}`,
  kind: "product",
  product,
  title: `${product.name} | AMARÉ Wellness Studio`,
  description: product.metaDescription,
  nav: "products",
}));

const ALL_PAGES = [...PAGES, ...PRODUCT_PAGES];

/** Mirrors `src/content/faq.html` Q&A for FAQPage JSON-LD (plain-text answers). */
const FAQ_SCHEMA_ITEMS = [
  {
    question: "What is Kangoo, and is it right for everyone?",
    answer:
      "Kangoo is one of our most fun, high-energy classes — think of it as a workout that feels like a party. The class is done using rebound boots, which help absorb impact while adding a fun, bouncy feel to the workout. The jumping movement can support lymphatic drainage, helps strengthen the core, and is amazing for calorie burn. We provide the boots at the studio, and they fit approximately US women’s sizes 6–11. We recommend wearing high socks for the best fit and comfort. Kangoo is not suitable during pregnancy or for those with serious knee injuries. If you are unsure whether it’s the right fit for you, please check with your doctor first.",
  },
  {
    question: "Can I book through ClassPass?",
    answer:
      "Yes — you can absolutely book classes through ClassPass. That said, we do give booking priority and greater class availability to clients who book directly with us through our website. Each class has a limited number of spots available for ClassPass users, so if you see that a class looks full on ClassPass, it may simply mean that the ClassPass spots have already been taken. In many cases, spots may still be available when you book directly through our website. We always recommend booking ahead of time if you’d like to secure your place through ClassPass.",
  },
  {
    question: "What is your late cancel / no-show policy?",
    answer:
      "Cancellation and no-show policies depend on the platform you booked through. If you booked through ClassPass, their cancellation and no-show policy will apply. If you booked directly through us, classes must be canceled more than 12 hours in advance. Late cancellations made within 12 hours of class, as well as no-shows, will result in the class being lost. For clients on our Unlimited membership, because there is no class credit to deduct, a $10 fee is charged for late cancellations or no-shows.",
  },
  {
    question: "Do I need my own equipment?",
    answer:
      "For Reformer classes, grip socks are required. If you don’t have a pair, we do sell grip socks at the studio in beautiful designs. For Mat classes, we provide the mats. We simply ask that you bring a long towel to place over the mat. We also sell towels at the studio and offer towel rentals if needed. Of course, if you prefer to use your own mat, you’re welcome to bring it. For Kangoo classes, we provide the boots. We recommend wearing high socks for the best fit and comfort. Kangoo is not suitable during pregnancy or for those with serious knee injuries. If you are pregnant, have an active injury, or are unsure whether a class is the right fit for you, please review the notes on our FAQ page and let your instructor know before class begins.",
  },
  {
    question: "Is there parking?",
    answer:
      "Yes — there is plenty of free street parking right by the studio entrance. If those spots are full, there is also a free ground-level parking garage in the same building with plenty of additional parking.",
  },
  {
    question: "How do I rent the treatment room?",
    answer:
      "Rates, rental options, and what’s included can be found on our Treatment room rental page. If you’d like photos of the room or want to check availability, feel free to message us on Instagram and we’ll be happy to help.",
  },
  {
    question: "How do I host a private event?",
    answer:
      "We host showers, bachelorettes, workshops, birthdays, and more. You can reach out to us on Instagram or through our contact form with your preferred date, group size, and a little about what you have in mind, and we’ll be happy to help from there.",
  },
];

function faqJsonLd() {
  const mainEntity = FAQ_SCHEMA_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  }));
  return `<script type="application/ld+json">
${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity }, null, 2)}
</script>`;
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function navClass(key, current) {
  return key === current ? "nav__link is-active" : "nav__link";
}

/** Link from site root, with optional `../` when page lives under /product/ */
function rel(assetPrefix, href) {
  if (!assetPrefix) return href;
  return assetPrefix + href;
}

/** Root-absolute URL for bundled CSS/JS so `/privateevents` (rewrite) still loads `/js/main.js`. */
function assetHref(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function renderHeader(currentNav, assetPrefix = "") {
  const n = (key) => navClass(key, currentNav);
  const r = (href) => rel(assetPrefix, href);
  return `<header class="site-header">
  <div class="site-header__top">
    <a class="brand" href="${r(H.home)}" lang="en"><img class="brand__logo" src="${BRAND.logoStacked}" width="420" height="168" alt="AMARÉ Wellness Studio" decoding="async" /></a>
    <a class="header-book" href="${r(H.classes)}" data-track="book_class_click" data-cta-location="header">Book a class</a>
    <div class="site-header__actions">
      <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav" id="nav-toggle">Menu</button>
    </div>
  </div>
  <div class="site-header__bar">
    <div class="nav-scroll" data-nav-scroll>
      <nav id="site-nav" class="nav nav--pills" aria-label="Main">
        <a class="${n("home")}" href="${r(H.home)}">Home</a>
        <a class="${n("pricing")}" href="${r(H.pricing)}">Pricing &amp; Membership</a>
        <a class="${n("classes")}" href="${r(H.classes)}" data-track="book_class_click" data-cta-location="nav">Book a class</a>
        <a class="${n("privateevents")}" href="${r(H.events)}">Events</a>
        <a class="${n("products")}" href="${r(H.products)}">Products</a>
        <a class="${n("about")}" href="${r(H.about)}">About us</a>
        <a class="${n("treatment-room")}" href="${r(H.treatmentRoom)}">Treatment room</a>
        <a class="${n("first-visit")}" href="${r(H.firstVisit)}">First visit</a>
        <a class="${n("faq")}" href="${r(H.faq)}">FAQ</a>
        <a class="${n("contact")}" href="${r(H.contact)}">Contact</a>
      </nav>
    </div>
  </div>
</header>`;
}

const MAPS_EMBED =
  "https://www.google.com/maps?q=501+N+Dixie+Hwy,+Hallandale+Beach,+FL+33009&output=embed";

function renderMapSection() {
  return `<section id="find-us" class="site-map" aria-labelledby="site-map-title">
  <div class="site-map__inner">
    <h2 id="site-map-title" class="site-map__title">Find us</h2>
    <p class="site-map__address">
      <a href="https://www.google.com/maps/search/?api=1&amp;query=501+N+Dixie+Hwy+Hallandale+Beach+FL" target="_blank" rel="noopener noreferrer">501 N Dixie Hwy, Hallandale Beach, FL</a>
    </p>
    <div class="site-map__frame">
      <iframe
        class="site-map__iframe"
        title="AMARÉ Wellness Studio on Google Maps"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        src="${MAPS_EMBED}"
      ></iframe>
    </div>
  </div>
</section>`;
}

function renderFooter(assetPrefix = "") {
  const r = (href) => rel(assetPrefix, href);
  return `<footer class="site-footer">
  <div class="site-footer__inner">
    <div>
      <p class="site-footer__brand">
        <img class="site-footer__logo" src="${BRAND.logoStacked}" width="280" height="112" alt="AMARÉ Wellness Studio" loading="lazy" decoding="async" />
      </p>
      <p>Wellness studio · Hallandale, Florida. Reformer &amp; Mat Pilates, barre, Kangoo, and more.</p>
    </div>
    <div>
      <h2>Visit</h2>
      <p><a href="https://www.google.com/maps/search/?api=1&query=501+N+Dixie+Hwy+Hallandale+Beach+FL" target="_blank" rel="noopener noreferrer">501 N Dixie Hwy, Hallandale Beach, FL</a></p>
      <p><a href="${r(H.contact)}">Contact &amp; hours</a></p>
    </div>
    <div>
      <h2>Legal</h2>
      <ul class="foot-list">
        <li><a href="${r(H.privacy)}">Privacy</a></li>
        <li><a href="${r(H.terms)}">Terms</a></li>
        <li><a href="${r(H.accessibility)}">Accessibility</a></li>
        <li><a href="${r(H.shipping)}">Shipping</a></li>
        <li><a href="${r(H.returns)}">Returns</a></li>
      </ul>
    </div>
  </div>
  <p class="foot-legal">© ${new Date().getFullYear()} AMARÉ Wellness Studio. <a href="${H.instagram}" target="_blank" rel="noopener noreferrer" class="foot-legal__ig"><svg class="foot-legal__ig-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg><span>Instagram @amare__wellness</span></a></p>
</footer>`;
}

function localBusinessSchema() {
  /** Opening hours aligned with contact.html — Saturday closed (omit from schema). */
  const sameAs = [H.instagram, ...(SITE_TIKTOK_URL ? [SITE_TIKTOK_URL] : [])];
  return `<script type="application/ld+json">
${JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "HealthAndBeautyBusiness",
      name: "AMARÉ Wellness Studio",
      description: "Pilates and wellness classes in Hallandale, Florida.",
      url: SITE_URL,
      telephone: SITE_PHONE_E164,
      logo: `${SITE_URL}${BRAND.logoStacked}`,
      image: [
        `${SITE_URL}${BRAND.logoStacked}`,
        `${SITE_URL}${HOME_OG_IMAGE}`,
        `${SITE_URL}${DEFAULT_OG_IMAGE}`,
      ],
      sameAs,
      openingHoursSpecification: [
        {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Sunday"],
          opens: "08:00",
          closes: "22:00",
        },
        {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: "Friday",
          opens: "08:00",
          closes: "16:00",
        },
      ],
      geo: {
        "@type": "GeoCoordinates",
        latitude: SITE_GEO.latitude,
        longitude: SITE_GEO.longitude,
      },
      address: {
        "@type": "PostalAddress",
        streetAddress: "501 N Dixie Hwy",
        addressLocality: "Hallandale Beach",
        addressRegion: "FL",
        postalCode: "33009",
        addressCountry: "US",
      },
    },
    null,
    2
  )}
</script>`;
}

function productJsonLd(p) {
  const name = p.name.replace(/&amp;/g, "&");
  const pageUrl = absoluteSiteUrl(`/product/${p.slug}`);
  const productEntity = {
    "@type": "Product",
    name,
    image: [p.image, ...p.gallery].map((u) => absoluteSiteUrl(u)),
    description: `${name}. ${PRODUCT_COPY.long}`,
    offers: {
      "@type": "Offer",
      price: String(p.price),
      priceCurrency: "USD",
      priceValidUntil: `${new Date().getFullYear() + 1}-12-31`,
      availability: "https://schema.org/InStock",
      url: pageUrl,
    },
  };
  const breadcrumbEntity = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "All products", item: `${SITE_URL}/products` },
      { "@type": "ListItem", position: 3, name, item: pageUrl },
    ],
  };
  return `<script type="application/ld+json">
${JSON.stringify({ "@context": "https://schema.org", "@graph": [productEntity, breadcrumbEntity] }, null, 2)}
</script>`;
}

function productImgAlt(p) {
  return p.name.replace(/&amp;/g, "&");
}

function renderProductGallery(product) {
  const baseAlt = productImgAlt(product);
  const gid = `product-gallery-${product.slug}`;
  const items = product.gallery
    .map((src, idx) => {
      const n = idx + 2;
      const alt = `${baseAlt} — view ${n}`;
      return `      <li class="shop-product__gallery-item">
        <figure class="shop-product__gallery-fig">
          <img
            class="shop-product__gallery-img"
            src="${src}"
            alt="${alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"
            width="640"
            height="640"
            loading="lazy"
            decoding="async"
          />
        </figure>
      </li>`;
    })
    .join("\n");
  return `
  <section class="shop-product__gallery-wrap" data-reveal aria-labelledby="${gid}-title">
    <h2 id="${gid}-title" class="shop-product__gallery-heading">More views</h2>
    <ul class="shop-product__gallery" role="list">
${items}
    </ul>
  </section>`;
}

function renderProductGrid(assetPrefix) {
  const r = (href) => rel(assetPrefix, href);
  const items = PRODUCTS.map(
    (p) => `    <li class="shop-grid__item" role="listitem">
      <a class="shop-card" href="${r(`product/${p.slug}.html`)}">
        <div class="shop-card__media">
          <img
            class="shop-card__img"
            src="${p.image}"
            alt="${productImgAlt(p).replace(/"/g, "&quot;")}"
            width="800"
            height="800"
            loading="lazy"
            decoding="async"
          />
        </div>
        <h2 class="shop-card__title">${p.name}</h2>
        <p class="shop-card__meta" aria-label="Price">
          <span class="shop-card__was">$${p.compareAt.toFixed(2)}</span>
          <span class="shop-card__now">$${p.price.toFixed(2)}</span>
        </p>
      </a>
    </li>`
  ).join("\n");
  return `<section class="shop-grid" data-reveal aria-label="All products list">
  <ul class="shop-grid__list" role="list">
${items}
  </ul>
${
    SHOW_PRODUCT_PURCHASE_BUTTONS
      ? `  <p class="shop-grid__note">Same ${PRODUCTS.length} styles as the <a href="https://www.amarewellness.com/category/all-products" target="_blank" rel="noopener noreferrer">original AMARÉ catalog</a> — add to cart on the Wix store.</p>`
      : `  <p class="shop-grid__note">Browse each style for photos, pricing, and care details.</p>`
  }
</section>`;
}

function renderProductMain(product, assetPrefix) {
  const r = (href) => rel(assetPrefix, href);
  return `<article class="shop-product">
  <div class="prose shop-product__prose">
    <nav class="prose__crumb" aria-label="Breadcrumb">
      <a href="${r("index.html")}">Home</a>
      <span class="prose__crumb-sep" aria-hidden="true">/</span>
      <a href="${r("products.html")}">All products</a>
      <span class="prose__crumb-sep" aria-hidden="true">/</span>
      <span>${product.name}</span>
    </nav>
  </div>
  <div class="shop-product__hero" data-reveal>
    <div class="shop-product__grid">
      <div class="shop-product__media">
        <div class="shop-product__img-frame">
          <img
            class="shop-product__img"
            src="${product.image}"
            alt="${productImgAlt(product).replace(/"/g, "&quot;")}"
            width="1000"
            height="1000"
            loading="eager"
            decoding="async"
          />
        </div>
      </div>
      <div class="shop-product__buy">
        <h1 class="shop-product__title">${product.name}</h1>
        <p class="shop-product__prices" aria-label="Pricing">
          <span class="shop-product__price-was">Was $${product.compareAt.toFixed(2)}</span>
          <span class="shop-product__price-now" aria-label="Current price">$${product.price.toFixed(2)}</span>
        </p>
        <p class="shop-product__lead">${PRODUCT_COPY.long}</p>
${
          SHOW_PRODUCT_PURCHASE_BUTTONS
            ? `        <p class="shop-product__actions">
          <a class="btn" href="${product.wixUrl}" target="_blank" rel="noopener noreferrer">Add to cart on the AMARÉ store</a>
        </p>`
            : ""
        }
      </div>
    </div>
  </div>
  ${renderProductGallery(product)}
  <div class="prose shop-product__prose" data-reveal>
    <h2>Care instructions</h2>
    <p>${PRODUCT_COPY.care}</p>
    <h2>Pickup &amp; shipping</h2>
    <p><strong>Local pickup:</strong> Available at AMARÉ Wellness Studio during studio hours.</p>
    <p><strong>Shipping:</strong> Orders are processed within 1–3 business days. Delivery times vary by location.</p>
  </div>
  <div class="prose shop-product__prose" data-reveal>
    <h2>Returns &amp; exchanges</h2>
    <p>${PRODUCT_COPY.returns}</p>
    <h2>Product notes</h2>
    <p>${PRODUCT_COPY.notes}</p>
    <p>See also <a href="${r("shipping.html")}">Shipping</a> and <a href="${r("returns.html")}">Returns</a> on this site.</p>
  </div>
</article>`;
}

function renderPage(page) {
  const assetPrefix = page.path?.startsWith("/product/") ? "../" : "";
  const isHome = page.file === "index.html";
  const isProduct = page.kind === "product";
  const isProductsIndex = !isProduct && page.content === "products.html";

  let main;
  if (isProduct) {
    main = renderProductMain(page.product, assetPrefix);
  } else {
    main = read(path.join(src, "content", page.content));
    if (isHome) {
      main = main.replace(/\{\{BRAND_MARK\}\}/g, BRAND.mark).replace(/\{\{BRAND_WORDMARK\}\}/g, BRAND.wordmark);
    }
    if (isProductsIndex) {
      main = main.replace("{{PRODUCT_GRID}}", renderProductGrid(assetPrefix));
    }
    if (page.content === "classes-api.html") {
      main = main.replace(/__MB_SCHEDULE_CONFIG_JSON__/g, mbScheduleConfigJson());
    }
    if (page.content === "pricing-api.html") {
      main = main.replace(/__PRICING_API_CONFIG_JSON__/g, mbPricingApiConfigJson());
      main = main.replace(/__MB_CONTRACT_TERMS_JSON__/g, mbContractTermsConfigJson());
    }
    if (
      page.content === "pricing-api.html" ||
      page.content === "classes-api.html" ||
      page.content === "mindbody-member.html" ||
      page.content === "mindbody-login.html"
    ) {
      main = main.replace(/__MB_SCHEDULE_ORIGIN__/g, escapeHtmlAttr(MB_SCHEDULE_ORIGIN));
    }
  }

  const canonical = `${SITE_URL}${page.path === "/" ? "" : page.path}`;
  const ogType = isProduct ? "product" : "website";
  const defaultOgAbs = absoluteSiteUrl(DEFAULT_OG_IMAGE);
  const homeOgAbs = absoluteSiteUrl(HOME_OG_IMAGE);
  const ogImageBlock = isProduct
    ? `
  <meta property="og:image" content="${absoluteSiteUrl(page.product.image)}" />
  <meta property="og:image:alt" content="${escapeHtmlAttr(productImgAlt(page.product))}" />
  <meta name="twitter:image" content="${absoluteSiteUrl(page.product.image)}" />`
    : isHome
      ? `
  <meta property="og:image" content="${homeOgAbs}" />
  <meta property="og:image:alt" content="${escapeHtmlAttr("Group class at AMARÉ Wellness studio")}" />
  <meta name="twitter:image" content="${homeOgAbs}" />`
      : `
  <meta property="og:image" content="${defaultOgAbs}" />
  <meta property="og:image:alt" content="${escapeHtmlAttr("AMARÉ Wellness Studio — grip socks and Pilates essentials")}" />
  <meta name="twitter:image" content="${defaultOgAbs}" />`;

  let headSchema = "";
  if (isHome) headSchema = localBusinessSchema();
  else if (isProduct) headSchema = productJsonLd(page.product);
  if (!isProduct && page.content === "faq.html") headSchema += faqJsonLd();

  const metaTitleEsc = escapeHtmlAttr(page.title);
  const metaDescEsc = escapeHtmlAttr(page.description);

  const bodyClass = isHome ? "is-home" : isProduct ? "is-product" : "";

  /** PWA manifest: ngrok-free (and similar) often returns HTML for subresource navigations → false “manifest syntax error.” Skip on `/pricing-api` and `/classes-api` (Mindbody-heavy pages). */
  const includeWebManifestLink =
    page.content !== "pricing-api.html" && page.content !== "classes-api.html";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${ga4HeadSnippet(GA_MEASUREMENT_ID)}
  <link rel="icon" href="${BRAND.faviconIco}" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="${BRAND.favicon32}" />
  <link rel="icon" type="image/png" sizes="16x16" href="${BRAND.favicon16}" />
  <link rel="apple-touch-icon" href="${BRAND.appleTouch}" />
  ${includeWebManifestLink ? `  <link rel="manifest" href="/favicon/site.webmanifest" />\n` : ""}  <meta name="theme-color" content="#faf3eb" />
  <link rel="preconnect" href="https://static.wixstatic.com" crossorigin />
  <link rel="preconnect" href="https://video.wixstatic.com" crossorigin />
  <title>${metaTitleEsc}</title>
  <meta name="description" content="${metaDescEsc}" />
  ${page.noindex ? `  <meta name="robots" content="noindex, nofollow" />\n` : ""}  <link rel="canonical" href="${canonical}" />
  <meta property="og:title" content="${metaTitleEsc}" />
  <meta property="og:description" content="${metaDescEsc}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="${escapeHtmlAttr(OG_SITE_NAME)}" />
  <meta property="og:locale" content="${escapeHtmlAttr(OG_LOCALE)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${metaTitleEsc}" />
  <meta name="twitter:description" content="${metaDescEsc}" />${ogImageBlock}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <!-- DM Sans primary UI font — preload reduces swap-driven layout shift before stylesheet resolves faces -->
  <link rel="preload" href="https://fonts.gstatic.com/s/dmsans/v17/rP2Hp2ywxg089UriCZOIHQ.woff2" as="font" type="font/woff2" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=optional" rel="stylesheet" />
  <link rel="stylesheet" href="${assetHref("css/tokens.css")}" />
  <link rel="stylesheet" href="${assetHref("css/site.css")}" />
  <link rel="stylesheet" href="${assetHref("css/components-mindbody.css")}" />
  <link rel="stylesheet" href="${assetHref("css/components-pricing.css")}" />
  ${headSchema}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
  <a class="skip-link" href="#main">Skip to content</a>
  ${renderHeader(page.nav, assetPrefix)}
  <main id="main">
${main}
  </main>
  ${renderMapSection()}
  ${renderFooter(assetPrefix)}
  <script src="${assetHref("js/main.js")}" defer></script>
</body>
</html>
`;
}

function buildSitemap() {
  const lastmod = new Date().toISOString().slice(0, 10);
  const lines = ALL_PAGES.filter((p) => !p.excludeFromSitemap).map((p) => {
    const loc = `${SITE_URL}${p.path === "/" ? "" : p.path}`;
    const priority =
      p.path === "/"
        ? "1"
        : p.path === "/products"
          ? "0.85"
          : p.path?.startsWith("/product/")
            ? "0.7"
            : "0.8";
    return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lines.join("\n")}
</urlset>
`;
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const f = path.join(from, name);
    const t = path.join(to, name);
    if (fs.statSync(f).isDirectory()) copyDir(f, t);
    else fs.copyFileSync(f, t);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

/** Netlify Functions read this at runtime (`load-mb-contract-terms.mjs`) for membership consent verification. */
const fnEmbedded = path.join(root, "netlify/functions/_embedded");
fs.mkdirSync(fnEmbedded, { recursive: true });
fs.copyFileSync(
  path.join(src, "content/mb-contract-terms.config.json"),
  path.join(fnEmbedded, "mb-contract-terms.config.json"),
);

copyDir(path.join(src, "css"), path.join(dist, "css"));
copyDir(path.join(src, "js"), path.join(dist, "js"));
copyDir(pub, dist);

for (const page of ALL_PAGES) {
  write(path.join(dist, page.file), renderPage(page));
}

write(path.join(dist, "sitemap.xml"), buildSitemap());
write(
  path.join(dist, "robots.txt"),
  `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`
);

console.log("Built to dist/ with SITE_URL =", SITE_URL);
