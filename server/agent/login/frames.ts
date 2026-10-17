// Frame-aware page introspection — because real login forms are not always in
// the main document:
//   - inside same- or cross-origin IFRAMES (embedded SSO, payment-style logins)
//   - inside open SHADOW DOM (web-component forms; page.content() does not
//     include shadow content, so challenge/signal detection gets a deep-text
//     pass that walks shadow roots and iframes)
//
// All functions are read-only probes. Field VALUES are never read; discovery
// only reports whether a selector matched (and in which frame).
import type { Frame, Page } from "playwright";
import { findField, findUserField, USER_SELECTORS, PASS_SELECTOR, type Scope } from "./forms.js";

export interface FrameSnapshot {
  html: string;
  title: string;
  url: string;
  /** 0 = main frame, then in Playwright's frame order. */
  index: number;
  isMain: boolean;
}

export interface FieldTarget {
  frame: Frame;
  selector: string;
  /** 0 = main frame; >0 must be surfaced in diagnostics. */
  frameIndex: number;
}

export const MAX_FRAMES = 8;

/**
 * Rendered text of a scope, INCLUDING open shadow roots. innerText alone
 * misses shadow content; we collect it by walking every element's shadowRoot.
 * Bounded to avoid pathological pages.
 */
export async function deepText(scope: Scope): Promise<string> {
  try {
    return (await scope.evaluate(() => {
      const out: string[] = [];
      const body = document.body ?? document.documentElement;
      if (body) out.push((body as HTMLElement).innerText ?? "");
      let seen = 0;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length && seen < 2000; i++) {
        const root = (all[i] as HTMLElement).shadowRoot;
        if (root) {
          seen++;
          out.push((root as unknown as HTMLElement).textContent ?? "");
        }
      }
      return out.join("\n").slice(0, 200_000);
    })) as string;
  } catch {
    return "";
  }
}

/**
 * Snapshots of every frame (capped), with shadow-DOM text appended to the main
 * frame's html so challenge/signal detection can see through components.
 * Frame markup is included as raw html plus its visible text.
 */
export async function frameSnapshots(page: Page): Promise<FrameSnapshot[]> {
  const frames = page.frames().slice(0, MAX_FRAMES);
  const out: FrameSnapshot[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const html = await f.content().catch(() => "");
    let title = "";
    try {
      title = i === 0 ? await page.title().catch(() => "") : await f.title().catch(() => "");
    } catch {
      title = "";
    }
    let text = "";
    if (i === 0) {
      text = await deepText(f);
    } else {
      text = await f
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
    }
    out.push({
      html: `${html}\n${text}`.slice(0, 200_000),
      title,
      url: f.url(),
      index: i,
      isMain: i === 0,
    });
  }
  return out;
}

/**
 * Frame-aware field discovery: the main frame is checked first (fast path for
 * the vast majority of logins), then each other frame in order. The first
 * frame containing a match wins — user/password fields are expected to live
 * together, which is how virtually every login frame is built.
 */
export async function findFieldInFrames(page: Page, selectors: string[]): Promise<FieldTarget | null> {
  const frames = page.frames().slice(0, MAX_FRAMES);
  for (let i = 0; i < frames.length; i++) {
    const selector = await findField(frames[i], selectors);
    if (selector) return { frame: frames[i], selector, frameIndex: i };
  }
  return null;
}

/** Same, but with the accessible-name probing used for username fields. */
export async function findUserFieldInFrames(page: Page): Promise<FieldTarget | null> {
  const frames = page.frames().slice(0, MAX_FRAMES);
  for (let i = 0; i < frames.length; i++) {
    const selector = await findUserField(frames[i]);
    if (selector) return { frame: frames[i], selector, frameIndex: i };
  }
  return null;
}

export { USER_SELECTORS, PASS_SELECTOR };

/** Count password fields across all frames — used by the adaptive settle. */
export async function countPasswordFields(page: Page): Promise<number> {
  let n = 0;
  for (const f of page.frames().slice(0, MAX_FRAMES)) {
    try {
      n += await f.locator(PASS_SELECTOR).count();
    } catch {
      /* frame detached mid-count — treat as zero */
    }
  }
  return n;
}
