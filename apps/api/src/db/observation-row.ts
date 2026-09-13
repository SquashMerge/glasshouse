import type { TenantScopedObservation } from "./traces-writer.js";
import { serializeObservationMetadata } from "./observation-metadata.js";
import { boundObservationMetadata, boundText } from "./trace-payload-bounds.js";

export interface ObservationInsertRow {
	[key: string]: string | number | null;
	metadata: string;
}

export function observationToInsertRow(
	observation: TenantScopedObservation,
): ObservationInsertRow {
	const input = boundText(observation.input_text);
	const output = boundText(observation.output_text);
	return {
		observation_id: observation.observation_id,
		trace_id: observation.trace_id,
		organization_id: observation.organization_id,
		project_id: observation.project_id,
		parent_observation_id: observation.parent_observation_id,
		type: observation.type,
		name: observation.name,
		start_time: observation.start_time,
		end_time: observation.end_time,
		duration_ms: observation.duration_ms,
		status: observation.status,
		model: observation.model,
		input_text: input.value,
		output_text: output.value,
		metadata: serializeObservationMetadata(
			boundObservationMetadata(observation.metadata),
		),
	};
}
