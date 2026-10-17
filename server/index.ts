// Fastify bootstrap — plan §6/§8/§11. Serves web/dist static + /api/* with auth cookie.
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerConfigRoute } from "./routes/config.js";
import { retentionSweep, recoverStaleJobs } from "./jobs/store.js";
import { pruneSessions } from "./jobs/sessions.js";

const app = Fastify({ logger: true, trustProxy: true });

await app.register(cookie);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
    },
  },
});

// Static landing + console (M4 builds web/dist; 404 falls through to index for SPA routes).
const dist = path.join(process.cwd(), "web", "dist");
if (fs.existsSync(dist)) {
  // Canonical/OG/sitemap URLs are baked at build time; when the build env had no
  // PUBLIC_BASE_URL they carry localhost. Rewrite once at boot so the deployed
  // domain always wins (served from memory — no file writes needed).
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const indexHtml = fs
    .readFileSync(path.join(dist, "index.html"), "utf8")
    .replaceAll("http://localhost:8080", base);
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(indexHtml));
  app.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`));
  app.get("/sitemap.xml", async (_req, reply) =>
    reply.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${base}/</loc></url>\n</urlset>\n`,
    ));
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  // Console entry (noindex via app.html meta + robots). Registered before SPA fallback.
  app.get("/app", async (_req, reply) => reply.sendFile("app.html"));
  app.get("/app/", async (_req, reply) => reply.sendFile("app.html"));
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "URL_INVALID", message: "Not found." } });
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
}

app.get("/healthz", async () => ({ ok: true, product: config.PRODUCT_NAME }));

await registerAuthRoutes(app);
await registerJobRoutes(app);
await registerSessionRoutes(app);
await registerConfigRoute(app);

// Orphaned jobs from a previous process are marked failed before we serve traffic.
recoverStaleJobs()
  .then((ids) => { if (ids.length > 0) app.log.info({ recovered: ids }, "stale jobs marked failed at boot"); })
  .catch(() => {});

// Expired saved sessions are pruned at boot (and hourly with the sweep).
pruneSessions()
  .then((n) => { if (n > 0) app.log.info({ pruned: n }, "saved sessions pruned at boot"); })
  .catch(() => {});

// Retention sweep hourly.
setInterval(() => {
  retentionSweep().then((d) => { if (d.length > 0) app.log.info({ deleted: d }, "retention sweep"); }).catch(() => {});
  pruneSessions().catch(() => {});
}, 3600 * 1000);

const port = config.PORT;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`[${config.PRODUCT_NAME}] listening on :${port}`);
});
