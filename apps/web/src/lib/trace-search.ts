import type { CanonicalObservation } from "./trace-model";

export interface TraceSearchResult {
	query: string;
	matchIds: readonly string[];
}

function searchableText(observation: CanonicalObservation): string {
	const fields = [
		observation.name,
		observation.service,
		observation.service_name,
		observation.observation_id,
		observation.trace_id,
		observation.parent_observation_id,
		observation.status,
		observation.metadata,
	];
	return fields
		.filter((value): value is string => typeof value === "string")
		.join("\n")
		.toLocaleLowerCase();
}

export function searchTraceObservations(
	observations: readonly CanonicalObservation[],
	query: string,
): TraceSearchResult {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return { query, matchIds: [] };
	return {
		query,
		matchIds: observations
			.filter((observation) =>
				searchableText(observation).includes(normalizedQuery),
			)
			.map((observation) => observation.observation_id),
	};
}

export function revealSearchAncestors(
	expandedIds: ReadonlySet<string>,
	matchIds: readonly string[],
	ancestorsFor: (observationId: string) => readonly string[],
): Set<string> {
	const revealed = new Set(expandedIds);
	for (const matchId of matchIds) {
		for (const ancestorId of ancestorsFor(matchId)) revealed.add(ancestorId);
	}
	return revealed;
}
