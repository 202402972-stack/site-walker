// Credential auto-login — fills a plain username+password form in the same
// browser context, then capture proceeds with the resulting session.
//
// What this is NOT:
// - Not a Google/SSO/MFA solver. The mechanism is generic form-fill; providers
//   that challenge automation (Google "suspicious sign-in", OTP, passkeys) will
//   fail and the job reports it — see BOT_CHALLENGE / LOGIN_FAILED.
// - Not a CAPTCHA/Cloudflare bypass. Challenge pages are DETECTED (markers
//   below), given a bounded wait in case a "managed" challenge auto-clears,
//   then reported with code BOT_CHALLENGE. Nothing is solved or defeated.
// - The password must never reach logs or disk — callers log only codes and
//   the username. Enforcement is tested in tests/server/login.test.ts.
import type { Page } from "playwright";
import { config } from "../config.js";

export interface LoginCreds {
  username: string;
  password: string;
}

export interface LoginResult {
  ok: boolean;
  code?: "LOGIN_NO_FORM" | "LOGIN_FAILED" | "BOT_CHALLENGE";
  /** Human-readable reason. Must never contain credentials. */
  detail: string;
}

// Markers of bot-challenge pages (Cloudflare, Turnstile, CAPTCHA vendors).
// Page text only — used to REPORT, never to interact with the challenge.
export const CHALLENGE_MARKERS: RegExp[] = [
  /cf-turnstile/i,
  /g-recaptcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /cloudflare/i,
  /verify you are human/i,
  /attention required/i,
  /are you a robot/i,
  /captcha/i,
  /just a moment/i,
];

const USER_SELECTORS = [
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[id*="login" i]',
  'input[type="text"]',
];

const PASS_SELECTOR = 'input[type="password"]';

export function detectChallenge(html: string, title: string): boolean {
  const hay = `${title}\n${html.slice(0, 200_000)}`;
  return CHALLENGE_MARKERS.some((re) => re.test(hay));
}

async function firstPresent(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      if ((await page.locator(sel).count()) > 0) return sel;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function attemptLogin(page: Page, creds: LoginCreds): Promise<LoginResult> {
  const userSel = await firstPresent(page, USER_SELECTORS);
  const passSel = await firstPresent(page, [PASS_SELECTOR]);
  if (!userSel || !passSel) {
    return { ok: false, code: "LOGIN_NO_FORM", detail: "no username+password form found on the login page" };
  }
  await page.fill(userSel, creds.username);
  await page.fill(passSel, creds.password);
  const submit = page.locator('button[type="submit"], input[type="submit"]');
  try {
    if ((await submit.count()) > 0) await submit.first().click({ timeout: 5000 });
    else await page.locator(passSel).press("Enter");
  } catch {
    /* fall through to the post-submit checks */
  }
  await page.waitForTimeout(3000);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: config.NAV_WAIT_MS });
  } catch {
    /* proceed with what rendered */
  }

  const html = await page.content().catch(() => "");
  const title = await page.title().catch(() => "");
  if (detectChallenge(html, title)) {
    // Bounded wait only — managed challenges sometimes auto-clear in a real
    // browser. Nothing is solved; a persistent challenge is reported.
    await page.waitForTimeout(15000);
    const html2 = await page.content().catch(() => "");
    const title2 = await page.title().catch(() => "");
    if (detectChallenge(html2, title2)) {
      return {
        ok: false,
        code: "BOT_CHALLENGE",
        detail: "bot challenge (CAPTCHA/Cloudflare) needs a human — reported, not bypassed",
      };
    }
  }

  let passGone = false;
  try {
    passGone = (await page.locator(PASS_SELECTOR).count()) === 0;
  } catch {
    /* treat as not-logged-in */
  }
  if (passGone) return { ok: true, detail: "form submitted, password field gone" };
  return {
    ok: false,
    code: "LOGIN_FAILED",
    detail: "form submitted but still on a login form (wrong credentials, MFA/extra step, or provider block?)",
  };
}
