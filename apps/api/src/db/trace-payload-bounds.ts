import type {
	ObservationMetadata,
	OtlpAttribute,
} from "./observation-metadata.js";
import { serializeObservationMetadata } from "./observation-metadata.js";

export const MAX_RETAINED_TEXT_BYTES = 8 * 1024;
export const MAX_RETAINED_METADATA_BYTES = 16 * 1024;
export const MAX_RETAINED_METADATA_DEPTH = 8;
export const MAX_RETAINED_METADATA_VALUES = 256;
export const MAX_TRACE_RESPONSE_BYTES = 256 * 1024;
export const MAX_LIST_TEXT_CODEPOINTS = 200;
export const MAX_LIST_METADATA_BYTES = 2 * 1024;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

export function boundText(
	value: string,
	maxBytes = MAX_RETAINED_TEXT_BYTES,
): { value: string; truncated: boolean } {
	if (utf8ByteLength(value) <= maxBytes) return { value, truncated: false };
	let bytes = 0;
	let bounded = "";
	for (const character of value) {
		const characterBytes = utf8ByteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		bounded += character;
		bytes += characterBytes;
	}
	return { value: bounded, truncated: true };
}

export function boundListExcerpt(value: string): {
	value: string;
	truncated: boolean;
} {
	let excerpt = "";
	let length = 0;
	for (const codePoint of value) {
		if (length === MAX_LIST_TEXT_CODEPOINTS)
			return { value: excerpt, truncated: true };
		excerpt += codePoint;
		length += 1;
	}
	return { value: excerpt, truncated: false };
}

function boundValue(
	value: unknown,
	state: { truncated: boolean; remaining: number },
	depth = 0,
): unknown {
	if (typeof value === "string") {
		const bounded = boundText(value);
		state.truncated ||= bounded.truncated;
		return bounded.value;
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_RETAINED_METADATA_DEPTH || state.remaining <= 0) {
		state.truncated = true;
		return undefined;
	}
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const entry of value) {
			if (state.remaining-- <= 0) {
				state.truncated = true;
				break;
			}
			out.push(boundValue(entry, state, depth + 1));
		}
		return out;
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (state.remaining-- <= 0) {
			state.truncated = true;
			break;
		}
		out[boundText(key).value] = boundValue(entry, state, depth + 1);
	}
	return out;
}

export function boundObservationMetadata(
	metadata: ObservationMetadata,
): ObservationMetadata {
	const state = {
		truncated: metadata.truncated === true,
		remaining: MAX_RETAINED_METADATA_VALUES,
	};
	const attributes: OtlpAttribute[] = [];
	for (const attribute of metadata.attributes) {
		const candidate: OtlpAttribute = {
			key: boundText(attribute.key).value,
			...(attribute.value === undefined
				? {}
				: { value: boundValue(attribute.value, state) }),
		};
		const next: ObservationMetadata = {
			schema_version: 1 as const,
			attributes: [...attributes, candidate],
			prompt_provenance: metadata.prompt_provenance,
		};
		if (
			utf8ByteLength(serializeObservationMetadata(next)) >
			MAX_RETAINED_METADATA_BYTES
		) {
			state.truncated = true;
			break;
		}
		attributes.push(candidate);
	}
	let bounded: ObservationMetadata = {
		schema_version: 1,
		attributes,
		prompt_provenance: metadata.prompt_provenance,
		...(state.truncated ? { truncated: true } : {}),
	};
	while (
		utf8ByteLength(serializeObservationMetadata(bounded)) >
			MAX_RETAINED_METADATA_BYTES &&
		bounded.attributes.length > 0
	) {
		bounded = { ...bounded, attributes: bounded.attributes.slice(0, -1) };
	}
	return bounded;
}

export function fitResponseItems<T>(
	items: readonly T[],
	build: (items: readonly T[]) => unknown,
	maxBytes = MAX_TRACE_RESPONSE_BYTES,
): { items: T[]; truncated: boolean } {
	const accepted: T[] = [];
	for (const item of items) {
		const next = [...accepted, item];
		if (utf8ByteLength(JSON.stringify(build(next))) > maxBytes) break;
		accepted.push(item);
	}
	return { items: accepted, truncated: accepted.length < items.length };
}
