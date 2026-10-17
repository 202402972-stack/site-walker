// Credential auto-login orchestrator v3 — frame-aware, multi-step, bounded.
//
// A login is a LOOP, not a single fill: username-only first screens, password
// on the second screen, code-only second factors, SSO hops to identity
// providers, lockout walls, and bot challenges each get an explicit branch
// with a labeled outcome. Rounds are capped and the whole attempt is
// deadline-bounded, so a weird page can never hang a job.
//
// v3 hardening over v2:
//   - fields are discovered across ALL frames (embedded iframe logins work)
//   - challenge/signal detection sees through open shadow DOM and frames
//   - post-submit settle is adaptive: URL change / password field appearing or
//     disappearing ends the wait early instead of sleeping a fixed time
//   - interactions are human-ish (mouse path + jitter before clicks, key-by-key
//     typing) — which also reduces the odds of tripping anti-bot heuristics
//
// Challenge policy (firm): full-page challenge interstitials are classified
// and, when "managed", given a bounded self-clear wait with gentle pointer
// activity. Challenge WIDGETS embedded in the site's own form never stop the
// run — the agent fills the site's fields and presses the site's button, but
// never ticks, solves, or bypasses the widget itself. Both outcomes are
// honest: reported, not faked.
//
// Credential hygiene: this module receives the password as an argument and
// never puts it — or any field VALUE — into results, trail entries, or
// errors. Only selector kinds, counts, frame indexes, strategy names, and
// signal names are recorded. Enforcement: tests/server/login.test.ts.
import type { Page } from "playwright";
import { config } from "../config.js";
import {
  PASS_SELECTOR,
  CODE_INPUT_SELECTORS,
  detectLockout,
  detectMfa,
  detectSsoRedirect,
  humanType,
  loggedInSignals,
  submitForm,
  type PageSnapshot,
} from "./login/forms.js";
import {
  countPasswordFields,
  findFieldInFrames,
  findUserFieldInFrames,
  frameSnapshots,
  type FieldTarget,
} from "./login/frames.js";
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
  /** Cred-free diagnostic trail (selectors kinds, frames, strategies, signals). */
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
const SETTLE_HARD_MS = 12_000;
const SETTLE_QUIET_EXIT_MS = 3_500;

/**
 * Adaptive settle after a submit: return as soon as the page shows a real
 * change (URL navigated, or the password-field count changed — form vanished
 * into a dashboard or a second screen appeared). If nothing structural moves,
 * exit after a short quiet period instead of burning the whole budget.
 */
async function settleAfterSubmit(page: Page, urlBefore: string, passBefore: number): Promise<void> {
  const start = Date.now();
  await page.waitForTimeout(600);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(config.NAV_WAIT_MS, 8000) });
  } catch {
    /* proceed with what rendered */
  }
  while (Date.now() - start < SETTLE_HARD_MS) {
    if (page.url() !== urlBefore) return; // real navigation happened
    let passNow = passBefore;
    try {
      passNow = await countPasswordFields(page);
    } catch {
      return; // frames detached mid-check — treat as changed
    }
    if (passNow !== passBefore) return; // form dissolved or a new form appeared
    if (Date.now() - start >= SETTLE_QUIET_EXIT_MS) return; // nothing structural — move on
    await page.waitForTimeout(400);
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
  const tag = (t: FieldTarget | null): string => (t ? `yes@f${t.frameIndex}` : "no");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      return fail("LOGIN_FAILED", `login budget exhausted after ${submits} submit(s)`);
    }

    // Aggregated view across frames + shadow DOM for every detector below.
    const snaps = await frameSnapshots(page);
    const main = snaps.find((s) => s.isMain) ?? snaps[0];
    const virt: PageSnapshot = {
      html: snaps.map((s) => s.html).join("\n"),
      title: main?.title ?? "",
      url: main?.url ?? page.url(),
    };

    // 1) SSO hop: the browser ended up on another site's identity provider.
    if (entryHostname) {
      const ssoHost = detectSsoRedirect(virt.url, entryHostname);
      if (ssoHost) {
        trail.push(`sso:${ssoHost}`);
        return fail("SSO_REDIRECT", `login handed off to external provider ${ssoHost} — SSO round-trips are unsupported`);
      }
    }

    // 2) Full-page challenge interstitial — classify and wait/report. Blockers
    // are checked in every frame; the wait adds gentle pointer activity.
    let blockerKind = null as ReturnType<typeof classifyBlocker>;
    let blockerFrame = -1;
    for (const s of snaps) {
      const k = classifyBlocker(s.html, s.title);
      if (k) {
        blockerKind = k;
        blockerFrame = s.index;
        break;
      }
    }
    if (blockerKind) {
      trail.push(`challenge:blocker:${blockerKind}${blockerFrame > 0 ? `@f${blockerFrame}` : ""}`);
      if (blockerKind === "managed") {
        const cleared = await waitForManagedClear(page, managedClearMs);
        trail.push(cleared ? "challenge:managed-cleared" : "challenge:managed-persisted");
        if (!cleared) {
          return fail("BOT_CHALLENGE", "bot challenge (Cloudflare-style) needs a human — reported, not bypassed");
        }
        continue;
      }
      return fail(
        "BOT_CHALLENGE",
        blockerKind === "hard"
          ? "interactive image challenge needs a human — reported, not bypassed"
          : "checkbox verification needs a human — not auto-clicked by policy",
      );
    }

    // 3) A widget embedded in the site's own page never blocks the run — but
    // it is recorded, and it is never touched by us.
    if (!embeddedSeen && snaps.some((s) => detectEmbeddedWidget(s.html, s.title))) {
      embeddedSeen = true;
      trail.push("challenge:embedded-recording");
    }

    // 4) Lockout / rate-limit wall — pointless (and harmful) to push through.
    if (detectLockout(virt)) {
      trail.push("lockout-detected");
      return fail("LOGIN_BLOCKED", "account or IP is throttled/locked — further attempts would make it worse");
    }

    // 5) Frame-aware field discovery across the whole matrix of login shapes.
    const userT = await findUserFieldInFrames(page);
    const passT = await findFieldInFrames(page, [PASS_SELECTOR]);
    const codeT = await findFieldInFrames(page, CODE_INPUT_SELECTORS);
    trail.push(`fields:user=${tag(userT)} pass=${tag(passT)} code=${tag(codeT)}`);

    // 6) No recognizable fields → sort the end states.
    if (!userT && !passT) {
      if (loggedInSignals(virt)) {
        trail.push("signals:logged-in");
        return { ok: true, detail: "signed in (no login form, account signals present)", trail };
      }
      if (codeT || detectMfa(virt).mfa) {
        trail.push(codeT ? "mfa:code-input" : "mfa:code-screen");
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
    if (codeT && (!passT || submits > 0)) {
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
    if (userT) {
      if (!(await humanType(userT.frame, userT.selector, creds.username))) {
        return fail("LOGIN_FAILED", "username field present but not typeable");
      }
      trail.push(`filled:username${userT.frameIndex > 0 ? `@f${userT.frameIndex}` : ""}`);
    }
    if (passT) {
      if (!(await humanType(passT.frame, passT.selector, creds.password))) {
        return fail("LOGIN_FAILED", "password field present but not typeable");
      }
      trail.push(`filled:password${passT.frameIndex > 0 ? `@f${passT.frameIndex}` : ""}`);
    }

    // 10) Submit in the same frame as the fields first (embedded forms post
    // from inside their iframe); the strategies fall back to native submit.
    const submitScope = passT?.frame ?? userT?.frame ?? page;
    const urlBefore = page.url();
    const passBefore = await countPasswordFields(page).catch(() => 0);
    const strategy = await submitForm(submitScope, passT?.selector ?? null);
    submits++;
    trail.push(`submit:${strategy}#${submits}`);
    await settleAfterSubmit(page, urlBefore, passBefore);
  }
}
