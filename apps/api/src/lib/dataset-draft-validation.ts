export const DATASET_DRAFT_VALIDATION_VERSION = 1;

export type JsonObject = Record<string, unknown>;

export type DatasetDraftValidationIssue = {
	field: string;
	code: string;
	message: string;
};

export type DatasetDraftItemInput = {
	input: JsonObject;
	expected_output?: JsonObject | null;
	metadata?: JsonObject;
	external_id?: string | null;
	source_trace_id?: string | null;
	source_observation_id?: string | null;
};

const MAX_ITEM_JSON_BYTES = 32_768;
const MAX_METADATA_JSON_BYTES = 8_192;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 500;
const MAX_STRING_LENGTH = 16_384;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_ARRAY_ENTRIES = 16;
const metadataKey = /^[A-Za-z0-9_.-]{1,64}$/;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined
			? null
			: new TextEncoder().encode(serialized).byteLength;
	} catch {
		return null;
	}
}

function validateJsonValue(
	value: unknown,
	field: string,
	issues: DatasetDraftValidationIssue[],
	depth = 0,
	state = { nodes: 0 },
): void {
	state.nodes += 1;
	if (state.nodes > MAX_JSON_NODES) {
		issues.push({
			field,
			code: "TOO_COMPLEX",
			message: "Value contains too many JSON nodes",
		});
		return;
	}
	if (depth > MAX_JSON_DEPTH) {
		issues.push({
			field,
			code: "TOO_DEEP",
			message: "Value exceeds the maximum nesting depth",
		});
		return;
	}
	if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
		issues.push({
			field,
			code: "STRING_TOO_LONG",
			message: "String values must not exceed 16384 characters",
		});
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries())
			validateJsonValue(entry, `${field}/${index}`, issues, depth + 1, state);
		return;
	}
	if (isObject(value))
		for (const [key, entry] of Object.entries(value))
			validateJsonValue(entry, `${field}/${key}`, issues, depth + 1, state);
}

function validatePayloadObject(
	value: unknown,
	field: "input" | "expected_output",
	issues: DatasetDraftValidationIssue[],
): void {
	if (!isObject(value)) {
		issues.push({
			field,
			code: "OBJECT_REQUIRED",
			message: `${field === "input" ? "Input" : "Expected output"} must be a JSON object`,
		});
		return;
	}
	const bytes = byteLength(value);
	if (bytes === null || bytes > MAX_ITEM_JSON_BYTES)
		issues.push({
			field,
			code: "TOO_LARGE",
			message: `${field === "input" ? "Input" : "Expected output"} must not exceed 32768 bytes`,
		});
	validateJsonValue(value, field, issues);
}

function isMetadataValue(value: unknown): boolean {
	if (
		value === null ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(typeof value === "string" && value.length <= 512)
	)
		return true;
	return (
		Array.isArray(value) &&
		value.length <= MAX_METADATA_ARRAY_ENTRIES &&
		value.every(
			(entry) =>
				entry === null ||
				typeof entry === "boolean" ||
				(typeof entry === "number" && Number.isFinite(entry)) ||
				(typeof entry === "string" && entry.length <= 512),
		)
	);
}

function validateMetadata(
	value: unknown,
	issues: DatasetDraftValidationIssue[],
): void {
	if (!isObject(value)) {
		issues.push({
			field: "metadata",
			code: "OBJECT_REQUIRED",
			message: "Metadata must be a JSON object",
		});
		return;
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_METADATA_ENTRIES)
		issues.push({
			field: "metadata",
			code: "TOO_MANY_FIELDS",
			message: "Metadata must not contain more than 32 fields",
		});
	for (const [key, entry] of entries) {
		if (!metadataKey.test(key))
			issues.push({
				field: `metadata/${key}`,
				code: "INVALID_KEY",
				message:
					"Metadata keys must use letters, numbers, dots, underscores, or hyphens",
			});
		if (!isMetadataValue(entry))
			issues.push({
				field: `metadata/${key}`,
				code: "INVALID_VALUE",
				message:
					"Metadata values must be scalar values or short arrays of scalar values",
			});
	}
	const bytes = byteLength(value);
	if (bytes === null || bytes > MAX_METADATA_JSON_BYTES)
		issues.push({
			field: "metadata",
			code: "TOO_LARGE",
			message: "Metadata must not exceed 8192 bytes",
		});
}

export function validateDatasetDraftItem(
	value: DatasetDraftItemInput,
): DatasetDraftValidationIssue[] {
	const issues: DatasetDraftValidationIssue[] = [];
	validatePayloadObject(value.input, "input", issues);
	if (value.expected_output !== undefined && value.expected_output !== null)
		validatePayloadObject(value.expected_output, "expected_output", issues);
	validateMetadata(value.metadata ?? {}, issues);
	if (
		value.external_id !== undefined &&
		value.external_id !== null &&
		(value.external_id.trim().length === 0 || value.external_id.length > 200)
	)
		issues.push({
			field: "external_id",
			code: "INVALID_EXTERNAL_ID",
			message: "External source identity must be between 1 and 200 characters",
		});
	if (value.source_observation_id && !value.source_trace_id)
		issues.push({
			field: "source_observation_id",
			code: "TRACE_REQUIRED",
			message: "Observation provenance requires a trace",
		});
	return issues;
}

export function captureTextAsObject(value: string): JsonObject {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (isObject(parsed)) return parsed;
	} catch {
		// A source value does not need to be JSON to become an explicitly labeled case.
	}
	return { text: value };
}
