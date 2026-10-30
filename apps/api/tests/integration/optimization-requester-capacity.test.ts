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
	});
	secondPool = new Pool({
		connectionString,
		max: 1,
		application_name: `${databaseName}_second`,
	});
	await migrate({ DATABASE_URL: connectionString });
}, 60000);

afterAll(async () => {
	await Promise.all([pool?.end(), firstPool?.end(), secondPool?.end()]);
	if (databaseCreated)
		await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
	await adminPool?.end();
});

async function waitForLock(applicationName: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await pool.query<{ waiting: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND wait_event_type = 'Lock') AS waiting",
			[databaseName, applicationName],
		);
		if (result.rows[0]?.waiting) return;
		await Bun.sleep(20);
	}
	throw new Error("GEPA admission did not reach its PostgreSQL lock fence");
}

test("serializes one requester's concurrent GEPA admissions across authorized Projects", async () => {
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
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $1::uuid::text)",
		[actorId, organizationId],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'user')",
		[organizationId, actorId],
	);
	const inputs = await Promise.all(
		projectIds.map(async (projectId, index) => {
			const prompt = await createPrompt(pool, {
				project_id: projectId,
				name: `Capacity prompt ${index}`,
				messages: [{ role: "system", content: "Summarize {{topic}}." }],
				actor: actorId,
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
				actor: actorId,
				authorization,
			};
		}),
	);
	const oldProjectLimit = process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT;
	const oldRequesterLimit = process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER;
	const blocker = await pool.connect();
	let outcomes:
		| Promise<
				PromiseSettledResult<
					Awaited<ReturnType<typeof createOptimizationJob>>
				>[]
		  >
		| undefined;
	try {
		process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT = "3";
		process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER = "1";
		await blocker.query("BEGIN");
		await blocker.query(
			"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
			[organizationId, actorId],
		);
		const first = createOptimizationJob(firstPool, inputs[0]!);
		const second = createOptimizationJob(secondPool, inputs[1]!);
		outcomes = Promise.allSettled([first, second]);
		// Observe both live transactions waiting before releasing either admission.
		await Promise.all([
			waitForLock(`${databaseName}_first`),
			waitForLock(`${databaseName}_second`),
		]);
		await blocker.query("COMMIT");
		const results = await outcomes;
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
		expect(
			(await pool.query("SELECT requested_by FROM prompt_optimization_jobs"))
				.rows,
		).toEqual([{ requested_by: actorId }]);
		const winner = results.findIndex(({ status }) => status === "fulfilled");
		const admitted = results[winner];
		if (admitted?.status !== "fulfilled") throw new Error("No admitted job");
		expect((await createOptimizationJob(pool, inputs[winner]!)).id).toBe(
			admitted.value.id,
		);
		await stopOptimizationJob(pool, {
			project_id: admitted.value.project_id,
			id: admitted.value.id,
			authorization,
		});
		// The previously rejected Project/prompt is valid and can use released capacity.
		expect(
			(await createOptimizationJob(pool, inputs[1 - winner]!)).project_id,
		).toBe(projectIds[1 - winner]);
	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
		await outcomes;
		if (oldProjectLimit === undefined)
			delete process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT;
		else process.env.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT = oldProjectLimit;
		if (oldRequesterLimit === undefined)
			delete process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER;
		else process.env.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER = oldRequesterLimit;
	}
});
