import type { ClickHouseClient } from "@clickhouse/client";
import { ch } from "./clickhouse.js";
import type { NormalizedObservation, NormalizedTrace } from "./gen-ai-attrs.js";
import { observationToInsertRow } from "./observation-row.js";
import { boundText } from "./trace-payload-bounds.js";

export type TenantScopedTrace = NormalizedTrace & {
	organization_id: string;
	project_id: string;
};

export type TenantScopedObservation = NormalizedObservation & {
	organization_id: string;
	project_id: string;
};

interface ClickHouseRow {
	[key: string]: string | number | boolean | null | string[];
}

function traceToRow(t: TenantScopedTrace): ClickHouseRow {
	const input = boundText(t.input_text);
	const output = boundText(t.output_text);
	return {
		trace_id: t.trace_id,
		organization_id: t.organization_id,
		project_id: t.project_id,
		name: t.name,
		start_time: t.start_time,
		end_time: t.end_time,
		duration_ms: t.duration_ms,
		status: t.status,
		user_id: t.user_id,
		session_id: t.session_id,
		agent_id: t.agent_id,
		agent_version: t.agent_version,
		env: t.env,
		tags: t.tags,
		input_text: input.value,
		output_text: output.value,
		input_retained_truncated:
			t.input_retained_truncated === true || input.truncated,
		output_retained_truncated:
			t.output_retained_truncated === true || output.truncated,
		scores_summary: t.scores_summary,
		metadata: "",
	};
}

export async function insertTraces(
	client: ClickHouseClient,
	traces: TenantScopedTrace[],
	deduplicationToken: string,
): Promise<void> {
	if (traces.length === 0) return;
	await client.insert({
		table: "traces",
		values: traces.map(traceToRow),
		format: "JSONEachRow",
		clickhouse_settings: {
			insert_deduplicate: 1,
			insert_deduplication_token: deduplicationToken,
		},
	});
}

export async function insertObservations(
	client: ClickHouseClient,
	observations: TenantScopedObservation[],
	deduplicationToken: string,
): Promise<void> {
	if (observations.length === 0) return;
	await client.insert({
		table: "observations",
		values: observations.map(observationToInsertRow),
		format: "JSONEachRow",
		clickhouse_settings: {
			insert_deduplicate: 1,
			insert_deduplication_token: deduplicationToken,
		},
	});
}

export function defaultClient(): ClickHouseClient {
	return ch();
}
