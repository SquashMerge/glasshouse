import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import {
  PromptTemplateError,
  renderPromptTemplate,
  renderPromptTemplateWithWarnings,
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
    expectBadTemplate(() => validatePromptTemplate("{{#prototype}}unsafe{{/prototype}}"));
  });

  it("renders ordinary and raw variables as plain LLM text", () => {
    expect(renderPromptTemplate("{{value}}", { value: "<&>" })).toBe("<&>");
  });

  it("renders triple-mustache and ampersand variables as explicit raw forms", () => {
    expect(renderPromptTemplate("{{{value}}}|{{& value}}", { value: "<&>" })).toBe("<&>|<&>");
  });

  it("reports each missing root variable once and does not persist its identity escape override", () => {
    const rendered = renderPromptTemplate("{{value}}", { value: "<&>" });
    const warnings = renderPromptTemplateWithWarnings("{{missing}} {{missing}} {{user.name}}", { user: {} });
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
    expect(mustache.render("{{value}}", { value: "<&>" })).toBe("&lt;&amp;&gt;");
  });

  it("renders sections and repeated array data", () => {
    const output = renderPromptTemplate("{{#items}}{{name}}={{value}};{{/items}}", {
      items: [
        { name: "first", value: 1 },
        { name: "second", value: 2 },
      ],
    });

    expect(output).toBe("first=1;second=2;");
  });

  it("rejects executable values, getters, class instances, and non-JSON primitives", () => {
    expectBadTemplate(() => renderPromptTemplate("{{value}}", { value: () => "unsafe" }));
    expectBadTemplate(() => renderPromptTemplate("{{value}}", { value: 1n }));
    expectBadTemplate(() => renderPromptTemplate("{{value}}", { value: Number.POSITIVE_INFINITY }));
    expectBadTemplate(() => renderPromptTemplate("{{value}}", { value: Symbol("unsafe") }));

    const getter = {} as { value?: string };
    Object.defineProperty(getter, "value", { enumerable: true, get: () => "unsafe" });
    expectBadTemplate(() => renderPromptTemplate("{{value}}", getter));

    class UnsafeValue {
      value = "unsafe";
    }
    expectBadTemplate(() => renderPromptTemplate("{{value}}", new UnsafeValue()));
  });

  it("rejects cycles and dangerous data keys", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    expectBadTemplate(() => renderPromptTemplate("{{self}}", cycle));
    expectBadTemplate(() => renderPromptTemplate("{{value}}", { constructor: "unsafe" }));
  });
});
