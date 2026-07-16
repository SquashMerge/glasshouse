import { describe, it, expect } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";

const HEX = (n: number) => "0".repeat(n);

describe("normalizeSpan", () => {
	it("extracts gen_ai.system and gen_ai.response.model into the model field", () => {
		const { trace, observation } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "llm-call",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			end_time_unix_nano: 1_700_000_000_050_000_000,
			attributes: [
				{ key: "gen_ai.system", value: { stringValue: "openai" } },
				{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
				{ key: "gen_ai.response.model", value: { stringValue: "gpt-4o" } },
			],
		} as never);
		expect(trace.name).toBe("llm-call");
		expect(observation.model).toBe("gpt-4o");
	});

	it("falls back to OpenInference when gen_ai.* is absent", () => {
		const { trace, observation } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "llm-call",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [
				{ key: "openinference.span.kind", value: { stringValue: "LLM" } },
				{ key: "llm.system", value: { stringValue: "anthropic" } },
				{ key: "llm.model_name", value: { stringValue: "claude-3-5-sonnet" } },
				{ key: "llm.token_count.prompt", value: { intValue: 100 } },
				{ key: "llm.token_count.completion", value: { intValue: 50 } },
				{ key: "input.value", value: { stringValue: "Hello world" } },
				{ key: "output.value", value: { stringValue: "Hi!" } },
			],
		} as never);
		expect(trace.env).toBe("production");
		expect(observation.model).toBe("claude-3-5-sonnet");
		expect(trace.scores_summary).toBe("input_tokens:100,output_tokens:50");
		expect(trace.input_text).toBe("Hello world");
		expect(trace.output_text).toBe("Hi!");
		expect(trace.tags).toContain("openinference.span.kind:LLM");
	});

	it("prefers gen_ai.* over OpenInference when both are present (R2)", () => {
		const { trace, observation } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "llm-call",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [
				{ key: "gen_ai.response.model", value: { stringValue: "gpt-4o" } },
				{ key: "llm.model_name", value: { stringValue: "claude-3-5-sonnet" } },
				{ key: "gen_ai.usage.input_tokens", value: { intValue: 100 } },
				{ key: "llm.token_count.prompt", value: { intValue: 999 } },
			],
		} as never);
		expect(observation.model).toBe("gpt-4o");
		expect(trace.scores_summary).toBe("input_tokens:100");
	});

	it("sets status to 'error' when OTLP status.code is 2", () => {
		const { trace, observation } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "failed-call",
			start_time_unix_nano: 1,
			status: { code: 2, message: "boom" },
			attributes: [],
		} as never);
		expect(trace.status).toBe("error");
		expect(observation.status).toBe("error");
	});

	it("sets status to 'error' when exception.type attribute is present", () => {
		const { trace } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "threw",
			start_time_unix_nano: 1,
			attributes: [
				{ key: "exception.type", value: { stringValue: "ValueError" } },
			],
		} as never);
		expect(trace.status).toBe("error");
	});

	it("computes duration_ms from start and end times", () => {
		const { trace } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "x",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			end_time_unix_nano: 1_700_000_000_250_000_000, // +250ms
			attributes: [],
		} as never);
		expect(trace.duration_ms).toBe(250);
	});

	it("returns null end_time and null duration_ms for in-flight spans", () => {
		const { trace } = normalizeSpan({
			trace_id: HEX(32),
			span_id: HEX(16),
			name: "x",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [],
		} as never);
		expect(trace.end_time).toBeNull();
		expect(trace.duration_ms).toBeNull();
	});

	it("populates parent_observation_id from parent_span_id and NULL for root spans", () => {
		const a = normalizeSpan({
			trace_id: HEX(32),
			span_id: "aaaa".repeat(4),
			name: "root",
			start_time_unix_nano: 1,
			attributes: [],
		} as never);
		const b = normalizeSpan({
			trace_id: HEX(32),
			span_id: "bbbb".repeat(4),
			parent_span_id: "aaaa".repeat(4),
			name: "child",
			start_time_unix_nano: 1,
			attributes: [],
		} as never);
		expect(a.observation.parent_observation_id).toBeNull();
		expect(b.observation.parent_observation_id).toBe("aaaaaaaaaaaaaaaa");
	});
});
