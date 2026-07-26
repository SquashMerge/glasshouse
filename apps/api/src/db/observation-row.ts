import type { NormalizedObservation } from "./gen-ai-attrs.js";
import { serializeObservationMetadata } from "./observation-metadata.js";

export interface ObservationInsertRow {
	[key: string]: string | number | null;
	metadata: string;
}

export function observationToInsertRow(
	observation: NormalizedObservation,
): ObservationInsertRow {
	return {
		observation_id: observation.observation_id,
		trace_id: observation.trace_id,
		project_id: "",
		parent_observation_id: observation.parent_observation_id,
		type: observation.type,
		name: observation.name,
		start_time: observation.start_time,
		end_time: observation.end_time,
		duration_ms: observation.duration_ms,
		status: observation.status,
		model: observation.model,
		input_text: observation.input_text,
		output_text: observation.output_text,
		metadata: serializeObservationMetadata(observation.metadata),
	};
}
