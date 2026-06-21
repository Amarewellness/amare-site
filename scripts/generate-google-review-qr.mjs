/**
 * AMARÉ Google Review QR → https://g.page/r/Cbdf8XUX-lCbEAI/review
 * Taupe-on-cream palette (matches in-studio print reference).
 * Run: node scripts/generate-google-review-qr.mjs
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
const URL = "https://g.page/r/Cbdf8XUX-lCbEAI/review";

/** Warm taupe + cream — matches studio Google review QR reference */
const COLORS = {
  dot: "#a38b7a",
  corner: "#a38b7a",
  bg: "#f5f0e9",
};

const QR_SIZE = 1200;
const QR_QUIET = 56;
/** Extra cream margin for print / cropping */
const SAFE = 80;
const OUTER = QR_SIZE + SAFE * 2;

async function buildQrPng() {
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
  });

  const raw = await qr.getRawData("png");
  return Buffer.isBuffer(raw) ? raw : Buffer.from(await raw.arrayBuffer());
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const qrPng = await buildQrPng();

  const framed = await sharp(qrPng)
    .extend({
      top: SAFE,
      bottom: SAFE,
      left: SAFE,
      right: SAFE,
      background: COLORS.bg,
    })
    .png()
    .toBuffer();

  const pngPath = path.join(OUT_DIR, "qr-google-review.png");
  const svgPath = path.join(OUT_DIR, "qr-google-review.svg");

  await sharp(framed).png({ compressionLevel: 9 }).toFile(pngPath);

  const b64 = framed.toString("base64");
  fs.writeFileSync(
    svgPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTER}" height="${OUTER}" viewBox="0 0 ${OUTER} ${OUTER}">
  <image href="data:image/png;base64,${b64}" width="${OUTER}" height="${OUTER}"/>
</svg>`
  );

  console.log("Google Review QR generated:");
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
