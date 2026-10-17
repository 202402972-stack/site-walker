// Console — plan §9.3. Token-gated agent control with live progress.
// States: gate, idle, invalid, blocked, queued, running, partial, done,
// busy, rate-limited, expired, lost-connection (auto-reconnect).
import React from "react";
import { StatusBadge, ProgressBar, formatKB, type Limits } from "./shared.js";

type Phase =
  | { kind: "gate" }
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live"; id: string }
  | { kind: "error"; message: string; code?: string; back: "gate" | "idle" };

interface Step { t: string; event: string; detail?: string }
interface Shot { name: string; url: string; kind: string; file?: string; width?: number; height?: number; bytes?: number; truncated?: boolean; elementCapture?: string; error?: string; code?: string }
interface JobPayload { status: string; steps: Step[]; sections: Shot[]; url?: string; settings?: { maxSections: number; viewport: string; format: string }; peakMemoryMB?: number }
interface HistItem { id: string; url: string; at: string; status: string }

async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(path, { credentials: "include", ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON (zip) */ }
  return { ok: res.ok, status: res.status, body };
}

function errCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const e = (body as { error: { code?: string } }).error;
    return e?.code;
  }
  return undefined;
}

function friendly(code: string | undefined, fallback: string): string {
  switch (code) {
    case "URL_INVALID": return "That URL doesn't look valid. Check the address and try again.";
    case "URL_BLOCKED": return "That address is blocked: private/local hosts, non-HTTP schemes, and disguised IPs are never fetched.";
    case "BUSY": return "The agent is walking another site right now — one job at a time. Try again shortly.";
    case "RATE_LIMITED": return "Rate limit reached (10 jobs/hour, or too many login attempts). Wait and retry.";
    case "UNAUTHORIZED": return "Session expired. Log in again.";
    case "NAV_TIMEOUT": return "The site took too long to load that section.";
    default: return fallback;
  }
}

function discoveredTotal(steps: Step[]): number | null {
  for (const s of steps) {
    if (s.event === "sections.discovered" && s.detail) {
      const m = /^(\d+)\s*:/.exec(s.detail);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function loadHistory(): HistItem[] {
  try {
    const raw = sessionStorage.getItem("sw_history");
    if (!raw) return [];
    const arr = JSON.parse(raw) as HistItem[];
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch { return []; }
}

interface SessionMeta {
  id: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  label?: string;
}

/**
 * Saved sessions — the human-in-the-loop answer to CAPTCHA-protected logins.
 * The owner signs in once in their own browser (solving any challenge as a
 * human), exports the cookies, imports them here; runs on the site reuse the
 * session automatically. Nothing is ever solved by the service itself.
 */
function SavedSessions(): React.ReactElement {
  const [items, setItems] = React.useState<SessionMeta[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [importUrl, setImportUrl] = React.useState("");
  const [importJson, setImportJson] = React.useState("");

  const refresh = React.useCallback(async (): Promise<void> => {
    const r = await api("/api/sessions");
    if (r.ok && typeof r.body === "object" && r.body !== null && Array.isArray((r.body as { sessions?: unknown }).sessions)) {
      setItems((r.body as { sessions: SessionMeta[] }).sessions);
    } else {
      setItems([]); // not signed in yet — stay quiet
    }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const doImport = async (): Promise<void> => {
    setMsg(null);
    if (!importUrl.trim() || !importJson.trim()) {
      setMsg("Both the site URL and the exported cookies JSON are required.");
      return;
    }
    let state: unknown;
    try { state = JSON.parse(importJson); } catch { setMsg("The pasted text is not valid JSON."); return; }
    setBusy(true);
    const r = await api("/api/sessions/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: importUrl.trim(), state }),
    });
    setBusy(false);
    if (r.ok) {
      const dropped = (r.body as { droppedCookies?: number } | null)?.droppedCookies ?? 0;
      setMsg(`Session saved${dropped ? ` — ${dropped} cookies for other sites were dropped` : ""}. Future runs on this site use it automatically.`);
      setImportJson(""); // the paste can contain live session secrets — clear it
      void refresh();
    } else {
      const m = typeof r.body === "object" && r.body !== null && "error" in r.body
        ? (r.body as { error: { message?: string } }).error.message
        : undefined;
      setMsg(m ?? "Import was rejected.");
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    const r = await api(`/api/sessions/${id}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) { setMsg("Session deleted."); void refresh(); }
  };

  return (
    <section aria-labelledby="sessions-h" style={{ marginTop: 24, maxWidth: 560 }}>
      <h3 id="sessions-h" style={{ fontSize: 14 }}>Saved sessions — for sites with CAPTCHA or tough logins</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Sign in once in <em>your own browser</em> — solving any CAPTCHA as a human — then export
        the site&apos;s cookies (a cookie-editor extension, or a Playwright storageState file) and
        import them here. Runs on this site reuse the session automatically. Stored encrypted on
        the server; delete anytime.
      </p>
      {items.length > 0 && (
        <ul className="steps5" style={{ padding: 0 }}>
          {items.map((s) => (
            <li key={s.id}>
              <span className="n" aria-hidden="true">·</span>
              <span>
                <div style={{ overflowWrap: "anywhere" }}>{s.origin}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {s.cookieCount} cookies · saved {new Date(s.savedAt).toLocaleString()}
                  {s.label ? ` · ${s.label}` : ""}
                </div>
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void remove(s.id)}>
                    Delete
                  </button>
                </div>
              </span>
            </li>
          ))}
        </ul>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 14 }}>Import a session</summary>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="sess-url">Site URL</label>
          <input
            id="sess-url" type="url" inputMode="url" value={importUrl}
            onChange={(e) => { setImportUrl(e.target.value); setMsg(null); }}
            placeholder="https://example.com"
          />
        </div>
        <div className="field">
          <label htmlFor="sess-json">Exported cookies JSON</label>
          <textarea
            id="sess-json" rows={5} value={importJson}
            onChange={(e) => { setImportJson(e.target.value); setMsg(null); }}
            placeholder={'{"cookies":[{"name":"…","value":"…","domain":".example.com","path":"/"}]}'}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </div>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => void doImport()}>
            Import session
          </button>
        </div>
      </details>
      {msg && <p className="notice" style={{ marginTop: 12 }}>{msg}</p>}
    </section>
  );
}

export function Console(): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>(() => {
    if (typeof sessionStorage !== "undefined") {
      const saved = sessionStorage.getItem("sw_job");
      if (saved) return { kind: "live", id: saved };
    }
    return { kind: "gate" };
  });
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [showPass, setShowPass] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [viewport, setViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [format, setFormat] = React.useState<"webp" | "png">("webp");
  const [maxSec, setMaxSec] = React.useState(12);
  const [loginUrl, setLoginUrl] = React.useState("");
  const [authUser, setAuthUser] = React.useState("");
  const [authPass, setAuthPass] = React.useState("");
  const [authConsent, setAuthConsent] = React.useState(false);
  const [limits, setLimits] = React.useState<Limits | null>(null);
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [shots, setShots] = React.useState<Shot[]>([]);
  const [jobUrl, setJobUrl] = React.useState("");
  const [jobSettings, setJobSettings] = React.useState<{ maxSections: number } | null>(null);
  const [peakMb, setPeakMb] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [history, setHistory] = React.useState<HistItem[]>([]);
  const [lightbox, setLightbox] = React.useState<number | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const pollRef = React.useRef<number | null>(null);
  const esRef = React.useRef<EventSource | null>(null);
  const startRef = React.useRef(0);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);

  const stopStreams = React.useCallback(() => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  const pushHistory = React.useCallback((id: string, jobPageUrl: string, st: string) => {
    setHistory((prev) => {
      const next = [{ id, url: jobPageUrl, at: new Date().toISOString(), status: st }, ...prev.filter((h) => h.id !== id)].slice(0, 10);
      try { sessionStorage.setItem("sw_history", JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const attach = React.useCallback((id: string) => {
    sessionStorage.setItem("sw_job", id);
    startRef.current = Date.now();
    setElapsed(0);
    setPhase({ kind: "live", id });
    setSteps([]);
    setShots([]);
    setJobUrl("");
    setJobSettings(null);
    setPeakMb(null);
    setStatus("queued");
    setNote(null);
    setCopied(false);
    setLightbox(null);

    const onData = (payload: JobPayload) => {
      setSteps(payload.steps ?? []);
      setShots(payload.sections ?? []);
      setStatus(payload.status);
      if (payload.url) setJobUrl(payload.url);
      if (payload.settings) setJobSettings({ maxSections: payload.settings.maxSections });
      if (typeof payload.peakMemoryMB === "number") setPeakMb(payload.peakMemoryMB);
      if (["done", "partial", "failed"].includes(payload.status)) {
        stopStreams();
        sessionStorage.removeItem("sw_job");
        pushHistory(id, payload.url ?? "", payload.status);
      }
    };

    try {
      const es = new EventSource(`/api/jobs/${id}/events`);
      esRef.current = es;
      es.onmessage = (m) => {
        try { onData(JSON.parse(m.data)); } catch { /* keep polling as backup */ }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        setNote("Live connection lost — polling instead, auto-reconnecting.");
        const retry = new EventSource(`/api/jobs/${id}/events`);
        esRef.current = retry;
        retry.onmessage = es.onmessage;
        retry.onerror = () => { retry.close(); if (esRef.current === retry) esRef.current = null; };
      };
    } catch {
      setNote("Live events unavailable — polling for progress.");
    }
    pollRef.current = window.setInterval(async () => {
      const r = await api(`/api/jobs/${id}`);
      if (r.status === 404) {
        stopStreams();
        sessionStorage.removeItem("sw_job");
        setPhase({ kind: "error", message: "That job is gone — results expire after retention. Start a new run.", back: "idle" });
        return;
      }
      if (r.status === 401) {
        stopStreams();
        setPhase({ kind: "gate" });
        return;
      }
      if (r.ok && typeof r.body === "object" && r.body !== null) onData(r.body as JobPayload);
    }, 2000);
  }, [stopStreams, pushHistory]);

  React.useEffect(() => {
    if (phase.kind === "live") attach(phase.id);
    return stopStreams;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Public limits for the idle form + history restore (no auth needed).
  React.useEffect(() => {
    let cancelled = false;
    api("/api/config").then((r) => {
      if (cancelled || !r.ok || typeof r.body !== "object" || r.body === null) return;
      const l = r.body as Limits;
      setLimits(l);
      setMaxSec((m) => Math.min(m, l.maxSections));
    }).catch(() => {});
    setHistory(loadHistory());
    return () => { cancelled = true; };
  }, []);

  // Elapsed ticker while the run is not finished.
  const finished = ["done", "partial", "failed"].includes(status);
  React.useEffect(() => {
    if (phase.kind !== "live" || finished) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [phase, finished]);

  // Auto-scroll the log only when already near the bottom.
  React.useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom || steps.length <= 1) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  // Lightbox: Esc closes, focus lands on Close, background scroll locks.
  React.useEffect(() => {
    if (lightbox === null) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight") setLightbox((i) => (i === null ? i : (i + 1) % Math.max(shots.length, 1)));
      if (e.key === "ArrowLeft") setLightbox((i) => (i === null ? i : (i - 1 + shots.length) % Math.max(shots.length, 1)));
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [lightbox, shots.length]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.ok) {
      setToken("");
      const saved = sessionStorage.getItem("sw_job");
      setPhase(saved ? { kind: "live", id: saved } : { kind: "idle" });
    } else {
      setPhase({ kind: "error", message: friendly(errCode(r.body), "Login failed."), code: errCode(r.body), back: "gate" });
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setUrlError(friendly("URL_INVALID", ""));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setUrlError(friendly("URL_BLOCKED", ""));
      return;
    }
    // Optional login: all-or-nothing (username + password + consent).
    const wantsAuth = authUser.trim() !== "" || authPass !== "" || loginUrl.trim() !== "";
    let auth: { username: string; password: string; loginUrl?: string } | undefined;
    if (wantsAuth) {
      if (authUser.trim() === "" || authPass === "") {
        setUrlError("Login needs both a username and a password — or leave all login fields empty.");
        return;
      }
      let loginPage: string | undefined;
      if (loginUrl.trim() !== "") {
        try {
          const lp = new URL(loginUrl.trim());
          if (lp.protocol !== "http:" && lp.protocol !== "https:") throw new Error("bad scheme");
          if (lp.origin !== parsed.origin) {
            setUrlError("The login page must be on the same site as the URL being captured.");
            return;
          }
          loginPage = lp.toString();
        } catch {
          setUrlError("That login page URL doesn't look valid.");
          return;
        }
      }
      if (!authConsent) {
        setUrlError("Confirm the login consent checkbox to use your credentials for this run.");
        return;
      }
      auth = { username: authUser.trim(), password: authPass, ...(loginPage ? { loginUrl: loginPage } : {}) };
    }
    setUrlError(null);
    setPhase({ kind: "starting" });
    const r = await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: parsed.toString(), viewport, format, maxSections: maxSec, ...(auth ? { auth } : {}) }),
    });
    setAuthPass(""); // password leaves component state the moment it is sent
    setShowPass(false);
    if (r.ok && typeof r.body === "object" && r.body !== null && "id" in r.body) {
      const id = (r.body as { id: string }).id;
      pushHistory(id, parsed.toString(), "queued");
      attach(id);
    } else if (r.status === 401) {
      setPhase({ kind: "gate" });
    } else {
      setPhase({ kind: "error", message: friendly(errCode(r.body), `Could not start the run (HTTP ${r.status}).`), code: errCode(r.body), back: "idle" });
    }
  };

  const detach = (id: string) => {
    stopStreams();
    sessionStorage.removeItem("sw_job");
    setPhase({ kind: "idle" });
    void id;
  };

  const remove = async (id: string) => {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    stopStreams();
    sessionStorage.removeItem("sw_job");
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      try { sessionStorage.setItem("sw_history", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setPhase({ kind: "idle" });
  };

  const copyLink = async (id: string) => {
    const link = `${window.location.origin}/app#job-${id}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the job link:", link);
    }
  };

  const clearHistory = () => {
    setHistory([]);
    try { sessionStorage.removeItem("sw_history"); } catch { /* ignore */ }
  };

  if (phase.kind === "gate") {
    return (
      <div className="wrap-narrow" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <p className="eyebrow">Site Walker console</p>
        <h1>Console sign-in</h1>
        <p className="lede">The console is token-gated. Enter the admin token to control the agent.</p>
        <form onSubmit={login} style={{ maxWidth: 420 }}>
          <div className="field">
            <label htmlFor="token">Admin token</label>
            <input id="token" type={showToken ? "text" : "password"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
          </div>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button className="btn" type="submit">Sign in</button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowToken((s) => !s)} aria-pressed={showToken}>
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </form>
        <p style={{ marginTop: 16 }}><a href="/">← Back to the landing page</a></p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="wrap-narrow" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <div className="error" role="alert">
          {phase.code && <span className="code-chip">{phase.code}</span>}
          {phase.message}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => setPhase({ kind: phase.back })}>Back</button>
          {phase.back === "idle" && (
            <button className="btn btn-ghost" onClick={() => setPhase({ kind: "idle" })}>Try again</button>
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === "starting") {
    return (
      <div className="wrap-narrow" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <p className="eyebrow">Starting the run</p>
        <div className="skeleton" aria-busy="true" aria-label="Starting the run">
          <div className="pulse">Contacting the agent…</div>
        </div>
      </div>
    );
  }

  if (phase.kind === "idle") {
    const cap = limits?.maxSections ?? 12;
    return (
      <div className="wrap-narrow" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <p className="eyebrow">Site Walker console</p>
        <h1>New run</h1>
        <p className="lede">Paste any website URL. The agent walks it in a real browser and captures each section.</p>
        <form onSubmit={start} style={{ maxWidth: 560 }} noValidate={false}>
          <div className="field">
            <label htmlFor="url">Website URL</label>
            <input
              id="url" type="url" value={url} onChange={(e) => { setUrl(e.target.value); setUrlError(null); }}
              placeholder="https://example.com" required aria-invalid={urlError ? "true" : undefined}
              aria-describedby={urlError ? "url-error" : "url-hint"} inputMode="url"
            />
            {urlError
              ? <p className="error" id="url-error" role="alert" style={{ margin: 0 }}>{urlError}</p>
              : <p className="hint" id="url-hint">Only sites you own or have permission to capture. Up to {cap} sections, one job at a time.</p>}
          </div>
          <div className="form-row cols3">
            <div className="field">
              <label htmlFor="maxsec">Sections (max)</label>
              <input
                id="maxsec" type="number" min={1} max={cap} value={maxSec}
                onChange={(e) => setMaxSec(Math.max(1, Math.min(cap, Number(e.target.value) || 1)))}
              />
            </div>
            <div className="field">
              <label htmlFor="vp">Viewport</label>
              <select id="vp" value={viewport} onChange={(e) => setViewport(e.target.value as "desktop" | "mobile")}>
                <option value="desktop">Desktop 1440×900</option>
                <option value="mobile">Mobile 390×844</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="fmt">Format</label>
              <select id="fmt" value={format} onChange={(e) => setFormat(e.target.value as "webp" | "png")}>
                <option value="webp">WebP</option>
                <option value="png">PNG</option>
              </select>
            </div>
          </div>
          <button className="btn" type="submit">Walk the site</button>
        </form>
        <form aria-label="Login (optional)" style={{ maxWidth: 560, marginTop: 8 }} onSubmit={start}>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "16px" }}>
            <legend style={{ fontSize: 13, padding: "0 8px" }}>Login (optional) — simple email + password forms</legend>
            <div className="field">
              <label htmlFor="login-url">Login page URL (optional, same site — defaults to the URL above)</label>
              <input
                id="login-url" type="url" value={loginUrl} onChange={(e) => { setLoginUrl(e.target.value); setUrlError(null); }}
                placeholder="https://example.com/login" inputMode="url"
              />
            </div>
            <div className="form-row cols2">
              <div className="field">
                <label htmlFor="auth-user">Username or email</label>
                <input id="auth-user" type="text" value={authUser} onChange={(e) => { setAuthUser(e.target.value); setUrlError(null); }} autoComplete="username" />
              </div>
              <div className="field">
                <label htmlFor="auth-pass">Password</label>
                <input
                  id="auth-pass" type={showPass ? "text" : "password"} value={authPass}
                  onChange={(e) => { setAuthPass(e.target.value); setUrlError(null); }} autoComplete="current-password"
                />
              </div>
            </div>
            <div className="field" style={{ flexDirection: "row", alignItems: "center", gap: 10, display: "flex" }}>
              <input
                id="auth-consent" type="checkbox" checked={authConsent} onChange={(e) => setAuthConsent(e.target.checked)}
                style={{ width: 20, height: 20, minHeight: 0, accentColor: "var(--ink)" }}
              />
              <label htmlFor="auth-consent" style={{ fontSize: 13 }}>
                This is my own account (or I have permission), and I accept that MFA/OTP, Google
                sign-in blocks, and CAPTCHAs may fail the login — failures are reported, never faked.
              </label>
            </div>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button className="btn btn-ghost" type="button" onClick={() => setShowPass((s) => !s)} aria-pressed={showPass}>
                {showPass ? "Hide password" : "Show password"}
              </button>
            </div>
          </fieldset>
        </form>
        <p className="notice" style={{ marginTop: 24, maxWidth: 560 }}>
          Passwords are used once for the run and never stored — not in logs, job files, or the
          ZIP. Capture only sites and accounts you own or have permission to capture. Private
          addresses, login walls, and bot-blocked pages are refused or reported — never faked.
        </p>
        <SavedSessions />
        {history.length > 0 && (
          <section aria-labelledby="hist-h" style={{ marginTop: 32 }}>
            <h2 id="hist-h">Recent runs on this device</h2>
            <ol className="steps5" style={{ padding: 0 }}>
              {history.map((h) => (
                <li key={h.id}>
                  <span className="n" aria-hidden="true">·</span>
                  <span>
                    <div style={{ overflowWrap: "anywhere" }}>{h.url}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {new Date(h.at).toLocaleString()} · {h.status} · <code className="inline">{h.id.slice(0, 8)}</code>
                    </div>
                    <div className="btn-row" style={{ marginTop: 8 }}>
                      <button className="btn btn-ghost" onClick={() => attach(h.id)}>Reopen</button>
                    </div>
                  </span>
                </li>
              ))}
            </ol>
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={clearHistory}>Clear history</button>
            </div>
          </section>
        )}
      </div>
    );
  }

  const id = phase.id;
  const total = discoveredTotal(steps) ?? jobSettings?.maxSections ?? shots.length;
  const doneCount = shots.length;
  const okCount = shots.filter((s) => s.file).length;
  const lb = lightbox !== null ? shots[lightbox] : null;
  return (
    <div className="wrap" style={{ paddingTop: 32, paddingBottom: 48 }}>
      <p><a href="/app" onClick={(e) => { e.preventDefault(); detach(id); }}>← New run</a></p>
      <p className="eyebrow">Run <code className="inline">{id.slice(0, 8)}</code></p>
      <h1 style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {jobUrl || "Walking the site…"} <StatusBadge status={status} />
      </h1>
      {note && <p className="notice">{note}</p>}
      <div className="card" style={{ marginBottom: 24 }}>
        <ProgressBar value={doneCount} max={Math.max(total, doneCount, 1)} label="Sections finished" />
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {okCount} captured · {elapsed}s elapsed · {steps.length} log events
          {typeof peakMb === "number" && peakMb > 0 ? ` · peak ${peakMb}MB` : ""}
        </div>
      </div>
      <h2>Steps</h2>
      <div className="log" ref={logRef} role="log" aria-label="Live capture log">
        {steps.length === 0 && <div><span className="t">··</span> waiting for the first event…</div>}
        {steps.map((s, i) => (
          <div key={i}>
            <span className="t">{s.t ? new Date(s.t).toLocaleTimeString() : i}</span>{" "}
            <span className={s.event.includes("failed") || s.event.includes("timeout") || s.event.includes("interrupted") ? "ev-bad" : "ev-ok"}>{s.event}</span>{" "}
            {s.detail}
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 32 }}>Sections ({shots.length})</h2>
      {shots.length === 0 && <p>No sections captured yet — they appear here as the agent finishes each one.</p>}
      <div className="gallery">
        {shots.map((s, i) => (
          <figure className="shot" style={{ margin: 0 }} key={i}>
            {s.file ? (
              <button className="shot-open" onClick={() => setLightbox(i)} aria-label={`Open full capture of ${s.name}`}>
                <img src={`/api/jobs/${id}/shots/${s.file}`} alt={`Capture of ${s.name}`} loading="lazy" />
              </button>
            ) : (
              <div style={{ padding: 24 }}><span className="ev-bad">{s.code}: {s.error}</span></div>
            )}
            <figcaption>
              {s.name} · {s.kind}
              {s.width ? ` · ${s.width}×${s.height} · ${s.bytes ? formatKB(s.bytes) : "?"}` : ""}
              {s.truncated ? " · truncated at height cap" : ""}
              <div className="btn-row" style={{ marginTop: 8 }}>
                {s.file && <a className="btn btn-ghost" href={`/api/jobs/${id}/shots/${s.file}`} download={s.file}>Download</a>}
                {s.elementCapture && <a className="btn btn-ghost" href={`/api/jobs/${id}/shots/${s.elementCapture}`}>Element close-up</a>}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
      {finished && (
        <div className="btn-row">
          <a className="btn" href={`/api/jobs/${id}/download.zip`}>Download ZIP</a>
          <button className="btn btn-ghost" onClick={() => copyLink(id)}>{copied ? "Copied!" : "Copy job link"}</button>
          <button className="btn btn-ghost" onClick={() => remove(id)}>Delete this run</button>
        </div>
      )}
      {!finished && (
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => detach(id)}>Watch later (keeps running)</button>
        </div>
      )}
      {lightbox !== null && lb && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Full capture of ${lb.name}`} onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-bar">
              <span style={{ fontSize: 13 }}>{lb.name} · {lightbox + 1}/{shots.length}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => setLightbox((lightbox - 1 + shots.length) % shots.length)} aria-label="Previous shot">←</button>
                <button className="btn btn-ghost" onClick={() => setLightbox((lightbox + 1) % shots.length)} aria-label="Next shot">→</button>
                <button className="btn" ref={closeRef} onClick={() => setLightbox(null)}>Close</button>
              </div>
            </div>
            {lb.file
              ? <img src={`/api/jobs/${id}/shots/${lb.file}`} alt={`Full capture of ${lb.name}`} />
              : <p style={{ padding: 24 }}>{lb.code}: {lb.error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
