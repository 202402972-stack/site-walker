// Section discovery — plan §7.2. Priority: nav → anchors → landmarks → sitemap.xml.
import type { Page } from "playwright";
import { config } from "../config.js";

export interface Section {
  name: string;
  url: string;
  kind: "fullpage" | "nav" | "anchor" | "landmark" | "sitemap";
  anchorId?: string;
}

const SKIP_PATH = /(login|logout|signin|sign-in|signup|sign-up|cart|checkout|account)/i;
const SKIP_EXT = /\.(pdf|zip|rar|7z|exe|dmg|mp4|mp3|avi|mov|csv|xlsx?|docx?)$/i;

function canonical(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = u.hash; // keep hash for anchors — dedupe key includes it
    // strip trailing slash (except root) for stable dedupe
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

function nameFromPath(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  const clean = seg.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim();
  return clean ? clean.replace(/\b\w/g, (c) => c.toUpperCase()) : "Home";
}

export async function discoverSections(page: Page, entryUrl: string): Promise<Section[]> {
  const entry = new URL(entryUrl);
  const origin = entry.origin;
  const seen = new Set<string>();
  const out: Section[] = [];

  const push = (s: Section) => {
    const key = s.url + "#" + (s.anchorId ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  // Always first: Full page (entry URL).
  push({ name: "Full page", url: entry.toString(), kind: "fullpage" });

  // 1. Primary nav links, same-origin only.
  const navLinks = await page.evaluate(() => {
    const roots = [...document.querySelectorAll("nav, header, [role=navigation]")];
    const scope: Element[] = (roots.length > 0 ? roots : [document.body]).filter((el): el is Element => !!el);
    const links: { href: string; text: string; aria: string }[] = [];
    for (const r of scope) {
      for (const a of r.querySelectorAll("a[href]")) {
        links.push({
          href: (a as HTMLAnchorElement).href,
          text: ((a.textContent ?? "").trim().slice(0, 60)),
          aria: (a.getAttribute("aria-label") ?? "").slice(0, 60),
        });
      }
    }
    return links;
  });

  for (const l of navLinks) {
    if (out.length >= config.MAX_SECTIONS) break;
    if (!l.href || l.href.startsWith("mailto:") || l.href.startsWith("tel:") || l.href.startsWith("javascript:")) continue;
    const c = canonical(l.href, entryUrl);
    if (!c) continue;
    let u: URL;
    try { u = new URL(c); } catch { continue; }
    if (u.origin !== origin) continue;
    if (SKIP_PATH.test(u.pathname) || SKIP_EXT.test(u.pathname)) continue;
    const name = l.aria || l.text || nameFromPath(u.pathname);
    push({ name: name || "Page", url: c.split("#")[0], kind: "nav" });
  }

  // 2. In-page anchors (#id or self-URL + #id) with a visibly large target.
  const anchors = await page.evaluate((entryHref: string) => {
    const res: { id: string; name: string }[] = [];
    const entry = new URL(entryHref);
    for (const a of document.querySelectorAll('a[href*="#"]')) {
      const raw = a.getAttribute("href") ?? "";
      if (!raw.includes("#")) continue;
      let id = "";
      if (raw.startsWith("#")) id = raw.slice(1);
      else {
        try {
          const u = new URL(raw, entryHref);
          if (u.origin !== entry.origin || u.pathname !== entry.pathname) continue;
          id = u.hash.slice(1);
        } catch { continue; }
      }
      if (!id) continue;
      const t = document.getElementById(id);
      if (!t) continue;
      const r = t.getBoundingClientRect();
      if (r.height < 200 || r.width < 200) continue;
      const h = t.querySelector("h1,h2,h3");
      res.push({ id, name: ((h?.textContent ?? a.textContent ?? id).trim().slice(0, 60) || id) });
    }
    return res;
  }, entry.toString());
  for (const a of anchors) {
    if (out.length >= config.MAX_SECTIONS) break;
    push({ name: a.name, url: entry.toString().split("#")[0], kind: "anchor", anchorId: a.id });
  }

  // 3. Landmark sections on one-pagers.
  if (out.length < 4) {
    const landmarks = await page.evaluate(() => {
      const res: { id: string; name: string }[] = [];
      for (const s of document.querySelectorAll("main > section[id], section[id]")) {
        const id = (s as HTMLElement).id;
        const h = s.querySelector("h1,h2,h3");
        if (!h) continue;
        const r = (s as HTMLElement).getBoundingClientRect();
        if (r.height < 200) continue;
        res.push({ id, name: (h.textContent ?? id).trim().slice(0, 60) });
      }
      return res;
    });
    for (const l of landmarks) {
      if (out.length >= config.MAX_SECTIONS) break;
      push({ name: l.name || l.id, url: entry.toString().split("#")[0], kind: "landmark", anchorId: l.id });
    }
  }

  // 4. sitemap.xml fallback when fewer than 2 candidates (besides Full page).
  // Handles sitemap indexes: descends one level, never captures *.xml itself.
  if (out.length < 3) {
    try {
      const res = await fetch(new URL("/sitemap.xml", origin).toString());
      if (res.ok) {
        const xml = await res.text();
        let locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
        const isIndex = /<sitemapindex[\s>]/.test(xml) || locs.some((l) => l.endsWith(".xml"));
        if (isIndex) {
          const nested: string[] = [];
          for (const sub of locs.filter((l) => l.endsWith(".xml")).slice(0, 2)) {
            try {
              const r2 = await fetch(sub);
              if (!r2.ok) continue;
              const x2 = await r2.text();
              for (const m of x2.matchAll(/<loc>([^<]+)<\/loc>/g)) {
                const l2 = m[1].trim();
                if (!l2.endsWith(".xml")) nested.push(l2);
                if (nested.length >= config.MAX_SECTIONS) break;
              }
            } catch { /* one bad sub-sitemap skips */ }
            if (nested.length >= config.MAX_SECTIONS) break;
          }
          locs = nested;
        }
        for (const loc of locs.slice(0, config.MAX_SECTIONS)) {
          if (loc.endsWith(".xml")) continue; // never capture sitemap files themselves
          if (out.length >= config.MAX_SECTIONS) break;
          const c = canonical(loc, entryUrl);
          if (!c) continue;
          const u = new URL(c);
          if (u.origin !== origin) continue;
          if (SKIP_PATH.test(u.pathname) || SKIP_EXT.test(u.pathname)) continue;
          push({ name: nameFromPath(u.pathname), url: c, kind: "sitemap" });
        }
      }
    } catch { /* sitemap is best-effort */ }
  }

  return out.slice(0, config.MAX_SECTIONS);
}
