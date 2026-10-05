import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	admitEvaluationRun,
	cancelEvaluationRun,
	EvaluationRunRepositoryError,
	getEvaluationRunStatus,
} from "../../src/db/evaluation-runs";
import {
	claimExperimentTask,
	getExperiment,
	listRecoverableExperiments,
} from "../../src/db/experiments";

const databaseUrl = process.env.DATABASE_URL;

async function seedRunAdmission(pool: Pool) {
	const organizationId = randomUUID();
	const defaultProjectId = randomUUID();
	const projectId = randomUUID();
	const actorId = randomUUID();
	const datasetId = randomUUID();
	const datasetVersionId = randomUUID();
	const datasetVersionItemId = randomUUID();
	const evaluationId = randomUUID();
	const definitionVersionId = randomUUID();

	await pool.query(
		`WITH organization AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1, $2, $3, $4)
			RETURNING id
		)
		INSERT INTO projects (id, organization_id, name, slug)
		SELECT $4, id, 'Default Project', 'default' FROM organization
		UNION ALL
		SELECT $5, id, 'Capacity race', $6 FROM organization`,
		[
			organizationId,
			"Capacity race",
			`capacity-race-${organizationId}`,
			defaultProjectId,
			projectId,
			`capacity-race-${projectId}`,
		],
	);
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
		[actorId, organizationId, `capacity-race-${actorId}`],
	);
	await pool.query(
		"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'member')",
		[organizationId, `capacity-race-${actorId}`],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'user')",
		[organizationId, actorId],
	);
	await pool.query(
		"INSERT INTO datasets (id, project_id, slug, name) VALUES ($1, $2, 'capacity-dataset', 'Capacity dataset')",
		[datasetId, projectId],
	);
	await pool.query(
		"INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash) VALUES ($1, $2, $3, 1, 1, repeat('a', 64))",
		[datasetVersionId, projectId, datasetId],
	);
	await pool.query(
		'INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input, expected_output) VALUES ($1, $2, $3, \'only\', 0, \'{"question":"one"}\', \'{"output":"one"}\')',
		[datasetVersionItemId, projectId, datasetVersionId],
	);
	await pool.query(
		"INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by) VALUES ($1, $2, $3, 'capacity-evaluation', 'Capacity evaluation', $4)",
		[evaluationId, organizationId, projectId, actorId],
	);
	await pool.query(
		`INSERT INTO evaluation_definition_versions (
			id, evaluation_id, organization_id, project_id, version, dataset_version_id,
			evaluator, target, execution_defaults, thresholds, sampling, limits,
			content_hash, published_by, published_draft_revision
		) VALUES (
			$1, $2, $3, $4, 1, $5,
			'{"kind":"exact_match","version":"v1","expected_output_path":"$.expected_output","output_path":"$.output"}',
			'{"kind":"configured_llm","provider":"openai","model":"gpt-4o-mini","system_prompt":null}',
			'{"temperature":0,"max_tokens":null}', '{"minimum_pass_rate":null}',
			'{"strategy":"first_n","sample_size":1,"seed":0}', '{"max_cost_usd":1,"max_duration_seconds":60}',
			repeat('b', 64), $6, 1
		)`,
		[
			definitionVersionId,
			evaluationId,
			organizationId,
			projectId,
			datasetVersionId,
			actorId,
		],
	);

	return {
		organizationId,
		projectId,
		actorId,
		datasetId,
		evaluationId,
		cleanup: async () => {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query(
					"SELECT set_config('astraea.project_deletion_id', $1, true)",
					[projectId],
				);
				await client.query(
					"DELETE FROM experiment_results WHERE project_id=$1",
					[projectId],
				);
				await client.query("DELETE FROM experiment_tasks WHERE project_id=$1", [
					projectId,
				]);
				await client.query("DELETE FROM experiments WHERE project_id=$1", [
					projectId,
				]);
				await client.query(
					"DELETE FROM evaluation_run_items WHERE project_id=$1",
					[projectId],
				);
				await client.query(
					"DELETE FROM evaluation_run_inputs WHERE project_id=$1",
					[projectId],
				);
				await client.query(
					"DELETE FROM evaluation_run_capacity_admissions WHERE project_id=$1",
					[projectId],
				);
				await client.query("DELETE FROM evaluation_runs WHERE project_id=$1", [
					projectId,
				]);
				await client.query(
					"DELETE FROM evaluation_definition_versions WHERE project_id=$1",
					[projectId],
				);
				await client.query("DELETE FROM evaluations WHERE project_id=$1", [
					projectId,
				]);
				await client.query(
					"DELETE FROM dataset_version_items WHERE project_id=$1",
					[projectId],
				);
				await client.query("DELETE FROM dataset_versions WHERE project_id=$1", [
					projectId,
				]);
				await client.query("DELETE FROM datasets WHERE project_id=$1", [
					projectId,
				]);
				await client.query(
					"DELETE FROM project_actor_grants WHERE organization_id=$1",
					[organizationId],
				);
				await client.query(
					"DELETE FROM organization_actor_roles WHERE organization_id=$1",
					[organizationId],
				);
				await client.query(
					"DELETE FROM organization_memberships WHERE organization_id=$1",
					[organizationId],
				);
				await client.query("DELETE FROM actor_identities WHERE actor_id=$1", [
					actorId,
				]);
				await client.query("DELETE FROM actors WHERE id=$1", [actorId]);
				await client.query("DELETE FROM projects WHERE id=$1", [projectId]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		},
	};
}

test.skipIf(!databaseUrl)(
	"terminalizes a recovered Run whose persisted provider-charge ledger has exhausted its budget",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		const previousProviderCap =
			process.env.EVALUATION_MAX_PROVIDER_CALLS_PER_RUN;
		try {
			const run = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "recovery-provider-budget-exhausted",
				authorization,
			});
			await pool.query(
				"UPDATE evaluation_runs SET provider_call_count=1 WHERE id=$1 AND project_id=$2",
				[run.id, fixture.projectId],
			);
			process.env.EVALUATION_MAX_PROVIDER_CALLS_PER_RUN = "1";

			expect(await listRecoverableExperiments(pool)).not.toContainEqual(
				expect.objectContaining({ id: run.experiment_id }),
			);
			expect(
				await pool.query(
					"SELECT status, terminal_reason FROM evaluation_runs WHERE id=$1",
					[run.id],
				),
			).toMatchObject({
				rows: [
					{
						status: "failed",
						terminal_reason: "provider_call_limit_exceeded",
					},
				],
			});
		} finally {
			if (previousProviderCap === undefined)
				delete process.env.EVALUATION_MAX_PROVIDER_CALLS_PER_RUN;
			else
				process.env.EVALUATION_MAX_PROVIDER_CALLS_PER_RUN = previousProviderCap;
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"terminalizes a legacy Experiment without an immutable Run before recovery can invoke its provider",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		try {
			const legacyId = randomUUID();
			await pool.query(
				`INSERT INTO experiments (
					id, project_id, agent_id, dataset_id, resolved_dataset_version_id,
					dataset_input_binding, name, config, status, requested_by_actor_id
				) VALUES ($1, $2, NULL, $3, (SELECT id FROM dataset_versions WHERE dataset_id=$3 AND project_id=$2), 'versioned', 'legacy recovery fixture', '{"provider":"openai","model":"gpt-4o-mini"}', 'pending', $4)`,
				[legacyId, fixture.projectId, fixture.datasetId, fixture.actorId],
			);

			expect(await listRecoverableExperiments(pool)).not.toContainEqual(
				expect.objectContaining({ id: legacyId }),
			);
			expect(
				await pool.query("SELECT status FROM experiments WHERE id=$1", [
					legacyId,
				]),
			).toMatchObject({ rows: [{ status: "failed" }] });
		} finally {
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"re-admits historical Runs against the current capacity before returning them for recovery",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		const previousProjectCap =
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT;
		const previousActorCap = process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR;
		try {
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT = "2";
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR = "2";
			const first = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "recovery-current-capacity-first",
				authorization,
			});
			const second = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "recovery-current-capacity-second",
				authorization,
			});
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT = "1";
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR = "1";

			const recovered = await listRecoverableExperiments(pool);
			const ownRecoveries = recovered.filter(
				(candidate) =>
					candidate.id === first.experiment_id ||
					candidate.id === second.experiment_id,
			);
			expect(ownRecoveries).toHaveLength(1);
			expect(
				await pool.query(
					"SELECT id, status, terminal_reason FROM evaluation_runs WHERE id = ANY($1::uuid[]) ORDER BY id",
					[[first.id, second.id]],
				),
			).toMatchObject({
				rows: expect.arrayContaining([
					expect.objectContaining({ status: "pending", terminal_reason: null }),
					expect.objectContaining({
						status: "failed",
						terminal_reason: "capacity_limit_exceeded",
					}),
				]),
			});
		} finally {
			if (previousProjectCap === undefined)
				delete process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT;
			else
				process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT = previousProjectCap;
			if (previousActorCap === undefined)
				delete process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR;
			else process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR = previousActorCap;
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"terminalizes a Run whose persisted provider target is no longer allowed before recovery can resume it",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		const previousAllowedModels = process.env.EVALUATION_ALLOWED_MODELS;
		try {
			const run = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "recovery-revoked-provider",
				authorization,
			});
			process.env.EVALUATION_ALLOWED_MODELS = "codex_cli/safe-model";

			expect(await listRecoverableExperiments(pool)).not.toContainEqual(
				expect.objectContaining({ id: run.experiment_id }),
			);
			expect(
				await pool.query(
					"SELECT status, terminal_reason FROM evaluation_runs WHERE id=$1",
					[run.id],
				),
			).toMatchObject({
				rows: [
					{ status: "failed", terminal_reason: "provider_policy_revoked" },
				],
			});
			expect(
				await pool.query("SELECT status FROM experiments WHERE id=$1", [
					run.experiment_id,
				]),
			).toMatchObject({ rows: [{ status: "failed" }] });
		} finally {
			if (previousAllowedModels === undefined)
				delete process.env.EVALUATION_ALLOWED_MODELS;
			else process.env.EVALUATION_ALLOWED_MODELS = previousAllowedModels;
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"reports persisted provider-call charges in the durable lifecycle status",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		try {
			const run = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "lifecycle-provider-call-count",
				authorization,
			});
			await pool.query(
				"UPDATE evaluation_runs SET provider_call_count=3 WHERE id=$1 AND project_id=$2",
				[run.id, fixture.projectId],
			);

			const status = await getEvaluationRunStatus(pool, {
				id: run.id,
				project_id: fixture.projectId,
				authorization: { ...authorization, operation: "product_read" },
			});

			expect(status.metrics.provider_calls_used).toBe(3);
		} finally {
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"does not serialize mutable persisted execution config from an admitted Experiment",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const fixture = await seedRunAdmission(pool);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		try {
			const run = await admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: "persisted-config-serialization",
				authorization,
			});
			const persisted = await pool.query<{ config: Record<string, unknown> }>(
				"SELECT config FROM experiments WHERE id=$1 AND project_id=$2",
				[run.experiment_id, fixture.projectId],
			);
			expect(persisted.rows[0]?.config).toMatchObject({
				model: "gpt-4o-mini",
			});

			const experiment = await getExperiment(pool, {
				id: run.experiment_id,
				project_id: fixture.projectId,
				authorization: { ...authorization, operation: "product_read" },
			});

			expect(experiment).not.toHaveProperty("config");
			expect(JSON.stringify(experiment)).not.toContain("gpt-4o-mini");
		} finally {
			await fixture.cleanup();
			await pool.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"serializes capacity at PostgreSQL and reconciles release paths without a process restart",
	async () => {
		const poolA = new Pool({ connectionString: databaseUrl, max: 1 });
		const poolB = new Pool({ connectionString: databaseUrl, max: 1 });
		const previousProjectCap =
			process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT;
		const previousActorCap = process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR;
		process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT = "1";
		process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR = "1";
		const fixture = await seedRunAdmission(poolA);
		const authorization = {
			organization_id: fixture.organizationId,
			actor_id: fixture.actorId,
			operation: "execute" as const,
		};
		const admit = (pool: Pool, key: string) =>
			admitEvaluationRun(pool, {
				project_id: fixture.projectId,
				evaluation_selector: fixture.evaluationId,
				definition_version: 1,
				idempotency_key: key,
				authorization,
			});
		try {
			const raced = await Promise.allSettled([
				admit(poolA, "capacity-race-a"),
				admit(poolB, "capacity-race-b"),
			]);
			const admitted = raced.find(
				(
					result,
				): result is PromiseFulfilledResult<
					Awaited<ReturnType<typeof admit>>
				> => result.status === "fulfilled",
			);
			const rejected = raced.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			expect(admitted).toBeDefined();
			expect(rejected?.reason).toBeInstanceOf(EvaluationRunRepositoryError);
			expect((rejected?.reason as EvaluationRunRepositoryError).status).toBe(
				429,
			);

			await cancelEvaluationRun(poolA, {
				id: admitted!.value.id,
				project_id: fixture.projectId,
				authorization,
			});
			expect(
				await poolA.query(
					"SELECT status FROM evaluation_run_capacity_admissions WHERE run_id=$1",
					[admitted!.value.id],
				),
			).toMatchObject({ rows: [{ status: "released" }] });

			const recoveredRun = await admit(poolA, "capacity-after-cancel");
			await poolA.query(
				"DELETE FROM evaluation_run_capacity_admissions WHERE run_id=$1",
				[recoveredRun.id],
			);
			const recovered = await listRecoverableExperiments(poolA);
			expect(recovered).toContainEqual(
				expect.objectContaining({
					id: recoveredRun.experiment_id,
					config: expect.objectContaining({ provider: "openai" }),
				}),
			);
			expect(
				await poolA.query(
					"SELECT status FROM evaluation_run_capacity_admissions WHERE run_id=$1",
					[recoveredRun.id],
				),
			).toMatchObject({ rows: [{ status: "active" }] });

			await poolA.query(
				"DELETE FROM project_actor_grants WHERE project_id=$1 AND actor_id=$2",
				[fixture.projectId, fixture.actorId],
			);
			await claimExperimentTask(poolA, {
				project_id: fixture.projectId,
				experiment_id: recoveredRun.experiment_id,
			});
			expect(
				await poolA.query(
					"SELECT status FROM evaluation_run_capacity_admissions WHERE run_id=$1",
					[recoveredRun.id],
				),
			).toMatchObject({
				rows: [{ status: "released" }],
			});
		} finally {
			if (previousProjectCap === undefined)
				delete process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT;
			else
				process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT = previousProjectCap;
			if (previousActorCap === undefined)
				delete process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR;
			else process.env.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR = previousActorCap;
			await fixture.cleanup();
			await poolA.end();
			await poolB.end();
		}
	},
);
