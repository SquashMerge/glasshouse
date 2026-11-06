import { TupleParam } from "@clickhouse/client";
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
	const scope =
		"organization_id = {organizationId:String} AND project_id = {projectId:String} AND time_unix_nano < {cutoff:UInt64}";
	const remaining = async () => {
		const result = await client.query({
			query: `SELECT toString(count()) AS count FROM metrics WHERE ${scope}`,
			query_params,
			format: "JSONEachRow",
			clickhouse_settings: { use_query_cache: 0 },
		});
		return BigInt((await result.json<{ count: string }>())[0]!.count);
	};
	// The caller holds the Project write fence through selection, mutation and
	// counting. Part/offset pairs bound physical copies even with identical IDs.
	const before = await remaining();
	if (before === 0n) return 0;
	for (let attempt = 0; attempt < 3; attempt++) {
		const selected = await client.query({
			query: `SELECT _part AS part, toString(_part_offset) AS offset FROM metrics WHERE ${scope} ORDER BY time_unix_nano, point_id, _part, _part_offset LIMIT {batchSize:UInt64}`,
			query_params,
			format: "JSONEachRow",
			clickhouse_settings: { use_query_cache: 0 },
		});
		const rows = await selected.json<{ part: string; offset: string }>();
		await client.command({
			query: `ALTER TABLE metrics DELETE WHERE ${scope} AND (_part, _part_offset) IN {positions:Array(Tuple(String, UInt64))} SETTINGS mutations_sync = 1`,
			query_params: {
				...query_params,
				positions: rows.map(
					(row) => new TupleParam([row.part, BigInt(row.offset)]),
				),
			},
		});
		const deleted = before - (await remaining());
		if (deleted < 0n || deleted > BigInt(rows.length))
			throw new Error(
				"Metric retention row count changed outside the Project fence",
			);
		if (deleted > 0n) return Number(deleted);
		// Merges rename immutable parts. Stale pairs match nothing; reselect with
		// a bounded retry rather than report selected rows as deleted.
	}
	throw new Error(
		"Metric retention could not make progress after part changes",
	);
}
