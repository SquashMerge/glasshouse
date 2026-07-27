import { Hono } from "hono";
import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";
import { basicAuthMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { bodySizeLimit } from "./middleware/body-size.js";
import { handleOtlpIngest } from "./routes/otlp.js";
import { logger } from "./lib/logger.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES ?? 1_048_576);

export type ApiDependencies = {
	handleHealth: typeof handleHealth;
	handleOtlpIngest: typeof handleOtlpIngest;
};

const productionApiDependencies: ApiDependencies = {
	handleHealth,
	handleOtlpIngest,
};

export function createApiApp(
	dependencies: ApiDependencies = productionApiDependencies,
): Hono {
	const apiApp = new Hono();

	apiApp.use("*", async (c, next) => {
		const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
		c.header("x-request-id", requestId);
		const startedAt = performance.now();
		try {
			await next();
		} finally {
			const durationMs = Math.round(performance.now() - startedAt);
			const fields = {
				request_id: requestId,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				duration_ms: durationMs,
			};
			if (c.req.path === "/health" || c.req.path === "/v1/health")
				logger.debug("http.request", fields);
			else if (c.res.status >= 500)
				logger.error("http.request.failed", undefined, fields);
			else if (c.res.status >= 400)
				logger.warn("http.request.rejected", fields);
			else logger.info("http.request", fields);
		}
	});
	apiApp.onError((error, c) => {
		logger.error("http.unhandled_error", error, {
			method: c.req.method,
			path: c.req.path,
		});
		return c.json({ code: "INTERNAL", message: "Internal server error" }, 500);
	});

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
	apiApp.use("/v1/prompt-optimizations/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	apiApp.use("/v1/*", basicAuthMiddleware());

	// OTLP is mounted as a raw handler (not via openapiApp) because it consumes
	// the raw JSON body and returns a non-typed OTLP response shape.
	apiApp.post("/v1/otel/v1/traces", (c) =>
		dependencies.handleOtlpIngest(c.req.raw),
	);

	apiApp.route("/", openapiApp);
	return apiApp;
}

const apiApp = createApiApp();

logger.info("api.started", {
	port: PORT,
	host: "0.0.0.0",
	log_level: process.env.LOG_LEVEL ?? "info",
});
logger.info("api.routes_ready", {
	openapi: `/openapi.json`,
	reference: `/reference`,
	health: `/health`,
	otlp_ingest: "/v1/otel/v1/traces",
});

export default {
	port: PORT,
	hostname: "0.0.0.0",
	fetch: apiApp.fetch,
};
