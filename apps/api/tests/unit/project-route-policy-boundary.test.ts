import { expect, mock, spyOn, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";

const tenancy = await import("../../src/tenancy.js");
const postgres = await import("../../src/db/postgres.js");

const { TRUSTED_TENANT_CONTEXT_KEY } = await import(
	"../../src/middleware/auth.js"
);
const { archiveProject, handleArchiveProject } = await import(
	"../../src/routes/projects.js"
);
const { getEffectivePolicy, handleGetEffectivePolicy } = await import(
	"../../src/routes/governance.js"
);

test("denies strict project lifecycle changes before legacy route SQL can run", async () => {
	const assertTenantProjectAccess = mock(async () => {
		throw new tenancy.TenantScopeError("Project is not available");
	});
	const query = mock(async () => {
		throw new Error("database must not be reached after policy denial");
	});
	const tenancySpy = spyOn(
		tenancy,
		"assertTenantProjectAccess",
	).mockImplementation(assertTenantProjectAccess);
	const postgresSpy = spyOn(postgres, "pgPool").mockReturnValue({
		query,
		connect: async () => ({ query, release() {} }),
	} as unknown as ReturnType<typeof postgres.pgPool>);
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

	try {
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
	} finally {
		tenancySpy.mockRestore();
		postgresSpy.mockRestore();
	}
});

test("does not leak policy denial into a governance manager request", async () => {
	const query = mock(async (statement: string) => {
		if (statement.includes("authorization_effective_project_role"))
			return {
				rows: [
					{
						effective_role: "user",
						enforcement: "compatibility",
						project_status: "active",
						allowed: true,
					},
				],
			};
		if (statement.startsWith("SELECT CASE WHEN om.role"))
			return { rows: [{ role: "manager" }] };
		if (statement.startsWith("SELECT v.id")) return { rows: [] };
		throw new Error(`unexpected query: ${statement}`);
	});
	const postgresSpy = spyOn(postgres, "pgPool").mockReturnValue({
		query,
		connect: async () => ({ query, release() {} }),
	} as unknown as ReturnType<typeof postgres.pgPool>);
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
			actor: "manager",
			actorId,
			organizationId,
		});
		await next();
	});
	app.openapi(getEffectivePolicy, handleGetEffectivePolicy);

	try {
		const response = await app.request(
			`http://localhost/v1/governance/policy?project_id=${projectId}`,
		);

		expect(response.status).toBe(200);
	} finally {
		postgresSpy.mockRestore();
	}
});
