import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Pool } from "pg";
import {
	INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION,
	INTERNAL_LOG_ORGANIZATION_LOCK_SEED,
	InternalLogAccessDeniedError,
	listAuthorizedInternalLogs,
	persistInternalLog,
	cleanupExpiredInternalLogs,
} from "../../src/db/internal-logs";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import {
	createHandleListInternalLogs,
	listInternalLogsRoute,
} from "../../src/routes/internal-logs";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)(
	"public paging freezes rows visible before an in-flight writer commits",
	async () => {
		const monitor = new Pool({ connectionString: databaseUrl, max: 4 });
		const readerPool = new Pool({
			connectionString: databaseUrl,
			application_name: "gh58-page-reader",
			max: 1,
		});
		const replicaPool = new Pool({ connectionString: databaseUrl, max: 1 });
		const { organizationId } = await seedOrganization(monitor);
		const reader = await seedAdmin(monitor, organizationId, "paging-reader");
		const writer = await monitor.connect();
		const app = new OpenAPIHono();
		const replica = snapshotApp(replicaPool, {
			organizationId,
			actorId: reader.actorId,
		});
		app.use("*", async (c, next) => {
			c.set(TRUSTED_TENANT_CONTEXT_KEY, {
				actor: "test",
				actorId: reader.actorId,
				organizationId,
			});
			await next();
		});
		app.openapi(
			listInternalLogsRoute,
			createHandleListInternalLogs(
				() => readerPool,
				() => true,
			),
		);
		try {
			const older = await monitor.query<{ id: string }>(
				"INSERT INTO internal_log_entries (organization_id, recorded_at, severity, source, message, context) SELECT $1, now() - interval '1 minute' - least(n,2) * interval '1 second', 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,3) n RETURNING id",
				[organizationId],
			);
			await writer.query("BEGIN");
			await writer.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
				[organizationId, INTERNAL_LOG_ORGANIZATION_LOCK_SEED],
			);
			const pending = await writer.query<{ id: string }>(
				"INSERT INTO internal_log_entries (organization_id, recorded_at, severity, source, message, context) VALUES ($1, now() - interval '61.5 seconds', 'info', 'api', 'API request outcome', '{}'::jsonb) RETURNING id",
				[organizationId],
			);
			let response = await Promise.race([
				app.request("/v1/admin/logs?limit=1"),
				Bun.sleep(3000).then(() => {
					throw new Error("first page waited for uncommitted writer");
				}),
			]);
			await writer.query("COMMIT");
			const found: string[] = [];
			let complete = false;
			let snapshotId = "";
			for (let i = 0; i < 10; i++) {
				expect(response.status).toBe(200);
				const page = (await response.json()) as {
					items: Array<{ id: string }>;
					next_cursor?: string;
				};
				found.push(...page.items.map((row) => row.id));
				if (page.next_cursor && !snapshotId)
					snapshotId = page.next_cursor.split(".")[1]!;
				if (!page.next_cursor) {
					complete = true;
					break;
				}
				response = await replica.request(
					`/v1/admin/logs?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
				);
			}
			expect(complete).toBe(true);
			expect(new Set(found).size).toBe(found.length);
			expect(found.sort()).toEqual(older.rows.map((row) => row.id).sort());
			const remaining = await monitor.query(
				"SELECT id FROM internal_log_snapshots WHERE id = $1",
				[snapshotId],
			);
			expect(remaining.rows).toHaveLength(0);
			const refreshed = await app.request("/v1/admin/logs?limit=100");
			expect(refreshed.status).toBe(200);
			const freshPage = (await refreshed.json()) as {
				items: Array<{ id: string }>;
			};
			expect(freshPage.items.map((row) => row.id)).toContain(
				pending.rows[0]!.id,
			);
		} finally {
			await writer.query("ROLLBACK").catch(() => {});
			writer.release();
			await readerPool.end();
			await replicaPool.end();
			await monitor.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"retention cannot silently omit an unseen row from an active public traversal",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 4 });
		const { organizationId } = await seedOrganization(pool);
		const reader = await seedAdmin(pool, organizationId, "retention-reader");
		const app = new OpenAPIHono();
		app.use("*", async (c, next) => {
			c.set(TRUSTED_TENANT_CONTEXT_KEY, {
				actor: "test",
				actorId: reader.actorId,
				organizationId,
			});
			await next();
		});
		app.openapi(
			listInternalLogsRoute,
			createHandleListInternalLogs(
				() => pool,
				() => true,
			),
		);
		try {
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, recorded_at, severity, source, message, context) SELECT $1, clock_timestamp() - interval '1 minute', 'error', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,49998)",
				[organizationId],
			);
			const targets = await pool.query<{ id: string }>(
				"INSERT INTO internal_log_entries (organization_id, recorded_at, severity, source, message, context) SELECT $1, clock_timestamp() - interval '2 minutes' - n * interval '1 microsecond', 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,2) n RETURNING id",
				[organizationId],
			);
			const first = await app.request("/v1/admin/logs?limit=1&level=info");
			expect(first.status).toBe(200);
			const page = (await first.json()) as {
				items: Array<{ id: string }>;
				total: number;
				next_cursor: string;
			};
			expect(page.total).toBe(2);
			expect(page.next_cursor).toBeDefined();
			await persistInternalLog(pool, {
				organizationId,
				severity: "warn",
				context: {
					route: "projects",
					method: "GET",
					status: 200,
					duration_ms: 1,
				},
			});
			const next = await app.request(
				`/v1/admin/logs?limit=1&level=info&cursor=${encodeURIComponent(page.next_cursor)}`,
			);
			expect(targets.rows).toHaveLength(2);
			expect(next.status).toBe(409);
			expect(((await next.json()) as { code: string }).code).toBe("CONFLICT");
		} finally {
			await pool.end();
		}
	},
	30000,
);

async function waitForLock(
	pool: Pool,
	applicationNames: readonly string[],
	expected: number,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await pool.query<{ waiting: number }>(
			"SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'",
			[applicationNames],
		);
		if (result.rows[0]?.waiting === expected) return;
		await Bun.sleep(20);
	}
	throw new Error("internal-log transaction did not wait for its fence");
}

async function seedOrganization(pool: Pool) {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	await pool.query(
		`WITH organization AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1, 'Internal logs serialization', $2, $3)
			RETURNING id
		)
		INSERT INTO projects (id, organization_id, name, slug)
		SELECT $3, id, 'Default Project', 'default' FROM organization`,
		[organizationId, `internal-logs-${organizationId}`, projectId],
	);
	return { organizationId, projectId };
}

async function seedAdmin(pool: Pool, organizationId: string, prefix: string) {
	const actorId = randomUUID();
	const subject = `${prefix}-${actorId}`;
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3)",
		[actorId, organizationId, subject],
	);
	await pool.query(
		"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'owner')",
		[organizationId, subject],
	);
	await pool.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin')",
		[organizationId, actorId],
	);
	return { actorId, subject };
}

function snapshotApp(
	pool: Pool,
	tenant: { organizationId: string; actorId: string },
) {
	const app = new OpenAPIHono();
	app.use("*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, { actor: "test", ...tenant });
		await next();
	});
	app.openapi(
		listInternalLogsRoute,
		createHandleListInternalLogs(
			() => pool,
			() => true,
		),
	);
	return app;
}

test.skipIf(!databaseUrl)(
	"snapshot storage constraints and indexes are enforced by PostgreSQL",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 2 });
		try {
			const { organizationId } = await seedOrganization(pool);
			const actor = await seedAdmin(pool, organizationId, "constraints-reader");
			const insert = `INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at) VALUES (gen_random_uuid(), $1, $2, 'hash', decode(repeat('01',32),'hex'), $3::uuid[], $4::timestamptz[], clock_timestamp() + interval '5 minutes')`;
			await expect(
				pool.query(insert, [organizationId, actor.actorId, [randomUUID()], []]),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				pool.query(insert, [organizationId, randomUUID(), [], []]),
			).rejects.toMatchObject({ code: "23503" });
			const indexes = await pool.query<{ indexname: string }>(
				"SELECT indexname FROM pg_indexes WHERE tablename = 'internal_log_snapshots'",
			);
			expect(indexes.rows.map((row) => row.indexname)).toContain(
				"internal_log_snapshots_expiry_idx",
			);
			const constraint = await pool.query<{ definition: string }>(
				"SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'internal_log_snapshots'::regclass AND contype = 'c'",
			);
			expect(
				constraint.rows.some((row) => row.definition.includes("1250000")),
			).toBe(true);
		} finally {
			await pool.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"expired snapshots are removed by the real maintenance path",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 3 });
		try {
			const { organizationId } = await seedOrganization(pool);
			const reader = await seedAdmin(pool, organizationId, "cleanup-reader");
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT $1, 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,2)",
				[organizationId],
			);
			const app = snapshotApp(pool, {
				organizationId,
				actorId: reader.actorId,
			});
			const first = await app.request("/v1/admin/logs?limit=1");
			const { next_cursor } = (await first.json()) as { next_cursor: string };
			const id = next_cursor.split(".")[1];
			await pool.query(
				"UPDATE internal_log_snapshots SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
				[id],
			);
			await cleanupExpiredInternalLogs(pool);
			expect(
				(
					await pool.query(
						"SELECT id FROM internal_log_snapshots WHERE id = $1",
						[id],
					)
				).rows,
			).toHaveLength(0);
			expect(
				(
					await app.request(
						`/v1/admin/logs?cursor=${encodeURIComponent(next_cursor)}`,
					)
				).status,
			).toBe(409);
		} finally {
			await pool.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"snapshot cursors reject tampering, different scope, filters and expiry",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 4 });
		try {
			const { organizationId } = await seedOrganization(pool);
			const admin = await seedAdmin(pool, organizationId, "snapshot-owner");
			const otherAdmin = await seedAdmin(
				pool,
				organizationId,
				"snapshot-other-admin",
			);
			const other = await seedOrganization(pool);
			const otherOrgAdmin = await seedAdmin(
				pool,
				other.organizationId,
				"snapshot-other-org",
			);
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT $1, 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,3)",
				[organizationId],
			);
			const app = snapshotApp(pool, { organizationId, actorId: admin.actorId });
			const first = await app.request("/v1/admin/logs?limit=1");
			expect(first.status).toBe(200);
			const { next_cursor: cursor } = (await first.json()) as {
				next_cursor: string;
			};
			const parts = cursor.split(".");
			parts[2] = "2";
			const url = (value: string) =>
				`/v1/admin/logs?limit=1&cursor=${encodeURIComponent(value)}`;
			expect((await app.request(url(parts.join(".")))).status).toBe(409);
			expect((await app.request(`${url(cursor)}&level=info`)).status).toBe(409);
			expect(
				(
					await snapshotApp(pool, {
						organizationId,
						actorId: otherAdmin.actorId,
					}).request(url(cursor))
				).status,
			).toBe(409);
			expect(
				(
					await snapshotApp(pool, {
						organizationId: other.organizationId,
						actorId: otherOrgAdmin.actorId,
					}).request(url(cursor))
				).status,
			).toBe(409);
			await pool.query(
				"UPDATE internal_log_snapshots SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
				[cursor.split(".")[1]],
			);
			const expired = await app.request(url(cursor));
			expect(expired.status).toBe(409);
			expect(((await expired.json()) as { message: string }).message).toContain(
				"Refresh",
			);
		} finally {
			await pool.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"public continuation reauthorizes after a concurrent Admin demotion",
	async () => {
		const monitor = new Pool({ connectionString: databaseUrl, max: 4 });
		const readerPool = new Pool({
			connectionString: databaseUrl,
			application_name: "gh58-snapshot-demotion-reader",
			max: 1,
		});
		const { organizationId } = await seedOrganization(monitor);
		const reader = await seedAdmin(monitor, organizationId, "snapshot-demoted");
		await seedAdmin(monitor, organizationId, "snapshot-surviving-admin");
		const holder = await monitor.connect();
		try {
			await monitor.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT $1, 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,3)",
				[organizationId],
			);
			const app = snapshotApp(readerPool, {
				organizationId,
				actorId: reader.actorId,
			});
			const first = await app.request("/v1/admin/logs?limit=1");
			expect(first.status).toBe(200);
			const { next_cursor } = (await first.json()) as { next_cursor: string };
			await holder.query("BEGIN");
			await holder.query(
				"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
				[organizationId, reader.actorId],
			);
			const continuation = app.request(
				`/v1/admin/logs?limit=1&cursor=${encodeURIComponent(next_cursor)}`,
			);
			await waitForLock(monitor, ["gh58-snapshot-demotion-reader"], 1);
			await holder.query("COMMIT");
			expect((await continuation).status).toBe(403);
		} finally {
			await holder.query("ROLLBACK").catch(() => {});
			holder.release();
			await readerPool.end();
			await monitor.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"concurrent snapshot allocations enforce the actor quota across connections",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 12 });
		try {
			const { organizationId } = await seedOrganization(pool);
			const reader = await seedAdmin(pool, organizationId, "quota-reader");
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT $1, 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,2)",
				[organizationId],
			);
			const app = snapshotApp(pool, {
				organizationId,
				actorId: reader.actorId,
			});
			const responses = await Promise.all(
				Array.from({ length: 9 }, () => app.request("/v1/admin/logs?limit=1")),
			);
			expect(
				responses.filter((response) => response.status === 200),
			).toHaveLength(8);
			expect(
				responses.filter((response) => response.status === 503),
			).toHaveLength(1);
			const count = await pool.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM internal_log_snapshots WHERE organization_id = $1 AND actor_id = $2",
				[organizationId, reader.actorId],
			);
			expect(count.rows[0]?.count).toBe(8);
		} finally {
			await pool.end();
		}
	},
	15000,
);

test.skipIf(!databaseUrl)(
	"concurrent allocations respect organization and global quotas across replicas",
	async () => {
		const pool = new Pool({ connectionString: databaseUrl, max: 12 });
		const createdOrganizations: string[] = [];
		const makeOrg = async () => {
			const org = await seedOrganization(pool);
			createdOrganizations.push(org.organizationId);
			return org.organizationId;
		};
		const fill = async (organizationId: string, count: number) => {
			for (let used = 0; used < count; used += 8) {
				const actorId = randomUUID();
				await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
				await pool.query(
					`INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at)
			 SELECT gen_random_uuid(), $1, $2, 'quota-fixture', decode(repeat('01',32),'hex'), '{}'::uuid[], '{}'::timestamptz[], clock_timestamp() + interval '5 minutes' FROM generate_series(1,$3)`,
					[organizationId, actorId, Math.min(8, count - used)],
				);
			}
		};
		try {
			const org = await makeOrg();
			const a = await seedAdmin(pool, org, "org-quota-a");
			const b = await seedAdmin(pool, org, "org-quota-b");
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT $1, 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1,2)",
				[org],
			);
			await fill(org, 31);
			const orgResults = await Promise.all([
				snapshotApp(pool, { organizationId: org, actorId: a.actorId }).request(
					"/v1/admin/logs?limit=1",
				),
				snapshotApp(pool, { organizationId: org, actorId: b.actorId }).request(
					"/v1/admin/logs?limit=1",
				),
			]);
			expect(orgResults.map((r) => r.status).sort()).toEqual([200, 503]);
			await pool.query(
				"DELETE FROM internal_log_snapshots WHERE organization_id = $1",
				[org],
			);
			const existing = await pool.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM internal_log_snapshots WHERE expires_at > clock_timestamp()",
			);
			let needed = 127 - existing.rows[0]!.count;
			if (needed < 0)
				throw new Error(
					"isolated snapshot test database is already at capacity",
				);
			while (needed > 0) {
				const fixtureOrg = await makeOrg();
				const n = Math.min(32, needed);
				await fill(fixtureOrg, n);
				needed -= n;
			}
			const orgA = await makeOrg();
			const orgB = await makeOrg();
			const actorA = await seedAdmin(pool, orgA, "global-quota-a");
			const actorB = await seedAdmin(pool, orgB, "global-quota-b");
			await pool.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) SELECT org, 'info', 'api', 'API request outcome', '{}'::jsonb FROM unnest($1::uuid[]) org CROSS JOIN generate_series(1,2)",
				[[orgA, orgB]],
			);
			const responses = await Promise.all([
				snapshotApp(pool, {
					organizationId: orgA,
					actorId: actorA.actorId,
				}).request("/v1/admin/logs?limit=1"),
				snapshotApp(pool, {
					organizationId: orgB,
					actorId: actorB.actorId,
				}).request("/v1/admin/logs?limit=1"),
			]);
			expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
			const total = await pool.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM internal_log_snapshots WHERE expires_at > clock_timestamp()",
			);
			expect(total.rows[0]?.count).toBe(128);
		} finally {
			await pool.query(
				"DELETE FROM internal_log_snapshots WHERE organization_id = ANY($1::uuid[])",
				[createdOrganizations],
			);
			await pool.end();
		}
	},
	30000,
);

test.skipIf(!databaseUrl)(
	"two API replicas serialize an organization's insert and bounded over-cap trim",
	async () => {
		const monitor = new Pool({ connectionString: databaseUrl, max: 4 });
		const replicaA = new Pool({
			connectionString: databaseUrl,
			application_name: "glasshouse-internal-log-replica-a",
			max: 1,
		});
		const replicaB = new Pool({
			connectionString: databaseUrl,
			application_name: "glasshouse-internal-log-replica-b",
			max: 1,
		});
		const { organizationId } = await seedOrganization(monitor);
		const holder = await monitor.connect();
		try {
			await monitor.query(
				"INSERT INTO internal_log_entries (organization_id, recorded_at, severity, source, message, context) SELECT $1, clock_timestamp() - interval '1 day' - series * interval '1 microsecond', 'info', 'api', 'API request outcome', '{}'::jsonb FROM generate_series(1, $2) AS series",
				[organizationId, INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION],
			);
			await holder.query("BEGIN");
			await holder.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
				[organizationId, INTERNAL_LOG_ORGANIZATION_LOCK_SEED],
			);
			const entry = {
				organizationId,
				severity: "info" as const,
				context: {
					route: "projects" as const,
					method: "GET" as const,
					status: 200,
					duration_ms: 1,
				},
			};
			const writes = [
				persistInternalLog(replicaA, entry),
				persistInternalLog(replicaB, entry),
			];
			await waitForLock(
				monitor,
				[
					"glasshouse-internal-log-replica-a",
					"glasshouse-internal-log-replica-b",
				],
				2,
			);
			await holder.query("COMMIT");
			await Promise.all(writes);
			const result = await monitor.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM internal_log_entries WHERE organization_id = $1",
				[organizationId],
			);
			expect(result.rows[0]?.count).toBe(
				INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION,
			);
		} finally {
			await holder.query("ROLLBACK").catch(() => {});
			holder.release();
			await replicaA.end();
			await replicaB.end();
			await monitor.end();
		}
	},
);

test.skipIf(!databaseUrl)(
	"an Admin demotion that commits first fences an internal-log read",
	async () => {
		const monitor = new Pool({ connectionString: databaseUrl, max: 4 });
		const readerPool = new Pool({
			connectionString: databaseUrl,
			application_name: "glasshouse-internal-log-reader",
			max: 1,
		});
		const { organizationId } = await seedOrganization(monitor);
		const reader = await seedAdmin(monitor, organizationId, "log-reader");
		await seedAdmin(monitor, organizationId, "log-demoter");
		const demoter = await monitor.connect();
		try {
			await monitor.query(
				"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) VALUES ($1, 'info', 'api', 'API request outcome', '{}'::jsonb)",
				[organizationId],
			);
			await demoter.query("BEGIN");
			await demoter.query(
				"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
				[organizationId, reader.actorId],
			);
			const read = listAuthorizedInternalLogs(
				readerPool,
				{ organizationId, actorId: reader.actorId },
				{ limit: 25 },
			);
			await waitForLock(monitor, ["glasshouse-internal-log-reader"], 1);
			await demoter.query("COMMIT");
			await expect(read).rejects.toBeInstanceOf(InternalLogAccessDeniedError);
		} finally {
			await demoter.query("ROLLBACK").catch(() => {});
			demoter.release();
			await readerPool.end();
			await monitor.end();
		}
	},
);
