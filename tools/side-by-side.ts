// A14 helper — reference vs product side-by-side contact sheet.
// Left: design/ref/<viewport>.png (reference page). Right: design/qa/landing-1440.png
// (our rendered landing). Output: design/qa/side-by-side-<viewport>.png with labels.
// Usage: npx tsx tools/side-by-side.ts [viewport=desktop]
import sharp from "sharp";
import fs from "node:fs";

const viewport = process.argv[2] ?? "desktop";
const refPath = `design/ref/${viewport}.png`;
const oursPath = viewport === "desktop" ? "design/qa/landing-1440.png" : `design/qa/landing-${viewport === "tablet" ? "834" : "390"}.png`;
for (const p of [refPath, oursPath]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run the extractor/QA first`);
    process.exit(1);
  }
}

const W = 660;
const GAP = 24;
const BAR = 56;
const ref = await sharp(refPath).resize({ width: W }).toBuffer();
const ours = await sharp(oursPath).resize({ width: W }).toBuffer();
const rh = (await sharp(ref).metadata()).height!;
const oh = (await sharp(ours).metadata()).height!;
const H = BAR + Math.max(rh, oh);

const label = (x: number, text: string) =>
  Buffer.from(
    `<svg width="${W}" height="${BAR}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${BAR}" fill="#111110"/>
      <text x="18" y="36" font-family="Arial, sans-serif" font-size="20" fill="#fff">${text}</text>
    </svg>`,
  );

const out = `design/qa/side-by-side-${viewport}.png`;
await sharp({ create: { width: W * 2 + GAP, height: H, channels: 3, background: "#fdfcfc" } })
  .composite([
    { input: label(0, `REFERENCE — ${viewport}`), left: 0, top: 0 },
    { input: label(0, "SITE WALKER — rendered"), left: W + GAP, top: 0 },
    { input: ref, left: 0, top: BAR },
    { input: ours, left: W + GAP, top: BAR },
  ])
  .png()
  .toFile(out);
console.log(`${out} written — ${W * 2 + GAP}x${H}`);
