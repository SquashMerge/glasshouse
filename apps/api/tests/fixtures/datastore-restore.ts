import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { ch, closeClickHouseClient } from "../../src/db/clickhouse";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate";
import { migrate } from "../../src/db/migrate";
import { metricIdentityKey } from "../../src/db/metric-identity";
import { pgPool } from "../../src/db/postgres";

// Only invoked explicitly by the disposable CI restore projects, never a unit test.
assert.equal(process.env.BACKUP_RESTORE_APPLICATION_FIXTURE, "1");
const mode = process.argv[2];
assert.ok(mode === "seed" || mode === "verify");
const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "43000000-0000-4000-8000-000000000002";
const traceId = "43000000000040008000000000000003";
const physicalLogId = "43000000-0000-4000-8000-000000000005";
const logBody = {
	kvlistValue: {
		values: [
			{
				key: "restore-fixture",
				value: { intValue: "9223372036854775807" },
			},
		],
	},
};

async function logIdentity() {
	const client = await pgPool().connect();
	try {
		const key = await metricIdentityKey(client, organizationId, projectId);
		const wire = JSON.stringify({
			resourceLogs: [
				{
					scopeLogs: [
						{
							logRecords: [
								{ timeUnixNano: "1793318400123456789", body: logBody },
							],
						},
					],
				},
			],
		});
		const digest = createHash("sha256")
			.update(`otlp-logs-wire-v1\0${organizationId}\0${projectId}\0json\0`)
			.update(wire)
			.digest("hex");
		return createHmac("sha256", key)
			.update(`logs-record-v2:${digest}:0`)
			.digest("hex");
	} finally {
		client.release();
	}
}

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
		await ch().insert({
			table: "logs",
			format: "JSONEachRow",
			values: [
				{
					log_id: await logIdentity(),
					physical_row_id: physicalLogId,
					organization_id: organizationId,
					project_id: projectId,
					time_unix_nano: "1793318400123456789",
					observed_time_unix_nano: "1793318400987654321",
					ingested_time_unix_nano: "1793318401000000000",
					trace_id: traceId,
					span_id: "4300000000000004",
					severity_number: 13,
					severity_text: "WARN",
					body: JSON.stringify(logBody),
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
		const logId = await logIdentity();
		const logs = await ch().query({
			query:
				"SELECT toString(physical_row_id) AS physical_row_id, toString(time_unix_nano) AS time, toString(observed_time_unix_nano) AS observed, body FROM logs WHERE organization_id = {org:String} AND project_id = {project:String} AND log_id = {logId:String}",
			query_params: { org: organizationId, project: projectId, logId },
			format: "JSONEachRow",
		});
		const restored = await logs.json<{
			physical_row_id: string;
			time: string;
			observed: string;
			body: string;
		}>();
		assert.equal(restored.length, 1);
		assert.equal(restored[0].physical_row_id, physicalLogId);
		assert.equal(restored[0].time, "1793318400123456789");
		assert.equal(restored[0].observed, "1793318400987654321");
		assert.deepEqual(JSON.parse(restored[0].body), {
			kvlistValue: {
				values: [
					{
						key: "restore-fixture",
						value: { intValue: "9223372036854775807" },
					},
				],
			},
		});
		// Re-run both production runners with restored ledgers/checksums in place.
		await Promise.all([migrate(), applyClickHouseMigrations()]);
		assert.equal(await logIdentity(), logId);
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
