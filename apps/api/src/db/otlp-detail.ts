import { boundText, utf8ByteLength } from "./trace-payload-bounds.js";

export const MAX_OTLP_DETAIL_BYTES = 32_768;
export const MAX_OTLP_REQUEST_DETAIL_BYTES = 8 * 1024 * 1024;
export interface OtlpDetail extends Record<string, unknown> {
	schema_version: 1;
	truncated?: boolean;
}

export function boundOtlpDetail(
	source: Record<string, unknown>,
	maxBytes = MAX_OTLP_DETAIL_BYTES,
): OtlpDetail {
	const state = {
		bytes: Math.max(0, maxBytes - 128),
		nodes: 4096,
		truncated: false,
	};
	function visit(value: unknown, depth: number): unknown {
		if (value === undefined) return undefined;
		if (depth > 32 || state.nodes-- <= 0 || state.bytes <= 0) {
			state.truncated = true;
			return undefined;
		}
		if (value === null || typeof value !== "object") {
			const bounded =
				typeof value === "string"
					? boundText(value)
					: { value, truncated: false };
			state.truncated ||= bounded.truncated;
			const bytes = utf8ByteLength(JSON.stringify(bounded.value)) + 1;
			if (bytes > state.bytes) {
				state.truncated = true;
				return undefined;
			}
			state.bytes -= bytes;
			return bounded.value;
		}
		state.bytes -= 2;
		if (Array.isArray(value)) {
			const output: unknown[] = [];
			for (const entry of value) {
				const next = visit(entry, depth + 1);
				if (next === undefined) {
					state.truncated = true;
					break;
				}
				output.push(next);
			}
			return output;
		}
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) continue;
			state.bytes -= utf8ByteLength(JSON.stringify(key)) + 2;
			const next = visit(entry, depth + 1);
			if (next !== undefined) output[key] = next;
		}
		return output;
	}
	const detail = visit(source, 0) as Record<string, unknown> | undefined;
	return {
		...detail,
		schema_version: 1,
		...(state.truncated ? { truncated: true } : {}),
	};
}

export function parseOtlpDetail(value: unknown): OtlpDetail | null {
	if (typeof value !== "string" || !value) return null;
	if (utf8ByteLength(value) > MAX_OTLP_DETAIL_BYTES)
		return { schema_version: 1, truncated: true };
	try {
		const parsed = JSON.parse(value);
		return parsed?.schema_version === 1 ? boundOtlpDetail(parsed) : null;
	} catch {
		return { schema_version: 1, truncated: true };
	}
}
