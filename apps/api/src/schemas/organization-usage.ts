import { z } from "@hono/zod-openapi";

export const OrganizationUsageRange = z.enum(["24h", "7d", "30d", "90d"]);
const UsageCount = z.number().int().nonnegative();
const ObservationCounts = z
	.object({
		span: UsageCount,
		event: UsageCount,
		generation: UsageCount,
		tool: UsageCount,
	})
	.strict();
const UsageCounts = z
	.object({
		traces: UsageCount,
		observations: UsageCount,
		observations_by_type: ObservationCounts,
	})
	.strict();
const UsageProject = z
	.object({
		id: z.string().uuid(),
		name: z.string(),
		slug: z.string(),
		status: z.enum(["active", "archived"]),
	})
	.strict();
export const OrganizationUsageQuery = z
	.object({ range: OrganizationUsageRange.default("30d") })
	.strict();
export const OrganizationUsageDashboard = z
	.object({
		range: OrganizationUsageRange,
		from: z.string().datetime(),
		to: z.string().datetime(),
		projects: z.array(UsageProject.extend(UsageCounts.shape).strict()),
		totals: UsageCounts,
		series: z.array(
			UsageCounts.extend({ bucket_start: z.string().datetime() }).strict(),
		),
	})
	.strict()
	.openapi("OrganizationUsageDashboard");
