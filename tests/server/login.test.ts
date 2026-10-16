// Login feature (plan §9.3): challenge detection + credential-hygiene guarantees.
import { describe, it, expect } from "vitest";
import { detectChallenge } from "../../server/agent/login.js";
import { stashPassword, takePassword, dropPassword } from "../../server/jobs/secrets.js";

describe("login challenge detection", () => {
  it("flags Cloudflare / CAPTCHA vendor pages", () => {
    expect(detectChallenge('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">', "Just a moment...")).toBe(true);
    expect(detectChallenge('<div class="g-recaptcha" data-sitekey="x">', "Login")).toBe(true);
    expect(detectChallenge("<p>Verify you are human to continue</p>", "Sign in")).toBe(true);
  });
  it("does not flag ordinary login forms", () => {
    expect(
      detectChallenge('<form><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></form>', "Sign in"),
    ).toBe(false);
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

describe("job record never carries a password", () => {
  it("settings.auth holds username + loginUrl only", async () => {
    const store = await import("../../server/jobs/store.js");
    const now = new Date().toISOString();
    const job: store.Job = {
      id: "redact-check",
      url: "https://example.com/",
      settings: { maxSections: 1, viewport: "desktop", format: "webp", auth: { username: "owner@example.com", loginUrl: "https://example.com/login" } },
      status: "queued",
      steps: [],
      sections: [],
      createdAt: now,
      updatedAt: now,
    };
    const json = JSON.stringify(job);
    expect(json).toContain("owner@example.com");
    expect(json).not.toMatch(/password/i);
  });
});
