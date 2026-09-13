import type { ClickHouseClient } from "@clickhouse/client";
import { ch } from "./clickhouse.js";
import type { TraceCursor } from "./trace-cursor.js";

export interface TraceRow {
	trace_id: string;
	organization_id: string;
	project_id: string;
	name: string;
	start_time: string;
	end_time: string | null;
	duration_ms: number | null;
	status: "ok" | "error";
	user_id: string;
	session_id: string;
	agent_id: string;
	agent_version: string;
	env: string;
	tags: string[];
	input_text: string;
	output_text: string;
	scores_summary: string;
	input_truncated?: boolean;
	output_truncated?: boolean;
}

export interface ObservationRow {
	observation_id: string;
	trace_id: string;
	organization_id: string;
	project_id: string;
	parent_observation_id: string | null;
	type: "span" | "event" | "generation" | "tool";
	name: string;
	start_time: string;
	end_time: string | null;
	duration_ms: number | null;
	status: "ok" | "error";
	model: string | null;
	input_text: string;
	output_text: string;
	metadata: string;
	input_truncated?: boolean;
	output_truncated?: boolean;
	metadata_truncated?: boolean;
}

export interface TraceListFilters {
	organization_id: string;
	project_id?: string;
	agent_id?: string;
	env?: string;
	time_from?: string; // ISO datetime
	time_to?: string;
	name?: string; // substring (case-insensitive) on the trace name
	status?: string; // exact: "ok" | "error"
	duration?: string; // "<500" | ">100" | "500" (exact ms)
	scores?: string; // substring (case-insensitive) on scores_summary
	input_text?: string; // substring (case-insensitive) on input_text
}

export interface ObservationListFilters {
	organization_id: string;
	project_id?: string;
	agent_id?: string;
	trace_id?: string; // exact match — useful for "all spans in this trace"
	type?: string; // exact: "span" | "event" | "generation" | "tool"
	time_from?: string;
	time_to?: string;
	name?: string; // substring (case-insensitive)
	status?: string;
	duration?: string;
	model?: string; // substring (case-insensitive)
	input_text?: string;
}

const LIST_COLUMNS =
	"trace_id, organization_id, project_id, name, start_time, end_time, duration_ms, status, user_id, session_id, agent_id, agent_version, env, tags, substringUTF8(input_text, 1, 200) AS input_text, substringUTF8(output_text, 1, 200) AS output_text, lengthUTF8(input_text) > 200 AS input_truncated, lengthUTF8(output_text) > 200 AS output_truncated, scores_summary";

const OBSERVATION_COLUMNS =
	"observation_id, trace_id, organization_id, project_id, parent_observation_id, type, name, start_time, end_time, duration_ms, status, model, substringUTF8(input_text, 1, 200) AS input_text, substringUTF8(output_text, 1, 200) AS output_text, lengthUTF8(input_text) > 200 AS input_truncated, lengthUTF8(output_text) > 200 AS output_truncated, if(length(metadata) <= 2048, metadata, '') AS metadata, length(metadata) > 2048 AS metadata_truncated";

const OBSERVATION_FULL_COLUMNS =
	"observation_id, trace_id, organization_id, project_id, parent_observation_id, type, name, start_time, end_time, duration_ms, status, model, substringUTF8(input_text, 1, 2048) AS input_text, substringUTF8(output_text, 1, 2048) AS output_text, length(input_text) > 8192 AS input_truncated, length(output_text) > 8192 AS output_truncated, if(length(metadata) <= 16384, metadata, '') AS metadata, length(metadata) > 16384 AS metadata_truncated";

export const MAX_TRACE_DETAIL_OBSERVATIONS = 7;

function defaultClient(): ClickHouseClient {
	return ch();
}

function buildWhere(
	filters: TraceListFilters,
	params: Record<string, unknown>,
): string {
	const where: string[] = ["organization_id = {organization_id: String}"];
	params.organization_id = filters.organization_id;
	if (filters.project_id) {
		where.push("project_id = {project_id: String}");
		params.project_id = filters.project_id;
	}
	if (filters.agent_id) {
		where.push("agent_id = {agent_id: String}");
		params.agent_id = filters.agent_id;
	}
	if (filters.env) {
		where.push("env = {env: String}");
		params.env = filters.env;
	}
	if (filters.time_from) {
		where.push("start_time >= {time_from: DateTime64(3)}");
		params.time_from = filters.time_from;
	}
	if (filters.time_to) {
		where.push("start_time <= {time_to: DateTime64(3)}");
		params.time_to = filters.time_to;
	}
	if (filters.name && filters.name.length > 0) {
		where.push("positionCaseInsensitiveUTF8(name, {name: String}) > 0");
		params.name = filters.name;
	}
	if (filters.status && filters.status.length > 0) {
		where.push("status = {status: String}");
		params.status = filters.status;
	}
	if (filters.duration && filters.duration.length > 0) {
		const d = filters.duration.trim();
		const m = /^(<=|<|>=|>|=)?\s*(\d+(?:\.\d+)?)$/.exec(d);
		if (m) {
			const op = m[1] ?? "=";
			const num = Number(m[2]);
			const safeOp = op === "=" ? "=" : op; // ClickHouse accepts all four
			where.push(`duration_ms ${safeOp} {duration_ms: UInt32}`);
			params.duration_ms = num;
		}
	}
	if (filters.scores && filters.scores.length > 0) {
		where.push(
			"positionCaseInsensitiveUTF8(scores_summary, {scores: String}) > 0",
		);
		params.scores = filters.scores;
	}
	if (filters.input_text && filters.input_text.length > 0) {
		where.push(
			"positionCaseInsensitiveUTF8(input_text, {input_text: String}) > 0",
		);
		params.input_text = filters.input_text;
	}
	return where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
}

export async function listTraces(
	client: ClickHouseClient,
	filters: TraceListFilters,
	limit: number,
	cursor?: TraceCursor,
): Promise<{ items: TraceRow[]; total: number; next_cursor?: TraceCursor }> {
	const params: Record<string, unknown> = {
		limit: limit === 0 ? 0 : limit + 1,
	};
	const whereClause = buildWhere(filters, params);
	const cursorClause = cursor
		? " AND (start_time, trace_id) < ({cursor_start_time: DateTime64(3)}, {cursor_id: String})"
		: "";
	if (cursor) {
		params.cursor_start_time = cursor.start_time;
		params.cursor_id = cursor.id;
	}

	const itemsResult = await client.query({
		query: `SELECT ${LIST_COLUMNS} FROM traces ${whereClause}${cursorClause} ORDER BY start_time DESC, trace_id DESC LIMIT {limit: UInt32}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const rows = (await itemsResult.json()) as TraceRow[];
	const items = rows.slice(0, limit);

	const totalResult = await client.query({
		query: `SELECT count() AS total FROM traces ${whereClause}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const totalRows = (await totalResult.json()) as Array<{
		total: string | number;
	}>;
	const total = Number(totalRows[0]?.total ?? 0);

	const last = items.at(-1);
	return {
		items,
		total,
		...(rows.length > limit && last
			? { next_cursor: { start_time: last.start_time, id: last.trace_id } }
			: {}),
	};
}

export async function getTrace(
	client: ClickHouseClient,
	organizationId: string,
	traceId: string,
	projectId?: string,
	signal?: AbortSignal,
	cursor?: TraceCursor,
): Promise<{
	trace: TraceRow | null;
	observations: ObservationRow[];
	next_cursor?: TraceCursor;
}> {
	const query_params = {
		organization_id: organizationId,
		trace_id: traceId,
		project_id: projectId ?? "",
		limit: MAX_TRACE_DETAIL_OBSERVATIONS + 1,
	};
	const traceResult = await client.query({
		query: `SELECT ${LIST_COLUMNS} FROM traces WHERE organization_id = {organization_id: String} AND trace_id = {trace_id: String} AND project_id = {project_id: String} LIMIT 1`,
		query_params,
		format: "JSONEachRow",
		abort_signal: signal,
	});
	const traceRows = (await traceResult.json()) as TraceRow[];
	const trace = traceRows.length > 0 ? traceRows[0] : null;
	if (!trace) return { trace: null, observations: [] };

	if (cursor) {
		Object.assign(query_params, {
			cursor_start_time: cursor.start_time,
			cursor_id: cursor.id,
		});
	}
	const cursorClause = cursor
		? " AND (start_time, observation_id) > ({cursor_start_time: DateTime64(3)}, {cursor_id: String})"
		: "";
	const obsResult = await client.query({
		query: `SELECT ${OBSERVATION_FULL_COLUMNS} FROM observations WHERE organization_id = {organization_id: String} AND trace_id = {trace_id: String} AND project_id = {project_id: String}${cursorClause} ORDER BY start_time ASC, observation_id ASC LIMIT {limit: UInt32}`,
		query_params,
		format: "JSONEachRow",
		abort_signal: signal,
	});
	const rows = (await obsResult.json()) as ObservationRow[];
	const observations = rows.slice(0, MAX_TRACE_DETAIL_OBSERVATIONS);
	const last = observations.at(-1);

	return {
		trace,
		observations,
		...(rows.length > MAX_TRACE_DETAIL_OBSERVATIONS && last
			? {
					next_cursor: { start_time: last.start_time, id: last.observation_id },
				}
			: {}),
	};
}

function buildObservationWhere(
	filters: ObservationListFilters,
	params: Record<string, unknown>,
): string {
	const where: string[] = ["organization_id = {organization_id: String}"];
	params.organization_id = filters.organization_id;
	if (filters.project_id) {
		where.push("project_id = {project_id: String}");
		params.project_id = filters.project_id;
	}
	if (filters.agent_id) {
		// agent_id isn't a first-class column on observations; the OTLP normalizer
		// serializes the span's attributes as JSON into `metadata`. Substring match
		// on the rendered string. Good enough until we add an agent_id column.
		where.push("positionCaseInsensitiveUTF8(metadata, {agent_id: String}) > 0");
		params.agent_id = filters.agent_id;
	}
	if (filters.trace_id) {
		where.push("trace_id = {trace_id: String}");
		params.trace_id = filters.trace_id;
	}
	if (filters.type) {
		where.push("type = {type: String}");
		params.type = filters.type;
	}
	if (filters.time_from) {
		where.push("start_time >= {time_from: DateTime64(3)}");
		params.time_from = filters.time_from;
	}
	if (filters.time_to) {
		where.push("start_time <= {time_to: DateTime64(3)}");
		params.time_to = filters.time_to;
	}
	if (filters.name && filters.name.length > 0) {
		where.push("positionCaseInsensitiveUTF8(name, {name: String}) > 0");
		params.name = filters.name;
	}
	if (filters.status && filters.status.length > 0) {
		where.push("status = {status: String}");
		params.status = filters.status;
	}
	if (filters.duration && filters.duration.length > 0) {
		const d = filters.duration.trim();
		const m = /^(<=|<|>=|>|=)?\s*(\d+(?:\.\d+)?)$/.exec(d);
		if (m) {
			const op = m[1] ?? "=";
			const num = Number(m[2]);
			where.push(`duration_ms ${op} {duration_ms: UInt32}`);
			params.duration_ms = num;
		}
	}
	if (filters.model && filters.model.length > 0) {
		where.push("positionCaseInsensitiveUTF8(model, {model: String}) > 0");
		params.model = filters.model;
	}
	if (filters.input_text && filters.input_text.length > 0) {
		where.push(
			"positionCaseInsensitiveUTF8(input_text, {input_text: String}) > 0",
		);
		params.input_text = filters.input_text;
	}
	return where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
}

export async function listObservations(
	client: ClickHouseClient,
	filters: ObservationListFilters,
	limit: number,
	cursor?: TraceCursor,
): Promise<{
	items: ObservationRow[];
	total: number;
	next_cursor?: TraceCursor;
}> {
	const params: Record<string, unknown> = {
		limit: limit === 0 ? 0 : limit + 1,
	};
	const whereClause = buildObservationWhere(filters, params);
	const cursorClause = cursor
		? " AND (start_time, observation_id) < ({cursor_start_time: DateTime64(3)}, {cursor_id: String})"
		: "";
	if (cursor) {
		params.cursor_start_time = cursor.start_time;
		params.cursor_id = cursor.id;
	}

	const itemsResult = await client.query({
		query: `SELECT ${OBSERVATION_COLUMNS} FROM observations ${whereClause}${cursorClause} ORDER BY start_time DESC, observation_id DESC LIMIT {limit: UInt32}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const rows = (await itemsResult.json()) as ObservationRow[];
	const items = rows.slice(0, limit);

	const totalResult = await client.query({
		query: `SELECT count() AS total FROM observations ${whereClause}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const totalRows = (await totalResult.json()) as Array<{
		total: string | number;
	}>;
	const total = Number(totalRows[0]?.total ?? 0);

	const last = items.at(-1);
	return {
		items,
		total,
		...(rows.length > limit && last
			? {
					next_cursor: { start_time: last.start_time, id: last.observation_id },
				}
			: {}),
	};
}

export { defaultClient };
