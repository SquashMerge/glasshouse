import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { ch, closeClickHouseClient } from "../../src/db/clickhouse";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate";
import { migrate } from "../../src/db/migrate";
import { pgPool } from "../../src/db/postgres";

// Only invoked explicitly by the disposable CI restore projects, never a unit test.
assert.equal(process.env.BACKUP_RESTORE_APPLICATION_FIXTURE, "1");
const mode = process.argv[2];
assert.ok(mode === "seed" || mode === "verify");
const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "43000000-0000-4000-8000-000000000002";
const traceId = "43000000000040008000000000000003";

try {
	await Promise.all([migrate(), applyClickHouseMigrations()]);
	if (mode === "seed") {
		await pgPool().query(
			"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, 'Datastore upgrade fixture', 'datastore-upgrade-fixture')",
			[projectId, organizationId],
		);
		await ch().insert({
			table: "traces",
			format: "JSONEachRow",
			values: [
				{
					trace_id: traceId,
					organization_id: organizationId,
					project_id: projectId,
					name: "datastore-upgrade-fixture",
					start_time: "2026-10-30 00:00:00.123",
					input_text: "restore-fixture",
					metadata: '{"fixture":true}',
				},
			],
		});
		await ch().insert({
			table: "observations",
			format: "JSONEachRow",
			values: [
				{
					observation_id: "4300000000000004",
					trace_id: traceId,
					organization_id: organizationId,
					project_id: projectId,
					type: "span",
					name: "datastore-upgrade-fixture",
					start_time: "2026-10-30 00:00:00.123",
					input_text: "restore-fixture",
				},
			],
		});
	} else {
		const project = await pgPool().query(
			"SELECT name FROM projects WHERE id = $1 AND organization_id = $2",
			[projectId, organizationId],
		);
		assert.equal(project.rows[0]?.name, "Datastore upgrade fixture");
		for (const table of ["traces", "observations"]) {
			const result = await ch().query({
				query: `SELECT count() AS count FROM ${table} WHERE trace_id = {trace:String} AND organization_id = {org:String} AND project_id = {project:String} AND input_text = 'restore-fixture'`,
				query_params: {
					trace: traceId,
					org: organizationId,
					project: projectId,
				},
				format: "JSONEachRow",
			});
			assert.equal(
				Number((await result.json<{ count: string }>())[0].count),
				1,
			);
		}
		// Re-run both production runners with restored ledgers/checksums in place.
		await Promise.all([migrate(), applyClickHouseMigrations()]);
		const postgresCount = await pgPool().query(
			"SELECT count(*) FROM pgmigrations",
		);
		assert.equal(
			Number(postgresCount.rows[0].count),
			readdirSync(
				new URL("../../../../infra/db/migrations/", import.meta.url),
			).filter((name) => name.endsWith(".sql")).length,
		);
		await pgPool().query("ANALYZE");
	}
} finally {
	await Promise.all([pgPool().end(), closeClickHouseClient()]);
}
