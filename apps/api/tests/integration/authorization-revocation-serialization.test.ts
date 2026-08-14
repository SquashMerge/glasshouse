import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { SSEStreamingApi } from "hono/streaming";
import { StreamingApi } from "hono/utils/stream";
import { Pool } from "pg";
import {
	cancelExecutionAdmission,
	claimExecutionAdmission,
	completeExecutionAdmission,
} from "../../src/db/execution-admissions";
import {
	admitExperimentExecution,
	claimExperimentExecution,
	claimExperimentTask,
	completeExperimentIfTasksFinished,
	experimentExecutionAdmissionIsActive,
	finalizeExperimentTask,
	getExperiment as getExperimentRecord,
	updateExperiment,
} from "../../src/db/experiments";
import {
	lockActiveAuthorizedOrganizationProject,
	lockActiveAuthorizedProject,
	lockAuthorizedOrganization,
	lockProjectAuditProvenance,
	withLockPhaseTransaction,
} from "../../src/db/project-authorization";
import {
	admitOptimizationExecution,
	claimOptimizationExecution,
	claimOptimizationJob,
	type OptimizationJob,
	optimizationExecutionAdmissionIsActive,
	transitionOptimizationJob,
} from "../../src/db/prompt-optimizations";
import { createAuthorizedSseDelivery } from "../../src/lib/authorized-sse";
import { publishSync } from "../../src/lib/event-bus";
import {
	TRUSTED_ACTOR_CONTEXT_KEY,
	TRUSTED_TENANT_CONTEXT_KEY,
} from "../../src/middleware/auth";
import {
	createExperimentHandlers,
	type ExperimentDependencies,
	executeExperiment,
	getExperimentEvents,
} from "../../src/routes/experiments";
import {
	createOptimizationHandlers,
	type OptimizationDependencies,
	optimizationEvents,
	runOptimizationJob,
} from "../../src/routes/prompt-optimizations";
import {
	createTraceEventHandlers,
	streamTraceEvents,
} from "../../src/routes/trace-events";

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

// Organizations retain a mandatory default project, so teardown removes only scenario data.
async function seedOrganizationWithDefaultProject(
	pool: Pool,
	organizationId: string,
	name: string,
	slug: string,
) {
	const defaultProjectId = randomUUID();
	await pool.query(
		`WITH organization AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1, $2, $3, $4)
			RETURNING id
		)
		INSERT INTO projects (id, organization_id, name, slug)
		SELECT $4, id, 'Default Project', 'default'
		FROM organization`,
		[organizationId, name, slug, defaultProjectId],
	);
}

async function seedAdditionalProjectManager(
	pool: Pool,
	organizationId: string,
	projectId: string,
	prefix: string,
) {
	const actorId = randomUUID();
	const subject = `${prefix}-other-${actorId}`;
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
		"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
		[projectId, organizationId, subject],
	);
	await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
	return { actorId, subject };
}

async function seedDurableProjectAccess(
	pool: Pool,
	organizationId: string,
	projectId: string,
	actorId: string,
) {
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'user')",
		[organizationId, actorId],
	);
	await pool.query(
		"INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role) VALUES ($1, $2, $3, 'user')",
		[projectId, organizationId, actorId],
	);
}

async function seedDurableOrganizationAdmin(
	pool: Pool,
	organizationId: string,
	actorId: string,
) {
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin')",
		[organizationId, actorId],
	);
}

async function seedAdditionalOrganizationOwner(
	pool: Pool,
	organizationId: string,
	prefix: string,
) {
	const actorId = randomUUID();
	const subject = `${prefix}-other-${actorId}`;
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
		[actorId, organizationId, subject],
	);
	await pool.query(
		"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'owner')",
		[organizationId, subject],
	);
	await seedDurableOrganizationAdmin(pool, organizationId, actorId);
}

async function deleteScenarioActor(pool: Pool, actorId: string) {
	await pool.query("DELETE FROM project_actor_grants WHERE actor_id = $1", [
		actorId,
	]);
	await pool.query("DELETE FROM organization_actor_roles WHERE actor_id = $1", [
		actorId,
	]);
	await pool.query("DELETE FROM actor_identities WHERE actor_id = $1", [
		actorId,
	]);
	await pool.query("DELETE FROM actors WHERE id = $1", [actorId]);
}

async function seedExecutionExperiment(pool: Pool) {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const actorId = randomUUID();
	const datasetId = randomUUID();
	const itemId = randomUUID();
	const versionId = randomUUID();
	const versionItemId = randomUUID();
	const experimentId = randomUUID();
	const subject = `dispatch-race-${actorId}`;
	await seedOrganizationWithDefaultProject(
		pool,
		organizationId,
		"Dispatch race",
		`dispatch-race-${organizationId}`,
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
		"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Dispatch race', $3)",
		[projectId, organizationId, `dispatch-race-${projectId}`],
	);
	await pool.query(
		"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
		[projectId, organizationId, subject],
	);
	await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
	const additionalManager = await seedAdditionalProjectManager(
		pool,
		organizationId,
		projectId,
		"dispatch-race",
	);
	await pool.query(
		"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'dispatch-race-dataset', 'Dispatch race dataset')",
		[datasetId, projectId],
	);
	await pool.query(
		"INSERT INTO dataset_items (id, dataset_id, input, expected_output) VALUES ($1, $2, '{\"question\":true}', '{\"answer\":true}')",
		[itemId, datasetId],
	);
	await pool.query(
		"INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash) VALUES ($1, $2, $3, 1, 1, repeat('0', 64))",
		[versionId, projectId, datasetId],
	);
	await pool.query(
		"INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input, expected_output) VALUES ($1, $2, $3, $4, 0, '{\"question\":true}', '{\"answer\":true}')",
		[versionItemId, projectId, versionId, itemId],
	);
	await pool.query(
		"UPDATE datasets SET latest_published_version = 1 WHERE id = $1",
		[datasetId],
	);
	await pool.query(
		"INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id) VALUES ($1, $2, $3, '{}', 'running', $4)",
		[experimentId, projectId, datasetId, actorId],
	);
	const tasks = await pool.query(
		"SELECT project_id, dataset_item_id, dataset_version_item_id FROM experiment_tasks WHERE experiment_id = $1",
		[experimentId],
	);
	expect(tasks.rows).toEqual([
		expect.objectContaining({
			project_id: projectId,
			dataset_item_id: null,
			dataset_version_item_id: versionItemId,
		}),
	]);
	return {
		organizationId,
		projectId,
		actorId,
		datasetId,
		itemId,
		experimentId,
		subject,
		additionalManagerActorId: additionalManager.actorId,
		cleanup: async () => {
			const cleanup = await pool.connect();
			try {
				await cleanup.query("BEGIN");
				await cleanup.query(
					"SELECT set_config('astraea.project_deletion_id', $1, true)",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM execution_admission_claims WHERE admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
					[projectId],
				);
				await cleanup
					.query("DELETE FROM execution_effects WHERE project_id = $1", [
						projectId,
					])
					.catch(() => {});
				await cleanup.query(
					"DELETE FROM execution_admissions WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM experiment_results WHERE experiment_id = $1",
					[experimentId],
				);
				await cleanup.query(
					"DELETE FROM experiment_tasks WHERE experiment_id = $1",
					[experimentId],
				);
				await cleanup.query("DELETE FROM experiments WHERE id = $1", [
					experimentId,
				]);
				await cleanup.query(
					"DELETE FROM dataset_version_items WHERE dataset_version_id = $1",
					[versionId],
				);
				await cleanup.query("DELETE FROM dataset_versions WHERE id = $1", [
					versionId,
				]);
				await cleanup.query("DELETE FROM dataset_items WHERE dataset_id = $1", [
					datasetId,
				]);
				await cleanup.query("DELETE FROM datasets WHERE id = $1", [datasetId]);
				await cleanup.query(
					"UPDATE projects SET status = 'archived' WHERE id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM project_memberships WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM organization_memberships WHERE organization_id = $1",
					[organizationId],
				);
				await cleanup.query("COMMIT");
			} catch (cause) {
				await cleanup.query("ROLLBACK").catch(() => {});
				throw cause;
			} finally {
				cleanup.release();
			}
			await deleteScenarioActor(pool, actorId);
			await deleteScenarioActor(pool, additionalManager.actorId);
		},
	};
}

async function seedProjectAuditLockRace(pool: Pool) {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const managerActorId = randomUUID();
	const ownerActorId = randomUUID();
	const managerSubject = `audit-race-manager-${managerActorId}`;
	const ownerSubject = `audit-race-owner-${ownerActorId}`;
	await seedOrganizationWithDefaultProject(
		pool,
		organizationId,
		"Audit lock race",
		`audit-lock-race-${organizationId}`,
	);
	for (const [actorId, subject] of [
		[managerActorId, managerSubject],
		[ownerActorId, ownerSubject],
	] as const) {
		await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
		await pool.query(
			"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
			[actorId, organizationId, subject],
		);
	}
	await pool.query(
		"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'owner'), ($1, $3, 'owner')",
		[organizationId, managerSubject, ownerSubject],
	);
	await seedDurableOrganizationAdmin(pool, organizationId, managerActorId);
	await seedDurableOrganizationAdmin(pool, organizationId, ownerActorId);
	await pool.query(
		"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Audit lock race', $3)",
		[projectId, organizationId, `audit-lock-race-${projectId}`],
	);
	// Authorization audit rows are retained; UUID-scoped fixtures avoid collisions.
	return {
		organizationId,
		projectId,
		managerActorId,
		ownerActorId,
		managerSubject,
		ownerSubject,
	};
}

test.skipIf(!databaseUrl)(
	"a revocation that holds the project fence before authorization completes without 40P01 and denies the later write",
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
		let additionalManagerActorId: string | undefined;
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Revocation race",
				`revocation-race-${organizationId}`,
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
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"revocation",
				)
			).actorId;
			await pool.query(
				"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'revocation-race-dataset', 'Revocation race dataset')",
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
				"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[projectId, organizationId, actorId],
			);
			await expect(
				pool.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE NOWAIT", [
					projectId,
				]),
			).rejects.toMatchObject({ code: "55P03" });

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
					"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'must-not-write', 'must-not-write')",
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
				"UPDATE projects SET status = 'archived' WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"an authorized project-to-membership fence serializes a later revocation without deadlock",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 4 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const subject = `lock-order-${actorId}`;
		const writer = await pool.connect();
		const demoter = await pool.connect();
		let additionalManagerActorId: string | undefined;
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Lock order",
				`lock-order-${organizationId}`,
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
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Lock order', $3)",
				[projectId, organizationId, `lock-order-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"lock-order",
				)
			).actorId;
			await writer.query("BEGIN");
			await writer.query(
				"SET application_name = 'astraea-authorized-lock-order'",
			);
			expect(
				await lockActiveAuthorizedProject(writer, projectId, {
					organization_id: organizationId,
					actor_id: actorId,
					operation: "product_write",
				}),
			).toBe(true);
			await demoter.query(
				"SET application_name = 'astraea-revocation-lock-order'",
			);
			const revoke = (async () => {
				await demoter.query("BEGIN");
				await demoter.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[projectId, organizationId, actorId],
				);
				await demoter.query("COMMIT");
			})();
			await waitForLock(pool, "astraea-revocation-lock-order");
			await writer.query("COMMIT");
			await Promise.race([
				revoke,
				Bun.sleep(1_000).then(() => {
					throw new Error("membership/project lock order deadlocked");
				}),
			]);
		} finally {
			await writer.query("ROLLBACK").catch(() => {});
			await demoter.query("ROLLBACK").catch(() => {});
			writer.release();
			demoter.release();
			await pool.query(
				"UPDATE projects SET status = 'archived' WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a manager mutation that wins the membership/audit lock race records one audit before owner demotion",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedProjectAuditLockRace(pool);
		const demoter = await pool.connect();
		const mutationStarted = deferred();
		const releaseMutation = deferred();
		try {
			const mutation = withLockPhaseTransaction(
				pool,
				async (client) => {
					await client.query(
						"SET LOCAL application_name = 'astraea-audit-race-manager-first'",
					);
					if (
						!(await lockActiveAuthorizedProject(client, fixture.projectId, {
							organization_id: fixture.organizationId,
							actor_id: fixture.managerActorId,
							operation: "project_manage",
						}))
					)
						throw new Error("manager authorization was unexpectedly denied");
					await lockProjectAuditProvenance(client, fixture.projectId);
				},
				async (client) => {
					await client.query(
						"UPDATE projects SET name = 'manager-won', updated_at = now() WHERE id = $1",
						[fixture.projectId],
					);
					await client.query(
						"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated')",
						[fixture.organizationId, fixture.projectId, fixture.managerSubject],
					);
					mutationStarted.resolve();
					await releaseMutation.promise;
				},
			);
			await mutationStarted.promise;
			await demoter.query("BEGIN");
			await demoter.query(
				"SET LOCAL application_name = 'astraea-audit-race-owner-second'",
			);
			const demotion = (async () => {
				if (
					!(await lockAuthorizedOrganization(
						demoter,
						fixture.organizationId,
						fixture.ownerActorId,
						"organization_manage",
						fixture.managerSubject,
					))
				)
					throw new Error("owner authorization was unexpectedly denied");
				await demoter.query(
					"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
					[fixture.organizationId, fixture.managerActorId],
				);
				await demoter.query(
					"SELECT id FROM projects WHERE organization_id = $1 ORDER BY id FOR UPDATE",
					[fixture.organizationId],
				);
				await lockProjectAuditProvenance(demoter, fixture.projectId);
				await demoter.query(
					"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
					[fixture.organizationId, fixture.managerActorId],
				);
				await demoter.query(
					"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'organization_membership_updated')",
					[fixture.organizationId, fixture.projectId, fixture.ownerSubject],
				);
				await demoter.query("COMMIT");
			})();
			await waitForLock(pool, "astraea-audit-race-owner-second");
			releaseMutation.resolve();
			await mutation;
			await Promise.race([
				demotion,
				Bun.sleep(2_000).then(() => {
					throw new Error("manager-first audit/membership order deadlocked");
				}),
			]);

			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM project_authorization_audit_events WHERE project_id = $1 AND event_type = 'project_updated'",
						[fixture.projectId],
					)
				).rows[0]?.count,
			).toBe(1);
			expect(
				(
					await pool.query(
						"SELECT role FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
						[fixture.organizationId, fixture.managerActorId],
					)
				).rows[0]?.role,
			).toBe("user");
		} finally {
			releaseMutation.resolve();
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"an owner demotion that wins the membership/audit lock race prevents a later manager mutation without replay",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedProjectAuditLockRace(pool);
		const demoter = await pool.connect();
		const demotionLocked = deferred();
		let mutations = 0;
		try {
			await demoter.query("BEGIN");
			await demoter.query(
				"SET LOCAL application_name = 'astraea-audit-race-owner-first'",
			);
			if (
				!(await lockAuthorizedOrganization(
					demoter,
					fixture.organizationId,
					fixture.ownerActorId,
					"organization_manage",
					fixture.managerSubject,
				))
			)
				throw new Error("owner authorization was unexpectedly denied");
			await demoter.query(
				"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
				[fixture.organizationId, fixture.managerActorId],
			);
			await demoter.query(
				"SELECT id FROM projects WHERE organization_id = $1 ORDER BY id FOR UPDATE",
				[fixture.organizationId],
			);
			await lockProjectAuditProvenance(demoter, fixture.projectId);
			demotionLocked.resolve();

			const mutation = withLockPhaseTransaction(
				pool,
				async (client) => {
					await client.query(
						"SET LOCAL application_name = 'astraea-audit-race-manager-second'",
					);
					if (
						!(await lockActiveAuthorizedProject(client, fixture.projectId, {
							organization_id: fixture.organizationId,
							actor_id: fixture.managerActorId,
							operation: "project_manage",
						}))
					)
						throw new Error("manager access was revoked");
					await lockProjectAuditProvenance(client, fixture.projectId);
				},
				async () => {
					mutations += 1;
				},
			);
			await demotionLocked.promise;
			await waitForLock(pool, "astraea-audit-race-manager-second");
			await demoter.query(
				"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
				[fixture.organizationId, fixture.managerActorId],
			);
			await demoter.query(
				"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'organization_membership_updated')",
				[fixture.organizationId, fixture.projectId, fixture.ownerSubject],
			);
			await demoter.query("COMMIT");
			await expect(mutation).rejects.toThrow("manager access was revoked");

			expect(mutations).toBe(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM project_authorization_audit_events WHERE project_id = $1 AND event_type = 'project_updated'",
						[fixture.projectId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
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
		let additionalManagerActorId: string | undefined;
		SSEStreamingApi.prototype.writeSSE = async function (message) {
			if (message.event === "status" && message.id === "1") {
				firstWrite.resolve();
				await releaseFirstWrite.promise;
			}
			return originalWriteSSE.call(this, message);
		};
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Optimization SSE revocation",
				`optimization-sse-${organizationId}`,
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
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"optimization-sse",
				)
			).actorId;

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
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[projectId, organizationId, actorId],
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
				"UPDATE projects SET status = 'archived' WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation fence prevents a queued trace frame after a paused authorized frame settles",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const subject = `trace-sse-${actorId}`;
		const applicationName = "astraea-trace-sse-revocation";
		const firstWrite = deferred();
		const releaseFirstWrite = deferred();
		const demoter = await pool.connect();
		const originalWrite = StreamingApi.prototype.write;
		let revoke: Promise<void> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let blocked = false;
		let additionalManagerActorId: string | undefined;
		StreamingApi.prototype.write = async function (data) {
			if (!blocked && String(data).includes("event: trace")) {
				blocked = true;
				firstWrite.resolve();
				await releaseFirstWrite.promise;
			}
			return originalWrite.call(this, data);
		};
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Trace SSE revocation",
				`trace-sse-${organizationId}`,
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
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Trace SSE revocation', $3)",
				[projectId, organizationId, `trace-sse-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"trace-sse",
				)
			).actorId;

			const handlers = createTraceEventHandlers({
				createFrameDelivery: (stream, tenant, scopedProjectId, cleanup) =>
					createAuthorizedSseDelivery({
						stream,
						pool: () => pool,
						tenant,
						projectId: scopedProjectId,
						onClose: cleanup,
					}),
				defaultClient: () => ({}) as never,
				getTrace: async () => ({ trace: null, observations: [] }),
				graceMs: 1_000,
				heartbeatMs: 10_000,
				subscribe: (await import("../../src/lib/event-bus")).subscribe,
			});
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
			api.openapi(streamTraceEvents, handlers.handleStreamTraceEvents);
			const response = await api.request(
				`/v1/traces/events?project_id=${projectId}`,
			);
			expect(response.status).toBe(200);
			reader = response.body?.getReader();
			if (!reader) throw new Error("Trace SSE response has no body");
			const firstChunk = reader.read();
			publishSync("trace.created", {
				trace: { organization_id: organizationId, project_id: projectId },
			});
			await firstWrite.promise;
			await demoter.query(`SET application_name = '${applicationName}'`);
			revoke = (async () => {
				await demoter.query("BEGIN");
				await demoter.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[projectId, organizationId, actorId],
				);
				await demoter.query("COMMIT");
			})();
			await waitForLock(pool, applicationName);
			publishSync("trace.created", {
				trace: { organization_id: organizationId, project_id: projectId },
			});
			releaseFirstWrite.resolve();
			await firstChunk;
			await revoke;
			let body = "";
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				body += new TextDecoder().decode(next.value);
			}
			expect(body.match(/event: trace/g)).toHaveLength(1);
		} finally {
			releaseFirstWrite.resolve();
			await revoke?.catch(() => {});
			await reader?.cancel().catch(() => {});
			StreamingApi.prototype.write = originalWrite;
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
			await pool.query(
				"UPDATE projects SET status = 'archived' WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a stalled evaluation provider does not hold the revocation fence",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const datasetId = randomUUID();
		const itemId = randomUUID();
		const versionId = randomUUID();
		const versionItemId = randomUUID();
		const experimentId = randomUUID();
		const subject = `provider-revocation-${actorId}`;
		const providerEntered = deferred();
		const providerRelease = deferred();
		const controller = new AbortController();
		const previousTimeout = process.env.EXECUTION_ADMISSION_TIMEOUT_MS;
		let additionalManagerActorId: string | undefined;
		try {
			process.env.EXECUTION_ADMISSION_TIMEOUT_MS = "1000";
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Provider revocation",
				`provider-revocation-${organizationId}`,
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
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Provider revocation', $3)",
				[projectId, organizationId, `provider-revocation-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"provider-revocation",
				)
			).actorId;
			await pool.query(
				"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'provider-revocation-dataset', 'Provider revocation dataset')",
				[datasetId, projectId],
			);
			await pool.query(
				"INSERT INTO dataset_items (id, dataset_id, input, expected_output) VALUES ($1, $2, '{\"input\":true}', '{\"output\":true}')",
				[itemId, datasetId],
			);
			await pool.query(
				"INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash) VALUES ($1, $2, $3, 1, 1, repeat('0', 64))",
				[versionId, projectId, datasetId],
			);
			await pool.query(
				"INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input, expected_output) VALUES ($1, $2, $3, $4, 0, '{\"input\":true}', '{\"output\":true}')",
				[versionItemId, projectId, versionId, itemId],
			);
			await pool.query(
				"UPDATE datasets SET latest_published_version = 1 WHERE id = $1",
				[datasetId],
			);
			await pool.query(
				"INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id) VALUES ($1, $2, $3, '{}', 'running', $4)",
				[experimentId, projectId, datasetId, actorId],
			);
			const deps = {
				pool: () => pool,
				updateExperiment,
				claimTask: claimExperimentTask,
				completeExperiment: completeExperimentIfTasksFinished,
				nextTaskRetryDelay: async () => null,
				waitForTaskRetry: async () => {},
				finalizeTask: finalizeExperimentTask,
				admitExecution: admitExperimentExecution,
				isAdmissionActive: experimentExecutionAdmissionIsActive,
				claimExecution: claimExperimentExecution,
				cancelAdmission: cancelExecutionAdmission,
				completeAdmission: completeExecutionAdmission,
				invokeLlm: async () => {
					providerEntered.resolve();
					await providerRelease.promise;
					return { output: { value: "late" }, model: "test" };
				},
				trace: async () => {},
			} as unknown as ExperimentDependencies;
			const executing = executeExperiment(
				deps,
				{
					project_id: projectId,
					experiment_id: experimentId,
					dataset_id: datasetId,
					config: {},
				},
				controller.signal,
			);
			await providerEntered.promise;
			await Promise.race([
				pool.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[projectId, organizationId, actorId],
				),
				Bun.sleep(500).then(() => {
					throw new Error("revocation waited on the stalled provider");
				}),
			]);
			await Promise.race([
				executing,
				Bun.sleep(2_000).then(() => {
					throw new Error("cancelled admission outlived its bounded deadline");
				}),
			]);
			expect(
				(
					await pool.query("SELECT status FROM experiments WHERE id = $1", [
						experimentId,
					])
				).rows[0]?.status,
			).toBe("cancelled");
			expect(
				(
					await pool.query(
						"SELECT status FROM execution_admissions WHERE work_kind = 'experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $1)",
						[experimentId],
					)
				).rows[0]?.status,
			).toBe("cancelled");
			providerRelease.resolve();
			await Bun.sleep(50);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM experiment_results WHERE experiment_id = $1",
						[experimentId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			if (previousTimeout === undefined)
				delete process.env.EXECUTION_ADMISSION_TIMEOUT_MS;
			else process.env.EXECUTION_ADMISSION_TIMEOUT_MS = previousTimeout;
			providerRelease.resolve();
			controller.abort();
			await pool.query(
				"DELETE FROM experiment_results WHERE experiment_id = $1",
				[experimentId],
			);
			await pool.query(
				"DELETE FROM execution_admission_claims WHERE admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1 AND work_kind = 'experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $2))",
				[projectId, experimentId],
			);
			await pool.query(
				"DELETE FROM execution_effects WHERE project_id = $1 AND work_kind = 'experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $2)",
				[projectId, experimentId],
			);
			await pool.query(
				"DELETE FROM execution_admissions WHERE project_id = $1 AND work_kind = 'experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $2)",
				[projectId, experimentId],
			);
			await pool.query(
				"DELETE FROM experiment_tasks WHERE experiment_id = $1",
				[experimentId],
			);
			await pool.query("DELETE FROM experiments WHERE id = $1", [experimentId]);
			const cleanup = await pool.connect();
			try {
				await cleanup.query("BEGIN");
				await cleanup.query(
					"SELECT set_config('astraea.project_deletion_id', $1, true)",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM dataset_version_items WHERE dataset_version_id = $1",
					[versionId],
				);
				await cleanup.query("DELETE FROM dataset_versions WHERE id = $1", [
					versionId,
				]);
				await cleanup.query("DELETE FROM dataset_items WHERE dataset_id = $1", [
					datasetId,
				]);
				await cleanup.query("DELETE FROM datasets WHERE id = $1", [datasetId]);
				await cleanup.query(
					"UPDATE projects SET status = 'archived' WHERE id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM project_memberships WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
					[projectId],
				);
				await cleanup.query("COMMIT");
			} catch (cause) {
				await cleanup.query("ROLLBACK").catch(() => {});
				throw cause;
			} finally {
				cleanup.release();
			}
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revoked member cannot receive a queued evaluation SSE snapshot",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const datasetId = randomUUID();
		const experimentId = randomUUID();
		const subject = `experiment-sse-${actorId}`;
		const firstWrite = deferred();
		const releaseFirstWrite = deferred();
		const demoter = await pool.connect();
		const originalWrite = StreamingApi.prototype.write;
		let revoke: Promise<void> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let blocked = false;
		let additionalManagerActorId: string | undefined;
		StreamingApi.prototype.write = async function (data) {
			if (!blocked && String(data).includes("event: experiment")) {
				blocked = true;
				firstWrite.resolve();
				await releaseFirstWrite.promise;
			}
			return originalWrite.call(this, data);
		};
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Experiment SSE revocation",
				`experiment-sse-${organizationId}`,
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
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Experiment SSE revocation', $3)",
				[projectId, organizationId, `experiment-sse-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"experiment-sse",
				)
			).actorId;
			await pool.query(
				"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'experiment-sse-dataset', 'Experiment SSE dataset')",
				[datasetId, projectId],
			);
			await pool.query(
				"INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id) VALUES ($1, $2, $3, '{}', 'running', $4)",
				[experimentId, projectId, datasetId, actorId],
			);
			const handlers = createExperimentHandlers({
				pool: () => pool,
				getExperiment: getExperimentRecord,
			} as unknown as ExperimentDependencies);
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
			api.openapi(getExperimentEvents, handlers.handleGetExperimentEvents);
			const response = await api.request(
				`/v1/experiments/${experimentId}/events?project_id=${projectId}`,
			);
			expect(response.status).toBe(200);
			reader = response.body?.getReader();
			if (!reader) throw new Error("Experiment SSE response has no body");
			await reader.read();
			await firstWrite.promise;
			await demoter.query(
				"SET application_name = 'astraea-experiment-sse-revocation'",
			);
			revoke = (async () => {
				await demoter.query("BEGIN");
				await demoter.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[projectId, organizationId, actorId],
				);
				await demoter.query("COMMIT");
			})();
			await waitForLock(pool, "astraea-experiment-sse-revocation");
			releaseFirstWrite.resolve();
			await revoke;
			let body = "";
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				body += new TextDecoder().decode(next.value);
			}
			expect(body.match(/event: experiment/g)).toHaveLength(1);
		} finally {
			releaseFirstWrite.resolve();
			await revoke?.catch(() => {});
			await reader?.cancel().catch(() => {});
			StreamingApi.prototype.write = originalWrite;
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
			await pool.query(
				"DELETE FROM experiment_results WHERE experiment_id = $1",
				[experimentId],
			);
			await pool.query(
				"DELETE FROM experiment_tasks WHERE experiment_id = $1",
				[experimentId],
			);
			await pool.query("DELETE FROM experiments WHERE id = $1", [experimentId]);
			await pool.query("DELETE FROM datasets WHERE id = $1", [datasetId]);
			await pool.query(
				"UPDATE projects SET status = 'archived' WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM project_memberships WHERE project_id = $1",
				[projectId],
			);
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			await pool.query(
				"DELETE FROM organization_memberships WHERE organization_id = $1",
				[organizationId],
			);
			await deleteScenarioActor(pool, actorId);
			if (additionalManagerActorId)
				await deleteScenarioActor(pool, additionalManagerActorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation committed between evaluation validation and dispatch claim prevents provider and ClickHouse writer calls",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const revoker = await pool.connect();
		const fixture = await seedExecutionExperiment(pool);
		const validated = deferred();
		const releaseClaim = deferred();
		let paused = false;
		let providerCalls = 0;
		let traceCalls = 0;
		try {
			const deps = {
				pool: () => pool,
				updateExperiment,
				claimTask: claimExperimentTask,
				completeExperiment: completeExperimentIfTasksFinished,
				nextTaskRetryDelay: async () => null,
				waitForTaskRetry: async () => {},
				finalizeTask: finalizeExperimentTask,
				admitExecution: admitExperimentExecution,
				isAdmissionActive: async (
					db: Parameters<typeof experimentExecutionAdmissionIsActive>[0],
					input: Parameters<typeof experimentExecutionAdmissionIsActive>[1],
				) => {
					const active = await experimentExecutionAdmissionIsActive(db, input);
					if (!paused) {
						paused = true;
						validated.resolve();
						await releaseClaim.promise;
					}
					return active;
				},
				claimExecution: claimExperimentExecution,
				cancelAdmission: cancelExecutionAdmission,
				completeAdmission: completeExecutionAdmission,
				invokeLlm: async () => {
					providerCalls += 1;
					return { output: { answer: true }, model: "test" };
				},
				trace: async () => {
					traceCalls += 1;
				},
			} as unknown as ExperimentDependencies;
			const executing = executeExperiment(deps, {
				project_id: fixture.projectId,
				experiment_id: fixture.experimentId,
				dataset_id: fixture.datasetId,
				config: {},
			});
			await validated.promise;
			await revoker.query("BEGIN");
			await revoker.query(
				"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[fixture.projectId, fixture.organizationId, fixture.actorId],
			);
			await revoker.query("COMMIT");
			releaseClaim.resolve();
			await executing;

			expect(providerCalls).toBe(0);
			expect(traceCalls).toBe(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM execution_admission_claims WHERE admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
						[fixture.projectId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			releaseClaim.resolve();
			await revoker.query("ROLLBACK").catch(() => {});
			revoker.release();
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"an evaluation dispatch claim that commits first is cancelled after revocation and suppresses later persistence",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedExecutionExperiment(pool);
		const providerEntered = deferred();
		const providerAborted = deferred();
		let aborted = false;
		try {
			const deps = {
				pool: () => pool,
				updateExperiment,
				claimTask: claimExperimentTask,
				completeExperiment: completeExperimentIfTasksFinished,
				nextTaskRetryDelay: async () => null,
				waitForTaskRetry: async () => {},
				finalizeTask: finalizeExperimentTask,
				admitExecution: admitExperimentExecution,
				isAdmissionActive: experimentExecutionAdmissionIsActive,
				claimExecution: claimExperimentExecution,
				cancelAdmission: cancelExecutionAdmission,
				completeAdmission: completeExecutionAdmission,
				invokeLlm: async (
					_input: unknown,
					_config: unknown,
					signal: AbortSignal,
				) => {
					providerEntered.resolve();
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								providerAborted.resolve();
								resolve();
							},
							{ once: true },
						);
					});
					return { output: { answer: "late" }, model: "test" };
				},
				trace: async () => {
					throw new Error("a cancelled provider must not reach tracing");
				},
			} as unknown as ExperimentDependencies;
			const executing = executeExperiment(deps, {
				project_id: fixture.projectId,
				experiment_id: fixture.experimentId,
				dataset_id: fixture.datasetId,
				config: {},
			});
			await providerEntered.promise;
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM execution_admission_claims WHERE effect = 'provider_dispatch' AND admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
						[fixture.projectId],
					)
				).rows[0]?.count,
			).toBe(1);
			await pool.query(
				"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[fixture.projectId, fixture.organizationId, fixture.actorId],
			);
			await Promise.race([
				providerAborted.promise,
				Bun.sleep(1_500).then(() => {
					throw new Error("revocation did not abort the dispatched provider");
				}),
			]);
			await executing;

			expect(aborted).toBe(true);
			expect(
				(
					await pool.query(
						"SELECT status FROM execution_admission_claims WHERE effect = 'provider_dispatch' AND admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
						[fixture.projectId],
					)
				).rows[0]?.status,
			).toBe("cancelled");
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM experiment_results WHERE experiment_id = $1",
						[fixture.experimentId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation committed before the trace-write claim suppresses the mocked ClickHouse writer",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const revoker = await pool.connect();
		const fixture = await seedExecutionExperiment(pool);
		const traceValidated = deferred();
		const releaseTraceClaim = deferred();
		let checks = 0;
		let traceCalls = 0;
		try {
			const deps = {
				pool: () => pool,
				updateExperiment,
				claimTask: claimExperimentTask,
				completeExperiment: completeExperimentIfTasksFinished,
				nextTaskRetryDelay: async () => null,
				waitForTaskRetry: async () => {},
				finalizeTask: finalizeExperimentTask,
				admitExecution: admitExperimentExecution,
				isAdmissionActive: async (
					db: Parameters<typeof experimentExecutionAdmissionIsActive>[0],
					input: Parameters<typeof experimentExecutionAdmissionIsActive>[1],
				) => {
					const active = await experimentExecutionAdmissionIsActive(db, input);
					checks += 1;
					if (checks === 3) {
						traceValidated.resolve();
						await releaseTraceClaim.promise;
					}
					return active;
				},
				claimExecution: claimExperimentExecution,
				cancelAdmission: cancelExecutionAdmission,
				completeAdmission: completeExecutionAdmission,
				invokeLlm: async () => ({
					output: { answer: true },
					model: "test",
				}),
				trace: async () => {
					traceCalls += 1;
				},
			} as unknown as ExperimentDependencies;
			const executing = executeExperiment(deps, {
				project_id: fixture.projectId,
				experiment_id: fixture.experimentId,
				dataset_id: fixture.datasetId,
				config: {},
			});
			await traceValidated.promise;
			await revoker.query("BEGIN");
			await revoker.query(
				"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[fixture.projectId, fixture.organizationId, fixture.actorId],
			);
			await revoker.query("COMMIT");
			releaseTraceClaim.resolve();
			await executing;

			expect(traceCalls).toBe(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM execution_admission_claims WHERE effect = 'trace_write' AND admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
						[fixture.projectId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			releaseTraceClaim.resolve();
			await revoker.query("ROLLBACK").catch(() => {});
			revoker.release();
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation committed between optimization validation and dispatch claim prevents worker execution",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const revoker = await pool.connect();
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const promptId = randomUUID();
		const jobId = randomUUID();
		const subject = `optimization-dispatch-${actorId}`;
		const validated = deferred();
		const releaseClaim = deferred();
		let paused = false;
		let workerCalls = 0;
		let additionalManagerActorId: string | undefined;
		const job: OptimizationJob = {
			id: jobId,
			project_id: projectId,
			prompt_id: promptId,
			prompt_slug: "dispatch-race",
			source_version: 1,
			target: "system",
			evaluator: { type: "default_adapter" },
			dataset: {
				version: 1,
				rubric: "race test",
				training_examples: [{ input: "input", answer: "answer" }],
				validation_examples: [{ input: "held out", answer: "answer" }],
			},
			dataset_hash: "a".repeat(64),
			model_config: { task_lm: "task", reflection_lm: "reflection" },
			budget: { max_metric_calls: 1 },
			status: "queued",
			requested_by: subject,
			result_version: null,
			candidate_content: null,
			evidence: null,
			promotion_status: "pending",
			promotion_reason: null,
			reviewed_by: null,
			promoted_at: null,
			error_message: null,
			metric_calls_used: null,
			created_at: "2026-08-11T00:00:00.000Z",
			updated_at: "2026-08-11T00:00:00.000Z",
			completed_at: null,
		};
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Optimization dispatch race",
				`optimization-dispatch-${organizationId}`,
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
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Optimization dispatch race', $3)",
				[projectId, organizationId, `optimization-dispatch-${projectId}`],
			);
			await pool.query(
				"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager')",
				[projectId, organizationId, subject],
			);
			await seedDurableProjectAccess(pool, organizationId, projectId, actorId);
			additionalManagerActorId = (
				await seedAdditionalProjectManager(
					pool,
					organizationId,
					projectId,
					"optimization-dispatch",
				)
			).actorId;
			await pool.query(
				"INSERT INTO prompts (id, project_id, name, slug) VALUES ($1, $2, 'Dispatch race prompt', 'dispatch-race')",
				[promptId, projectId],
			);
			await pool.query(
				'INSERT INTO prompt_optimization_jobs (id, project_id, prompt_id, prompt_slug, source_version, target_role, source_messages, evaluator, examples, dataset, dataset_hash, model_config, budget, status, requested_by) VALUES ($1, $2, $3, \'dispatch-race\', 1, \'system\', \'[{"role":"system","content":"Summarize"}]\'::jsonb, \'{}\'::jsonb, \'[]\'::jsonb, $4::jsonb, $5, \'{"task_lm":"task","reflection_lm":"reflection"}\'::jsonb, \'{"max_metric_calls":1}\'::jsonb, \'queued\', $6)',
				[
					jobId,
					projectId,
					promptId,
					JSON.stringify(job.dataset),
					job.dataset_hash,
					subject,
				],
			);
			const deps = {
				pool: () => pool,
				claim: claimOptimizationJob,
				transition: transitionOptimizationJob,
				sourceMessages: async () => [
					{ role: "system" as const, content: "Summarize" },
				],
				admitExecution: admitOptimizationExecution,
				isAdmissionActive: async (
					db: Parameters<typeof optimizationExecutionAdmissionIsActive>[0],
					input: Parameters<typeof optimizationExecutionAdmissionIsActive>[1],
				) => {
					const active = await optimizationExecutionAdmissionIsActive(
						db,
						input,
					);
					if (!paused) {
						paused = true;
						validated.resolve();
						await releaseClaim.promise;
					}
					return active;
				},
				claimExecution: claimOptimizationExecution,
				cancelAdmission: cancelExecutionAdmission,
				completeAdmission: completeExecutionAdmission,
				cancelExecution: async () => {},
				renew: async () => true,
				worker: async () => {
					workerCalls += 1;
					return {
						candidate: "Summarize safely.",
						training_score: 1,
						validation_score: 1,
						baseline_validation_score: 0,
						metric_calls_used: 1,
					};
				},
			} as unknown as OptimizationDependencies;
			const running = runOptimizationJob(job, deps);
			await validated.promise;
			await revoker.query("BEGIN");
			await revoker.query(
				"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[projectId, organizationId, actorId],
			);
			await revoker.query("COMMIT");
			releaseClaim.resolve();
			await running;

			expect(workerCalls).toBe(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM execution_admission_claims WHERE admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
						[projectId],
					)
				).rows[0]?.count,
			).toBe(0);
		} finally {
			releaseClaim.resolve();
			await revoker.query("ROLLBACK").catch(() => {});
			revoker.release();
			const cleanup = await pool.connect();
			try {
				await cleanup.query("BEGIN");
				await cleanup.query(
					"SELECT set_config('astraea.project_deletion_id', $1, true)",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM execution_admission_claims WHERE admission_id IN (SELECT id FROM execution_admissions WHERE project_id = $1)",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM execution_effects WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM execution_admissions WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM prompt_optimization_events WHERE job_id IN (SELECT id FROM prompt_optimization_jobs WHERE project_id = $1)",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM prompt_optimization_jobs WHERE id = $1",
					[jobId],
				);
				await cleanup.query("DELETE FROM prompts WHERE id = $1", [promptId]);
				await cleanup.query(
					"UPDATE projects SET status = 'archived' WHERE id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM project_memberships WHERE project_id = $1",
					[projectId],
				);
				await cleanup.query(
					"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
					[projectId],
				);
				await cleanup.query(
					"DELETE FROM organization_memberships WHERE organization_id = $1",
					[organizationId],
				);
				await cleanup.query(
					"DELETE FROM actor_identities WHERE actor_id = ANY($1::uuid[])",
					[[actorId, additionalManagerActorId].filter(Boolean)],
				);
				await cleanup.query("DELETE FROM actors WHERE id = ANY($1::uuid[])", [
					[actorId, additionalManagerActorId].filter(Boolean),
				]);
				await cleanup.query("COMMIT");
			} catch (cause) {
				await cleanup.query("ROLLBACK").catch(() => {});
				throw cause;
			} finally {
				cleanup.release();
			}
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation holding its project grant first serializes project authorization without 40P01 and fails closed",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedExecutionExperiment(pool);
		const revoker = await pool.connect();
		const authorizer = await pool.connect();
		try {
			await revoker.query("BEGIN");
			await revoker.query(
				"SELECT actor_id FROM project_actor_grants WHERE project_id = $1 AND actor_id = $2 FOR UPDATE",
				[fixture.projectId, fixture.actorId],
			);
			await authorizer.query("BEGIN");
			await authorizer.query(
				"SET application_name = 'astraea-grant-first-project'",
			);
			const authorized = lockActiveAuthorizedProject(
				authorizer,
				fixture.projectId,
				{
					organization_id: fixture.organizationId,
					actor_id: fixture.actorId,
					operation: "product_write",
				},
			);
			await waitForLock(pool, "astraea-grant-first-project");
			const revoke = (async () => {
				await revoker.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
					[fixture.projectId, fixture.organizationId, fixture.actorId],
				);
				await revoker.query("COMMIT");
			})();
			const allowed = await Promise.race([
				authorized,
				Bun.sleep(2_000).then(() => {
					throw new Error("project authorization deadlocked behind revocation");
				}),
			]);
			await revoke;
			await authorizer.query("COMMIT");

			expect(allowed).toBe(false);
		} finally {
			await authorizer.query("ROLLBACK").catch(() => {});
			await revoker.query("ROLLBACK").catch(() => {});
			authorizer.release();
			revoker.release();
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"a revocation holding its organization role first serializes the default-project lock without 40P01 and fails closed",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const actorId = randomUUID();
		const subject = `default-race-${actorId}`;
		const revoker = await pool.connect();
		const defaultProject = await pool.connect();
		try {
			await seedOrganizationWithDefaultProject(
				pool,
				organizationId,
				"Default lock race",
				`default-lock-race-${organizationId}`,
			);
			await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
			await pool.query(
				"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
				[actorId, organizationId, subject],
			);
			await pool.query(
				"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'owner')",
				[organizationId, subject],
			);
			await seedDurableOrganizationAdmin(pool, organizationId, actorId);
			await seedAdditionalOrganizationOwner(
				pool,
				organizationId,
				"default-race",
			);
			await pool.query(
				"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Default lock race', $3)",
				[projectId, organizationId, `default-lock-race-${projectId}`],
			);

			await revoker.query("BEGIN");
			await revoker.query(
				"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
				[organizationId, actorId],
			);
			await defaultProject.query("BEGIN");
			await defaultProject.query(
				"SET application_name = 'astraea-role-first-default'",
			);
			const authorized = lockActiveAuthorizedOrganizationProject(
				defaultProject,
				projectId,
				organizationId,
				actorId,
				"destructive",
			);
			await waitForLock(pool, "astraea-role-first-default");
			const revoke = (async () => {
				await revoker.query(
					"DELETE FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
					[organizationId, actorId],
				);
				await revoker.query("COMMIT");
			})();
			const allowed = await Promise.race([
				authorized,
				Bun.sleep(2_000).then(() => {
					throw new Error(
						"default-project authorization deadlocked behind revocation",
					);
				}),
			]);
			await revoke;
			await defaultProject.query("COMMIT");

			expect(allowed).toBe(false);
		} finally {
			await defaultProject.query("ROLLBACK").catch(() => {});
			await revoker.query("ROLLBACK").catch(() => {});
			defaultProject.release();
			revoker.release();
			await pool.query(
				"WITH grants AS (DELETE FROM project_actor_grants WHERE project_id = $1) DELETE FROM projects WHERE id = $1",
				[projectId],
			);
			// The default project and its remaining Admin are retained by design.
			await deleteScenarioActor(pool, actorId);
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"stable effect claims make ambiguous commit replay and concurrent callers dispatch provider and trace effects exactly once",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedExecutionExperiment(pool);
		const first = await pool.connect();
		const second = await pool.connect();
		const admissionId = randomUUID();
		let providerDispatches = 0;
		let traceWrites = 0;
		try {
			const epoch = await pool.query<{ authorization_epoch: number }>(
				"SELECT authorization_epoch FROM projects WHERE id = $1",
				[fixture.projectId],
			);
			await pool.query(
				"INSERT INTO execution_admissions (id, organization_id, project_id, requester_actor_id, work_kind, work_id, authorization_epoch, expires_at) VALUES ($1, $2, $3, $4, 'experiment_task', $5, $6, now() + interval '1 minute')",
				[
					admissionId,
					fixture.organizationId,
					fixture.projectId,
					fixture.actorId,
					fixture.itemId,
					epoch.rows[0]!.authorization_epoch,
				],
			);

			await first.query("BEGIN");
			const created = await claimExecutionAdmission(first, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "provider_dispatch",
				effect_key: "provider",
			});
			await second.query("BEGIN");
			await second.query(
				"SET application_name = 'astraea-effect-claim-replay'",
			);
			const replay = claimExecutionAdmission(second, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "provider_dispatch",
				effect_key: "provider",
			});
			await waitForLock(pool, "astraea-effect-claim-replay");
			await first.query("COMMIT");
			if (created.status === "created") providerDispatches += 1;
			const existing = await replay;
			await second.query("COMMIT");
			if (existing.status === "created") providerDispatches += 1;

			const traceCreated = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "trace_write",
				effect_key: "trace",
			});
			if (traceCreated.status === "created") traceWrites += 1;
			const traceReplay = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "trace_write",
				effect_key: "trace",
			});
			if (traceReplay.status === "created") traceWrites += 1;

			const metricOne = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "metric_write",
				effect_key: "metric:1",
			});
			const metricTwo = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "metric_write",
				effect_key: "metric:2",
			});
			const eventPreparing = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "event_write",
				effect_key: "event:preparing",
			});
			const eventCompleted = await claimExecutionAdmission(pool, {
				id: admissionId,
				project_id: fixture.projectId,
				effect: "event_write",
				effect_key: "event:completed",
			});

			expect(created).toEqual({ status: "created" });
			expect(existing).toEqual({ status: "existing" });
			expect(traceCreated).toEqual({ status: "created" });
			expect(traceReplay).toEqual({ status: "existing" });
			expect(providerDispatches).toBe(1);
			expect(traceWrites).toBe(1);
			expect(metricOne).toEqual({ status: "created" });
			expect(metricTwo).toEqual({ status: "created" });
			expect(eventPreparing).toEqual({ status: "created" });
			expect(eventCompleted).toEqual({ status: "created" });
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM execution_admission_claims WHERE admission_id = $1",
						[admissionId],
					)
				).rows[0]?.count,
			).toBe(6);
		} finally {
			await first.query("ROLLBACK").catch(() => {});
			await second.query("ROLLBACK").catch(() => {});
			first.release();
			second.release();
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"expired experiment-task lease recovery never redispatches a committed logical provider or trace effect",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 5 });
		const fixture = await seedExecutionExperiment(pool);
		const first = await pool.connect();
		const recovery = await pool.connect();
		let providerCalls = 0;
		let traceWrites = 0;
		try {
			const initialTask = await claimExperimentTask(pool, {
				project_id: fixture.projectId,
				experiment_id: fixture.experimentId,
				lease_seconds: 1,
			});
			expect(initialTask).not.toBeNull();
			const initialAdmission = await admitExperimentExecution(pool, {
				project_id: fixture.projectId,
				id: fixture.experimentId,
				work_id: initialTask!.id,
				timeout_ms: 1_000,
			});
			expect(initialAdmission).not.toBeNull();

			await first.query("BEGIN");
			const firstProvider = await claimExecutionAdmission(first, {
				id: initialAdmission!.id,
				project_id: fixture.projectId,
				effect: "provider_dispatch",
				effect_key: "provider:1",
			});
			const firstTrace = await claimExecutionAdmission(first, {
				id: initialAdmission!.id,
				project_id: fixture.projectId,
				effect: "trace_write",
				effect_key: "trace:1",
			});
			await first.query("COMMIT");
			if (firstProvider.status === "created") providerCalls += 1;
			if (firstTrace.status === "created") traceWrites += 1;

			await pool.query(
				"UPDATE execution_admissions SET expires_at = now() - interval '1 second' WHERE id = $1",
				[initialAdmission!.id],
			);
			await pool.query(
				"UPDATE experiment_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
				[initialTask!.id],
			);
			const recoveredTask = await claimExperimentTask(pool, {
				project_id: fixture.projectId,
				experiment_id: fixture.experimentId,
				lease_seconds: 60,
			});
			expect(recoveredTask?.id).toBe(initialTask!.id);
			expect(recoveredTask?.lease_token).not.toBe(initialTask!.lease_token);
			const recoveryAdmission = await admitExperimentExecution(pool, {
				project_id: fixture.projectId,
				id: fixture.experimentId,
				work_id: recoveredTask!.id,
				timeout_ms: 1_000,
			});
			expect(recoveryAdmission).not.toBeNull();

			await recovery.query("BEGIN");
			const recoveredProvider = await claimExecutionAdmission(recovery, {
				id: recoveryAdmission!.id,
				project_id: fixture.projectId,
				effect: "provider_dispatch",
				effect_key: "provider:1",
			});
			const recoveredTrace = await claimExecutionAdmission(recovery, {
				id: recoveryAdmission!.id,
				project_id: fixture.projectId,
				effect: "trace_write",
				effect_key: "trace:1",
			});
			await recovery.query("COMMIT");
			if (recoveredProvider.status === "created") providerCalls += 1;
			if (recoveredTrace.status === "created") traceWrites += 1;

			const metricOne = await claimExecutionAdmission(pool, {
				id: recoveryAdmission!.id,
				project_id: fixture.projectId,
				effect: "metric_write",
				effect_key: "metric:1",
			});
			const metricTwo = await claimExecutionAdmission(pool, {
				id: recoveryAdmission!.id,
				project_id: fixture.projectId,
				effect: "metric_write",
				effect_key: "metric:2",
			});

			expect(firstProvider).toEqual({ status: "created" });
			expect(firstTrace).toEqual({ status: "created" });
			expect(recoveredProvider).toEqual({ status: "existing" });
			expect(recoveredTrace).toEqual({ status: "existing" });
			expect(providerCalls).toBe(1);
			expect(traceWrites).toBe(1);
			expect(metricOne).toEqual({ status: "created" });
			expect(metricTwo).toEqual({ status: "created" });
		} finally {
			await first.query("ROLLBACK").catch(() => {});
			await recovery.query("ROLLBACK").catch(() => {});
			first.release();
			recovery.release();
			await fixture.cleanup();
			await pool.end();
		}
	},
);
