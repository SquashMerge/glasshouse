export interface ObservationRecord {
	observation_id: unknown;
	parent_observation_id?: unknown;
	metadata?: unknown;
	start_time?: unknown;
	end_time?: unknown;
	duration_ms?: unknown;
	status?: unknown;
	[key: string]: unknown;
}

export interface CanonicalObservation extends ObservationRecord {
	observation_id: string;
}

export interface TraceSnapshot<TTrace = unknown> {
	trace?: TTrace;
	observations: readonly unknown[];
}

export interface TraceModel<TTrace = unknown> {
	trace: TTrace | undefined;
	observationsById: ReadonlyMap<string, CanonicalObservation>;
	observationIds: readonly string[];
	malformedObservationCount: number;
	highlightVersions: ReadonlyMap<string, number>;
}

export interface TraceModelDiagnostics {
	malformedObservationCount: number;
}

export function canonicalObservationId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim();
	return id.length > 0 ? id : null;
}

export function canonicalizeObservation(
	value: unknown,
): CanonicalObservation | null {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const observation = value as ObservationRecord;
	const observationId = canonicalObservationId(observation.observation_id);
	if (!observationId) return null;
	return { ...observation, observation_id: observationId };
}

export function createTraceModel<TTrace = unknown>(
	snapshot: TraceSnapshot<TTrace>,
): TraceModel<TTrace> {
	const observationsById = new Map<string, CanonicalObservation>();
	let malformedObservationCount = 0;

	for (const value of snapshot.observations) {
		const observation = canonicalizeObservation(value);
		if (!observation) {
			malformedObservationCount += 1;
			continue;
		}
		observationsById.set(observation.observation_id, observation);
	}

	return {
		trace: snapshot.trace,
		observationsById,
		observationIds: [...observationsById.keys()],
		malformedObservationCount,
		highlightVersions: new Map(
			[...observationsById.keys()].map((id) => [id, 0]),
		),
	};
}

export function upsertLiveObservation<TTrace>(
	model: TraceModel<TTrace>,
	value: unknown,
): TraceModel<TTrace> {
	const observation = canonicalizeObservation(value);
	if (!observation) {
		return {
			...model,
			malformedObservationCount: model.malformedObservationCount + 1,
		};
	}

	const observationsById = new Map(model.observationsById);
	const highlightVersions = new Map(model.highlightVersions);
	observationsById.set(observation.observation_id, observation);
	highlightVersions.set(
		observation.observation_id,
		(highlightVersions.get(observation.observation_id) ?? 0) + 1,
	);

	return {
		...model,
		observationsById,
		observationIds: [...observationsById.keys()],
		highlightVersions,
	};
}

export function getObservationHighlightVersion(
	model: TraceModel,
	observationId: string,
): number {
	return model.highlightVersions.get(observationId) ?? 0;
}

export function getTraceModelDiagnostics(
	model: TraceModel,
): TraceModelDiagnostics {
	return { malformedObservationCount: model.malformedObservationCount };
}

export function traceModelObservations(
	model: TraceModel,
): CanonicalObservation[] {
	return model.observationIds.flatMap((id) => {
		const observation = model.observationsById.get(id);
		return observation ? [observation] : [];
	});
}

export function traceModelRawPayload<TTrace>(model: TraceModel<TTrace>): {
	trace?: TTrace;
	observations: CanonicalObservation[];
} {
	return { trace: model.trace, observations: traceModelObservations(model) };
}
