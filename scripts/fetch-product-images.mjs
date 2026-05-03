/**
 * Re-fetch Wix product pages and print likely `static.wixstatic.com/media/…` hero URLs
 * (use when you add products or replace art). Copy IDs into `wixImage("…~mv2.png")` in build.mjs.
 * Run: node scripts/fetch-product-images.mjs
 */
const pages = [
  {
    slug: "grip-socks-cutie-with-a-booty",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-cutie-with-a-booty",
  },
  {
    slug: "grip-socks-pilates-princess",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-pilates-princess",
  },
  {
    slug: "grip-socks-black-white",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-black-white",
  },
  {
    slug: "grip-socks-hearts",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-hearts",
  },
  {
    slug: "grip-socks-grip-me-baby",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks-grip-me-baby",
  },
  {
    slug: "grip-socks-matcha",
    url: "https://www.amarewellness.com/product-page/amar%C3%A9-grip-socks",
  },
];

const re = /https:\/\/static\.wixstatic\.com\/media\/[^\s"'<>]+/g;

function pickProductImage(urls) {
  // Prefer main product gallery (often largest / fit/w_ or c_fill in product page)
  const noThumb = urls.filter(
    (u) =>
      !/icon|favicon|logo|avatar|1x1|w_50[,\s]|w_80[,\s]|w_100[,\s]/i.test(u)
  );
  const productLike = noThumb.filter(
    (u) => /~mv2\.(jpg|png|jpeg|webp)/i.test(u) && /w_\d+/.test(u)
  );
  if (productLike.length) {
    // Sort by width hint descending
    productLike.sort((a, b) => {
      const wa = (a.match(/w_(\d+)/) || [0, 0])[1];
      const wb = (b.match(/w_(\d+)/) || [0, 0])[1];
      return Number(wb) - Number(wa);
    });
    return productLike[0];
  }
  return noThumb[0] || urls[0];
}

for (const { slug, url } of pages) {
  const res = await fetch(url);
  const html = await res.text();
  const all = html.match(re) || [];
  const unique = [...new Set(all.map((u) => u.split("?")[0]))];
  const chosen = pickProductImage(unique);
  console.log(slug);
  console.log("  " + (chosen || "(none)"));
}
