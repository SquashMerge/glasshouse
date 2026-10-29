import { expect, test } from "bun:test";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth.js";
import { TenantScopeError } from "../../src/tenancy.js";

const tenant = {
	actor: "collector",
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
};
const projectId = "33333333-3333-4333-8333-333333333333";

test("maps a revocation race during OTLP ingest to project unavailable", async () => {
	process.env.UI_USERNAME ??= "test-user";
	process.env.UI_PASSWORD ??= "test-password";
	const { createApiApp } = await import("../../src/index.js");
	const app = createApiApp({
		authenticate: () => async (c, next) => {
			c.set(TRUSTED_TENANT_CONTEXT_KEY, tenant);
			await next();
		},
		resolveTenantProject: async () => ({ ...tenant, projectId }) as never,
		handleOtlpIngest: async () => {
			throw new TenantScopeError("Credential is revoked");
		},
	});

	const response = await app.request("/v1/otel/v1/traces", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-glasshouse-project-id": projectId,
		},
		body: JSON.stringify({ resource_spans: [] }),
	});

	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		code: "NOT_FOUND",
		message: "Project is not available",
	});
});
