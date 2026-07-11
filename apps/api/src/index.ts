import { Hono } from "hono";
import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";
import { basicAuthMiddleware } from "./middleware/auth.js";
import { loginRoute, handleLogin } from "./routes/auth.js";
import { handleOtlpIngest } from "./routes/otlp.js";

const PORT = Number(process.env.API_PORT ?? 3000);

// Build the API as a small Hono app so we can mount auth middleware cleanly
// around /v1/* before delegating to OpenAPIHono (which has the typed routes).
const apiApp = new Hono();

// Public routes (no auth): health checks + OpenAPI doc + Scalar UI
apiApp.get("/health", (c) => handleHealth());
apiApp.get("/v1/health", (c) => handleHealth());

// Auth middleware applies to all /v1/* routes EXCEPT /v1/health.
apiApp.use("/v1/*", basicAuthMiddleware());

// Auth-managed login endpoint
apiApp.openapi(loginRoute, handleLogin);

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