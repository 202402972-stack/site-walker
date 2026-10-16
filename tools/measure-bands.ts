// A4 helper — quantifies blank/gray bands in a full-page capture.
// Splits the image into 100px-tall bands; a band counts as blank-ish when
// >98% of its pixels are near-white (all channels > 240) AND low-variance.
// Usage: npx tsx tools/measure-bands.ts <image> [bandPx]
import sharp from "sharp";

const file = process.argv[2];
const bandPx = Number(process.argv[3] ?? 100);
if (!file) {
  console.error("Usage: npx tsx tools/measure-bands.ts <image> [bandPx]");
  process.exit(1);
}

const img = sharp(file);
const meta = await img.metadata();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

let blankBands = 0;
const totalBands = Math.ceil(height / bandPx);
const rows: string[] = [];
for (let b = 0; b < totalBands; b++) {
  const y0 = b * bandPx;
  const y1 = Math.min(y0 + bandPx, height);
  let nearWhite = 0;
  const px = (y1 - y0) * width;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const bl = data[i + 2];
      if (r > 240 && g > 240 && bl > 240) nearWhite++;
    }
  }
  const frac = nearWhite / px;
  const blank = frac > 0.98;
  if (blank) blankBands++;
  rows.push(`y ${String(y0).padStart(5)}–${String(y1).padStart(5)}  near-white ${(frac * 100).toFixed(1).padStart(5)}%${blank ? "  BLANK" : ""}`);
}
console.log(`${file}: ${meta.width}x${meta.height}`);
console.log(rows.join("\n"));
console.log(`blank bands: ${blankBands}/${totalBands} (${((blankBands / totalBands) * 100).toFixed(1)}%)`);
