import type { TenantScopedObservation } from "./traces-writer.js";
import { serializeObservationMetadata } from "./observation-metadata.js";
import { boundObservationMetadata, boundText } from "./trace-payload-bounds.js";
import { boundOtlpDetail } from "./otlp-detail.js";

export interface ObservationInsertRow {
	[key: string]: string | number | boolean | null;
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
		duration_ms:
			observation.duration_ms === null
				? null
				: Math.min(4_294_967_295, Math.round(observation.duration_ms)),
		precise_duration_ms: observation.duration_ms,
		start_time_unix_nano: observation.start_time_unix_nano ?? null,
		end_time_unix_nano: observation.end_time_unix_nano ?? null,
		duration_nano: observation.duration_nano ?? null,
		otlp: observation.otlp
			? JSON.stringify(boundOtlpDetail(observation.otlp))
			: "",
		status: observation.status,
		model: observation.model,
		input_text: input.value,
		output_text: output.value,
		input_retained_truncated:
			observation.input_retained_truncated === true || input.truncated,
		output_retained_truncated:
			observation.output_retained_truncated === true || output.truncated,
		metadata: serializeObservationMetadata(
			boundObservationMetadata(observation.metadata),
		),
	};
}
