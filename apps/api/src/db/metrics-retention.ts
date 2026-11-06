import { ch } from "./clickhouse.js";

export async function deleteMetricRetentionBatch(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	batchSize: number,
): Promise<number> {
	const client = ch();
	const query_params = {
		organizationId,
		projectId,
		cutoff: (BigInt(cutoff.getTime()) * 1_000_000n).toString(),
		batchSize,
	};
	// A retry after the deduplication window can create several physical rows for
	// one point ID. Select whole groups under the physical-row budget.
	const selected = await client.query({
		query:
			"WITH grouped AS (SELECT point_id, min(time_unix_nano) AS time, count() AS physical_rows FROM metrics WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND time_unix_nano < {cutoff:UInt64} GROUP BY point_id HAVING physical_rows <= {batchSize:UInt64}), bounded AS (SELECT point_id, physical_rows, time, sum(physical_rows) OVER (ORDER BY time, point_id) AS cumulative FROM grouped) SELECT point_id, physical_rows FROM bounded WHERE cumulative <= {batchSize:UInt64} ORDER BY time, point_id",
		query_params,
		format: "JSONEachRow",
	});
	const rows = await selected.json<{
		point_id: string;
		physical_rows: string;
	}>();
	if (!rows.length) return 0;
	await client.command({
		query:
			"ALTER TABLE metrics DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND point_id IN {pointIds:Array(String)} AND time_unix_nano < {cutoff:UInt64} SETTINGS mutations_sync = 1",
		query_params: {
			...query_params,
			pointIds: rows.map((row) => row.point_id),
		},
	});
	return rows.reduce((count, row) => count + Number(row.physical_rows), 0);
}
