// OG card + favicon support (M4/M5 polish).
// - web/public/sample/og.jpg: 1200x630 social card cropped from the REAL sample
//   capture (top of the full-page shot), JPEG q84.
// - web/public/favicon.svg: original mark (same as the site logo), not the reference's.
// Usage: npx tsx tools/make-og.ts
import sharp from "sharp";
import fs from "node:fs";

const src = "web/public/sample/full-page.webp";
const out = "web/public/sample/og.jpg";

const meta = await sharp(src).metadata();
const top = Math.min(630 * (meta.width! / 1200), meta.height!);
await sharp(src)
  .extract({ left: 0, top: 0, width: meta.width!, height: Math.round(top) })
  .resize(1200, 630, { fit: "cover", position: "top" })
  .jpeg({ quality: 84, mozjpeg: true })
  .toFile(out);
console.log(`${out} written — ${Math.round(fs.statSync(out).size / 1024)}KB from ${src} ${meta.width}x${meta.height}`);
