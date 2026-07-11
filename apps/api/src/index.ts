import { Hono } from "hono";
import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";
import { basicAuthMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { bodySizeLimit } from "./middleware/body-size.js";
import { handleOtlpIngest } from "./routes/otlp.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES ?? 1_048_576); // 1 MiB

// Build the API as a small Hono app so we can mount auth middleware cleanly
// around /v1/* before delegating to OpenAPIHono (which has the typed routes).
const apiApp = new Hono();

// Security headers (applied to ALL responses, public + auth-gated).
apiApp.use(securityHeaders());

// Body size limit (1 MiB by default; raise via API_MAX_BODY_BYTES env).
// Applied BEFORE auth so unauth'd large payloads don't waste auth work.
apiApp.use(bodySizeLimit(MAX_BODY_BYTES));

// Public routes (no auth): health checks + OpenAPI doc + Scalar UI
apiApp.get("/health", (c) => handleHealth());
apiApp.get("/v1/health", (c) => handleHealth());

// Auth middleware applies to all /v1/* routes EXCEPT /v1/health.
apiApp.use("/v1/*", basicAuthMiddleware());

// OTLP HTTP/JSON trace ingest — auth-gated (mounted before openapiApp)
// Mounted as raw handler (not via openapiApp) because it consumes the raw
// JSON body and returns a non-typed OTLP response shape.
apiApp.post("/v1/otel/v1/traces", (c) => handleOtlpIngest(c.req.raw));

// Mount OpenAPIHono at /v1/* for all other typed routes.
// (OpenAPIHono internally resolves paths relative to its mount point.)
apiApp.route("/", openapiApp);

console.log(`✓ Astraea API listening on :${PORT}`);
console.log(`  OpenAPI JSON: http://localhost:${PORT}/openapi.json`);
console.log(`  OpenAPI ref:  http://localhost:${PORT}/reference`);
console.log(`  Health:       http://localhost:${PORT}/health`);
console.log(`  OTLP ingest:  POST http://localhost:${PORT}/v1/otel/v1/traces`);
console.log(`  Auth:          Basic (UI_USERNAME / UI_PASSWORD from env)`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: apiApp.fetch,
};