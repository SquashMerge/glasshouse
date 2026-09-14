import type { ObservationMetadata } from "./observation-metadata.js";
import {
	boundListExcerpt,
	MAX_LIST_METADATA_BYTES,
	utf8ByteLength,
} from "./trace-payload-bounds.js";

type PublicTraceSource = {
	organization_id: string;
	start_time: string;
	end_time: string | null;
};

type PublicObservationSource = PublicTraceSource & {
	type: string;
	metadata: string | ObservationMetadata;
};

function presentTimestamp(value: string): string {
	if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return value;
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(
		value,
	);
	return match ? `${match[1]}T${match[2]}Z` : value;
}

function omitFalseFlags<
	T extends {
		input_retained_truncated?: boolean;
		output_retained_truncated?: boolean;
		input_excerpt_truncated?: boolean;
		output_excerpt_truncated?: boolean;
	},
>(row: T) {
	const {
		input_retained_truncated,
		output_retained_truncated,
		input_excerpt_truncated,
		output_excerpt_truncated,
		...rest
	} = row;
	return {
		...rest,
		...(input_retained_truncated ? { input_retained_truncated: true } : {}),
		...(output_retained_truncated ? { output_retained_truncated: true } : {}),
		...(input_excerpt_truncated ? { input_excerpt_truncated: true } : {}),
		...(output_excerpt_truncated ? { output_excerpt_truncated: true } : {}),
	};
}

export function presentTrace<T extends PublicTraceSource>(trace: T) {
	const { organization_id: _, start_time, end_time, ...rest } = trace;
	return {
		...rest,
		start_time: presentTimestamp(start_time),
		end_time: end_time ? presentTimestamp(end_time) : null,
	};
}

export function presentListTrace<
	T extends PublicTraceSource & {
		input_text: string;
		output_text: string;
		input_retained_truncated?: boolean;
		output_retained_truncated?: boolean;
		input_excerpt_truncated?: boolean;
		output_excerpt_truncated?: boolean;
	},
>(trace: T) {
	const input = boundListExcerpt(trace.input_text);
	const output = boundListExcerpt(trace.output_text);
	return omitFalseFlags({
		...presentTrace(trace),
		input_text: input.value,
		output_text: output.value,
		input_excerpt_truncated:
			trace.input_excerpt_truncated === true || input.truncated,
		output_excerpt_truncated:
			trace.output_excerpt_truncated === true || output.truncated,
	});
}

export function presentObservation<T extends PublicObservationSource>(
	observation: T,
	presentMetadata: (
		metadata: string | ObservationMetadata,
		isGeneration: boolean,
	) => ObservationMetadata,
) {
	const {
		organization_id: _,
		start_time,
		end_time,
		type,
		metadata,
		...rest
	} = observation;
	return {
		...rest,
		type,
		start_time: presentTimestamp(start_time),
		end_time: end_time ? presentTimestamp(end_time) : null,
		metadata: presentMetadata(metadata, type === "generation"),
	};
}

export function presentListObservation<
	T extends PublicObservationSource & {
		input_text: string;
		output_text: string;
		input_retained_truncated?: boolean;
		output_retained_truncated?: boolean;
		input_excerpt_truncated?: boolean;
		output_excerpt_truncated?: boolean;
		metadata_truncated?: boolean;
	},
>(
	observation: T,
	presentMetadata: (
		metadata: string | ObservationMetadata,
		isGeneration: boolean,
	) => ObservationMetadata,
) {
	const input = boundListExcerpt(observation.input_text);
	const output = boundListExcerpt(observation.output_text);
	let metadata: string | ObservationMetadata = observation.metadata;
	let metadataTruncated = observation.metadata_truncated === true;
	try {
		if (
			utf8ByteLength(
				typeof metadata === "string" ? metadata : JSON.stringify(metadata),
			) > MAX_LIST_METADATA_BYTES
		) {
			metadata = "";
			metadataTruncated = true;
		}
	} catch {
		metadata = "";
		metadataTruncated = true;
	}
	return {
		...omitFalseFlags({
			...presentObservation(
				{
					...observation,
					metadata,
					input_text: input.value,
					output_text: output.value,
					input_excerpt_truncated:
						observation.input_excerpt_truncated === true || input.truncated,
					output_excerpt_truncated:
						observation.output_excerpt_truncated === true || output.truncated,
				},
				presentMetadata,
			),
			input_retained_truncated: observation.input_retained_truncated,
			output_retained_truncated: observation.output_retained_truncated,
			input_excerpt_truncated:
				observation.input_excerpt_truncated === true || input.truncated,
			output_excerpt_truncated:
				observation.output_excerpt_truncated === true || output.truncated,
		}),
		...(metadataTruncated ? { metadata_truncated: true } : {}),
	};
}
