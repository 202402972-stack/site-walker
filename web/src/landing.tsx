// Landing page — plan §9.2. Content-led sections; hero visual is the working
// console replayed from a REAL recorded run (web/src/sample.json), labeled.
import React from "react";
import { SiteHeader, SiteFooter, StepList, type Limits, type SampleRun } from "./shared.js";

const FIVE_STEPS: { name: string; log: string }[] = [
  { name: "Open", log: "job.started — entry URL validated, real Chromium launches" },
  { name: "Discover", log: "sections.discovered — nav, anchors, landmarks, then sitemap fallback" },
  { name: "Wait", log: "load + network idle (capped), fonts ready, DOM quiet, lazy scroll" },
  { name: "Capture", log: "section.captured — one full-page shot per section, blank captures rejected" },
  { name: "Deliver", log: "job.done — gallery grows live, ZIP downloads everything" },
];

export function Landing({ limits, sample }: { limits: Limits; sample: SampleRun }): React.ReactElement {
  return (
    <>
      <SiteHeader consoleLink />
      <main>
        <section className="wrap block" style={{ borderTop: 0 }} aria-labelledby="hero-h">
          <p className="eyebrow">Web agent · real Chromium · live results</p>
          <h1 id="hero-h">Point it at a website. Get every section, fully captured.</h1>
          <p>
            Site Walker opens the site in a real Chromium browser, finds its pages and sections,
            waits for each to finish loading, and returns one full-page screenshot per section as
            it works.
          </p>
          <p>
            <a className="btn" href="/app">Open the console</a>
          </p>
          <figure style={{ margin: "32px 0 0" }}>
            <figcaption className="eyebrow">
              Live replay — real run against {sample.target} on {sample.date} (status: {sample.status})
            </figcaption>
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
          </figure>
        </section>

        <section className="wrap block" aria-labelledby="how-h">
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
        </section>

        <section className="wrap block" aria-labelledby="back-h">
          <p className="eyebrow">What comes back</p>
          <h2 id="back-h">One file per section, with its real size.</h2>
          <p>
            From the same recorded run ({sample.target}, {sample.date}). Full files ship in the
            console ZIP; the element shot is the anchor close-up the agent takes on one-pagers.
          </p>
          <div className="gallery">
            <figure className="shot" style={{ margin: 0 }}>
              <img src="/sample/full-page.webp" alt="Full-page capture of the sample run target" loading="lazy" />
              <figcaption>
                full-page.webp · {sample.shots[0]?.width}×{sample.shots[0]?.height} ·{" "}
                {sample.shots[0] ? Math.round(sample.shots[0].bytes / 1024) : "?"}KB
              </figcaption>
            </figure>
            <figure className="shot" style={{ margin: 0 }}>
              <img src="/sample/sound-effects.webp" alt="Full-page capture of a discovered section" loading="lazy" />
              <figcaption>
                sound-effects.webp · {sample.shots[2]?.width}×{sample.shots[2]?.height} ·{" "}
                {sample.shots[2] ? Math.round(sample.shots[2].bytes / 1024) : "?"}KB
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="wrap block" aria-labelledby="limits-h">
          <p className="eyebrow">Controls and limits</p>
          <h2 id="limits-h">The same values the agent enforces.</h2>
          <p>This table is rendered from the live server configuration — copy and behavior cannot drift.</p>
          <table className="limits">
            <tbody>
              <tr><th scope="row">Sections per run</th><td>up to {limits.maxSections}</td></tr>
              <tr><th scope="row">Time per job</th><td>{limits.maxJobSeconds} seconds</td></tr>
              <tr><th scope="row">Page height cap</th><td>{limits.maxPageHeight.toLocaleString()} px (taller pages tile or truncate, labeled)</td></tr>
              <tr><th scope="row">Navigation wait</th><td>{Math.round(limits.navWaitMs / 1000)} seconds per section</td></tr>
              <tr><th scope="row">Memory guard</th><td>{limits.memGuardMb} MB container guard</td></tr>
              <tr><th scope="row">Disk per job</th><td>{limits.maxJobMb} MB</td></tr>
              <tr><th scope="row">Concurrency</th><td>{limits.concurrency} job at a time, queue depth {limits.queueDepth}</td></tr>
              <tr><th scope="row">Fair use</th><td>{limits.jobsPerHour} jobs per hour per session</td></tr>
              <tr><th scope="row">Retention</th><td>{limits.retentionHours} hours, then deleted</td></tr>
            </tbody>
          </table>
        </section>

        <section className="wrap block" aria-labelledby="refuse-h">
          <p className="eyebrow">What it refuses and why</p>
          <h2 id="refuse-h">Some URLs are never fetched.</h2>
          <StepList
            steps={[
              { event: "URL_BLOCKED", detail: "Private and local addresses (127.x, 10.x, 172.16.x, 192.168.x, ::1, cloud metadata 169.254.x) — the service must never become a proxy into private networks." },
              { event: "URL_BLOCKED", detail: "Non-HTTP schemes (file, ftp, data) and disguised numeric IPs (decimal, hex, octal, IPv4-mapped IPv6)." },
              { event: "SECTION_FAILED", detail: "Login-walled pages, bot-blocked pages, and blank renders are reported as failures with reasons — never delivered as successes." },
            ]}
          />
        </section>

        <section className="wrap block" aria-labelledby="server-h">
          <p className="eyebrow">Runs on one small server</p>
          <h2 id="server-h">One job at a time, asleep when idle.</h2>
          <p>
            Jobs run one at a time on a single small container and the service sleeps when idle,
            so the first request after quiet time can take a little longer to answer. Refreshing
            during a run never loses it — job state lives on disk and the console reattaches.
          </p>
        </section>

        <section className="wrap block" aria-labelledby="faq-h">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-h">Answers to common questions.</h2>
          <dl>
            <dt><strong>Does it work behind logins?</strong></dt>
            <dd>No. Login-walled content cannot be captured; the run reports it as failed with the reason.</dd>
            <dt><strong>What about bot-protected sites?</strong></dt>
            <dd>Sites that block automation return an error for that section, labeled in the log. Nothing is faked.</dd>
            <dt><strong>How long are results kept?</strong></dt>
            <dd>{limits.retentionHours} hours, then the retention sweep deletes job files automatically.</dd>
            <dt><strong>Mobile capture?</strong></dt>
            <dd>Yes — choose the mobile viewport (390×844) when starting the run.</dd>
            <dt><strong>What does it cost to run?</strong></dt>
            <dd>One small container, no paid providers, no database. Heavy multi-page runs take longer because jobs run one at a time.</dd>
          </dl>
        </section>
      </main>
      <SiteFooter retentionHours={limits.retentionHours} />
    </>
  );
}
