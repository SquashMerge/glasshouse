import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION,
	INTERNAL_LOG_ORGANIZATION_LOCK_SEED,
	InternalLogAccessDeniedError,
	listAuthorizedInternalLogs,
	persistInternalLog,
} from "../../src/db/internal-logs";

const databaseUrl = process.env.DATABASE_URL;

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
