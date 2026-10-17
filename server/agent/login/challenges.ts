// Bot-challenge handling — classify blockers precisely, wait only for what
// clears itself, REPORT everything else. Nothing here clicks a challenge
// checkbox, picks images, or extracts tokens: an agent asserting "I am human"
// would be a false attestation, and image/CAPTCHA solving is an arms race we
// refuse. The honest best effort is: (1) exact classification, (2) a bounded
// wait for managed challenges that auto-clear in a real browser, (3) a
// labeled code (`BOT_CHALLENGE`) — never a faked success.
import type { Page } from "playwright";
import { detectBlocker } from "./markers.js";

/** Shape of a full-page blocker. null = not a blocker. */
export type BlockerKind = "hard" | "interactive" | "managed";

const HARD_MARKERS: RegExp[] = [
  /select all images/i,
  /image challenge/i,
  /select all (squares|cars|buses|traffic)/i,
  /click (all|on) the/i,
];

const INTERACTIVE_MARKERS: RegExp[] = [
  /tick the box/i,
  /check the box/i,
  /confirm you'?re not a robot/i,
  /to continue, complete/i,
];

export function classifyBlocker(html: string, title: string): BlockerKind | null {
  if (!detectBlocker(html, title)) return null;
  const hay = `${title}\n${html.slice(0, 200_000)}`;
  if (HARD_MARKERS.some((re) => re.test(hay))) return "hard";
  if (INTERACTIVE_MARKERS.some((re) => re.test(hay))) return "interactive";
  return "managed";
}

/**
 * Bounded wait for a managed blocker to clear itself (Cloudflare "Just a
 * moment…" spinners and server-check interstitials usually resolve without
 * input in a real browser). Polls every `pollMs` up to `budgetMs`. Returns
 * true when the blocker markers are gone.
 */
export async function waitForManagedClear(
  page: Page,
  budgetMs = 30_000,
  pollMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    let html = "";
    let title = "";
    try {
      html = await page.content();
      title = await page.title();
    } catch {
      return false;
    }
    if (!detectBlocker(html, title)) return true;
  }
  return false;
}
