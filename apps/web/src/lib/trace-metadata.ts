export type MetadataState = "absent" | "malformed" | "valid";

export interface MetadataParseResult {
	state: MetadataState;
	raw: string | null;
	value: unknown;
}

export interface MetadataAttribute {
	key: string;
	value: unknown;
}

export function parseMetadata(raw: unknown): MetadataParseResult {
	if (raw === null || raw === undefined || raw === "") {
		return { state: "absent", raw: null, value: null };
	}
	if (typeof raw !== "string") {
		return { state: "malformed", raw: null, value: null };
	}

	try {
		return { state: "valid", raw, value: JSON.parse(raw) };
	} catch {
		return { state: "malformed", raw, value: null };
	}
}

export function metadataFallback(result: MetadataParseResult): string {
	if (result.state === "absent") return "No metadata supplied.";
	if (result.state === "malformed") return "Metadata could not be parsed.";
	return "";
}

export function formatMetadata(result: MetadataParseResult): string | null {
	if (result.state !== "valid") return null;
	try {
		return JSON.stringify(result.value, null, 2);
	} catch {
		return null;
	}
}

export function metadataAttributes(
	result: MetadataParseResult,
): MetadataAttribute[] {
	if (result.state !== "valid" || !Array.isArray(result.value)) return [];
	return result.value
		.flatMap((value) => {
			if (value === null || typeof value !== "object" || Array.isArray(value))
				return [];
			const attribute = value as { key?: unknown; value?: unknown };
			return typeof attribute.key === "string"
				? [{ key: attribute.key, value: attribute.value }]
				: [];
		})
		.sort((left, right) => left.key.localeCompare(right.key));
}
