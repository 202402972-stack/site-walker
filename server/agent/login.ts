// Credential auto-login orchestrator — multi-step, multi-strategy, bounded.
//
// A login is a LOOP, not a single fill: username-only first screens, password
// on the second screen, code-only second factors, SSO hops to identity
// providers, lockout walls, and bot challenges each get an explicit branch
// with a labeled outcome. Rounds are capped and the whole attempt is
// deadline-bounded, so a weird page can never hang a job.
//
// Challenge policy (firm): full-page challenge interstitials are classified
// and, when "managed", given a bounded self-clear wait. Challenge WIDGETS
// embedded in the site's own form never stop the run — the agent fills the
// site's fields and presses the site's button, but never ticks, solves, or
// bypasses the widget itself. Both outcomes are honest: reported, not faked.
//
// Credential hygiene: this module receives the password as an argument and
// never puts it — or any field VALUE — into results, trail entries, or
// errors. Only selector kinds, counts, strategy names, and signal names are
// recorded. Enforcement: tests/server/login.test.ts.
import type { Page } from "playwright";
import { config } from "../config.js";
import {
  PASS_SELECTOR,
  CODE_INPUT_SELECTORS,
  findField,
  findUserField,
  humanType,
  submitForm,
  detectMfa,
  detectLockout,
  detectSsoRedirect,
  loggedInSignals,
  snapshot,
} from "./login/forms.js";
import { classifyBlocker, waitForManagedClear } from "./login/challenges.js";
import { detectChallenge, detectEmbeddedWidget } from "./login/markers.js";

export { detectChallenge };

export interface LoginCreds {
  username: string;
  password: string;
}

export type LoginCode =
  | "LOGIN_NO_FORM"
  | "LOGIN_FAILED"
  | "MFA_REQUIRED"
  | "SSO_REDIRECT"
  | "LOGIN_BLOCKED"
  | "BOT_CHALLENGE";

export interface LoginResult {
  ok: boolean;
  code?: LoginCode;
  /** Human-readable reason. Never contains credentials or field values. */
  detail: string;
  /** Cred-free diagnostic trail (selector kinds, strategy names, signals). */
  trail: string[];
}

export interface LoginOptions {
  /** Hostname of the TARGET site — SSO hops are judged against it. */
  entryHostname?: string;
  /** Overall budget in ms. Defaults to 100s. */
  budgetMs?: number;
  /** Max form submits across all rounds. Defaults to 3. */
  maxSubmits?: number;
  /** Budget for a managed interstitial to clear itself. Defaults to 30s. */
  managedClearMs?: number;
}

const DEFAULT_BUDGET_MS = 100_000;
const DEFAULT_MAX_SUBMITS = 3;
const DEFAULT_MANAGED_CLEAR_MS = 30_000;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(2500);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: config.NAV_WAIT_MS });
  } catch {
    /* proceed with what rendered */
  }
}

export async function attemptLogin(
  page: Page,
  creds: LoginCreds,
  opts: LoginOptions = {},
): Promise<LoginResult> {
  const trail: string[] = [];
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const maxSubmits = opts.maxSubmits ?? DEFAULT_MAX_SUBMITS;
  const managedClearMs = opts.managedClearMs ?? DEFAULT_MANAGED_CLEAR_MS;
  let submits = 0;
  let embeddedSeen = false;
  let entryHostname = opts.entryHostname ?? "";
  try {
    entryHostname = entryHostname || new URL(page.url()).hostname;
  } catch {
    entryHostname = "";
  }

  const fail = (code: LoginCode, detail: string): LoginResult => ({ ok: false, code, detail, trail });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      return fail("LOGIN_FAILED", `login budget exhausted after ${submits} submit(s)`);
    }
    const snap = await snapshot(page);

    // 1) SSO hop: the browser ended up on another site's identity provider.
    if (entryHostname) {
      const ssoHost = detectSsoRedirect(snap.url, entryHostname);
      if (ssoHost) {
        trail.push(`sso:${ssoHost}`);
        return fail("SSO_REDIRECT", `login handed off to external provider ${ssoHost} — SSO round-trips are unsupported`);
      }
    }

    // 2) Full-page challenge interstitial — classify and wait/report.
    const kind = classifyBlocker(snap.html, snap.title);
    if (kind) {
      trail.push(`challenge:blocker:${kind}`);
      if (kind === "managed") {
        const cleared = await waitForManagedClear(page, managedClearMs);
        trail.push(cleared ? "challenge:managed-cleared" : "challenge:managed-persisted");
        if (!cleared) {
          return fail("BOT_CHALLENGE", "bot challenge (Cloudflare-style) needs a human — reported, not bypassed");
        }
        continue;
      }
      return fail(
        "BOT_CHALLENGE",
        kind === "hard"
          ? "interactive image challenge needs a human — reported, not bypassed"
          : "checkbox verification needs a human — not auto-clicked by policy",
      );
    }

    // 3) A widget embedded in the site's own page never blocks the run — but
    // it is recorded, and it is never touched by us.
    if (!embeddedSeen && detectEmbeddedWidget(snap.html, snap.title)) {
      embeddedSeen = true;
      trail.push("challenge:embedded-recording");
    }

    // 4) Lockout / rate-limit wall — pointless (and harmful) to push through.
    if (detectLockout(snap)) {
      trail.push("lockout-detected");
      return fail("LOGIN_BLOCKED", "account or IP is throttled/locked — further attempts would make it worse");
    }

    // 5) Field discovery across the whole matrix of login-page shapes.
    const userSel = await findUserField(page);
    const passSel = await findField(page, [PASS_SELECTOR]);
    const codeSel = await findField(page, CODE_INPUT_SELECTORS);
    const hasUser = userSel !== null;
    const hasPass = passSel !== null;
    trail.push(`fields:user=${hasUser ? "yes" : "no"} pass=${hasPass ? "yes" : "no"} code=${codeSel ? "yes" : "no"}`);

    // 6) No recognizable fields → sort the end states.
    if (!hasUser && !hasPass) {
      if (loggedInSignals(snap)) {
        trail.push("signals:logged-in");
        return { ok: true, detail: "signed in (no login form, account signals present)", trail };
      }
      if (codeSel || detectMfa(snap).mfa) {
        trail.push(codeSel ? "mfa:code-input" : "mfa:code-screen");
        return fail("MFA_REQUIRED", "second-factor screen (code/approval) — needs the account owner, unsupported");
      }
      // A submitted login normally dissolves the form (redirect, dashboard).
      // With no challenge/MFA/lockout/SSO anywhere, that is success; an
      // untouched page with no form was simply the wrong page.
      if (submits > 0) {
        trail.push("signals:form-dissolved");
        return { ok: true, detail: `form submitted (${submits}x), no login form remains`, trail };
      }
      return fail("LOGIN_NO_FORM", "no username+password form found on the login page");
    }

    // 7) Second-factor walls: a code input without a password (any time), or
    // a code input still present after credentials were already submitted.
    if (codeSel && (!hasPass || submits > 0)) {
      trail.push("mfa:code-input");
      return fail("MFA_REQUIRED", "second-factor code requested (OTP/authenticator) — unsupported, needs the account owner");
    }

    // 8) Cap: still facing a login form after N submits = wrong credentials
    // or an extra step we do not invent.
    if (submits >= maxSubmits) {
      return fail("LOGIN_FAILED", `still on a login form after ${submits} submit(s) — wrong credentials or an extra step?`);
    }

    // 9) Fill what is present: username-only first screens are as normal as
    // user+password screens — each round fills exactly what the page asks.
    if (hasUser && userSel) {
      if (!(await humanType(page, userSel, creds.username))) {
        return fail("LOGIN_FAILED", "username field present but not typeable");
      }
      trail.push("filled:username");
    }
    if (hasPass && passSel) {
      if (!(await humanType(page, passSel, creds.password))) {
        return fail("LOGIN_FAILED", "password field present but not typeable");
      }
      trail.push("filled:password");
    }
    const strategy = await submitForm(page, passSel);
    submits++;
    trail.push(`submit:${strategy}#${submits}`);
    await settle(page);
  }
}
