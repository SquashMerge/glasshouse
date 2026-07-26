import { describe, expect, it } from "bun:test";
import { hasMatchingMustacheTokenSignature, mustacheTokenSignature } from "../../src/lib/prompt-tokens";

describe("GEPA Mustache token guard", () => {
  it("preserves variables, raw variables, and section ordering exactly", () => {
    const source = "{{#customer}}{{{name}}} {{/customer}} {{& account.id}}";
    expect(mustacheTokenSignature(source)).toEqual(["#customer", "name", "/customer", "&account.id"]);
    expect(hasMatchingMustacheTokenSignature(source, "Assist {{#customer}}{{{name}}} {{/customer}} with {{& account.id}}.")).toBe(true);
  });

  it("rejects candidates that remove, add, or reorder tokens", () => {
    expect(hasMatchingMustacheTokenSignature("Hello {{name}}", "Hello")).toBe(false);
    expect(hasMatchingMustacheTokenSignature("Hello {{name}}", "Hello {{name}} {{account}}")).toBe(false);
    expect(hasMatchingMustacheTokenSignature("{{first}} {{last}}", "{{last}} {{first}}")).toBe(false);
  });
});
