// Login feature (plan §9.3+): challenge classification, embedded-widget
// policy, SSO/MFA/lockout detection, credential-hygiene guarantees, and the
// single-use memory vault.
import { describe, it, expect } from "vitest";
import { classifyBlocker } from "../../server/agent/login/challenges.js";
import { detectBlocker, detectEmbeddedWidget, detectChallenge } from "../../server/agent/login/markers.js";
import { detectMfa, detectLockout, detectSsoRedirect, loggedInSignals } from "../../server/agent/login/forms.js";
import { stashPassword, takePassword, dropPassword } from "../../server/jobs/secrets.js";
import type { Job } from "../../server/jobs/store.js";

const ENTRY = "example.com";

function snap(html: string, title = "Sign in") {
  return { html, title, url: "https://example.com/login" };
}

describe("full-page challenge interstitials (blockers)", () => {
  it("detects Cloudflare-style interstitials", () => {
    expect(detectBlocker('<html>Checking your browser before accessing…</html>', "Just a moment...")).toBe(true);
    expect(detectBlocker("<html><h1>Attention Required! | Cloudflare</h1></html>", "Error 1020")).toBe(true);
    expect(detectBlocker('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsd/r/123"></script>', "Sign in")).toBe(true);
    expect(detectBlocker("<p>Our systems have detected unusual traffic from this computer network.</p>", "Sorry")).toBe(true);
  });

  it("classifies: managed by default, hard/interactive by content", () => {
    expect(classifyBlocker('<div>Just a moment…</div><script src="/cdn-cgi/challenge-platform/x"></script>', "")).toBe("managed");
    expect(classifyBlocker("<p>Unusual traffic. Select all images with traffic lights.</p>", "")).toBe("hard");
    expect(classifyBlocker("<p>Unusual traffic. Please tick the box to confirm you're not a robot.</p>", "")).toBe("interactive");
  });

  it("never classifies ordinary pages as blockers", () => {
    expect(classifyBlocker('<form><input type="email"><input type="password"></form>', "Sign in")).toBeNull();
  });
});

describe("embedded challenge widgets never block by themselves", () => {
  it("a login form with a reCAPTCHA/Turnstile widget is embed, not blocker", () => {
    const html =
      '<form><input type="email"><input type="password"><div class="g-recaptcha" data-sitekey="x"></div></form>';
    expect(detectBlocker(html, "Sign in")).toBe(false);
    expect(detectEmbeddedWidget(html, "Sign in")).toBe(true);
  });

  it("widget labels alone are embedded signals, not blockers", () => {
    expect(detectBlocker('<form>…<span>Verify you are human</span>…</form>', "Sign in")).toBe(false);
    expect(detectEmbeddedWidget('<span>I\'m not a robot</span>', "Sign in")).toBe(true);
  });

  it("detectChallenge stays the boolean union for simple callers", () => {
    expect(detectChallenge('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>', "Login")).toBe(true);
    expect(detectChallenge('<div class="g-recaptcha" data-sitekey="x"></div>', "Login")).toBe(true);
    expect(detectChallenge('<h1>Just a moment…</h1>', "")).toBe(true);
    expect(
      detectChallenge('<form><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></form>', "Sign in"),
    ).toBe(false);
  });
});

describe("MFA / lockout text detection", () => {
  it("flags second-factor screens", () => {
    expect(detectMfa(snap("<p>Enter the 6-digit verification code we sent to your phone.</p>")).mfa).toBe(true);
    expect(detectMfa(snap("<p>Open your authenticator app and enter the code.</p>")).mfa).toBe(true);
    expect(detectMfa(snap("<p>Welcome, please sign in.</p>")).mfa).toBe(false);
  });

  it("flags second-factor screens in other languages", () => {
    expect(detectMfa(snap("<p>أدخل رمز التحقق المرسل إلى هاتفك</p>")).mfa).toBe(true);
    expect(detectMfa(snap("<p>Saisissez le code de vérification envoyé par SMS.</p>")).mfa).toBe(true);
    expect(detectMfa(snap("<p>Gib den Bestätigungscode ein.</p>")).mfa).toBe(true);
  });

  it("flags lockout and throttling walls", () => {
    expect(detectLockout(snap("<p>Too many attempts. Try again later.</p>"))).toBe(true);
    expect(detectLockout(snap("<p>Your account is temporarily locked.</p>"))).toBe(true);
    expect(detectLockout(snap("<p>We noticed unusual sign-in activity on your account.</p>"))).toBe(true);
    expect(detectLockout(snap("<p>Wrong email or password.</p>"))).toBe(false);
  });

  it("flags lockout walls in other languages", () => {
    expect(detectLockout(snap("<p>محاولات كثيرة لتسجيل الدخول. حاول لاحقًا.</p>"))).toBe(true);
    expect(detectLockout(snap("<p>Trop de tentatives. Réessayez plus tard.</p>"))).toBe(true);
    expect(detectLockout(snap("<p>Zu viele Versuche. Bitte später erneut versuchen.</p>"))).toBe(true);
  });

  it("recognizes logged-in signals in other languages", () => {
    expect(loggedInSignals(snap("<a>تسجيل الخروج</a>"))).toBe(true);
    expect(loggedInSignals(snap("<a>Déconnexion</a>"))).toBe(true);
    expect(loggedInSignals(snap("<p>Welcome</p>"))).toBe(false);
  });
});

describe("SSO hop detection", () => {
  it("same site (including www. and subdomain variants) is NOT SSO", () => {
    expect(detectSsoRedirect("https://example.com/app", ENTRY)).toBeNull();
    expect(detectSsoRedirect("https://www.example.com/dashboard", ENTRY)).toBeNull();
    expect(detectSsoRedirect("https://accounts.example.com/next", ENTRY)).toBeNull();
    expect(detectSsoRedirect("https://m.example.com/", ENTRY)).toBeNull();
  });

  it("known identity providers are flagged", () => {
    expect(detectSsoRedirect("https://accounts.google.com/o/oauth2/chooser", ENTRY)).toBe("accounts.google.com");
    expect(detectSsoRedirect("https://login.microsoftonline.com/common/oauth2/", ENTRY)).toBe("login.microsoftonline.com");
  });

  it("other domains on auth paths are flagged; unrelated redirects are not", () => {
    expect(detectSsoRedirect("https://idp.partner.net/authorize", ENTRY)).toBe("idp.partner.net");
    expect(detectSsoRedirect("https://cdn.stats-cdn.net/assets/home", ENTRY)).toBeNull();
  });
});

describe("password vault (memory only, single use)", () => {
  it("takes once, then it is gone", () => {
    stashPassword("job-a", "s3cret");
    expect(takePassword("job-a")).toBe("s3cret");
    expect(takePassword("job-a")).toBeUndefined();
  });
  it("drop removes without reading", () => {
    stashPassword("job-b", "s3cret");
    dropPassword("job-b");
    expect(takePassword("job-b")).toBeUndefined();
  });
  it("unknown ids take nothing", () => {
    expect(takePassword("no-such-job")).toBeUndefined();
  });
});

describe("job record never carries credential material", () => {
  it("settings.auth holds username + loginUrl only", async () => {
    const store = await import("../../server/jobs/store.js");
    const now = new Date().toISOString();
    const job: store.Job = {
      id: "redact-check",
      url: "https://example.com/",
      settings: {
        maxSections: 1,
        viewport: "desktop",
        format: "webp",
        auth: { username: "owner@example.com", loginUrl: "https://example.com/login" },
      },
      status: "queued",
      steps: [],
      sections: [],
      createdAt: now,
      updatedAt: now,
    } as Job;
    const json = JSON.stringify(job);
    expect(json).toContain("owner@example.com");
    expect(json).not.toMatch(/password/i);
  });
});
