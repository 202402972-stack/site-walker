// Saved-session API — list, import, delete. Auth-gated like every job route;
// listings are metadata-only; imports are host-filtered and size-capped.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { verifySession } from "../auth.js";
import {
  deleteSession,
  listSessions,
  normalizeImport,
  saveSession,
  type StorageState,
} from "../jobs/sessions.js";

function authed(req: FastifyRequest): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.["sw_session"];
  return verifySession(cookie);
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  // Metadata only: origin, savedAt, cookie count. Never cookie values.
  app.get("/api/sessions", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    return reply.send({ sessions: await listSessions() });
  });

  // Import a session the owner exported from their own browser (where any
  // CAPTCHA was solved by a human). Accepts Playwright storageState JSON or a
  // raw cookies array; cookies for other hosts are dropped.
  app.post("/api/sessions/import", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const body = req.body as { url?: unknown; state?: unknown; label?: unknown } | null;
    if (!body || typeof body.url !== "string" || typeof body.state !== "object" || body.state === null) {
      return reply.code(400).send({ error: { code: "SESSION_INVALID", message: "Body must be { url, state, label? }." } });
    }
    let size = 0;
    try {
      size = JSON.stringify(body.state).length;
    } catch {
      return reply.code(400).send({ error: { code: "SESSION_INVALID", message: "state is not serializable JSON." } });
    }
    if (size > config.MAX_SESSION_BYTES) {
      return reply.code(413).send({
        error: { code: "SESSION_TOO_LARGE", message: `Session import exceeds ${Math.round(config.MAX_SESSION_BYTES / 1024)} KB.` },
      });
    }
    const norm = normalizeImport(body.url, body.state);
    if (!norm.ok) return reply.code(400).send({ error: { code: "SESSION_INVALID", message: norm.reason } });
    const label = typeof body.label === "string" ? body.label : undefined;
    const meta = await saveSession(new URL(body.url).origin, norm.state as StorageState, label);
    return reply.code(201).send({
      session: { id: meta.id, origin: meta.origin, savedAt: meta.savedAt, cookieCount: meta.cookieCount, label: meta.label },
      droppedCookies: norm.dropped,
    });
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const id = (req.params as { id?: string }).id ?? "";
    // Only hex ids (our sha256-derived naming) reach the filesystem.
    if (!/^[a-f0-9]{24}$/.test(id)) {
      return reply.code(400).send({ error: { code: "SESSION_INVALID", message: "Bad session id." } });
    }
    const ok = await deleteSession(id);
    if (!ok) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No such session." } });
    return reply.send({ ok: true });
  });
}
