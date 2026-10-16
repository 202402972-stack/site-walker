// Shared, SSR-safe components (no window/document at module level).
import React from "react";

export interface Limits {
  product: string;
  maxSections: number;
  maxJobSeconds: number;
  maxPageHeight: number;
  navWaitMs: number;
  memGuardMb: number;
  retentionHours: number;
  maxJobMb: number;
  concurrency: number;
  queueDepth: number;
  jobsPerHour: number;
}

export interface SampleShot {
  name: string;
  kind: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  element: string | null;
}

export interface SampleRun {
  target: string;
  date: string;
  status: string;
  steps: { event: string; detail?: string }[];
  shots: SampleShot[];
}

export function LogoMark(): React.ReactElement {
  // Original mark: a walking path through three nodes. Not the reference logo.
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="5" cy="19" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="13" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="21" cy="6" r="3" fill="currentColor" />
      <path d="M7 16.5 11 13.5M15 10l4-2.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SiteHeader({ consoleLink }: { consoleLink: boolean }): React.ReactElement {
  return (
    <header className="wrap site-header">
      <a className="brand" href="/" aria-label="Site Walker home">
        <LogoMark /> Site Walker
      </a>
      {consoleLink && (
        <nav aria-label="Primary">
          <a className="btn" href="/app">Open the console</a>
        </nav>
      )}
    </header>
  );
}

export function SiteFooter({ retentionHours }: { retentionHours: number }): React.ReactElement {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <p>
          <strong>Site Walker.</strong> A web agent that turns any website URL into one complete
          full-page screenshot per section.
        </p>
        <p>
          Console runs are private and expire after {retentionHours} hours. Capture only sites you
          own or have permission to capture.
        </p>
      </div>
    </footer>
  );
}

export function StepList({ steps }: { steps: { event: string; detail?: string }[] }): React.ReactElement {
  return (
    <ol className="steps5" style={{ padding: 0, margin: 0 }}>
      {steps.map((s, i) => (
        <li key={i}>
          <span className="n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
          <span>
            <code className="inline">{s.event}</code>
            {s.detail && <div style={{ marginTop: 4 }}>{s.detail}</div>}
          </span>
        </li>
      ))}
    </ol>
  );
}
