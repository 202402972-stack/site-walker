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
import { retentionSweep } from "./jobs/store.js";

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
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "URL_INVALID", message: "Not found." } });
    return reply.sendFile("index.html");
  });
}

app.get("/healthz", async () => ({ ok: true, product: config.PRODUCT_NAME }));

await registerAuthRoutes(app);
await registerJobRoutes(app);

// Retention sweep hourly.
setInterval(() => {
  retentionSweep().then((d) => { if (d.length > 0) app.log.info({ deleted: d }, "retention sweep"); }).catch(() => {});
}, 3600 * 1000);

const port = config.PORT;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`[${config.PRODUCT_NAME}] listening on :${port}`);
});
