// Login field strategies — resilient discovery, human-like input, and
// post-submit signal detectors. Nothing here ever returns field VALUES;
// diagnostics carry selector kinds and counts only (credential hygiene).
import type { Page } from "playwright";

// Ordered: accessible selectors first (survive markup rewrites), CSS fallbacks after.
export const USER_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[id*="login" i]',
  'input[type="text"]',
];

export const PASS_SELECTOR = 'input[type="password"]';

export const MFA_MARKERS: RegExp[] = [
  /verific(ation|y) code/i,
  /one[-\s]?time (code|password)/i,
  /\botp\b/i,
  /authenticator/i,
  /two[-\s]?factor/i,
  /2[-\s]?step/i,
  /enter (the )?code/i,
  /6[-\s]?digit/i,
  /check your (phone|email)/i,
];

export const CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[name*="otp" i]',
  'input[name*="mfa" i]',
  'input[name*="code" i]',
];

export const LOCKOUT_MARKERS: RegExp[] = [
  /too many attempts/i,
  /account (is )?locked/i,
  /temporarily (locked|blocked|disabled)/i,
  /try again later/i,
  /suspicious (activity|sign-in)/i,
  /unusual (activity|sign-in)/i,
];

export const LOGGED_IN_MARKERS: RegExp[] = [
  /sign ?out/i,
  /log ?out/i,
  /my account/i,
  /account settings/i,
];

export const IDP_HOSTS: RegExp[] = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)gitlab\.com$/i,
  /okta\.com$/i,
  /auth0\.com$/i,
  /onelogin\.com$/i,
  /login\.yahoo\.com$/i,
];

const SUBMIT_BUTTON_NAMES = /sign in|log in|continue|next|submit|verify/i;

export interface PageSnapshot {
  html: string;
  title: string;
  url: string;
}

export async function snapshot(page: Page): Promise<PageSnapshot> {
  return {
    html: await page.content().catch(() => ""),
    title: await page.title().catch(() => ""),
    url: page.url(),
  };
}

function haystack(snap: PageSnapshot): string {
  return `${snap.title}\n${snap.html.slice(0, 200_000)}`;
}

export async function findField(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      if ((await page.locator(sel).count()) > 0) return sel;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Accessible-name lookup (label/placeholder/aria) before falling back to CSS. */
export async function findUserField(page: Page): Promise<string | null> {
  const roles: Array<{ name: RegExp }> = [
    { name: /^(email|e-mail|username|user name|login|login id|account)$/i },
    { name: /email address/i },
  ];
  for (const r of roles) {
    try {
      const loc = page.getByRole("textbox", { name: r.name });
      if ((await loc.count()) > 0) {
        // Resolve to a CSS selector via the element's id/name when possible.
        const handle = await loc.first().elementHandle().catch(() => null);
        const id = handle ? await handle.getAttribute("id").catch(() => null) : null;
        const name = handle ? await handle.getAttribute("name").catch(() => null) : null;
        if (id) return `#${id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1")}`;
        if (name) return `input[name="${name}"]`;
        return 'input[type="email"]';
      }
    } catch {
      /* try next */
    }
  }
  return findField(page, USER_SELECTORS);
}

/**
 * Human-like typing: key-by-key with a small delay (also triggers the JS
 * key listeners many frameworks need), falling back to fill. Returns false
 * when the field cannot be typed into. Never logs the text.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<boolean> {
  const loc = page.locator(selector).first();
  try {
    await loc.fill("", { timeout: 5000 });
    await loc.pressSequentially(text, { delay: 45, timeout: 20000 });
    return true;
  } catch {
    try {
      await loc.fill(text, { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }
}

/** Submit strategies in order; returns the strategy name used (for diagnostics). */
export async function submitForm(page: Page, passSelector: string | null): Promise<string> {
  // 1) Accessible submit button by name.
  try {
    const btn = page.getByRole("button", { name: SUBMIT_BUTTON_NAMES });
    if ((await btn.count()) > 0) {
      await btn.first().click({ timeout: 5000 });
      return "button-by-name";
    }
  } catch {
    /* next strategy */
  }
  // 2) CSS submit controls.
  try {
    const css = page.locator('button[type="submit"], input[type="submit"]');
    if ((await css.count()) > 0) {
      await css.first().click({ timeout: 5000 });
      return "button-css";
    }
  } catch {
    /* next strategy */
  }
  // 3) Enter key in the password field.
  if (passSelector) {
    try {
      await page.locator(passSelector).first().press("Enter", { timeout: 5000 });
      return "enter-key";
    } catch {
      /* next strategy */
    }
  }
  // 4) Native form submission.
  try {
    await page.evaluate(() => {
      const f = document.querySelector("form");
      if (f) {
        if (typeof (f as HTMLFormElement).requestSubmit === "function") (f as HTMLFormElement).requestSubmit();
        else (f as HTMLFormElement).submit();
      }
    });
    return "form-submit";
  } catch {
    return "none";
  }
}

/** True when the page asks for a second-factor code. */
export function detectMfa(snap: PageSnapshot): { mfa: boolean; signals: string[] } {
  const signals: string[] = [];
  const hay = haystack(snap);
  if (MFA_MARKERS.some((re) => re.test(hay))) signals.push("mfa-text");
  return { mfa: signals.length > 0, signals };
}

/** True when the account/rate-limit wall blocks further attempts. */
export function detectLockout(snap: PageSnapshot): boolean {
  return LOCKOUT_MARKERS.some((re) => re.test(haystack(snap)));
}

/** Strip leading www./m. so redirect variants don't read as SSO hops. */
function normalizeHost(host: string): string {
  return host.replace(/^(www\.|m\.)/, "");
}

/** Last-two-labels heuristic: subdomains of the SAME site are not SSO. */
function baseDomain(host: string): string {
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

/**
 * SSO detection: after submit the browser left the entry site for a known
 * identity-provider host (or any different registrable domain on an auth
 * path). Normalized hosts and same-base-domain subdomains do NOT count
 * (www./m./<sub>.site variants are ordinary redirects). Returns the new
 * host, or null. Hostnames only — never URLs with tokens.
 */
export function detectSsoRedirect(pageUrl: string, entryHostname: string): string | null {
  let host = "";
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  if (normalizeHost(host) === normalizeHost(entryHostname.toLowerCase())) return null;
  if (IDP_HOSTS.some((re) => re.test(host))) return host;
  if (baseDomain(host) === baseDomain(normalizeHost(entryHostname.toLowerCase()))) return null;
  let path = "";
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    /* no path check */
  }
  if (/\/(saml|oauth|authorize|sign-?in|sso)/i.test(path)) return host;
  return null;
}

/** Logged-in DOM signals (used together with "password field gone"). */
export function loggedInSignals(snap: PageSnapshot): boolean {
  return LOGGED_IN_MARKERS.some((re) => re.test(haystack(snap)));
}
