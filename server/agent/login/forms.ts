// Login field strategies — resilient discovery, human-like input, and
// post-submit signal detectors. Anything here can be scoped to a Page or a
// Frame, so the same strategies work inside iframes.
//
// Nothing here ever returns field VALUES; diagnostics carry selector kinds and
// counts only (credential hygiene). Multilingual markers are intentionally
// conservative (specific phrases, never single short words) to avoid false
// positives on ordinary pages.
import type { Frame, Locator, Page } from "playwright";

export type Scope = Page | Frame;

// Ordered: semantic-input types and accessible attributes first (survive
// markup rewrites), then name/id patterns, then last-resort bare text inputs.
export const USER_SELECTORS = [
  'input[type="email"]',
  'input[type="tel"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="tel"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[name*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[id*="login" i]',
  'input[id*="phone" i]',
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
  // Arabic / French / German / Spanish / Dutch
  /رمز (التحقق|التأكيد|الدخول)/,
  /التحقق بخطوتين/,
  /code de vérification/i,
  /vérification en deux étapes/i,
  /Bestätigungscode/i,
  /código de verificación/i,
  /verificatiecode/i,
];

export const CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[name*="otp" i]',
  'input[name*="mfa" i]',
  'input[name*="code" i]',
  'input[name*="token" i]',
  'input[name*="pin" i]',
];

export const LOCKOUT_MARKERS: RegExp[] = [
  /too many attempts/i,
  /account (is )?locked/i,
  /temporarily (locked|blocked|disabled)/i,
  /try again later/i,
  /suspicious (activity|sign-in)/i,
  /unusual (activity|sign-in)/i,
  // Arabic / French / German / Spanish
  /محاولات (كثيرة|عديدة)/,
  /تم قفل/,
  /حظر مؤقت/,
  /trop de tentatives/i,
  /zu viele Versuche/i,
  /cuenta (bloqueada|suspendida)/i,
];

export const LOGGED_IN_MARKERS: RegExp[] = [
  /sign ?out/i,
  /log ?out/i,
  /my account/i,
  /account settings/i,
  // Arabic / French / German
  /تسجيل (الخروج|خروج)/,
  /حسابي/,
  /déconnexion/i,
  /abmelden/i,
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
  /(^|\.)amazon\.com$/i,
];

// Submit controls by accessible name. Multilingual on purpose: a form's
// button is the single most likely element to differ across locales.
const SUBMIT_BUTTON_NAMES =
  /sign in|sign-in|log in|log-in|log on|continue|next|submit|verify|enter|unlock|access|دخول|تسجيل|متابعة|connexion|continuer|se connecter|anmelden|weiter|iniciar sesión|acceder/i;

export interface PageSnapshot {
  html: string;
  title: string;
  url: string;
}

export async function snapshot(scope: Scope): Promise<PageSnapshot> {
  const html = await scope.content().catch(() => "");
  const title = await scope.title().catch(() => "");
  const url = typeof (scope as Page).url === "function" ? (scope as Page).url() : (scope as Frame).url();
  return { html, title, url };
}

function haystack(snap: PageSnapshot): string {
  return `${snap.title}\n${snap.html.slice(0, 200_000)}`;
}

export async function findField(scope: Scope, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      if ((await scope.locator(sel).count()) > 0) return sel;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Accessible-name lookup (label/placeholder/aria) before falling back to CSS. */
export async function findUserField(scope: Scope): Promise<string | null> {
  const roles: Array<{ name: RegExp }> = [
    { name: /^(email|e-mail|username|user name|login|login id|account|phone|phone number|mobile|email or phone)$/i },
    { name: /email address/i },
    { name: /(ة|رقم الهاتف|البريد الإلكتروني|اسم المستخدم)/ },
  ];
  for (const r of roles) {
    try {
      const loc = scope.getByRole("textbox", { name: r.name });
      if ((await loc.count()) > 0) {
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
  return findField(scope, USER_SELECTORS);
}

/**
 * Human-like typing: focus by clicking the field (like a person would), clear
 * it, then type key-by-key with a small delay (triggers the JS key listeners
 * many frameworks need), falling back to fill. Returns false when the field
 * cannot be typed into. Never logs the text.
 */
export async function humanType(scope: Scope, selector: string, text: string): Promise<boolean> {
  const loc = scope.locator(selector).first();
  try {
    await loc.click({ timeout: 4000 }).catch(() => loc.focus({ timeout: 2000 }).catch(() => {}));
    await loc.fill("", { timeout: 5000 });
    await loc.pressSequentially(text, { delay: 45, timeout: 20_000 });
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

/**
 * Human-ish click: move the mouse toward the element in a couple of steps with
 * a small jitter and pause before pressing. Some sites' widgets only arm after
 * genuine pointer movement over them.
 */
export async function humanClick(scope: Scope, loc: Locator): Promise<boolean> {
  try {
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 2 && box.height > 2) {
      const target = {
        x: box.x + box.width / 2 + (Math.random() - 0.5) * Math.min(16, box.width * 0.2),
        y: box.y + box.height / 2 + (Math.random() - 0.5) * Math.min(8, box.height * 0.2),
      };
      const page: Page = typeof (scope as Frame).page === "function" ? (scope as Frame).page() : (scope as Page);
      await page.mouse.move(target.x - 24 - Math.random() * 12, target.y - 14 - Math.random() * 8, { steps: 2 }).catch(() => {});
      await page.mouse.move(target.x, target.y, { steps: 4 }).catch(() => {});
      await page.waitForTimeout(40 + Math.random() * 80);
      await loc.click({ timeout: 5000, delay: 10 + Math.random() * 25 });
      return true;
    }
    await loc.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Submit strategies in order; returns the strategy name used (for diagnostics). */
export async function submitForm(scope: Scope, passSelector: string | null): Promise<string> {
  // 1) Accessible submit button by name (covers <div role="button"> widgets).
  try {
    const btn = scope.getByRole("button", { name: SUBMIT_BUTTON_NAMES });
    if ((await btn.count()) > 0) {
      if (await humanClick(scope, btn.first())) return "button-by-name";
    }
  } catch {
    /* next strategy */
  }
  // 2) CSS submit controls, including image submits.
  try {
    const css = scope.locator('button[type="submit"], input[type="submit"], input[type="image"]');
    if ((await css.count()) > 0) {
      if (await humanClick(scope, css.first())) return "button-css";
    }
  } catch {
    /* next strategy */
  }
  // 3) Any button-ish control whose text looks like a submit (div/a widgets).
  try {
    const any = scope.locator('button, [role="button"], a.btn, a.button, a[href="#"]');
    if ((await any.count()) > 0) {
      const txt = await any.first().innerText().catch(() => "");
      if (SUBMIT_BUTTON_NAMES.test(txt)) {
        if (await humanClick(scope, any.first())) return "button-text";
      }
    }
  } catch {
    /* next strategy */
  }
  // 4) Enter key in the password field.
  if (passSelector) {
    try {
      await scope.locator(passSelector).first().press("Enter", { timeout: 5000 });
      return "enter-key";
    } catch {
      /* next strategy */
    }
  }
  // 5) Native form submission.
  try {
    await scope.evaluate(() => {
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
