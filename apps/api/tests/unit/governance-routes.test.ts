import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const policyId = "33333333-3333-4333-8333-333333333333";
const calls: string[] = [];
let approvalConflict = false;

const query = mock(async (statement: string, values: string[] = []) => {
	calls.push(statement);
	if (
		statement === "BEGIN" ||
		statement === "COMMIT" ||
		statement === "ROLLBACK"
	)
		return { rows: [] };
	if (statement.startsWith("SELECT CASE WHEN om.role")) {
		if (values[0] === otherProjectId) return { rows: [] };
		return { rows: [{ role: values[2] === "member" ? "member" : "manager" }] };
	}
	if (
		statement.startsWith("SELECT v.id, v.version") &&
		statement.includes("WHERE v.id")
	)
		return {
			rows: [
				{
					id: policyId,
					version: 1,
					retention: {},
					redaction: { mode: "none", keys: [] },
					content_hash: "a".repeat(64),
					created_by: "manager",
					created_at: new Date("2026-01-01T00:00:00Z"),
					approved_by: null,
					approved_at: null,
				},
			],
		};
	if (statement.startsWith("SELECT v.id, v.version")) return { rows: [] };
	if (statement.startsWith("INSERT INTO governance_policy_approvals"))
		return { rows: approvalConflict ? [] : [{ approved_at: new Date() }] };
	return { rows: [] };
});

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const {
	approvePolicy,
	handleApprovePolicy,
	handlePreviewRetention,
	previewRetention,
} = await import("../../src/routes/governance");
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
		actor: c.req.header("x-test-actor") ?? "manager",
		organizationId,
	});
	return next();
});
app.openapi(previewRetention, handlePreviewRetention);
app.openapi(approvePolicy, handleApprovePolicy);

function request(actor: string, path: string, init?: RequestInit) {
	return app.request(`http://test${path}`, {
		...init,
		headers: { "content-type": "application/json", "x-test-actor": actor },
	});
}

describe("governance route guards", () => {
	it("rejects members, cross-project access, and unapproved retention previews", async () => {
		calls.length = 0;
		for (const [actor, target, status] of [
			["member", projectId, 403],
			["manager", otherProjectId, 404],
			["manager", projectId, 409],
		] as const) {
			const response = await request(
				actor,
				"/v1/governance/retention/preview",
				{
					method: "POST",
					body: JSON.stringify({ project_id: target }),
				},
			);
			expect(response.status).toBe(status);
		}
		expect(calls.some((call) => call.includes("retention_previewed"))).toBe(
			false,
		);
	});

	it("commits policy approval and its immutable audit event together", async () => {
		calls.length = 0;
		approvalConflict = false;
		const response = await request(
			"manager",
			`/v1/governance/policy/${policyId}/approve?project_id=${projectId}`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		expect(calls).toEqual(
			expect.arrayContaining([
				"BEGIN",
				expect.stringContaining("governance_policy_approvals"),
				expect.stringContaining("'policy_approved'"),
				"COMMIT",
			]),
		);
	});

	it("records no approval audit event when approval conflicts", async () => {
		calls.length = 0;
		approvalConflict = true;
		const response = await request(
			"manager",
			`/v1/governance/policy/${policyId}/approve?project_id=${projectId}`,
			{ method: "POST" },
		);
		expect(response.status).toBe(409);
		expect(calls.some((call) => call.includes("'policy_approved'"))).toBe(
			false,
		);
		expect(calls).toContain("ROLLBACK");
		approvalConflict = false;
	});
});
