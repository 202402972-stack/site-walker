// Phase-0 follow-up: reference @font-face sources.
// The CSSOM read inside the page was blocked cross-origin, so fetch each
// stylesheet by URL instead. Evidence for design/tokens.md (font substitution)
// and the A14 side-by-side review.
//
// Usage: npx tsx tools/extract-fonts.ts [page-url]
import fs from "node:fs";

const PAGE = process.argv[2] ?? "https://join.elevenlabs.io/agents/architect";

const res = await fetch(PAGE, {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  },
});
if (!res.ok) {
  console.error(`fetch ${PAGE} → HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();

const hrefs: string[] = [];
for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
  if (!/rel=["']?stylesheet/i.test(tag[0])) continue;
  const href = /href=["']([^"']+)["']/i.exec(tag[0])?.[1];
  if (href) hrefs.push(new URL(href, PAGE).toString());
}
const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");

const sheets: { url: string; css: string }[] = [{ url: "(inline)", css: inline }];
for (const url of [...new Set(hrefs)]) {
  try {
    const r = await fetch(url);
    sheets.push({ url, css: r.ok ? await r.text() : `/* HTTP ${r.status} */` });
  } catch (e) {
    sheets.push({ url, css: `/* fetch failed: ${e instanceof Error ? e.message : String(e)} */` });
  }
}

interface Face {
  family: string;
  srcs: string[];
  cssUrl: string;
}
const faces: Face[] = [];
for (const { url, css } of sheets) {
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const block = m[1];
    const family =
      /font-family\s*:\s*([^;]+);/i.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "(unnamed)";
    const srcs = [...block.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((x) => x[1]);
    faces.push({ family, srcs, cssUrl: url });
  }
}

const families = [...new Set(faces.map((f) => f.family))];
const brandMentions = ["Waldenburg", "Inter", "Söhne", "Sohne", "Suisse", "GT "].filter((n) =>
  sheets.some((s) => s.css.includes(n)),
);

const lines = [
  "# Reference @font-face evidence",
  "",
  `Fetched ${PAGE} on ${new Date().toISOString().slice(0, 10)}.`,
  `Stylesheets: ${[...new Set(hrefs)].length} external, ${inline ? "inline styles present" : "no inline styles"}.`,
  "",
  `## Families declared (${families.length})`,
  "",
  ...families.map((f) => `- ${f} (${faces.filter((x) => x.family === f).length} faces)`),
  "",
  "## Faces",
  "",
  ...faces.map((f) => `- ${f.family}\n  - src: ${f.srcs.join(" | ") || "(no url src)"}\n  - from: ${f.cssUrl}`),
  "",
  "## Brand-name mentions in fetched CSS",
  "",
  ...(brandMentions.length ? brandMentions.map((b) => `- "${b}" found`) : ["- none matched"]),
  "",
];
fs.writeFileSync("design/fonts.md", lines.join("\n"));
console.log(`design/fonts.md written — ${faces.length} @font-face blocks, families: ${families.join(", ") || "none"}`);
