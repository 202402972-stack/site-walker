// Landing page — plan §9.2. Content-led sections; hero visual is the working
// console replayed from a REAL recorded run (web/src/sample.json), labeled.
import React from "react";
import { SiteHeader, SiteFooter, StepList, Reveal, formatKB, type Limits, type SampleRun } from "./shared.js";

const FIVE_STEPS: { name: string; log: string }[] = [
  { name: "Open", log: "job.started — entry URL validated, real Chromium launches" },
  { name: "Discover", log: "sections.discovered — nav, anchors, landmarks, then sitemap fallback" },
  { name: "Wait", log: "load + network idle (capped), fonts ready, DOM quiet, lazy scroll" },
  { name: "Capture", log: "section.captured — one full-page shot per section, blank captures rejected" },
  { name: "Deliver", log: "job.done — gallery grows live, ZIP downloads everything" },
];

const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: "Does it work behind logins?",
    a: <p>No. Login-walled content cannot be captured; the run reports it as failed with the reason.</p>,
  },
  {
    q: "What about bot-protected sites?",
    a: <p>Sites that block automation return an error for that section, labeled in the log. Nothing is faked.</p>,
  },
  {
    q: "How long are results kept?",
    a: <p>Results expire automatically after the retention window (see Controls and limits). Deleting a run removes it immediately.</p>,
  },
  {
    q: "Mobile capture?",
    a: <p>Yes — choose the mobile viewport (390×844) when starting the run.</p>,
  },
  {
    q: "What does it cost to run?",
    a: <p>One small container, no paid providers, no database. Heavy multi-page runs take longer because jobs run one at a time.</p>,
  },
];

export function Landing({ limits, sample }: { limits: Limits; sample: SampleRun }): React.ReactElement {
  const totalBytes = sample.shots.reduce((n, s) => n + (s.bytes || 0), 0);
  const maxHeight = sample.shots.reduce((n, s) => Math.max(n, s.height || 0), 0);
  // Fixed "en-US" numerals: bare toLocaleString() follows the server locale (ar-EG → ٩٬٤٧٤).
  const num = (n: number) => n.toLocaleString("en-US");
  const anchorSection = { marginTop: 0, scrollMarginTop: 72 };
  return (
    <>
      <SiteHeader consoleLink />
      <main>
        <section className="wrap block" style={{ borderTop: 0 }} aria-labelledby="hero-h">
          <div className="hero-grid">
            <div>
              <p className="eyebrow">Web agent · real Chromium · live results</p>
              <h1 id="hero-h">Point it at a website. Get every section, fully captured.</h1>
              <p className="lede">
                Site Walker opens the site in a real Chromium browser, finds its pages and sections,
                waits for each to finish loading, and returns one full-page screenshot per section as
                it works.
              </p>
              <div className="hero-actions">
                <a className="btn" href="/app">Open the console</a>
                <a className="btn btn-ghost" href="#how">How a run works</a>
              </div>
              <div className="hero-meta" aria-label="Run limits at a glance">
                <span className="badge"><span className="dot" aria-hidden="true" /> Up to {limits.maxSections} sections per run</span>
                <span className="badge"><span className="dot" aria-hidden="true" /> Desktop + mobile viewports</span>
                <span className="badge"><span className="dot" aria-hidden="true" /> Deleted after {limits.retentionHours}h</span>
              </div>
              <div className="stat-row" aria-label="Recorded run statistics">
                <div className="stat">
                  <div className="v">{sample.shots.length}</div>
                  <div className="k">sections in the recorded run</div>
                </div>
                <div className="stat">
                  <div className="v">{num(maxHeight)}px</div>
                  <div className="k">tallest full-page capture</div>
                </div>
                <div className="stat">
                  <div className="v">{formatKB(totalBytes)}</div>
                  <div className="k">total capture weight</div>
                </div>
              </div>
            </div>
            <figure style={{ margin: 0 }} aria-label="Recorded capture replay">
              <div className="replay-card">
                <div className="replay-head">
                  <span>Live replay — real run · {sample.status}</span>
                  <span>{sample.date}</span>
                </div>
                <div className="log" role="log" aria-label="Recorded capture log">
                  {sample.steps.map((s, i) => (
                    <div key={i}>
                      <span className="t">{String(i + 1).padStart(2, "0")}</span>{" "}
                      <span className={s.event.includes("failed") || s.event.includes("timeout") ? "ev-bad" : "ev-ok"}>
                        {s.event}
                      </span>{" "}
                      {s.detail}
                    </div>
                  ))}
                </div>
                <div className="shot-strip">
                  <figure style={{ margin: 0 }}>
                    <img src="/sample/full-page.webp" alt="Full-page capture from the recorded run" loading="lazy" />
                    <figcaption>{sample.shots[0]?.width}×{sample.shots[0]?.height} · {sample.shots[0] ? formatKB(sample.shots[0].bytes) : "?"}</figcaption>
                  </figure>
                  <figure style={{ margin: 0 }}>
                    <img src="/sample/sound-effects.webp" alt="Full-page capture of a discovered section" loading="lazy" />
                    <figcaption>{sample.shots[2]?.width}×{sample.shots[2]?.height} · {sample.shots[2] ? formatKB(sample.shots[2].bytes) : "?"}</figcaption>
                  </figure>
                </div>
              </div>
              <figcaption className="eyebrow" style={{ marginTop: 12 }}>
                Recorded run against {sample.target}
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="wrap block" id="how" style={anchorSection} aria-labelledby="how-h">
          <Reveal>
            <p className="eyebrow">How a run works</p>
            <h2 id="how-h">Five steps, each one visible in the log.</h2>
            <ol className="steps5" style={{ padding: 0 }}>
              {FIVE_STEPS.map((s, i) => (
                <li key={s.name}>
                  <span className="n" aria-hidden="true">{i + 1}</span>
                  <span>
                    <strong>{s.name}.</strong> <code className="inline">{s.log}</code>
                  </span>
                </li>
              ))}
            </ol>
          </Reveal>
        </section>

        <section className="wrap block" id="sample" style={anchorSection} aria-labelledby="back-h">
          <Reveal>
            <p className="eyebrow">What comes back</p>
            <h2 id="back-h">One file per section, with its real size.</h2>
            <p>
              From the same recorded run ({sample.target}, {sample.date}). Full files ship in the
              console ZIP; the element shot is the anchor close-up the agent takes on one-pagers.
            </p>
          </Reveal>
          <div className="gallery">
            <Reveal delay={1}>
              <figure className="shot" style={{ margin: 0 }}>
                <img src="/sample/full-page.webp" alt="Full-page capture of the sample run target" loading="lazy" />
                <figcaption>
                  full-page.webp · {sample.shots[0]?.width}×{sample.shots[0]?.height} ·{" "}
                  {sample.shots[0] ? formatKB(sample.shots[0].bytes) : "?"}
                </figcaption>
              </figure>
            </Reveal>
            <Reveal delay={2}>
              <figure className="shot" style={{ margin: 0 }}>
                <img src="/sample/sound-effects.webp" alt="Full-page capture of a discovered section" loading="lazy" />
                <figcaption>
                  sound-effects.webp · {sample.shots[2]?.width}×{sample.shots[2]?.height} ·{" "}
                  {sample.shots[2] ? formatKB(sample.shots[2].bytes) : "?"}
                </figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        <section className="wrap block" id="login" style={anchorSection} aria-labelledby="login-h">
          <Reveal>
            <p className="eyebrow">Sites with login</p>
            <h2 id="login-h">If the site needs sign-in, the agent can sign in first.</h2>
            <p>
              In the console, add the site's username and password to the run. The agent opens the
              login page in the same real browser, fills the form, submits it, and captures with the
              resulting session. A failed login never blocks the run — it is logged with its reason
              and capture continues with whatever is public.
            </p>
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Works with</h3>
              <p className="muted" style={{ marginBottom: 0 }}>Plain email + password forms on the same site.</p>
            </div>
            <div className="card" style={{ marginTop: 12 }}>
              <h3>Honest limits</h3>
              <StepList
                steps={[
                  { event: "LOGIN_NO_FORM", detail: "Variety of login layouts: username-only first screens, user+password, split forms — with layered field discovery, human-like typing, and four submit strategies. Wrong credentials report failure, never fake success." },
                  { event: "MFA_REQUIRED", detail: "Second factors (OTP codes, authenticator push, passkeys) and SSO hand-offs to external providers report specific codes — the agent stops there instead of guessing." },
                  { event: "SSO_REDIRECT", detail: "Google and other big providers often block sign-ins from server IPs as suspicious. It may work, it may challenge or lock the account — use a dedicated account, never your main one." },
                  { event: "BOT_CHALLENGE", detail: "Challenge widgets embedded in the site's form don't block the run (the bot never touches them) — a full-page interstitial gets a bounded self-clear wait, then is reported honestly. Never solved or bypassed." },
                ]}
              />
            </div>
            <div className="card" style={{ marginTop: 12 }}>
              <h3>Your password is never stored</h3>
              <p className="muted" style={{ marginBottom: 0 }}>
                Used once from server memory for that run, deleted the moment it is used, and never
                written to logs, job files, or the ZIP. The login page must be on the same site as
                the URL being captured. Only ever use accounts you own or have permission to use.
              </p>
            </div>
            <div className="btn-row">
              <a className="btn" href="/app">Open the console</a>
            </div>
          </Reveal>
        </section>

        <section className="wrap block" id="limits" style={anchorSection} aria-labelledby="limits-h">
          <Reveal>
            <p className="eyebrow">Controls and limits</p>
            <h2 id="limits-h">The same values the agent enforces.</h2>
            <p>This table is rendered from the live server configuration — copy and behavior cannot drift.</p>
            <table className="limits">
              <tbody>
                <tr><th scope="row">Sections per run</th><td>up to {limits.maxSections}</td></tr>
                <tr><th scope="row">Time per job</th><td>{limits.maxJobSeconds} seconds</td></tr>
                <tr><th scope="row">Page height cap</th><td>{num(limits.maxPageHeight)} px (taller pages tile or truncate, labeled)</td></tr>
                <tr><th scope="row">Navigation wait</th><td>{Math.round(limits.navWaitMs / 1000)} seconds per section</td></tr>
                <tr><th scope="row">Memory guard</th><td>{limits.memGuardMb} MB container guard</td></tr>
                <tr><th scope="row">Disk per job</th><td>{limits.maxJobMb} MB</td></tr>
                <tr><th scope="row">Concurrency</th><td>{limits.concurrency} job at a time, queue depth {limits.queueDepth}</td></tr>
                <tr><th scope="row">Fair use</th><td>{limits.jobsPerHour} jobs per hour per session</td></tr>
                <tr><th scope="row">Retention</th><td>{limits.retentionHours} hours, then deleted</td></tr>
              </tbody>
            </table>
          </Reveal>
        </section>

        <section className="wrap block" id="refuse" style={anchorSection} aria-labelledby="refuse-h">
          <Reveal>
            <p className="eyebrow">What it refuses and why</p>
            <h2 id="refuse-h">Some URLs are never fetched.</h2>
            <StepList
              steps={[
                { event: "URL_BLOCKED", detail: "Private and local addresses (127.x, 10.x, 172.16.x, 192.168.x, ::1, cloud metadata 169.254.x) — the service must never become a proxy into private networks." },
                { event: "URL_BLOCKED", detail: "Non-HTTP schemes (file, ftp, data) and disguised numeric IPs (decimal, hex, octal, IPv4-mapped IPv6)." },
                { event: "SECTION_FAILED", detail: "Login-walled pages, bot-blocked pages, and blank renders are reported as failures with reasons — never delivered as successes." },
              ]}
            />
          </Reveal>
        </section>

        <section className="wrap block" aria-labelledby="server-h">
          <Reveal>
            <p className="eyebrow">Runs on one small server</p>
            <h2 id="server-h">One job at a time, asleep when idle.</h2>
            <p>
              Jobs run one at a time on a single small container and the service sleeps when idle,
              so the first request after quiet time can take a little longer to answer. Refreshing
              during a run never loses it — job state lives on disk and the console reattaches.
            </p>
          </Reveal>
        </section>

        <section className="wrap block faq" id="faq" style={anchorSection} aria-labelledby="faq-h">
          <Reveal>
            <p className="eyebrow">FAQ</p>
            <h2 id="faq-h">Answers to common questions.</h2>
            {FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                {f.a}
              </details>
            ))}
          </Reveal>
        </section>

        <section className="wrap block" aria-labelledby="cta-h">
          <Reveal>
            <p className="eyebrow">Next step</p>
            <h2 id="cta-h">Have a URL? Walk it now.</h2>
            <p className="lede">The console is token-gated. Paste a URL, watch each section land live, download the ZIP.</p>
            <div className="btn-row">
              <a className="btn" href="/app">Open the console</a>
              <a className="btn btn-ghost" href="#sample">See what comes back</a>
            </div>
          </Reveal>
        </section>
      </main>
      <SiteFooter retentionHours={limits.retentionHours} />
    </>
  );
}
