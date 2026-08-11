import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { SSEStreamingApi } from "hono/streaming";
import { Pool } from "pg";
import {
	claimExperimentTask,
	finalizeExperimentTask,
} from "../../src/db/experiments";
import { lockActiveAuthorizedProject } from "../../src/db/project-authorization";
import {
	TRUSTED_ACTOR_CONTEXT_KEY,
	TRUSTED_TENANT_CONTEXT_KEY,
} from "../../src/middleware/auth";
import {
	createOptimizationHandlers,
	optimizationEvents,
	type OptimizationDependencies,
} from "../../src/routes/prompt-optimizations";

const databaseUrl = process.env.DATABASE_URL;

async function waitForLock(pool: Pool, applicationName: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await pool.query<{ waiting: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS waiting",
			[applicationName],
		);
		if (result.rows[0]?.waiting) return;
		await Bun.sleep(20);
	}
	throw new Error(
		"authorization transaction did not wait for the revocation fence",
	);
}

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForDemotionProgress(pool: Pool, applicationName: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await pool.query<{
			state: string;
			wait_event_type: string | null;
			query: string;
		}>(
			"SELECT state, wait_event_type, query FROM pg_stat_activity WHERE application_name = $1",
			[applicationName],
		);
		const session = result.rows[0];
		if (
			session?.wait_event_type === "Lock" ||
			(session?.state === "idle" && session.query === "COMMIT")
		)
			return;
		await Bun.sleep(20);
	}
	throw new Error("membership revocation did not reach its project fence");
}

function statusEventIds(body: string): string[] {
	return body
		.split("\n\n")
		.map((frame) => frame.split("\n"))
		.filter((lines) => lines.includes("event: status"))
		.map((lines) => lines.find((line) => line.startsWith("id: "))?.slice(4))
		.filter((id): id is string => id !== undefined);
}

test.skipIf(!databaseUrl)(
	"demotion committed while an authorization waits prevents the later write, claim, and finalize",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 4 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const datasetId = randomUUID();
		const datasetItemId = randomUUID();
		const experimentId = randomUUID();
		const subject = `revocation-${actorId}`;
		const writer = await pool.connect();
		const demoter = await pool.connect();
		try {
			await pool.query(
				"INSERT INTO organizations (id, name, slug) VALUES ($1, 'Revocation race', $2)",
				[organizationId, `revocation-race-${organizationId}`],
			);
			await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
			await pool.query(
				"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
				[actorId, organizationId, subject],
			);
			await pool.query(
				"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'member')",
				[organizationId, subject],
			);
			await pool.query(
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Revocation race', $3)",
				[projectId, organizationId, `revocation-race-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await pool.query(
				"INSERT INTO datasets (id, project_id, name) VALUES ($1, $2, 'Revocation race dataset')",
				[datasetId, projectId],
			);
			await pool.query(
				"INSERT INTO dataset_items (id, dataset_id, input, expected_output) VALUES ($1, $2, '{\"input\":true}', '{\"output\":true}')",
				[datasetItemId, datasetId],
			);
			await pool.query(
				"INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id) VALUES ($1, $2, $3, '{}', 'running', $4)",
				[experimentId, projectId, datasetId, actorId],
			);

			await demoter.query("BEGIN");
			await demoter.query(
				"UPDATE project_memberships SET role = 'member' WHERE project_id = $1 AND actor_subject = $2",
				[projectId, subject],
			);

			await writer.query("BEGIN");
			await writer.query("SET application_name = 'astraea-revocation-race'");
			const authorization = lockActiveAuthorizedProject(writer, projectId, {
				organization_id: organizationId,
				actor_id: actorId,
				operation: "product_write",
			});
			await waitForLock(pool, "astraea-revocation-race");
			await demoter.query("COMMIT");

			const allowed = await authorization;
			if (allowed)
				await writer.query(
					"INSERT INTO datasets (id, project_id, name) VALUES ($1, $2, 'must-not-write')",
					[randomUUID(), projectId],
				);
			await writer.query("COMMIT");

			expect(allowed).toBe(false);
			expect(
				await claimExperimentTask(pool, {
					project_id: projectId,
					experiment_id: experimentId,
				}),
			).toBeNull();
			expect(
				await finalizeExperimentTask(pool, {
					project_id: projectId,
					experiment_id: experimentId,
					task_id: datasetItemId,
					lease_token: randomUUID(),
					status: "completed",
					scores: { exact_match: 1 },
				}),
			).toBe(false);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM datasets WHERE project_id = $1 AND name = 'must-not-write'",
						[projectId],
					)
				).rows[0]?.count,
			).toBe(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM experiment_results WHERE experiment_id = $1",
						[experimentId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			await writer.query("ROLLBACK").catch(() => {});
			await demoter.query("ROLLBACK").catch(() => {});
			writer.release();
			demoter.release();
			await pool.query(
				"DELETE FROM experiment_results WHERE experiment_id = $1",
				[experimentId],
			);
			await pool.query("DELETE FROM experiments WHERE id = $1", [experimentId]);
			await pool.query("DELETE FROM dataset_items WHERE dataset_id = $1", [
				datasetId,
			]);
			await pool.query("DELETE FROM datasets WHERE id = $1", [datasetId]);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await pool.query("DELETE FROM actor_identities WHERE actor_id = $1", [
				actorId,
			]);
			await pool.query("DELETE FROM actors WHERE id = $1", [actorId]);
			await pool.query("DELETE FROM organizations WHERE id = $1", [
				organizationId,
			]);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revoked member cannot receive a queued optimization SSE frame after a backpressured frame settles",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const jobId = randomUUID();
		const subject = `optimization-sse-${actorId}`;
		const applicationName = "astraea-optimization-sse-revocation";
		const firstWrite = deferred();
		const releaseFirstWrite = deferred();
		const demoter = await pool.connect();
		const originalWriteSSE = SSEStreamingApi.prototype.writeSSE;
		let revoke: Promise<void> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		SSEStreamingApi.prototype.writeSSE = async function (message) {
			if (message.event === "status" && message.id === "1") {
				firstWrite.resolve();
				await releaseFirstWrite.promise;
			}
			return originalWriteSSE.call(this, message);
		};
		try {
			await pool.query(
				"INSERT INTO organizations (id, name, slug) VALUES ($1, 'Optimization SSE revocation', $2)",
				[organizationId, `optimization-sse-${organizationId}`],
			);
			await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
			await pool.query(
				"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
				[actorId, organizationId, subject],
			);
			await pool.query(
				"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'member')",
				[organizationId, subject],
			);
			await pool.query(
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Optimization SSE revocation', $3)",
				[projectId, organizationId, `optimization-sse-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);

			const handlers = createOptimizationHandlers({
				pool: () => pool,
				get: async () => ({}) as never,
				events: async () => [
					{
						id: 1,
						status: "preparing" as const,
						detail: {},
						created_at: "2026-08-11T00:00:00.000Z",
					},
					{
						id: 2,
						status: "completed" as const,
						detail: {},
						created_at: "2026-08-11T00:00:01.000Z",
					},
				],
			} as unknown as OptimizationDependencies);
			const api = new OpenAPIHono({
				defaultHook: (result, c) =>
					result.success
						? undefined
						: c.json(
								{ code: "BAD_REQUEST", message: "Request validation failed" },
								400,
							),
			});
			api.use("*", async (c, next) => {
				c.set(TRUSTED_ACTOR_CONTEXT_KEY, subject);
				c.set(TRUSTED_TENANT_CONTEXT_KEY, {
					actor: subject,
					actorId,
					organizationId,
				});
				await next();
			});
			api.openapi(optimizationEvents, handlers.handleEvents);

			const response = await api.request(
				`/v1/prompt-optimizations/${jobId}/events?project_id=${projectId}`,
			);
			expect(response.status).toBe(200);
			reader = response.body?.getReader();
			if (!reader) throw new Error("Optimization SSE response has no body");
			const firstChunk = reader.read();

			await firstWrite.promise;
			await demoter.query(`SET application_name = '${applicationName}'`);
			revoke = (async () => {
				await demoter.query("BEGIN");
				await demoter.query(
					"DELETE FROM project_memberships WHERE project_id = $1 AND actor_subject = $2",
					[projectId, subject],
				);
				await demoter.query("COMMIT");
			})();
			await waitForDemotionProgress(pool, applicationName);

			releaseFirstWrite.resolve();
			const first = await firstChunk;
			expect(first.done).toBe(false);
			await revoke;

			let body = new TextDecoder().decode(first.value);
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				body += new TextDecoder().decode(next.value);
			}
			expect(statusEventIds(body)).toEqual(["1"]);
		} finally {
			releaseFirstWrite.resolve();
			await revoke?.catch(() => {});
			await reader?.cancel().catch(() => {});
			SSEStreamingApi.prototype.writeSSE = originalWriteSSE;
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await pool.query("DELETE FROM actor_identities WHERE actor_id = $1", [
				actorId,
			]);
			await pool.query("DELETE FROM actors WHERE id = $1", [actorId]);
			await pool.query("DELETE FROM organizations WHERE id = $1", [
				organizationId,
			]);
			await pool.end();
		}
	},
);
