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
    <div className="site-header-sticky">
      <header className="wrap site-header">
        <a className="brand" href="/" aria-label="Site Walker home">
          <LogoMark /> Site Walker
        </a>
        <nav className="site-nav" aria-label="Primary">
          <a className="nav-link hide-sm" href="/#how">How it works</a>
          <a className="nav-link hide-sm" href="/#sample">Sample</a>
          <a className="nav-link hide-sm" href="/#limits">Limits</a>
          <a className="nav-link hide-sm" href="/#faq">FAQ</a>
          {consoleLink && (
            <a className="btn" href="/app">Open the console</a>
          )}
        </nav>
      </header>
    </div>
  );
}

export function SiteFooter({ retentionHours }: { retentionHours: number }): React.ReactElement {
  return (
    <footer className="site-footer">
      <div className="wrap cols">
        <div>
          <p>
            <strong>Site Walker.</strong> A web agent that turns any website URL into one complete
            full-page screenshot per section.
          </p>
          <p>
            Console runs are private and expire after {retentionHours} hours. Capture only sites you
            own or have permission to capture.
          </p>
        </div>
        <nav aria-label="Product">
          <p className="eyebrow">Product</p>
          <a href="/#how">How a run works</a>
          <a href="/#sample">What comes back</a>
          <a href="/#limits">Controls and limits</a>
        </nav>
        <nav aria-label="Console">
          <p className="eyebrow">Console</p>
          <a href="/app">Open the console</a>
          <a href="/#refuse">What it refuses</a>
          <a href="/#faq">FAQ</a>
        </nav>
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

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const kind = status === "done" ? "ok" : status === "failed" ? "bad" : status === "partial" ? "warn" : "warn";
  const label = status === "done" ? "Done" : status === "failed" ? "Failed" : status === "partial" ? "Partial" : status === "running" ? "Running" : status === "queued" ? "Queued" : status || "…";
  return (
    <span className={`badge ${kind}`} role="status">
      <span className="dot" aria-hidden="true" /> {label}
    </span>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }): React.ReactElement {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>{label}</span>
        <span className="muted" style={{ fontSize: 12 }} aria-live="polite">{value}/{max} · {pct}%</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Reveal-on-scroll wrapper. SSR-safe: observes only after mount; no-op without IntersectionObserver. */
export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: 0 | 1 | 2 }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    try { document.documentElement.classList.add("js"); } catch { /* non-DOM */ }
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return; // content stays visible
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="reveal" data-delay={delay === 0 ? undefined : String(delay)}>
      {children}
    </div>
  );
}

export function formatKB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  return `${Math.round(bytes / 1024)}KB`;
}
