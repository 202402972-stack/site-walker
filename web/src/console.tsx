// Console — plan §9.3. Token-gated agent control with live progress.
// States: gate, idle, invalid, blocked, queued, running, partial, done,
// busy, rate-limited, expired, lost-connection (auto-reconnect).
import React from "react";

type Phase =
  | { kind: "gate" }
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live"; id: string }
  | { kind: "error"; message: string; code?: string };

interface Step { t: string; event: string; detail?: string }
interface Shot { name: string; url: string; kind: string; file?: string; width?: number; height?: number; bytes?: number; truncated?: boolean; elementCapture?: string; error?: string; code?: string }

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

export function Console(): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>(() => {
    if (typeof sessionStorage !== "undefined") {
      const saved = sessionStorage.getItem("sw_job");
      if (saved) return { kind: "live", id: saved };
    }
    return { kind: "gate" };
  });
  const [token, setToken] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [viewport, setViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [format, setFormat] = React.useState<"webp" | "png">("webp");
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [shots, setShots] = React.useState<Shot[]>([]);
  const [status, setStatus] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const pollRef = React.useRef<number | null>(null);
  const esRef = React.useRef<EventSource | null>(null);

  const stopStreams = React.useCallback(() => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  const attach = React.useCallback((id: string) => {
    sessionStorage.setItem("sw_job", id);
    setPhase({ kind: "live", id });
    setSteps([]);
    setShots([]);
    setStatus("queued");
    setNote(null);

    const onData = (payload: { status: string; steps: Step[]; sections: Shot[] }) => {
      setSteps(payload.steps ?? []);
      setShots(payload.sections ?? []);
      setStatus(payload.status);
      if (["done", "partial", "failed"].includes(payload.status)) {
        stopStreams();
        sessionStorage.removeItem("sw_job");
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
        setPhase({ kind: "error", message: "That job is gone — results expire after retention. Start a new run." });
        return;
      }
      if (r.status === 401) {
        stopStreams();
        setPhase({ kind: "gate" });
        return;
      }
      if (r.ok && typeof r.body === "object" && r.body !== null) onData(r.body as { status: string; steps: Step[]; sections: Shot[] });
    }, 2000);
  }, [stopStreams]);

  React.useEffect(() => {
    if (phase.kind === "live") attach(phase.id);
    return stopStreams;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setPhase({ kind: "error", message: friendly(errCode(r.body), "Login failed."), code: errCode(r.body) });
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setPhase({ kind: "error", message: friendly("URL_INVALID", "") });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setPhase({ kind: "error", message: friendly("URL_BLOCKED", "") });
      return;
    }
    setPhase({ kind: "starting" });
    const r = await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: parsed.toString(), viewport, format }),
    });
    if (r.ok && typeof r.body === "object" && r.body !== null && "id" in r.body) {
      attach((r.body as { id: string }).id);
    } else if (r.status === 401) {
      setPhase({ kind: "gate" });
    } else {
      setPhase({ kind: "error", message: friendly(errCode(r.body), `Could not start the run (HTTP ${r.status}).`), code: errCode(r.body) });
    }
  };

  const remove = async (id: string) => {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    stopStreams();
    sessionStorage.removeItem("sw_job");
    setPhase({ kind: "idle" });
  };

  if (phase.kind === "gate") {
    return (
      <div className="wrap" style={{ paddingTop: 48 }}>
        <h1>Console sign-in</h1>
        <p>The console is token-gated. Enter the admin token to control the agent.</p>
        <form onSubmit={login} style={{ maxWidth: 420 }}>
          <div className="field">
            <label htmlFor="token">Admin token</label>
            <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
          </div>
          <button className="btn" type="submit">Sign in</button>
        </form>
        <p style={{ marginTop: 16 }}><a href="/">← Back to the landing page</a></p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="wrap" style={{ paddingTop: 48 }}>
        <div className="error" role="alert">{phase.message}</div>
        <p style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => setPhase({ kind: "idle" })}>Back to the console</button>
        </p>
      </div>
    );
  }

  if (phase.kind === "starting") {
    return <div className="wrap" style={{ paddingTop: 48 }}><p>Starting the run…</p></div>;
  }

  if (phase.kind === "idle") {
    return (
      <div className="wrap" style={{ paddingTop: 48 }}>
        <h1>New run</h1>
        <p>Paste any website URL. The agent walks it in a real browser and captures each section.</p>
        <form onSubmit={start} style={{ maxWidth: 560 }}>
          <div className="field">
            <label htmlFor="url">Website URL</label>
            <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" required />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="vp">Viewport</label>
              <select id="vp" value={viewport} onChange={(e) => setViewport(e.target.value as "desktop" | "mobile")}>
                <option value="desktop">Desktop 1440×900</option>
                <option value="mobile">Mobile 390×844</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="fmt">Format</label>
              <select id="fmt" value={format} onChange={(e) => setFormat(e.target.value as "webp" | "png")}>
                <option value="webp">WebP</option>
                <option value="png">PNG</option>
              </select>
            </div>
          </div>
          <button className="btn" type="submit">Walk the site</button>
        </form>
        <p className="notice" style={{ marginTop: 24, maxWidth: 560 }}>
          Capture only sites you own or have permission to capture. Private addresses, login walls,
          and bot-blocked pages are refused or reported — never faked.
        </p>
      </div>
    );
  }

  const id = phase.id;
  const finished = ["done", "partial", "failed"].includes(status);
  return (
    <div className="wrap" style={{ paddingTop: 32, paddingBottom: 48 }}>
      <p><a href="/app" onClick={(e) => { e.preventDefault(); stopStreams(); sessionStorage.removeItem("sw_job"); setPhase({ kind: "idle" }); }}>← New run</a></p>
      <h1>Run <code className="inline">{id.slice(0, 8)}</code> — {status || "connecting…"}</h1>
      {note && <p className="notice">{note}</p>}
      <h2>Steps</h2>
      <div className="log" role="log" aria-label="Live capture log">
        {steps.length === 0 && <div><span className="t">··</span> waiting for the first event…</div>}
        {steps.map((s, i) => (
          <div key={i}>
            <span className="t">{s.t ? new Date(s.t).toLocaleTimeString() : i}</span>{" "}
            <span className={s.event.includes("failed") || s.event.includes("timeout") ? "ev-bad" : "ev-ok"}>{s.event}</span>{" "}
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
              <img src={`/api/jobs/${id}/shots/${s.file}`} alt={`Capture of ${s.name}`} loading="lazy" />
            ) : (
              <div style={{ padding: 24 }}><span className="ev-bad">{s.code}: {s.error}</span></div>
            )}
            <figcaption>
              {s.name} · {s.kind}
              {s.width ? ` · ${s.width}×${s.height} · ${s.bytes ? Math.round(s.bytes / 1024) : "?"}KB` : ""}
              {s.truncated ? " · truncated at height cap" : ""}
              {s.elementCapture && <> · <a href={`/api/jobs/${id}/shots/${s.elementCapture}`}>element close-up</a></>}
            </figcaption>
          </figure>
        ))}
      </div>
      {finished && (
        <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
          <a className="btn" href={`/api/jobs/${id}/download.zip`}>Download ZIP</a>
          <button className="btn btn-ghost" onClick={() => remove(id)}>Delete this run</button>
        </div>
      )}
    </div>
  );
}
