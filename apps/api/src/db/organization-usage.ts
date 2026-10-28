import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseDateTime } from "./traces-query.js";

export type OrganizationUsageRange = "24h" | "7d" | "30d" | "90d";
export type UsageObservationType = "span" | "event" | "generation" | "tool";
export type UsageProject = {
	id: string;
	name: string;
	slug: string;
	status: "active" | "archived";
};

type UsageCounts = {
	traces: number;
	observations: number;
	observations_by_type: Record<UsageObservationType, number>;
};

export type OrganizationUsageDashboard = {
	range: OrganizationUsageRange;
	from: string;
	to: string;
	projects: Array<UsageProject & UsageCounts>;
	totals: UsageCounts;
	series: Array<UsageCounts & { bucket_start: string }>;
};

const observationTypes: readonly UsageObservationType[] = [
	"span",
	"event",
	"generation",
	"tool",
];

type BucketConfiguration = { durationMs: number; bucketMs: number };
const rangeConfig: Record<OrganizationUsageRange, BucketConfiguration> = {
	"24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
	"7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
	"30d": {
		durationMs: 30 * 24 * 60 * 60 * 1000,
		bucketMs: 24 * 60 * 60 * 1000,
	},
	"90d": {
		durationMs: 90 * 24 * 60 * 60 * 1000,
		bucketMs: 24 * 60 * 60 * 1000,
	},
};

function zeroCounts(): UsageCounts {
	return {
		traces: 0,
		observations: 0,
		observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
	};
}

function countValue(value: unknown): number {
	const count = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(count) || count < 0)
		throw new Error("ClickHouse returned an invalid usage count");
	return count;
}

function addCount(
	target: UsageCounts,
	kind: string,
	observationType: string,
	value: number,
): void {
	if (kind === "traces") {
		target.traces += value;
		return;
	}
	if (
		kind !== "observations" ||
		!observationTypes.includes(observationType as UsageObservationType)
	)
		throw new Error("ClickHouse returned an unsupported usage record type");
	target.observations += value;
	target.observations_by_type[observationType as UsageObservationType] += value;
}

function ensureSafeSums(counts: UsageCounts): void {
	if (
		!Number.isSafeInteger(counts.traces) ||
		!Number.isSafeInteger(counts.observations) ||
		Object.values(counts.observations_by_type).some(
			(count) => !Number.isSafeInteger(count),
		)
	)
		throw new Error("Organization usage exceeds the supported numeric range");
}

export async function getOrganizationUsage(
	client: ClickHouseClient,
	input: {
		organization_id: string;
		projects: UsageProject[];
		range: OrganizationUsageRange;
		now?: Date;
	},
): Promise<OrganizationUsageDashboard> {
	const now = input.now ?? new Date();
	if (!Number.isFinite(now.getTime()))
		throw new Error("Invalid usage dashboard time");
	const config = rangeConfig[input.range];
	const to = new Date(now);
	const from = new Date(to.getTime() - config.durationMs);
	const fromIso = from.toISOString();
	const toIso = to.toISOString();
	const projectUsage = new Map(
		input.projects.map((project) => [
			project.id,
			{ ...project, ...zeroCounts() },
		]),
	);
	const seriesByTimestamp = new Map<number, UsageCounts>();
	const firstBucket =
		Math.floor(from.getTime() / config.bucketMs) * config.bucketMs;
	const lastBucket =
		Math.floor((to.getTime() - 1) / config.bucketMs) * config.bucketMs;
	for (
		let timestamp = firstBucket;
		timestamp <= lastBucket;
		timestamp += config.bucketMs
	)
		seriesByTimestamp.set(timestamp, zeroCounts());

	if (input.projects.length > 0) {
		const projectIds = input.projects.map((project) => project.id);
		const result = await client.query({
			query: `
				SELECT project_id, intDiv(toUnixTimestamp64Milli(start_time), ${config.bucketMs}) * ${config.bucketMs} AS bucket_ms, record_kind, observation_type, toString(count()) AS count
				FROM (
					SELECT project_id, start_time, 'traces' AS record_kind, '' AS observation_type
					FROM traces
					WHERE organization_id = {organization_id: String}
						AND project_id IN {project_ids: Array(String)}
						AND start_time >= {time_from: DateTime64(3, 'UTC')}
						AND start_time < {time_to: DateTime64(3, 'UTC')}
					UNION ALL
					SELECT project_id, start_time, 'observations' AS record_kind, type AS observation_type
					FROM observations
					WHERE organization_id = {organization_id: String}
						AND project_id IN {project_ids: Array(String)}
						AND start_time >= {time_from: DateTime64(3, 'UTC')}
						AND start_time < {time_to: DateTime64(3, 'UTC')}
				)
				GROUP BY project_id, bucket_ms, record_kind, observation_type
			`,
			query_params: {
				organization_id: input.organization_id,
				project_ids: projectIds,
				time_from: clickHouseDateTime(fromIso),
				time_to: clickHouseDateTime(toIso),
			},
			format: "JSONEachRow",
		});
		const rows = (await result.json()) as Array<{
			project_id: string;
			bucket_ms: string | number;
			record_kind: string;
			observation_type: string;
			count: string | number;
		}>;
		for (const row of rows) {
			const project = projectUsage.get(row.project_id);
			const bucketTimestamp = Number(row.bucket_ms);
			const value = countValue(row.count);
			if (!project || !Number.isSafeInteger(bucketTimestamp))
				throw new Error(
					"ClickHouse returned usage outside the requested scope",
				);
			const bucket = seriesByTimestamp.get(bucketTimestamp);
			if (!bucket)
				throw new Error(
					"ClickHouse returned a bucket outside the requested range",
				);
			addCount(project, row.record_kind, row.observation_type, value);
			addCount(bucket, row.record_kind, row.observation_type, value);
		}
	}

	const projects = [...projectUsage.values()];
	const totals = zeroCounts();
	for (const project of projects) {
		totals.traces += project.traces;
		totals.observations += project.observations;
		for (const type of observationTypes)
			totals.observations_by_type[type] += project.observations_by_type[type];
	}
	ensureSafeSums(totals);
	const series = [...seriesByTimestamp.entries()].map(
		([timestamp, counts]) => ({
			bucket_start: new Date(timestamp).toISOString(),
			...counts,
		}),
	);
	const seriesTotals = series.reduce((sum, bucket) => {
		sum.traces += bucket.traces;
		sum.observations += bucket.observations;
		for (const type of observationTypes)
			sum.observations_by_type[type] += bucket.observations_by_type[type];
		return sum;
	}, zeroCounts());
	ensureSafeSums(seriesTotals);
	if (JSON.stringify(seriesTotals) !== JSON.stringify(totals))
		throw new Error("Organization usage aggregates did not reconcile");

	return {
		range: input.range,
		from: fromIso,
		to: toIso,
		projects,
		totals,
		series,
	};
}
