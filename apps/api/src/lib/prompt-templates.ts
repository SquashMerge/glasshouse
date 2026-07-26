import { createRequire } from "node:module";
import {
	MAX_RENDER_ARRAY_LENGTH,
	MAX_RENDER_DATA_DEPTH,
	MAX_RENDER_DATA_NODES,
	MAX_RENDER_DATA_STRING_BYTES,
	MAX_RENDER_OUTPUT_CHARS,
	MAX_TEMPLATE_INTERPOLATIONS,
	MAX_TEMPLATE_SECTION_NESTING,
	promptSourceBudgetError,
} from "./prompt-limits.js";

type MustacheRuntime = {
	parse(template: string): unknown;
	render(
		template: string,
		view: unknown,
		partials: undefined,
		config?: { escape(value: string): string },
	): string;
};

const Mustache = createRequire(import.meta.url)("mustache") as MustacheRuntime;

export type PromptTemplateMessage = {
	role: "system" | "user";
	content: string;
};

export class PromptTemplateError extends Error {
	readonly code = "BAD_REQUEST";
	readonly status = 400;

	constructor(message: string) {
		super(message);
		this.name = "PromptTemplateError";
	}
}

const dangerousPathSegments = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);

type TemplateMetrics = {
	interpolations: number;
	maxSectionDepth: number;
};

function templateError(message: string): PromptTemplateError {
	return new PromptTemplateError(message);
}

function assertSafePath(path: string): void {
	const segments = path.trim().split(".");
	if (segments.some((segment) => dangerousPathSegments.has(segment.trim()))) {
		throw templateError("Prompt templates cannot access dangerous paths");
	}
}

function assertSafeTemplateTags(template: string): TemplateMetrics {
	let open = "{{";
	let close = "}}";
	let cursor = 0;
	let sectionDepth = 0;
	let maxSectionDepth = 0;
	let interpolations = 0;

	while (cursor < template.length) {
		const start = template.indexOf(open, cursor);
		if (start === -1) return { interpolations, maxSectionDepth };

		const tagStart = start + open.length;
		const triple = open === "{{" && template.startsWith("{", tagStart);
		const end = template.indexOf(
			triple ? "}}}" : close,
			tagStart + (triple ? 1 : 0),
		);
		if (end === -1) return { interpolations, maxSectionDepth };

		const raw = template.slice(tagStart + (triple ? 1 : 0), end).trim();
		cursor = end + (triple ? 3 : close.length);
		if (!raw || raw.startsWith("!")) continue;

		if (raw.startsWith(">")) {
			throw templateError("Prompt templates cannot include partials");
		}

		if (raw.startsWith("=") && raw.endsWith("=")) {
			const delimiters = raw.slice(1, -1).trim().split(/\s+/);
			if (delimiters.length === 2 && delimiters[0] && delimiters[1]) {
				open = delimiters[0];
				close = delimiters[1];
			}
			continue;
		}

		if (raw.startsWith("#") || raw.startsWith("^")) {
			sectionDepth += 1;
			maxSectionDepth = Math.max(maxSectionDepth, sectionDepth);
			if (sectionDepth > MAX_TEMPLATE_SECTION_NESTING) {
				throw templateError(
					`Prompt templates may nest at most ${MAX_TEMPLATE_SECTION_NESTING} sections`,
				);
			}
		} else if (raw.startsWith("/")) {
			sectionDepth = Math.max(sectionDepth - 1, 0);
		} else {
			interpolations += 1;
			if (interpolations > MAX_TEMPLATE_INTERPOLATIONS) {
				throw templateError(
					`Prompt templates may contain at most ${MAX_TEMPLATE_INTERPOLATIONS} interpolations`,
				);
			}
		}

		const path = raw.replace(/^[#^/&]/, "");
		if (path) assertSafePath(path);
	}
	return { interpolations, maxSectionDepth };
}

function assertRenderOutputBudget(
	template: string,
	metrics: TemplateMetrics,
): void {
	// v1 permits one array section, so every source segment and interpolation can repeat at most this multiplier.
	const multiplier = MAX_RENDER_ARRAY_LENGTH ** metrics.maxSectionDepth;
	const maxInterpolationChars =
		MAX_RENDER_DATA_STRING_BYTES + MAX_RENDER_DATA_NODES + 24;
	const upperBound =
		template.length * multiplier +
		metrics.interpolations * multiplier * maxInterpolationChars;
	if (upperBound > MAX_RENDER_OUTPUT_CHARS) {
		throw templateError(
			`Prompt render may exceed ${MAX_RENDER_OUTPUT_CHARS} characters`,
		);
	}
}

export function validatePromptTemplate(template: string): void {
	if (typeof template !== "string") {
		throw templateError("Prompt template content must be a string");
	}
	const budgetError = promptSourceBudgetError(template);
	if (budgetError) throw templateError(budgetError);

	const metrics = assertSafeTemplateTags(template);
	assertRenderOutputBudget(template, metrics);
	try {
		Mustache.parse(template);
	} catch {
		throw templateError("Prompt template is malformed");
	}
}

export function validatePromptTemplates(
	messages: readonly PromptTemplateMessage[],
): void {
	for (const message of messages) {
		validatePromptTemplate(message.content);
	}
}

type JsonCloneBudget = {
	nodes: number;
	stringBytes: number;
};

function consumeStringBudget(value: string, budget: JsonCloneBudget): void {
	budget.stringBytes += new TextEncoder().encode(value).byteLength;
	if (budget.stringBytes > MAX_RENDER_DATA_STRING_BYTES) {
		throw templateError(
			`Prompt template data exceeds ${MAX_RENDER_DATA_STRING_BYTES} UTF-8 string bytes`,
		);
	}
}

function cloneJsonValue(
	value: unknown,
	ancestors: WeakSet<object>,
	budget: JsonCloneBudget,
	depth: number,
): unknown {
	if (depth > MAX_RENDER_DATA_DEPTH) {
		throw templateError(
			`Prompt template data exceeds depth ${MAX_RENDER_DATA_DEPTH}`,
		);
	}
	budget.nodes += 1;
	if (budget.nodes > MAX_RENDER_DATA_NODES) {
		throw templateError(
			`Prompt template data exceeds ${MAX_RENDER_DATA_NODES} JSON nodes`,
		);
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		consumeStringBudget(value, budget);
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw templateError(
			"Prompt template data must contain only finite JSON numbers",
		);
	}
	if (
		typeof value === "undefined" ||
		typeof value === "bigint" ||
		typeof value === "symbol" ||
		typeof value === "function"
	) {
		throw templateError("Prompt template data must contain only JSON values");
	}

	if (typeof value !== "object") {
		throw templateError("Prompt template data must contain only JSON values");
	}
	if (ancestors.has(value)) {
		throw templateError("Prompt template data cannot contain cycles");
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_RENDER_ARRAY_LENGTH) {
				throw templateError(
					`Prompt template data arrays may contain at most ${MAX_RENDER_ARRAY_LENGTH} entries`,
				);
			}
			if (Object.getOwnPropertySymbols(value).length > 0) {
				throw templateError(
					"Prompt template data must contain only JSON values",
				);
			}
			const names = Object.getOwnPropertyNames(value);
			if (
				names.some((name) => name !== "length" && !/^(0|[1-9]\d*)$/.test(name))
			) {
				throw templateError(
					"Prompt template data must contain only JSON values",
				);
			}

			const copy: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(
					value,
					String(index),
				);
				if (!descriptor || descriptor.get || descriptor.set) {
					throw templateError(
						"Prompt template data must contain only JSON values",
					);
				}
				copy.push(
					cloneJsonValue(descriptor.value, ancestors, budget, depth + 1),
				);
			}
			Object.setPrototypeOf(copy, null);
			return copy;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw templateError(
				"Prompt template data must contain plain JSON objects",
			);
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw templateError("Prompt template data must contain only JSON values");
		}

		const copy = Object.create(null) as Record<string, unknown>;
		const names = Object.getOwnPropertyNames(value);
		if (names.length > MAX_RENDER_DATA_NODES - budget.nodes) {
			throw templateError(
				`Prompt template data exceeds ${MAX_RENDER_DATA_NODES} JSON nodes`,
			);
		}
		for (const key of names) {
			consumeStringBudget(key, budget);
			if (dangerousPathSegments.has(key)) {
				throw templateError(
					"Prompt template data cannot contain dangerous keys",
				);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				!descriptor ||
				descriptor.get ||
				descriptor.set ||
				!descriptor.enumerable
			) {
				throw templateError(
					"Prompt template data must contain only JSON values",
				);
			}
			copy[key] = cloneJsonValue(
				descriptor.value,
				ancestors,
				budget,
				depth + 1,
			);
		}
		return copy;
	} finally {
		ancestors.delete(value);
	}
}

function missingVariablePaths(template: string, view: unknown): string[] {
	const missing = new Set<string>();
	let open = "{{";
	let close = "}}";
	let cursor = 0;
	let sectionDepth = 0;

	while (cursor < template.length) {
		const start = template.indexOf(open, cursor);
		if (start === -1) break;
		const tagStart = start + open.length;
		const triple = open === "{{" && template.startsWith("{", tagStart);
		const end = template.indexOf(
			triple ? "}}}" : close,
			tagStart + (triple ? 1 : 0),
		);
		if (end === -1) break;
		const raw = template.slice(tagStart + (triple ? 1 : 0), end).trim();
		cursor = end + (triple ? 3 : close.length);
		if (!raw || raw.startsWith("!")) continue;
		if (raw.startsWith("=") && raw.endsWith("=")) {
			const delimiters = raw.slice(1, -1).trim().split(/\s+/);
			if (delimiters.length === 2 && delimiters[0] && delimiters[1]) {
				open = delimiters[0];
				close = delimiters[1];
			}
			continue;
		}
		if (raw.startsWith("#") || raw.startsWith("^")) {
			sectionDepth += 1;
			continue;
		}
		if (raw.startsWith("/")) {
			sectionDepth = Math.max(sectionDepth - 1, 0);
			continue;
		}
		const path = raw.replace(/^&\s*/, "");
		if (sectionDepth > 0 || path === ".") continue;
		let current = view;
		let found = true;
		for (const segment of path.split(".")) {
			if (
				typeof current !== "object" ||
				current === null ||
				!Object.prototype.hasOwnProperty.call(current, segment)
			) {
				found = false;
				break;
			}
			current = (current as Record<string, unknown>)[segment];
		}
		if (!found) missing.add(path);
	}
	return [...missing];
}

export function renderPromptTemplateWithWarnings(
	template: string,
	data: unknown,
): { output: string; warnings: { code: "MISSING_VARIABLE"; path: string }[] } {
	validatePromptTemplate(template);
	const safeView = cloneJsonValue(
		data,
		new WeakSet<object>(),
		{ nodes: 0, stringBytes: 0 },
		0,
	);
	return {
		output: Mustache.render(template, safeView, undefined, {
			escape: (value) => value,
		}),
		warnings: missingVariablePaths(template, safeView).map((path) => ({
			code: "MISSING_VARIABLE",
			path,
		})),
	};
}

export function renderPromptTemplate(template: string, data: unknown): string {
	return renderPromptTemplateWithWarnings(template, data).output;
}

export function renderPromptTemplatesWithWarnings(
	templates: readonly PromptTemplateMessage[],
	data: unknown,
): {
	messages: PromptTemplateMessage[];
	warnings: {
		code: "MISSING_VARIABLE";
		role: PromptTemplateMessage["role"];
		path: string;
	}[];
} {
	const rendered = templates.map((message) => {
		const result = renderPromptTemplateWithWarnings(message.content, data);
		return {
			message: { role: message.role, content: result.output },
			warnings: result.warnings,
		};
	});
	return {
		messages: rendered.map(({ message }) => message),
		warnings: rendered.flatMap(({ message, warnings }) =>
			warnings.map((warning) => ({ ...warning, role: message.role })),
		),
	};
}
