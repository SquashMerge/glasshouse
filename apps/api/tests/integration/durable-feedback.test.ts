import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { migrate } from "../../src/db/migrate";
import { createFeedback, getOwnFeedback } from "../../src/db/feedback";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = `feedback_${randomUUID().replaceAll("-", "")}`;
let adminPool: Pool;
let pool: Pool;
let databaseCreated = false;
const organizationId = randomUUID();
const projectId = randomUUID();
const actorId = randomUUID();

beforeAll(async () => {
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	adminPool = new Pool({ connectionString: databaseUrl });
	await adminPool.query(`CREATE DATABASE ${databaseName}`);
	databaseCreated = true;
	const url = new URL(databaseUrl);
	url.pathname = `/${databaseName}`;
	pool = new Pool({ connectionString: url.toString(), max: 4 });
	await migrate({ DATABASE_URL: url.toString() });
	await pool.query(
		`WITH org AS (INSERT INTO organizations (id,name,slug,default_project_id) VALUES ($1,'Feedback',$1::uuid::text,$2) RETURNING id)
		INSERT INTO projects (id,organization_id,name,slug) SELECT $2,id,'Default','default' FROM org`,
		[organizationId, projectId],
	);
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id,organization_id,provider_namespace,canonical_subject) VALUES ($1,$2,'basic:v1','feedback-test')",
		[actorId, organizationId],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id,actor_id,role) VALUES ($1,$2,'user')",
		[organizationId, actorId],
	);
}, 60000);

afterAll(async () => {
	await pool?.end();
	if (databaseCreated)
		await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
	await adminPool?.end();
});

test("concurrent different keys for one Actor and trace produce one feedback and review", async () => {
	const input = {
		project_id: projectId,
		trace_id: "a".repeat(32),
		value: -1 as const,
		metadata: {
			feedback: {
				schema_version: 1 as const,
				sentiment: "negative" as const,
				reason: "incorrect",
			},
		},
		authorization: {
			organization_id: organizationId,
			actor_id: actorId,
			operation: "curation_write" as const,
		},
	};
	const responses = await Promise.all(
		Array.from({ length: 8 }, () =>
			createFeedback(pool, { ...input, idempotency_key: randomUUID() }),
		),
	);
	expect(new Set(responses.map((response) => response.id)).size).toBe(1);
	const later = await createFeedback(pool, {
		...input,
		value: 1,
		metadata: { feedback: { schema_version: 1, sentiment: "positive" } },
		idempotency_key: randomUUID(),
	});
	expect(later).toMatchObject({
		id: responses[0]!.id,
		value: -1,
		reason: "incorrect",
		status: "new",
	});
	const count = await pool.query(
		"SELECT COUNT(*)::int AS count FROM scores s JOIN feedback_reviews r ON r.score_id=s.id WHERE s.project_id=$1",
		[projectId],
	);
	expect(count.rows[0]?.count).toBe(1);
}, 30000);

test("current Actor reads only the exact selected trace or observation", async () => {
	const authorization = {
		organization_id: organizationId,
		actor_id: actorId,
		operation: "product_read" as const,
	};
	const trace = await getOwnFeedback(pool, {
		project_id: projectId,
		trace_id: "a".repeat(32),
		authorization,
	});
	expect(trace).toMatchObject({
		value: -1,
		reason: "incorrect",
		observation_id: null,
	});
	const missing = await getOwnFeedback(pool, {
		project_id: projectId,
		trace_id: "a".repeat(32),
		observation_id: "span-a",
		authorization,
	});
	expect(missing).toBeNull();
});

test("Actors and observation targets are distinct; reused keys cannot disclose another Actor's feedback", async () => {
	const secondActor = randomUUID();
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [secondActor]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id,organization_id,provider_namespace,canonical_subject) VALUES ($1,$2,'basic:v1','feedback-test-second')",
		[secondActor, organizationId],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id,actor_id,role) VALUES ($1,$2,'user')",
		[organizationId, secondActor],
	);
	const authorization = {
		organization_id: organizationId,
		actor_id: actorId,
		operation: "curation_write" as const,
	};
	const input = {
		project_id: projectId,
		trace_id: "a".repeat(32),
		value: 1 as const,
		metadata: {
			feedback: {
				schema_version: 1 as const,
				sentiment: "positive" as const,
				comment: "helpful",
			},
		},
		authorization,
	};
	const one = await createFeedback(pool, {
		...input,
		observation_id: "span-one",
		idempotency_key: "span-key",
	});
	const two = await createFeedback(pool, {
		...input,
		observation_id: "span-two",
		idempotency_key: "span-two-key",
	});
	const other = await createFeedback(pool, {
		...input,
		idempotency_key: "other-actor",
		authorization: { ...authorization, actor_id: secondActor },
	});
	expect(new Set([one.id, two.id, other.id]).size).toBe(3);
	expect(
		await getOwnFeedback(pool, {
			project_id: projectId,
			trace_id: input.trace_id,
			authorization: { ...authorization, actor_id: secondActor },
		}),
	).toMatchObject({ id: other.id, sentiment: "positive" });
	expect(
		await getOwnFeedback(pool, {
			project_id: projectId,
			trace_id: input.trace_id,
			observation_id: "span-one",
			authorization,
		}),
	).toMatchObject({ id: one.id, comment: "helpful" });
	await expect(
		createFeedback(pool, {
			...input,
			observation_id: "span-one",
			idempotency_key: "span-key",
			authorization: { ...authorization, actor_id: secondActor },
		}),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	await expect(
		getOwnFeedback(pool, {
			project_id: projectId,
			trace_id: input.trace_id,
			authorization: { ...authorization, organization_id: randomUUID() },
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	const anotherProject = randomUUID();
	await pool.query(
		"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1,$2,'Other','other')",
		[anotherProject, organizationId],
	);
	const separateProject = await createFeedback(pool, {
		...input,
		project_id: anotherProject,
		idempotency_key: "separate-project",
	});
	expect(separateProject.id).not.toBe(other.id);
	expect(separateProject).toMatchObject({
		project_id: anotherProject,
		value: 1,
	});
});

test("storage rejects attribution to an Actor outside the Project organization", async () => {
	const foreignOrg = randomUUID();
	const foreignProject = randomUUID();
	const foreignActor = randomUUID();
	await pool.query(
		`WITH org AS (INSERT INTO organizations (id,name,slug,default_project_id) VALUES ($1,'Foreign',$1::uuid::text,$2) RETURNING id) INSERT INTO projects (id,organization_id,name,slug) SELECT $2,id,'Default','default' FROM org`,
		[foreignOrg, foreignProject],
	);
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [foreignActor]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id,organization_id,provider_namespace,canonical_subject) VALUES ($1,$2,'basic:v1','foreign-feedback')",
		[foreignActor, foreignOrg],
	);
	await expect(
		pool.query(
			"INSERT INTO scores (project_id,trace_id,name,value,feedback_actor_id) VALUES ($1,$2,'human.feedback',1,$3)",
			[projectId, "b".repeat(32), foreignActor],
		),
	).rejects.toMatchObject({ code: "23514" });
});

test("migration fixture checks null trace and span uniqueness with unknown historical authors", async () => {
	const fixture = await Bun.file(
		"../../infra/scripts/test-db-migrations-0109.assert.sql",
	).text();
	await pool.query(fixture);
});

test("the unique index waits for an uncommitted competing trace and rejects the loser", async () => {
	const first = await pool.connect();
	const second = await pool.connect();
	try {
		await first.query("BEGIN");
		await second.query("BEGIN");
		const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]
			.pid;
		const sql =
			"INSERT INTO scores (project_id,trace_id,name,value,feedback_actor_id) VALUES ($1,$2,'human.feedback',1,$3)";
		const values = [projectId, "c".repeat(32), actorId];
		await first.query(sql, values);
		const competing = second.query(sql, values).then(
			() => null,
			(error) => error,
		);
		let blocked = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const state = await pool.query(
				"SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
				[pid],
			);
			if (state.rows[0].blocked) {
				blocked = true;
				break;
			}
			await Bun.sleep(20);
		}
		expect(blocked).toBe(true);
		await first.query("COMMIT");
		expect(await competing).toMatchObject({
			code: "23505",
			constraint: "scores_feedback_actor_target_key",
		});
		await second.query("ROLLBACK");
	} finally {
		await first.query("ROLLBACK").catch(() => {});
		await second.query("ROLLBACK").catch(() => {});
		first.release();
		second.release();
	}
});

test("populated 0108 upgrade preserves unknown feedback and review provenance", async () => {
	const name = `feedback_upgrade_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${name}`);
	const url = new URL(databaseUrl!);
	url.pathname = `/${name}`;
	const upgradePool = new Pool({ connectionString: url.toString() });
	try {
		const dir = resolve(import.meta.dir, "../../../../infra/db/migrations");
		await runner({
			databaseUrl: url.toString(),
			dir,
			direction: "up",
			migrationsTable: "pgmigrations",
			migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
			count: (await readdir(dir)).filter(
				(name) => name.endsWith(".sql") && Number(name.slice(0, 4)) < 109,
			).length,
			singleTransaction: true,
			log: () => {},
		});
		const org = randomUUID(),
			project = randomUUID(),
			score = randomUUID();
		await upgradePool.query(
			"WITH o AS (INSERT INTO organizations(id,name,slug,default_project_id) VALUES ($1,'Upgrade',$1::uuid::text,$2) RETURNING id) INSERT INTO projects(id,organization_id,name,slug) SELECT $2,id,'Default','default' FROM o",
			[org, project],
		);
		await upgradePool.query(
			"INSERT INTO scores (id,project_id,trace_id,name,value,metadata) VALUES ($1,$2,$3,'human.feedback',-1,$4)",
			[
				score,
				project,
				"d".repeat(32),
				JSON.stringify({
					feedback: {
						schema_version: 1,
						sentiment: "negative",
						reason: "legacy",
					},
				}),
			],
		);
		await upgradePool.query(
			"INSERT INTO feedback_reviews (score_id,project_id,status,note) VALUES ($1,$2,'reviewed','preserve')",
			[score, project],
		);
		await migrate({ DATABASE_URL: url.toString() });
		const result = await upgradePool.query(
			"SELECT s.id,s.feedback_actor_id,s.metadata,r.status,r.note FROM scores s JOIN feedback_reviews r ON r.score_id=s.id WHERE s.id=$1",
			[score],
		);
		expect(result.rows).toEqual([
			{
				id: score,
				feedback_actor_id: null,
				metadata: {
					feedback: {
						schema_version: 1,
						sentiment: "negative",
						reason: "legacy",
					},
				},
				status: "reviewed",
				note: "preserve",
			},
		]);
	} finally {
		await upgradePool.end();
		await adminPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
	}
}, 60000);
