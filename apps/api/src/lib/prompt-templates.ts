import { createRequire } from "node:module";

type MustacheRuntime = {
  parse(template: string): unknown;
  render(template: string, view: unknown, partials: undefined): string;
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

const dangerousPathSegments = new Set(["__proto__", "prototype", "constructor"]);

function templateError(message: string): PromptTemplateError {
  return new PromptTemplateError(message);
}

function assertSafePath(path: string): void {
  const segments = path.trim().split(".");
  if (segments.some((segment) => dangerousPathSegments.has(segment.trim()))) {
    throw templateError("Prompt templates cannot access dangerous paths");
  }
}

function assertSafeTemplateTags(template: string): void {
  let open = "{{";
  let close = "}}";
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf(open, cursor);
    if (start === -1) return;

    const tagStart = start + open.length;
    const triple = open === "{{" && template.startsWith("{", tagStart);
    const end = template.indexOf(triple ? "}}}" : close, tagStart + (triple ? 1 : 0));
    if (end === -1) return;

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

    const path = raw.replace(/^[#^/&]/, "");
    if (path) assertSafePath(path);
  }
}

export function validatePromptTemplate(template: string): void {
  if (typeof template !== "string") {
    throw templateError("Prompt template content must be a string");
  }

  assertSafeTemplateTags(template);
  try {
    Mustache.parse(template);
  } catch {
    throw templateError("Prompt template is malformed");
  }
}

export function validatePromptTemplates(messages: readonly PromptTemplateMessage[]): void {
  for (const message of messages) {
    validatePromptTemplate(message.content);
  }
}

function cloneJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw templateError("Prompt template data must contain only finite JSON numbers");
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
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw templateError("Prompt template data must contain only JSON values");
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.some((name) => name !== "length" && !/^(0|[1-9]\d*)$/.test(name))) {
        throw templateError("Prompt template data must contain only JSON values");
      }

      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw templateError("Prompt template data must contain only JSON values");
        }
        copy.push(cloneJsonValue(descriptor.value, ancestors));
      }
      Object.setPrototypeOf(copy, null);
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw templateError("Prompt template data must contain plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw templateError("Prompt template data must contain only JSON values");
    }

    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (dangerousPathSegments.has(key)) {
        throw templateError("Prompt template data cannot contain dangerous keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw templateError("Prompt template data must contain only JSON values");
      }
      copy[key] = cloneJsonValue(descriptor.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

export function renderPromptTemplate(template: string, data: unknown): string {
  validatePromptTemplate(template);
  const safeView = cloneJsonValue(data, new WeakSet<object>());
  return Mustache.render(template, safeView, undefined);
}
