import type { OptimizationEvent, OptimizationJob, PromptVersion } from "./api";

const statuses = new Set<OptimizationJob["status"]>([
	"queued",
	"preparing",
	"optimizing",
	"evaluating",
	"completed",
	"stopped",
	"failed",
]);

export function parseOptimizationEvent(
	value: unknown,
): OptimizationEvent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const event = value as Record<string, unknown>;
	if (
		typeof event.id !== "number" ||
		!Number.isSafeInteger(event.id) ||
		typeof event.status !== "string" ||
		!statuses.has(event.status as OptimizationJob["status"]) ||
		!event.detail ||
		typeof event.detail !== "object" ||
		Array.isArray(event.detail) ||
		typeof event.created_at !== "string"
	)
		return null;
	return {
		id: event.id as number,
		status: event.status as OptimizationJob["status"],
		detail: event.detail as Record<string, unknown>,
		created_at: event.created_at as string,
	};
}

export function progressScore(event: OptimizationEvent | null): number | null {
	const score = event?.detail.score;
	return typeof score === "number" && Number.isFinite(score) ? score : null;
}

export function optimizationDiff(
	job: OptimizationJob,
	versions: PromptVersion[] | undefined,
): { summary: string; before: string; after: string } | null {
	if (!job.source_version || !job.target) return null;
	const before = versions?.find(
		(version) => version.version === job.source_version,
	);
	const after = job.result_version
		? versions?.find((version) => version.version === job.result_version)
		: undefined;
	const beforeContent = before?.messages.find(
		(message) => message.role === job.target,
	)?.content;
	const afterContent =
		job.candidate_content ??
		after?.messages.find((message) => message.role === job.target)?.content;
	if (beforeContent === undefined || afterContent === undefined) return null;
	return {
		summary:
			beforeContent === afterContent
				? "Candidate matches the source prompt."
				: `Candidate differs from source v${job.source_version}.`,
		before: beforeContent,
		after: afterContent,
	};
}
