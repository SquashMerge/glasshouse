import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const policyId = "33333333-3333-4333-8333-333333333333";
const verifiedActorId = "33333333-3333-4333-8333-333333333333";
const previewId = "55555555-5555-4555-8555-555555555555";
const previewExpiresAt = new Date("2026-08-29T20:00:00.000Z");
const calls: string[] = [];
const previewConsumeValues: string[][] = [];
let approvalConflict = false;
let permittedActorId = verifiedActorId;
let approvedPolicyAvailable = false;
let legacyManagerProjection = true;

function approvedPolicy() {
	return {
		id: policyId,
		version: 1,
		retention: { feedback: 30 },
		redaction: { mode: "none", keys: [] },
		content_hash: "a".repeat(64),
		created_by: "manager",
		created_at: new Date("2026-01-01T00:00:00Z"),
		approved_by: `actor:${verifiedActorId}`,
		approved_by_username: "dan",
		approved_at: new Date("2026-01-01T00:00:00Z"),
	};
}

const query = mock(async (statement: string, values: string[] = []) => {
	calls.push(statement);
	if (
		statement.includes("UPDATE governance_retention_previews SET consumed_at")
	)
		previewConsumeValues.push(values);
	if (
		statement === "BEGIN" ||
		statement === "COMMIT" ||
		statement === "ROLLBACK"
	)
		return { rows: [] };
	if (statement.includes("authorization_effective_project_role")) {
		const allowed =
			values[1] !== otherProjectId &&
			values[2] !== "member" &&
			(values[2] === "manager" || values[2] === permittedActorId);
		return {
			rows: [
				{
					effective_role: allowed ? "user" : "read_only",
					enforcement: "compatibility",
					project_status: "active",
					allowed,
				},
			],
		};
	}
	if (statement.startsWith("SELECT CASE WHEN om.role")) {
		if (values[0] === otherProjectId) return { rows: [] };
		if (!legacyManagerProjection) return { rows: [] };
		return { rows: [{ role: values[2] === "member" ? "member" : "manager" }] };
	}
	if (statement.includes("p.status = ANY($3::text[])"))
		return values[0] === otherProjectId
			? { rows: [] }
			: { rows: [{ id: projectId }] };
	if (statement.includes("MAX(credential.username)"))
		return { rows: [{ username: "dan" }] };
	if (statement.includes("FROM organization_memberships om"))
		return { rows: [{ actor_subject: "manager" }] };
	if (statement.includes("FROM project_memberships pm"))
		return { rows: [{ actor_subject: "manager" }] };
	if (statement.startsWith("SELECT authorization_allows_project"))
		return {
			rows: [
				{ allowed: values[2] === "manager" || values[2] === permittedActorId },
			],
		};
	if (statement.startsWith("SELECT p.id FROM projects"))
		return values[2] === "manager" || values[2] === permittedActorId
			? { rows: [{ id: projectId }] }
			: { rows: [] };
	if (
		statement.includes("JOIN governance_policy_approvals a ON") &&
		!statement.includes("LEFT JOIN governance_policy_approvals")
	)
		return { rows: [approvedPolicy()] };
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
					approved_by_username: null,
					approved_at: null,
				},
			],
		};
	if (
		statement.startsWith("SELECT v.id, v.version") &&
		statement.includes("LEFT JOIN governance_policy_approvals")
	)
		return { rows: approvedPolicyAvailable ? [approvedPolicy()] : [] };
	if (statement.startsWith("SELECT v.id, v.version")) return { rows: [] };
	if (
		statement.startsWith("SELECT count(*)::text AS count FROM feedback_reviews")
	)
		return { rows: [{ count: "7" }] };
	if (statement.startsWith("INSERT INTO governance_retention_previews"))
		return { rows: [{ id: previewId, expires_at: previewExpiresAt }] };
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
	handleGetEffectivePolicy,
	handleListPolicyHistory,
	handleListRetentionRuns,
	handlePreviewRetention,
	handleRunRetention,
	getEffectivePolicy,
	listPolicyHistory,
	listRetentionRuns,
	previewRetention,
	runRetention,
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
		actorId:
			c.req.header("x-test-actor-id") ??
			c.req.header("x-test-actor") ??
			"manager",
		organizationId,
	});
	return next();
});
app.openapi(previewRetention, handlePreviewRetention);
app.openapi(approvePolicy, handleApprovePolicy);
app.openapi(runRetention, handleRunRetention);
app.openapi(getEffectivePolicy, handleGetEffectivePolicy);
app.openapi(listPolicyHistory, handleListPolicyHistory);
app.openapi(listRetentionRuns, handleListRetentionRuns);

function request(actor: string, path: string, init?: RequestInit) {
	return app.request(`http://test${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-test-actor": actor,
			...init?.headers,
		},
	});
}

describe("governance route guards", () => {
	it("resolves approved actor IDs to usernames in policy history", async () => {
		calls.length = 0;
		approvedPolicyAvailable = true;
		try {
			const response = await request(
				"manager",
				`/v1/governance/policy/history?project_id=${projectId}`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				items: [
					expect.objectContaining({
						approved_by: `actor:${verifiedActorId}`,
						approved_by_username: "dan",
					}),
				],
			});
			const history = calls.find((call) => call.startsWith("SELECT v.id"));
			expect(history).toContain("actor_identities");
			expect(history).toContain("local_credentials");
			expect(history).toContain("approved_by_username");
			expect(history).toContain(
				"a.actor_subject = 'actor:' || credential.actor_id::text",
			);
			expect(history).toContain(
				"identity.canonical_subject = basic_auth_canonical_subject(a.actor_subject)",
			);
		} finally {
			approvedPolicyAvailable = false;
		}
	});

	it("issues a complete preview for a durable governed actor without a legacy role projection", async () => {
		calls.length = 0;
		approvedPolicyAvailable = true;
		legacyManagerProjection = false;
		try {
			const response = await request(
				"manager",
				"/v1/governance/retention/preview",
				{
					method: "POST",
					headers: { "x-test-actor-id": verifiedActorId },
					body: JSON.stringify({ project_id: projectId }),
				},
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				policy_version_id: policyId,
				counts: { feedback: 7 },
				preview_id: previewId,
				preview_expires_at: previewExpiresAt.toISOString(),
			});
			expect(calls.some((call) => call.includes("'retention_previewed'"))).toBe(
				true,
			);
			const projectLock = calls.findIndex((call) =>
				call.includes("p.status = ANY($3::text[])"),
			);
			const auditLock = calls.findIndex((call) =>
				call.startsWith("SELECT lock_project_audit_provenance"),
			);
			expect(projectLock).toBeGreaterThanOrEqual(0);
			expect(auditLock).toBeGreaterThan(projectLock);
		} finally {
			approvedPolicyAvailable = false;
			legacyManagerProjection = true;
		}
	});

	it("rejects members, cross-project access, and unapproved retention previews", async () => {
		calls.length = 0;
		for (const [actor, target, status] of [
			["member", projectId, 404],
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

	it("rechecks active manager authorization in governance read queries", async () => {
		calls.length = 0;
		const effective = await request(
			"manager",
			`/v1/governance/policy?project_id=${projectId}`,
		);
		expect(effective.status).toBe(200);
		const history = calls.find((call) => call.startsWith("SELECT v.id"));
		expect(history).toContain("p.status = 'active'");
		expect(history).toContain(
			"authorization_allows_project(gp.organization_id, gp.project_id, $3, 'governed')",
		);
		expect(history).not.toContain("organization_memberships");

		calls.length = 0;
		const runs = await request(
			"manager",
			`/v1/governance/retention/runs?project_id=${projectId}`,
		);
		expect(runs.status).toBe(200);
		const summary = calls.find((call) => call.startsWith("SELECT r.id"));
		expect(summary).toContain("p.status = 'active'");
		expect(summary).toContain(
			"authorization_allows_project(r.organization_id, r.project_id, $3, 'governed')",
		);
		expect(summary).not.toContain("organization_memberships");
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
		expect(await response.json()).toMatchObject({
			policy: {
				approved_by_username: "dan",
			},
		});
		const index = (prefix: string) =>
			calls.findIndex((statement) => statement.startsWith(prefix));
		expect(index("SELECT lock_project_audit_provenance")).toBeGreaterThan(
			index("BEGIN"),
		);
		expect(index("SELECT lock_project_audit_provenance")).toBeGreaterThan(
			index("SELECT p.id FROM projects"),
		);
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

	it("binds retention to the latest previewed approval and commits durable start evidence first", async () => {
		calls.length = 0;
		const response = await request("manager", "/v1/governance/retention/runs", {
			method: "POST",
			body: JSON.stringify({
				project_id: projectId,
				policy_version_id: "44444444-4444-4444-8444-444444444444",
				preview_id: "55555555-5555-4555-8555-555555555555",
				batch_size: 1,
			}),
		});
		expect(response.status).toBe(409);
		expect(calls.some((call) => call.includes("retention_started"))).toBe(
			false,
		);
	});

	it("requires a server-issued, actor-bound single-use preview before starting", async () => {
		calls.length = 0;
		previewConsumeValues.length = 0;
		const response = await request("manager", "/v1/governance/retention/runs", {
			method: "POST",
			headers: { "x-test-actor-id": verifiedActorId },
			body: JSON.stringify({
				project_id: projectId,
				policy_version_id: policyId,
				preview_id: "55555555-5555-4555-8555-555555555555",
				batch_size: 1,
			}),
		});
		expect(response.status).toBe(409);
		const consume = calls.find((call) =>
			call.includes("UPDATE governance_retention_previews SET consumed_at"),
		);
		expect(consume).toContain(
			"trusted_actor_subject_matches($2, actor_subject, $5)",
		);
		expect(consume).toContain("consumed_at IS NULL AND expires_at > now()");
		expect(previewConsumeValues).toContainEqual([
			"55555555-5555-4555-8555-555555555555",
			organizationId,
			projectId,
			policyId,
			verifiedActorId,
		]);
		expect(calls.some((call) => call.includes("retention_started"))).toBe(
			false,
		);
	});

	it("uses verified actor IDs for governance rechecks and preview consumption", async () => {
		calls.length = 0;
		const canonicalEquivalent = await request(
			" MANAGER ",
			`/v1/governance/policy/${policyId}/approve?project_id=${projectId}`,
			{
				method: "POST",
				headers: { "x-test-actor-id": verifiedActorId },
			},
		);
		const collision = await request(
			"manager",
			`/v1/governance/policy/${policyId}/approve?project_id=${projectId}`,
			{
				method: "POST",
				headers: { "x-test-actor-id": "44444444-4444-4444-8444-444444444444" },
			},
		);
		const quarantined = await request(
			"legacy user",
			`/v1/governance/policy/${policyId}/approve?project_id=${projectId}`,
			{
				method: "POST",
				headers: { "x-test-actor-id": "55555555-5555-4555-8555-555555555555" },
			},
		);
		expect(canonicalEquivalent.status).toBe(200);
		expect(collision.status).toBe(404);
		expect(quarantined.status).toBe(404);
		const authorization = calls.find((call) =>
			call.startsWith("SELECT p.id FROM projects"),
		);
		expect(authorization).toContain("p.status = ANY($3::text[])");
	});

	it("rejects a run request without preview authorization", async () => {
		const response = await request("manager", "/v1/governance/retention/runs", {
			method: "POST",
			body: JSON.stringify({
				project_id: projectId,
				policy_version_id: policyId,
			}),
		});
		expect(response.status).toBe(400);
	});
});
