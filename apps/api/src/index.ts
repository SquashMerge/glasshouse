import { Hono } from "hono";
import { except } from "hono/combine";
import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";
import { basicAuthMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { bodySizeLimit } from "./middleware/body-size.js";
import { handleOtlpIngest } from "./routes/otlp.js";
import { customerCredentialAuthMiddleware } from "./middleware/customer-credential-auth.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES ?? 1_048_576);

export type ApiDependencies = {
  handleHealth: typeof handleHealth;
  handleOtlpIngest: typeof handleOtlpIngest;
};

const productionApiDependencies: ApiDependencies = { handleHealth, handleOtlpIngest };

export function createApiApp(dependencies: ApiDependencies = productionApiDependencies): Hono {
  const apiApp = new Hono();

  apiApp.use(securityHeaders());
  // Body size limit applied before auth so unauth'd large payloads don't waste auth work.
  apiApp.use(bodySizeLimit(MAX_BODY_BYTES));

  apiApp.get("/health", () => dependencies.handleHealth());
  apiApp.get("/v1/health", () => dependencies.handleHealth());

  apiApp.use("/v1/prompts/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  apiApp.use("/v1/prompt-provenance/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  apiApp.use("/v1/customer/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  apiApp.use("/v1/customer/*", customerCredentialAuthMiddleware());
  apiApp.use("/v1/*", except("/v1/customer/*", basicAuthMiddleware()));

  // OTLP is mounted as a raw handler (not via openapiApp) because it consumes
  // the raw JSON body and returns a non-typed OTLP response shape.
  apiApp.post("/v1/otel/v1/traces", (c) => dependencies.handleOtlpIngest(c.req.raw));

  apiApp.route("/", openapiApp);
  return apiApp;
}

const apiApp = createApiApp();

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
