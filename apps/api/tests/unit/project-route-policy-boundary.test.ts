import { expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";

const tenancy = await import("../../src/tenancy.js");
const assertTenantProjectAccess = mock(async () => {
	throw new tenancy.TenantScopeError("Project is not available");
});
mock.module("../../src/tenancy.js", () => ({
	...tenancy,
	assertTenantProjectAccess,
}));

const postgres = await import("../../src/db/postgres.js");
const query = mock(async () => {
	throw new Error("database must not be reached after policy denial");
});
mock.module("../../src/db/postgres.js", () => ({
	...postgres,
	pgPool: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const { TRUSTED_TENANT_CONTEXT_KEY } = await import(
	"../../src/middleware/auth.js"
);
const { archiveProject, handleArchiveProject } = await import(
	"../../src/routes/projects.js"
);

test("denies strict project lifecycle changes before legacy route SQL can run", async () => {
	const app = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	app.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reader",
			actorId,
			organizationId,
		});
		await next();
	});
	app.openapi(archiveProject, handleArchiveProject);

	const response = await app.request(
		`http://localhost/v1/projects/${projectId}/archive`,
		{ method: "POST" },
	);

	expect(response.status).toBe(404);
	expect(assertTenantProjectAccess).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ actorId, organizationId }),
		projectId,
		"project_manage",
	);
	expect(query).not.toHaveBeenCalled();
});
