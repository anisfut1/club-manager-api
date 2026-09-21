import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import type { AppEnv } from "@/auth/context";
import { ApiError } from "@/api-error";
import { getEnv } from "@/config/env";
import { v1Router } from "@/api/v1/index";
import { internalRouter } from "@/api/internal/index";
import { generateOpenApiDocument } from "@/openapi";
import { logError } from "@/logger";

export const app = new Hono<AppEnv>();

/**
 * CORS (§39 de la demande) : liste configurable d'origines, jamais un
 * wildcard avec authentification. `FRONTEND_ORIGINS` est une liste séparée
 * par des virgules (voir .env.example).
 */
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = getEnv().FRONTEND_ORIGINS.split(",").map((o) => o.trim());
      return origin && allowed.includes(origin) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }),
);

/** GET /health — §41 de la demande : simple, sans auth, sans secret. */
app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/openapi.json", (c) => c.json(generateOpenApiDocument()));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

app.route("/v1", v1Router);
app.route("/internal", internalRouter);

/**
 * Contrat d'erreur uniforme (§40 de la demande) : `{ error: { code,
 * message } }`, jamais de stack trace en production.
 */
app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400 | 401 | 403 | 404 | 409 | 500);
  }

  logError("Erreur interne non gérée", error, { path: c.req.path, method: c.req.method });
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Une erreur interne est survenue." } }, 500);
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
