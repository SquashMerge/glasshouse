export const MAX_PROMPT_SOURCE_CHARS = 4_096;
export const MAX_PROMPT_SOURCE_LINES = 128;
export const MAX_TEMPLATE_SECTION_NESTING = 1;
export const MAX_TEMPLATE_INTERPOLATIONS = 16;
export const MAX_RENDER_OUTPUT_CHARS = 65_536;
export const MAX_RENDER_DATA_DEPTH = 4;
export const MAX_RENDER_DATA_NODES = 64;
export const MAX_RENDER_ARRAY_LENGTH = 8;
export const MAX_RENDER_DATA_STRING_BYTES = 1_024;
export const MAX_DIFF_INPUT_CHARS = 32_768;
export const MAX_DIFF_INPUT_LINES = 512;

export function hasAtMostLines(value: string, maxLines: number): boolean {
	let lines = 1;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "\n" && ++lines > maxLines) return false;
	}
	return true;
}

export function promptSourceBudgetError(value: string): string | null {
	if (value.length > MAX_PROMPT_SOURCE_CHARS) {
		return `Prompt source exceeds ${MAX_PROMPT_SOURCE_CHARS} characters`;
	}
	if (!hasAtMostLines(value, MAX_PROMPT_SOURCE_LINES)) {
		return `Prompt source exceeds ${MAX_PROMPT_SOURCE_LINES} lines`;
	}
	return null;
}

export function renderDataBudgetError(value: unknown): string | null {
	const values: Array<{ value: unknown; depth: number }> = [
		{ value, depth: 0 },
	];
	let nodes = 0;
	let stringBytes = 0;

	while (values.length > 0) {
		const current = values.pop()!;
		if (current.depth > MAX_RENDER_DATA_DEPTH)
			return `Prompt template data exceeds depth ${MAX_RENDER_DATA_DEPTH}`;
		nodes += 1;
		if (nodes > MAX_RENDER_DATA_NODES)
			return `Prompt template data exceeds ${MAX_RENDER_DATA_NODES} JSON nodes`;
		if (typeof current.value === "string") {
			stringBytes += new TextEncoder().encode(current.value).byteLength;
		} else if (Array.isArray(current.value)) {
			if (current.value.length > MAX_RENDER_ARRAY_LENGTH) {
				return `Prompt template data arrays may contain at most ${MAX_RENDER_ARRAY_LENGTH} entries`;
			}
			for (const item of current.value)
				values.push({ value: item, depth: current.depth + 1 });
		} else if (typeof current.value === "object" && current.value !== null) {
			for (const [key, item] of Object.entries(current.value)) {
				stringBytes += new TextEncoder().encode(key).byteLength;
				values.push({ value: item, depth: current.depth + 1 });
			}
		}
		if (stringBytes > MAX_RENDER_DATA_STRING_BYTES) {
			return `Prompt template data exceeds ${MAX_RENDER_DATA_STRING_BYTES} UTF-8 string bytes`;
		}
	}
	return null;
}
