import { ApiError } from "./api";
import { authedFetch } from "./auth";

export interface MetricRow {
	point_id: string;
	series_id: string;
	name: string;
	description: string;
	unit: string;
	metric_type:
		| "gauge"
		| "sum"
		| "histogram"
		| "exponential_histogram"
		| "summary";
	aggregation_temporality: number;
	is_monotonic: boolean;
	time_unix_nano: string;
	resource_attributes: unknown[];
	scope_name: string;
	scope_version: string;
	scope_attributes: unknown[];
	data_point: Record<string, unknown>;
}

export async function listMetrics(
	projectId: string,
	name: string,
	cursor: string | null,
	signal: AbortSignal,
): Promise<{ items: MetricRow[]; next_cursor: string | null }> {
	const query = new URLSearchParams({ project_id: projectId, limit: "50" });
	if (name) query.set("name", name);
	if (cursor) query.set("cursor", cursor);
	const response = await authedFetch(`/v1/metrics?${query}`, { signal });
	if (!response.ok)
		throw new ApiError(
			response.status,
			"METRICS_READ_FAILED",
			"Metrics could not be loaded",
		);
	return response.json();
}
