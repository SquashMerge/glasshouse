import { PromptId } from "../schemas/prompts.js";

export interface OtlpAttribute {
	key: string;
	value?: unknown;
}

export interface PromptProvenance {
	id: string;
	version: number;
	content_hash: string;
}

export interface ObservationMetadata {
	schema_version: 1;
	attributes: OtlpAttribute[];
	prompt_provenance: PromptProvenance | null;
	truncated?: boolean;
}

interface StoredObservationMetadata {
	schema_version: 1;
	attributes: OtlpAttribute[];
	prompt_provenance?: PromptProvenance;
	truncated?: true;
}

const PROMPT_ATTRIBUTE_PREFIX = "glasshouse.prompt.";
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAttribute(value: unknown): value is OtlpAttribute {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		(value.value === undefined ||
			isRecord(value.value) ||
			Array.isArray(value.value))
	);
}

function attributeValue(
	attribute: OtlpAttribute | undefined,
): Record<string, unknown> | undefined {
	return isRecord(attribute?.value) ? attribute.value : undefined;
}

function isAttributeArray(value: unknown): value is OtlpAttribute[] {
	return Array.isArray(value) && value.every(isAttribute);
}

function isPromptProvenance(value: unknown): value is PromptProvenance {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.version !== "number" ||
		typeof value.content_hash !== "string"
	)
		return false;
	return (
		PromptId.safeParse(value.id).success &&
		Number.isSafeInteger(value.version) &&
		value.version > 0 &&
		CONTENT_HASH.test(value.content_hash)
	);
}

function isStoredMetadata(value: unknown): value is StoredObservationMetadata {
	return (
		isRecord(value) &&
		value.schema_version === 1 &&
		isAttributeArray(value.attributes) &&
		(value.truncated === undefined || value.truncated === true) &&
		(value.prompt_provenance === undefined ||
			isPromptProvenance(value.prompt_provenance))
	);
}

export function emptyObservationMetadata(): ObservationMetadata {
	return { schema_version: 1, attributes: [], prompt_provenance: null };
}

export function sanitizeOtlpAttributes(
	attributes: readonly OtlpAttribute[],
): OtlpAttribute[] {
	return attributes.filter(
		(attribute) => !attribute.key.startsWith(PROMPT_ATTRIBUTE_PREFIX),
	);
}

export function promptProvenanceFromAttributes(
	attributes: readonly OtlpAttribute[],
	isGeneration: boolean,
): PromptProvenance | null {
	if (!isGeneration) return null;

	const id = attributes.filter(
		(attribute) => attribute.key === "glasshouse.prompt.id",
	);
	const version = attributes.filter(
		(attribute) => attribute.key === "glasshouse.prompt.version",
	);
	const contentHash = attributes.filter(
		(attribute) => attribute.key === "glasshouse.prompt.content_hash",
	);
	if (id.length !== 1 || version.length !== 1 || contentHash.length !== 1)
		return null;

	const promptId = attributeValue(id[0])?.stringValue;
	const rawVersion = attributeValue(version[0])?.intValue;
	const hash = attributeValue(contentHash[0])?.stringValue;
	if (
		typeof promptId !== "string" ||
		!PromptId.safeParse(promptId).success ||
		typeof hash !== "string" ||
		!CONTENT_HASH.test(hash)
	)
		return null;

	const parsedVersion =
		typeof rawVersion === "number"
			? rawVersion
			: typeof rawVersion === "string" &&
					CANONICAL_POSITIVE_INTEGER.test(rawVersion)
				? Number(rawVersion)
				: NaN;
	if (!Number.isSafeInteger(parsedVersion) || parsedVersion <= 0) return null;

	return { id: promptId, version: parsedVersion, content_hash: hash };
}

export function observationMetadata(
	attributes: readonly OtlpAttribute[],
	promptProvenance: PromptProvenance | null,
	truncated = false,
): ObservationMetadata {
	return {
		schema_version: 1,
		attributes: sanitizeOtlpAttributes(attributes),
		prompt_provenance: promptProvenance,
		...(truncated ? { truncated: true } : {}),
	};
}

export function serializeObservationMetadata(
	metadata: ObservationMetadata,
): string {
	const stored: StoredObservationMetadata = {
		schema_version: 1,
		attributes: sanitizeOtlpAttributes(metadata.attributes),
	};
	if (metadata.prompt_provenance)
		stored.prompt_provenance = metadata.prompt_provenance;
	if (metadata.truncated) stored.truncated = true;
	return JSON.stringify(stored);
}

export function parseObservationMetadata(
	raw: string | null | undefined,
): ObservationMetadata {
	if (!raw) return emptyObservationMetadata();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isAttributeArray(parsed)) {
			return observationMetadata(parsed, null);
		}
		if (isStoredMetadata(parsed)) {
			return observationMetadata(
				parsed.attributes,
				parsed.prompt_provenance ?? null,
				parsed.truncated === true,
			);
		}
	} catch {
		// Invalid persisted metadata is intentionally not exposed.
	}
	return emptyObservationMetadata();
}

export function presentObservationMetadata(
	raw: string | ObservationMetadata,
	isGeneration: boolean,
): ObservationMetadata {
	const parsed =
		typeof raw === "string"
			? parseObservationMetadata(raw)
			: isAttributeArray(raw.attributes)
				? observationMetadata(
						raw.attributes,
						isPromptProvenance(raw.prompt_provenance)
							? raw.prompt_provenance
							: null,
						raw.truncated === true,
					)
				: emptyObservationMetadata();
	return isGeneration ? parsed : { ...parsed, prompt_provenance: null };
}

export function redactObservationMetadata(
	metadata: ObservationMetadata,
	redactKeys: readonly string[],
	redactedValue: string,
): ObservationMetadata {
	const attributes = sanitizeOtlpAttributes(metadata.attributes).map(
		(attribute) => {
			if (!redactKeys.includes(attribute.key)) return attribute;
			return attribute.value === undefined
				? { key: attribute.key }
				: { key: attribute.key, value: { stringValue: redactedValue } };
		},
	);
	return { ...metadata, attributes };
}

export function redactSerializedObservationMetadata(
	raw: string,
	redactKeys: readonly string[],
	redactedValue: string,
): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isAttributeArray(parsed)) {
			return serializeObservationMetadata(
				redactObservationMetadata(
					observationMetadata(parsed, null),
					redactKeys,
					redactedValue,
				),
			);
		}
		if (isStoredMetadata(parsed)) {
			return serializeObservationMetadata(
				redactObservationMetadata(
					observationMetadata(
						parsed.attributes,
						parsed.prompt_provenance ?? null,
					),
					redactKeys,
					redactedValue,
				),
			);
		}
	} catch {
		// Existing callers retain malformed data; read paths fail closed.
	}
	return raw;
}
