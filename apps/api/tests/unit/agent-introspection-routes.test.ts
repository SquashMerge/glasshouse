import { describe, expect, it, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import report from "../fixtures/agent-introspection/valid-complete-success.json";
import * as postgres from "../../src/db/postgres";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import { openapiApp } from "../../src/openapi";
import { createApiApp } from "../../src/index";
import {
	getAgentIntrospectionRoute,
	handleGetAgentIntrospection,
	handlePutAgentIntrospection,
	putAgentIntrospectionRoute,
} from "../../src/routes/agent-introspection";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const invocationId = "55555555-5555-4555-8555-555555555555";
const actorId = "66666666-6666-4666-8666-666666666666";

function app() {
	const api = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	api.use(
		"/v1/evaluation-runs/:run_id/tasks/:task_id/agent-introspection/:invocation_id",
		async (c, next) => {
			c.header("Cache-Control", "no-store");
			await next();
		},
	);
	api.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reporter",
			actorId,
			organizationId,
		});
		await next();
	});
	api.openapi(putAgentIntrospectionRoute, handlePutAgentIntrospection);
	api.openapi(getAgentIntrospectionRoute, handleGetAgentIntrospection);
	return api;
}

function database(taskAvailable = true) {
	let stored: Record<string, unknown> | undefined;
	const query = async (sql: string, values: unknown[] = []) => {
		if (
			sql === "BEGIN" ||
			sql === "COMMIT" ||
			sql === "ROLLBACK" ||
			sql.includes("FROM organization_memberships om") ||
			sql.includes("FROM organization_actor_roles") ||
			sql.includes("FROM project_memberships pm") ||
			sql.includes("FROM project_actor_grants")
		)
			return { rows: [] };
		if (sql.includes("FROM projects p WHERE p.id"))
			return { rows: [{ id: projectId }] };
		if (sql.startsWith("SELECT authorization_allows_project"))
			return { rows: [{ allowed: true }] };
		if (sql.includes("FROM experiment_tasks task"))
			return {
				rows: taskAvailable ? [{ evaluation_run_item_id: itemId }] : [],
			};
		if (sql.startsWith("SELECT * FROM agent_introspection_reports"))
			return { rows: stored ? [stored] : [] };
		if (sql.startsWith("INSERT INTO agent_introspection_reports")) {
			if (stored) return { rows: [] };
			stored = {
				id: "77777777-7777-4777-8777-777777777777",
				organization_id: organizationId,
				project_id: projectId,
				evaluation_run_id: runId,
				evaluation_run_item_id: itemId,
				task_id: taskId,
				invocation_id: invocationId,
				reported_by_actor_id: actorId,
				request_hash: values[9],
				received_at: new Date("2026-09-12T00:00:00.000Z"),
				report: values[10],
			};
			return { rows: [stored] };
		}
		throw new Error(`Unexpected query: ${sql}`);
	};
	return { connect: async () => ({ query, release() {} }) };
}

describe("agent introspection HTTP handlers", () => {
	it("uses real authenticated handlers for creation, replay, conflict, read, and no-store responses", async () => {
		const postgresSpy = spyOn(postgres, "pgPool").mockReturnValue(
			database() as never,
		);
		const path = `/v1/evaluation-runs/${runId}/tasks/${taskId}/agent-introspection/${invocationId}?project_id=${projectId}`;
		try {
			const api = app();
			const malformed = await api.request(`http://test${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(malformed.status).toBe(400);
			expect(malformed.headers.get("cache-control")).toBe("no-store");
			const create = await api.request(`http://test${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
			});
			expect(create.status).toBe(201);
			expect(create.headers.get("cache-control")).toBe("no-store");

			const replay = await api.request(`http://test${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
			});
			expect(replay.status).toBe(200);
			expect((await replay.json()).replayed).toBe(true);

			const conflict = structuredClone(report);
			conflict.adapter.version = "2.0";
			const changed = await api.request(`http://test${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(conflict),
			});
			expect(changed.status).toBe(409);
			expect(changed.headers.get("cache-control")).toBe("no-store");

			const read = await api.request(`http://test${path}`);
			expect(read.status).toBe(200);
			expect(read.headers.get("cache-control")).toBe("no-store");
		} finally {
			postgresSpy.mockRestore();
		}
	});

	it("does not disclose a missing scoped task and protects authentication failures with no-store", async () => {
		const postgresSpy = spyOn(postgres, "pgPool").mockReturnValue(
			database(false) as never,
		);
		const path = `/v1/evaluation-runs/${runId}/tasks/${taskId}/agent-introspection/${invocationId}?project_id=${projectId}`;
		try {
			const scoped = await app().request(`http://test${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
			});
			expect(scoped.status).toBe(404);
			expect(scoped.headers.get("cache-control")).toBe("no-store");

			const credentials = process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
			process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS = JSON.stringify([
				{
					username: "reporter",
					password: "secret",
					organization_id: organizationId,
				},
			]);
			try {
				const unauthorized = await createApiApp().request(`http://test${path}`);
				expect(unauthorized.status).toBe(401);
				expect(unauthorized.headers.get("cache-control")).toBe("no-store");
			} finally {
				if (credentials === undefined)
					delete process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
				else process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS = credentials;
			}
		} finally {
			postgresSpy.mockRestore();
		}
	});

	it("maps normalized semantic report overflow to 413 without entering a handler", async () => {
		const oversized = structuredClone(report);
		const modelEvent = oversized.events[1];
		oversized.events = [
			oversized.events[0],
			...Array.from({ length: 254 }, (_, index) => ({
				...modelEvent,
				event_id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				sequence: index + 1,
				references: Array.from({ length: 8 }, () => ({
					kind: "input",
					source: "observation",
					id: "a".repeat(256),
					sha256: null,
					byte_count: null,
					redacted: true,
				})),
			})),
			{ ...oversized.events[3], sequence: 255 },
		];
		const response = await openapiApp.request(
			`http://test/v1/evaluation-runs/${runId}/tasks/${taskId}/agent-introspection/${invocationId}?project_id=${projectId}`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(oversized),
			},
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
	});
});
