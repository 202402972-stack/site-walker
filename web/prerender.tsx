// Build-time prerender — plan §9.4. Real titles, headings and body text exist
// without JavaScript. Config + sample are the same live values, not copies.
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "node:fs";
import { config } from "../server/config.js";
import { Landing } from "./src/landing.js";
import sample from "./src/sample.json";

const limits = {
  product: config.PRODUCT_NAME,
  maxSections: config.MAX_SECTIONS,
  maxJobSeconds: config.MAX_JOB_SECONDS,
  maxPageHeight: config.MAX_PAGE_HEIGHT,
  navWaitMs: config.NAV_WAIT_MS,
  memGuardMb: config.MEM_GUARD_MB,
  retentionHours: config.RETENTION_HOURS,
  maxJobMb: Math.round(config.MAX_JOB_BYTES / 1024 / 1024),
  concurrency: 1,
  queueDepth: 3,
  jobsPerHour: 10,
};

const base = (process.env.PUBLIC_BASE_URL ?? config.PUBLIC_BASE_URL).replace(/\/$/, "");
const html = renderToString(<Landing limits={limits} sample={sample as never} />);
let page = fs.readFileSync("web/dist/index.html", "utf8");
page = page
  .replace("<!--PRERENDER-->", html)
  .replace("$SW_CONFIG", () => JSON.stringify(limits).replace(/</g, "\\u003c"))
  .replaceAll("$PUBLIC_BASE_URL", base);
fs.writeFileSync("web/dist/index.html", page);

// robots + sitemap (landing only; console and API disallowed)
fs.writeFileSync(
  "web/dist/robots.txt",
  `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`,
);
fs.writeFileSync(
  "web/dist/sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${base}/</loc></url>\n</urlset>\n`,
);
console.log("prerendered web/dist/index.html + robots.txt + sitemap.xml");
