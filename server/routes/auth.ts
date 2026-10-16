import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { tokenMatches, isRateLimited, recordAttempt, clearAttempts, issueSession } from "../auth.js";

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (req, reply) => {
    const ip = req.ip;
    if (isRateLimited(ip)) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in 15 minutes." } });
    const parsed = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body);
    if (!parsed.success) { recordAttempt(ip); return reply.code(400).send({ error: { code: "UNAUTHORIZED", message: "Token required." } }); }
    if (!tokenMatches(parsed.data.token)) { recordAttempt(ip); return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid token." } }); }
    clearAttempts(ip);
    const session = issueSession();
    return reply
      .setCookie("sw_session", session, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 24 * 3600 })
      .send({ ok: true, product: config.PRODUCT_NAME });
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    return reply.clearCookie("sw_session", { path: "/" }).send({ ok: true });
  });
}
