import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migrate } from "../../src/db/migrate";
import {
	createOptimizationJob,
	stopOptimizationJob,
} from "../../src/db/prompt-optimizations";
import { createPrompt } from "../../src/db/prompts";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = `gepa_capacity_${randomUUID().replaceAll("-", "")}`;
let adminPool: Pool;
let pool: Pool;
let firstPool: Pool;
let secondPool: Pool;
let databaseCreated = false;

beforeAll(async () => {
	if (!databaseUrl)
		throw new Error("DATABASE_URL is required for real PostgreSQL GEPA tests");
	adminPool = new Pool({ connectionString: databaseUrl });
	await adminPool.query(`CREATE DATABASE ${databaseName}`);
	databaseCreated = true;
	const url = new URL(databaseUrl);
	url.pathname = `/${databaseName}`;
	const connectionString = url.toString();
	pool = new Pool({ connectionString });
	firstPool = new Pool({
		connectionString,
		max: 1,
		application_name: `${databaseName}_first`,
		options: "-c statement_timeout=10000 -c lock_timeout=8000",
	});
	secondPool = new Pool({
		connectionString,
		max: 1,
		application_name: `${databaseName}_second`,
		options: "-c statement_timeout=10000 -c lock_timeout=8000",
	});
	await migrate({ DATABASE_URL: connectionString });
}, 60000);

afterAll(async () => {
	await Promise.all([pool?.end(), firstPool?.end(), secondPool?.end()]);
	if (databaseCreated)
		await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
	await adminPool?.end();
});

async function waitForAdvisoryLock(
	applicationName: string,
	blockerPid: number,
) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		const result = await pool.query<{ waiting: boolean }>(
			`SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity activity
				JOIN pg_locks waiting ON waiting.pid = activity.pid
				JOIN pg_locks held ON held.locktype = waiting.locktype
					AND held.database = waiting.database AND held.classid = waiting.classid
					AND held.objid = waiting.objid AND held.objsubid = waiting.objsubid
				WHERE activity.datname = $1 AND activity.application_name = $2
					AND activity.wait_event_type = 'Lock' AND activity.wait_event = 'advisory'
					AND waiting.locktype = 'advisory' AND NOT waiting.granted
					AND held.granted AND held.pid = $3
					AND $3 = ANY(pg_blocking_pids(activity.pid))
			) AS waiting`,
			[databaseName, applicationName, blockerPid],
		);
		if (result.rows[0]?.waiting) return;
		await Bun.sleep(20);
	}
	throw new Error(
		"GEPA admission did not wait on the durable Actor advisory key",
	);
}

async function seedActorProjects(username = "Alice") {
	const organizationId = randomUUID();
	const actorId = randomUUID();
	const projectIds = [randomUUID(), randomUUID()];
	const authorization = {
		organization_id: organizationId,
		actor_id: actorId,
		operation: "execute" as const,
	};
	await pool.query(
		`WITH organization AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1, 'GEPA capacity', $1::uuid::text, $2) RETURNING id
		)
		INSERT INTO projects (id, organization_id, name, slug)
		SELECT $2, id, 'Default', 'default' FROM organization
		UNION ALL SELECT $3, id, 'Second', 'second' FROM organization`,
		[organizationId, ...projectIds],
	);
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
		[actorId, organizationId, username.toLowerCase()],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'user')",
		[organizationId, actorId],
	);
	expect(
		(
			await pool.query(
				"SELECT trusted_actor_subject_matches($1, $3, $2) AS mixed, trusted_actor_subject_matches($1, $4, $2) AS lower",
				[organizationId, actorId, username, username.toLowerCase()],
			)
		).rows,
	).toEqual([{ mixed: true, lower: true }]);
	const actors = [username, username.toLowerCase()];
	const inputs = await Promise.all(
		projectIds.map(async (projectId, index) => {
			const prompt = await createPrompt(pool, {
				project_id: projectId,
				name: `Capacity prompt ${index}`,
				messages: [{ role: "system", content: "Summarize {{topic}}." }],
				actor: actors[index]!,
				authorization: { ...authorization, operation: "product_write" },
			});
			return {
				project_id: projectId,
				slug: prompt.id,
				source_version: prompt.version,
				target: "system" as const,
				evaluator: { type: "default_adapter" },
				dataset: {
					version: 1 as const,
					rubric: "Return the expected answer.",
					training_examples: [{ input: "training", answer: "training label" }],
					validation_examples: [
						{ input: "held out", answer: "held-out label" },
					],
				},
				model_config: { task_lm: "task", reflection_lm: "reflection" },
				budget: { max_metric_calls: 2 },
				actor: actors[index]!,
				authorization,
			};
		}),
	);
	return { actorId, projectIds, authorization, inputs };
}

test("shares one durable Actor's GEPA capacity across Projects and username spellings", async () => {
	const { projectIds, authorization, inputs } = await seedActorProjects();
	const oldProjectLimit = process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT;
	const oldRequesterLimit = process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER;
	try {
		process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT = "3";
		process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER = "1";
		const results = await Promise.allSettled([
			createOptimizationJob(firstPool, inputs[0]!),
			createOptimizationJob(secondPool, inputs[1]!),
		]);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
			1,
		);
		const rejected = results.find(({ status }) => status === "rejected");
		expect(rejected).toBeDefined();
		if (rejected?.status === "rejected")
			expect(rejected.reason).toMatchObject({
				code: "TOO_MANY_REQUESTS",
				status: 429,
			});
		const winner = results.findIndex(({ status }) => status === "fulfilled");
		const admitted = results[winner];
		if (admitted?.status !== "fulfilled") throw new Error("No admitted job");
		const winningInput = inputs[winner]!;
		const losingInput = inputs[1 - winner]!;
		expect(
			(
				await pool.query(
					"SELECT requested_by, status FROM prompt_optimization_jobs WHERE project_id = ANY($1::uuid[])",
					[projectIds],
				)
			).rows,
		).toEqual([{ requested_by: winningInput.actor, status: "queued" }]);
		expect(
			await createOptimizationJob(pool, {
				...winningInput,
				actor: losingInput.actor,
			}),
		).toMatchObject({
			id: admitted.value.id,
			requested_by: winningInput.actor,
		});
		expect(
			await stopOptimizationJob(pool, {
				project_id: admitted.value.project_id,
				id: admitted.value.id,
				authorization,
			}),
		).toMatchObject({ status: "stopped" });
		// The previously rejected Project/prompt is valid and can use released capacity.
		const readmitted = await createOptimizationJob(pool, losingInput);
		expect(readmitted).toMatchObject({
			project_id: projectIds[1 - winner],
			requested_by: losingInput.actor,
			status: "queued",
		});
		expect(
			(
				await pool.query(
					"SELECT requested_by, status FROM prompt_optimization_jobs WHERE project_id = ANY($1::uuid[]) ORDER BY status",
					[projectIds],
				)
			).rows,
		).toEqual([
			{ requested_by: losingInput.actor, status: "queued" },
			{ requested_by: winningInput.actor, status: "stopped" },
		]);
	} finally {
		if (oldProjectLimit === undefined)
			delete process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT;
		else process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT = oldProjectLimit;
		if (oldRequesterLimit === undefined)
			delete process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER;
		else process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER = oldRequesterLimit;
	}
});

test("GEPA admission waits on the durable Actor advisory fence", async () => {
	const { actorId, inputs } = await seedActorProjects("Fence-Alice");
	const blocker = await pool.connect();
	let outcome:
		| Promise<
				PromiseSettledResult<
					Awaited<ReturnType<typeof createOptimizationJob>>
				>[]
		  >
		| undefined;
	try {
		await blocker.query("BEGIN");
		await blocker.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`gepa-requester:${actorId}`],
		);
		const { rows } = await blocker.query<{ pid: number }>(
			"SELECT pg_backend_pid() AS pid",
		);
		outcome = Promise.allSettled([
			createOptimizationJob(firstPool, inputs[0]!),
		]);
		await waitForAdvisoryLock(`${databaseName}_first`, rows[0]!.pid);
		expect(
			(
				await pool.query(
					"SELECT id FROM prompt_optimization_jobs WHERE project_id = $1",
					[inputs[0]!.project_id],
				)
			).rows,
		).toHaveLength(0);
		await blocker.query("COMMIT");
		const [result] = await outcome;
		expect(result?.status).toBe("fulfilled");
		if (result?.status !== "fulfilled")
			throw new Error("No admitted job after fence release");
		expect(result.value).toMatchObject({
			requested_by: inputs[0]!.actor,
			status: "queued",
		});
		expect(
			(
				await pool.query(
					"SELECT requested_by, status FROM prompt_optimization_jobs WHERE id = $1",
					[result.value.id],
				)
			).rows,
		).toEqual([{ requested_by: inputs[0]!.actor, status: "queued" }]);
	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
		await outcome;
	}
}, 15000);
