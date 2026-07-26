import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import {
	MAX_PROMPT_SOURCE_CHARS,
	MAX_PROMPT_SOURCE_LINES,
	MAX_RENDER_ARRAY_LENGTH,
	MAX_RENDER_DATA_NODES,
	MAX_RENDER_DATA_STRING_BYTES,
	MAX_RENDER_DATA_DEPTH,
	MAX_TEMPLATE_INTERPOLATIONS,
	MAX_TEMPLATE_SECTION_NESTING,
} from "../../src/lib/prompt-limits";
import {
	PromptTemplateError,
	renderPromptTemplate,
	renderPromptTemplateWithWarnings,
	renderPromptTemplatesWithWarnings,
	validatePromptTemplate,
	validatePromptTemplates,
} from "../../src/lib/prompt-templates";

function expectBadTemplate(action: () => unknown): void {
	try {
		action();
		throw new Error("Expected PromptTemplateError");
	} catch (error) {
		expect(error).toBeInstanceOf(PromptTemplateError);
		expect((error as PromptTemplateError).status).toBe(400);
		expect((error as PromptTemplateError).code).toBe("BAD_REQUEST");
	}
}

describe("prompt templates", () => {
	it("parses every stored message without changing its source text", () => {
		const messages = [
			{ role: "system" as const, content: "Use {{topic}} exactly.\n" },
			{ role: "user" as const, content: "Tell me about {{topic}}." },
		];

		validatePromptTemplates(messages);

		expect(messages[0]?.content).toBe("Use {{topic}} exactly.\n");
		expect(messages[1]?.content).toBe("Tell me about {{topic}}.");
	});

	it("maps malformed Mustache templates to a 400 error", () => {
		expectBadTemplate(() => validatePromptTemplate("Hello {{name"));
		expectBadTemplate(() =>
			validatePromptTemplates([
				{ role: "system" as const, content: "Valid {{topic}}" },
				{ role: "user" as const, content: "Malformed {{topic" },
			]),
		);
	});

	it("rejects partials before rendering", () => {
		expectBadTemplate(() => validatePromptTemplate("Hello {{> secret}}"));
		expectBadTemplate(() => validatePromptTemplate("{{=<% %>=}}<%> secret%>"));
	});

	it("rejects dangerous tag paths", () => {
		expectBadTemplate(() => validatePromptTemplate("{{user.constructor}}"));
		expectBadTemplate(() =>
			validatePromptTemplate("{{#prototype}}unsafe{{/prototype}}"),
		);
	});

	it("renders ordinary and raw variables as plain LLM text", () => {
		expect(renderPromptTemplate("{{value}}", { value: "<&>" })).toBe("<&>");
	});

	it("renders triple-mustache and ampersand variables as explicit raw forms", () => {
		expect(
			renderPromptTemplate("{{{value}}}|{{& value}}", { value: "<&>" }),
		).toBe("<&>|<&>");
	});

	it("reports each missing root variable once and does not persist its identity escape override", () => {
		const rendered = renderPromptTemplate("{{value}}", { value: "<&>" });
		const warnings = renderPromptTemplateWithWarnings(
			"{{missing}} {{missing}} {{user.name}}",
			{ user: {} },
		);
		const mustache = createRequire(import.meta.url)("mustache") as {
			render(template: string, view: Record<string, string>): string;
		};

		expect(rendered).toBe("<&>");
		expect(warnings).toEqual({
			output: "  ",
			warnings: [
				{ code: "MISSING_VARIABLE", path: "missing" },
				{ code: "MISSING_VARIABLE", path: "user.name" },
			],
		});
		expect(mustache.render("{{value}}", { value: "<&>" })).toBe(
			"&lt;&amp;&gt;",
		);
	});

	it("renders sections and repeated array data", () => {
		const output = renderPromptTemplate(
			"{{#items}}{{name}}={{value}};{{/items}}",
			{
				items: [
					{ name: "first", value: 1 },
					{ name: "second", value: 2 },
				],
			},
		);

		expect(output).toBe("first=1;second=2;");
	});

	it("renders system and user templates separately with the same JSON data", () => {
		expect(
			renderPromptTemplatesWithWarnings(
				[
					{ role: "system", content: "You are helping {{customer.name}}." },
					{
						role: "user",
						content: "Resolve {{ticket}} for {{customer.name}}.",
					},
				],
				{ customer: { name: "Ada" }, ticket: "INC-42" },
			),
		).toEqual({
			messages: [
				{ role: "system", content: "You are helping Ada." },
				{ role: "user", content: "Resolve INC-42 for Ada." },
			],
			warnings: [],
		});
	});

	it("rejects executable values, getters, class instances, and non-JSON primitives", () => {
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", { value: () => "unsafe" }),
		);
		expectBadTemplate(() => renderPromptTemplate("{{value}}", { value: 1n }));
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", { value: Number.POSITIVE_INFINITY }),
		);
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", { value: Symbol("unsafe") }),
		);

		const getter = {} as { value?: string };
		Object.defineProperty(getter, "value", {
			enumerable: true,
			get: () => "unsafe",
		});
		expectBadTemplate(() => renderPromptTemplate("{{value}}", getter));

		class UnsafeValue {
			value = "unsafe";
		}
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", new UnsafeValue()),
		);
	});

	it("rejects cycles and dangerous data keys", () => {
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;

		expectBadTemplate(() => renderPromptTemplate("{{self}}", cycle));
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", { constructor: "unsafe" }),
		);
	});

	it("enforces compact source, nesting, and render-data execution budgets", () => {
		expectBadTemplate(() =>
			validatePromptTemplate("x".repeat(MAX_PROMPT_SOURCE_CHARS + 1)),
		);
		expectBadTemplate(() => validatePromptTemplate("{{x}}".repeat(6_553)));
		expectBadTemplate(() =>
			validatePromptTemplate(`${"x\n".repeat(MAX_PROMPT_SOURCE_LINES)}x`),
		);
		expectBadTemplate(() =>
			validatePromptTemplate(
				`${"{{#a}}".repeat(MAX_TEMPLATE_SECTION_NESTING + 1)}x${"{{/a}}".repeat(MAX_TEMPLATE_SECTION_NESTING + 1)}`,
			),
		);
		expectBadTemplate(() =>
			renderPromptTemplate("{{items}}", {
				items: Array(MAX_RENDER_ARRAY_LENGTH + 1).fill("x"),
			}),
		);
		expectBadTemplate(() =>
			renderPromptTemplate("{{value}}", {
				value: "x".repeat(MAX_RENDER_DATA_STRING_BYTES + 1),
			}),
		);
		expectBadTemplate(() =>
			renderPromptTemplate("{{x}}", { x: "x".repeat(32_767) }),
		);
		expectBadTemplate(() =>
			validatePromptTemplate(
				`{{#items}}${"{{x}}".repeat(MAX_TEMPLATE_INTERPOLATIONS)}{{/items}}`,
			),
		);

		const tooManyNodes = Object.fromEntries(
			Array.from({ length: MAX_RENDER_DATA_NODES }, (_, index) => [
				`k${index}`,
				index,
			]),
		);
		expectBadTemplate(() => renderPromptTemplate("{{k0}}", tooManyNodes));
		const tooDeep: { next?: unknown } = {};
		let cursor = tooDeep;
		for (let index = 0; index <= MAX_RENDER_DATA_DEPTH; index += 1) {
			cursor.next = {};
			cursor = cursor.next as { next?: unknown };
		}
		expectBadTemplate(() => renderPromptTemplate("{{next}}", tooDeep));
	});
});
