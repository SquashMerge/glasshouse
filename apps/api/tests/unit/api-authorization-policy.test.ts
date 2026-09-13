import { afterEach, expect, test } from "bun:test";

const projectId = "11111111-1111-4111-8111-111111111111";
const originalUsername = process.env.UI_USERNAME;
const originalPassword = process.env.UI_PASSWORD;
process.env.UI_USERNAME = "policy-user";
process.env.UI_PASSWORD = "policy-secret";
const { createApiApp } = await import("../../src/index");

afterEach(() => {
	if (originalUsername === undefined) delete process.env.UI_USERNAME;
	else process.env.UI_USERNAME = originalUsername;
	if (originalPassword === undefined) delete process.env.UI_PASSWORD;
	else process.env.UI_PASSWORD = originalPassword;
});

test("classifies curation writes, executions, and governed promotions at the server boundary", async () => {
	const operations: string[] = [];
	const app = createApiApp({
		assertTenantProjectAccess: async (_pool, _tenant, _project, operation) => {
			operations.push(operation);
		},
	});
	const authorization = `Basic ${Buffer.from("policy-user:policy-secret").toString("base64")}`;

	await app.request(`http://localhost/v1/datasets`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify({ project_id: projectId, name: "Dataset" }),
	});
	await app.request(`http://localhost/v1/feedback`, {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"idempotency-key": "policy-feedback",
		},
		body: JSON.stringify({ project_id: projectId }),
	});
	await app.request(
		`http://localhost/v1/prompt-optimizations/22222222-2222-4222-8222-222222222222/promote?project_id=${projectId}`,
		{ method: "POST", headers: { authorization } },
	);
	await app.request(`http://localhost/v1/experiments`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify({ project_id: projectId }),
	});
	await app.request(
		`http://localhost/v1/evaluation-runs/22222222-2222-4222-8222-222222222222/tasks/33333333-3333-4333-8333-333333333333/agent-introspection/44444444-4444-4444-8444-444444444444?project_id=${projectId}`,
		{
			method: "PUT",
			headers: { authorization, "content-type": "application/json" },
			body: "{}",
		},
	);

	expect(operations).toEqual([
		"curation_write",
		"curation_write",
		"governed",
		"execute",
		"ingest",
	]);
});
