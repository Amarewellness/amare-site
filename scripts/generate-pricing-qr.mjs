/**
 * AMARÉ branded QR → https://www.amarewellness.com/pricing
 * Run: node scripts/generate-pricing-qr.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const QRCodeStyling = require("qr-code-styling");
const nodeCanvas = require("canvas");
const { JSDOM } = require("jsdom");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "print");
const LOGO = path.join(ROOT, "public", "logo", "logo-mark.png");
const URL = "https://www.amarewellness.com/pricing";

/** AMARÉ palette — matches member-benefits gold + warm neutrals */
const COLORS = {
  dot: "#c4a574",
  corner: "#a88b4a",
  bg: "#f7f3ec",
  frame: "#8a7b68",
  frameAccent: "#d4bc8a",
  page: "#f0ebe3",
};

const QR_SIZE = 1200;
/** Extra cream padding inside the frame so modules never clip at the edges */
const PAD = 136;
const FRAME = 14;
/** Quiet zone around the QR matrix (spec recommends ≥4 modules; we use generous) */
const QR_QUIET = 56;
/** Extra page margin so nothing clips when cropping for print */
const SAFE = 56;
const OUTER = QR_SIZE + PAD * 2 + FRAME * 2 + SAFE * 2;

/** Logo stroke — same as QR dot modules */
const LOGO_RGB = { r: 196, g: 165, b: 116 }; // #c4a574

/** Black line-art mark → solid gold, transparent background */
async function goldLogoPng() {
  const { data, info } = await sharp(LOGO)
    .ensureAlpha()
    .resize(320, 320, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    if (a > 20 && lum < 0.78) {
      data[i] = LOGO_RGB.r;
      data[i + 1] = LOGO_RGB.g;
      data[i + 2] = LOGO_RGB.b;
      data[i + 3] = 255;
    } else {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function buildQrPng(logoPath) {
  const qr = new QRCodeStyling({
    jsdom: JSDOM,
    nodeCanvas,
    width: QR_SIZE,
    height: QR_SIZE,
    type: "canvas",
    data: URL,
    margin: QR_QUIET,
    qrOptions: {
      errorCorrectionLevel: "H",
    },
    imageOptions: {
      hideBackgroundDots: true,
      imageSize: 0.2,
      margin: 12,
      crossOrigin: "anonymous",
    },
    dotsOptions: {
      color: COLORS.dot,
      type: "rounded",
    },
    backgroundOptions: {
      color: COLORS.bg,
    },
    cornersSquareOptions: {
      color: COLORS.corner,
      type: "extra-rounded",
    },
    cornersDotOptions: {
      color: COLORS.corner,
      type: "dot",
    },
    image: logoPath,
  });

  const raw = await qr.getRawData("png");
  return Buffer.isBuffer(raw) ? raw : Buffer.from(await raw.arrayBuffer());
}

function frameSvg(size, radius) {
  const r = radius;
  const f = FRAME;
  const taupe = size - f * 2;
  const cream = taupe - f * 2;
  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${COLORS.page}"/>
  <rect x="${f}" y="${f}" width="${taupe}" height="${taupe}" rx="${r}" fill="${COLORS.frame}"/>
  <rect x="${f + 3}" y="${f + 3}" width="${taupe - 6}" height="${taupe - 6}" rx="${r - 2}" fill="none" stroke="${COLORS.frameAccent}" stroke-width="1.5"/>
  <rect x="${f * 2}" y="${f * 2}" width="${cream}" height="${cream}" rx="${r - 4}" fill="${COLORS.bg}"/>
</svg>`);
}

async function main() {
  if (!fs.existsSync(LOGO)) {
    console.error("Missing logo:", LOGO);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const goldLogoPath = path.join(OUT_DIR, "qr-pricing-logo-gold.png");
  await sharp(await goldLogoPng()).toFile(goldLogoPath);

  const qrPng = await buildQrPng(goldLogoPath);
  const radius = 48;
  const canvasSize = QR_SIZE + PAD * 2 + FRAME * 2;
  const qrInset = FRAME * 2 + PAD;

  const framed = await sharp(frameSvg(canvasSize, radius))
    .composite([
      {
        input: await sharp(qrPng).png().toBuffer(),
        left: qrInset,
        top: qrInset,
      },
    ])
    .extend({
      top: SAFE,
      bottom: SAFE,
      left: SAFE,
      right: SAFE,
      background: COLORS.page,
    })
    .png()
    .toBuffer();

  const pngPath = path.join(OUT_DIR, "qr-pricing.png");
  const svgPath = path.join(OUT_DIR, "qr-pricing.svg");

  await sharp(framed).png({ compressionLevel: 9 }).toFile(pngPath);

  // SVG embed for scalable print
  const b64 = framed.toString("base64");
  fs.writeFileSync(
    svgPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTER}" height="${OUTER}" viewBox="0 0 ${OUTER} ${OUTER}">
  <image href="data:image/png;base64,${b64}" width="${OUTER}" height="${OUTER}"/>
</svg>`
  );

  console.log("QR generated:");
  console.log("  URL:", URL);
  console.log("  PNG:", pngPath);
  console.log("  SVG:", svgPath);
  const meta = await sharp(pngPath).metadata();
  console.log("  Size:", meta.width, "×", meta.height, "px");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
