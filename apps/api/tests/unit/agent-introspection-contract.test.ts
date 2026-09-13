import { describe, expect, it } from "bun:test";
import completeSuccess from "../fixtures/agent-introspection/valid-complete-success.json";
import partial from "../fixtures/agent-introspection/valid-partial.json";
import failed from "../fixtures/agent-introspection/valid-failed.json";
import cancelled from "../fixtures/agent-introspection/valid-cancelled.json";
import secondFramework from "../fixtures/agent-introspection/valid-second-framework.json";
import invalidSecurity from "../fixtures/agent-introspection/invalid-security.json";
import {
	AgentIntrospectionReportV1,
	canonicalAgentIntrospectionJson,
	canonicalAgentIntrospectionRequestHash,
} from "../../src/schemas/agent-introspection";

const identity = {
	organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	actor_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
	task_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
	invocation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
const compactJws =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJpZGVudGlmaWVyIn0.c2lnbmF0dXJl";

function reportAtNormalizedSize(bytes: number) {
	const sized = structuredClone(partial) as any;
	sized.capabilities[1] = {
		capability: "model_calls",
		support: "supported",
		reason: null,
	};
	sized.capabilities[9] = {
		capability: "content_references",
		support: "supported",
		reason: null,
	};
	sized.events = [
		sized.events[0],
		...Array.from({ length: 127 }, (_, index) => ({
			event_id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			sequence: index + 1,
			occurred_at: "2026-09-12T00:00:01.000Z",
			type: "model.started",
			operation_id: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			parent_event_id: sized.events[0].event_id,
			trace: { trace_id: null, span_id: null },
			references: Array.from({ length: 8 }, () => ({
				kind: "input",
				source: "prompt_version",
				id: "a@1",
				sha256: null,
				byte_count: null,
				redacted: true,
			})),
			detail: { provider: "fixture", model: "fixture-model", attempt: 1 },
		})),
	];
	let remaining =
		bytes - Buffer.byteLength(canonicalAgentIntrospectionJson(sized));
	for (const event of sized.events.slice(1))
		for (const reference of event.references) {
			const eventCapacity =
				4096 - Buffer.byteLength(canonicalAgentIntrospectionJson(event));
			const increase = Math.min(253, eventCapacity, remaining);
			reference.id = `a@${"9".repeat(reference.id.length - 2 + increase)}`;
			remaining -= increase;
		}
	expect(remaining).toBe(0);
	expect(Buffer.byteLength(canonicalAgentIntrospectionJson(sized))).toBe(bytes);
	return sized;
}

function eventAtNormalizedSize(bytes: number) {
	const event = structuredClone(completeSuccess.events[1]) as any;
	event.type = "model.completed";
	event.trace = {
		trace_id: "a".repeat(32),
		span_id: "b".repeat(16),
	};
	event.detail = {
		provider: "p".repeat(200),
		model: "m".repeat(200),
		attempt: 1,
		duration_ms: 0,
		input_tokens: 0,
		output_tokens: 0,
		cost_usd: 0,
	};
	event.references = Array.from({ length: 8 }, () => ({
		kind: "input",
		source: "prompt_version",
		id: "a@1",
		sha256: "a".repeat(64),
		byte_count: 0,
		redacted: true,
	}));
	let remaining =
		bytes - Buffer.byteLength(canonicalAgentIntrospectionJson(event));
	for (const reference of event.references) {
		const increase = Math.min(253, remaining);
		reference.id = `a@${"9".repeat(reference.id.length - 2 + increase)}`;
		remaining -= increase;
	}
	expect(remaining).toBe(0);
	expect(Buffer.byteLength(canonicalAgentIntrospectionJson(event))).toBe(bytes);
	return event;
}

describe("agent-introspection.v1 contract", () => {
	it("accepts strict normalized framework-neutral complete and partial reports", () => {
		expect(AgentIntrospectionReportV1.safeParse(completeSuccess).success).toBe(
			true,
		);
		expect(AgentIntrospectionReportV1.safeParse(partial).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(failed).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(cancelled).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(secondFramework).success).toBe(
			true,
		);
	});

	it("rejects unsafe and arbitrary report content", () => {
		expect(AgentIntrospectionReportV1.safeParse(invalidSecurity).success).toBe(
			false,
		);
		expect(
			AgentIntrospectionReportV1.safeParse({
				...completeSuccess,
				prompt: "secret",
			}).success,
		).toBe(false);
	});

	it("rejects transport and credential syntax in identifier leaves", () => {
		const unsafeAdapter = structuredClone(completeSuccess);
		unsafeAdapter.adapter.name = "https://private.example/token";
		expect(AgentIntrospectionReportV1.safeParse(unsafeAdapter).success).toBe(
			false,
		);
		for (const value of [
			"Bearer secret-token",
			"OPENAI_API_KEY=secret",
			"sk-secret-token",
			"model-api_key-secret",
			"AIza-not-a-real-google-key",
			"glpat-not-a-real-gitlab-token",
			"hf_not_a_real_hugging_face_token",
			"github_pat_not_a_real_token",
		]) {
			const unsafeModel = structuredClone(completeSuccess);
			unsafeModel.events[1].detail.model = value;
			expect(
				AgentIntrospectionReportV1.safeParse(unsafeModel).success,
				value,
			).toBe(false);
		}
	});

	it("rejects compact JWS syntax without rejecting ordinary dotted identifiers", () => {
		const ordinary = structuredClone(completeSuccess);
		ordinary.adapter.name = "release.2026_09-rc1";
		expect(AgentIntrospectionReportV1.safeParse(ordinary).success).toBe(true);

		const leaves: Array<[string, (value: any) => void]> = [
			["adapter name", (value) => (value.adapter.name = compactJws)],
			["adapter version", (value) => (value.adapter.version = compactJws)],
			["adapter framework", (value) => (value.adapter.framework = compactJws)],
			[
				"adapter framework version",
				(value) => (value.adapter.framework_version = compactJws),
			],
			["agent key", (value) => (value.events[0].detail.agent_key = compactJws)],
			[
				"model provider",
				(value) => (value.events[1].detail.provider = compactJws),
			],
			["model", (value) => (value.events[1].detail.model = compactJws)],
			[
				"tool",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "tool.started",
						detail: { tool: compactJws, attempt: 1 },
					};
				},
			],
			[
				"workflow",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "workflow.started",
						detail: { workflow: compactJws },
					};
				},
			],
			[
				"team",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "team.started",
						detail: { team: compactJws },
					};
				},
			],
			[
				"handoff source",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "handoff",
						detail: {
							from_agent_key: compactJws,
							to_agent_key: "fixture-agent",
							reason_code: "delegated",
						},
					};
				},
			],
			[
				"handoff destination",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "handoff",
						detail: {
							from_agent_key: "fixture-agent",
							to_agent_key: compactJws,
							reason_code: "delegated",
						},
					};
				},
			],
		];
		for (const [name, mutate] of leaves) {
			const unsafe = structuredClone(completeSuccess) as any;
			mutate(unsafe);
			expect(AgentIntrospectionReportV1.safeParse(unsafe).success, name).toBe(
				false,
			);
		}
	});

	it("enforces report lifecycle and capability consistency", () => {
		const mismatch = structuredClone(completeSuccess);
		mismatch.outcome = "failed";
		expect(AgentIntrospectionReportV1.safeParse(mismatch).success).toBe(false);
		const unsupported = structuredClone(completeSuccess);
		unsupported.capabilities[1] = {
			capability: "model_calls",
			support: "unsupported",
			reason: "adapter_unsupported",
		};
		expect(AgentIntrospectionReportV1.safeParse(unsupported).success).toBe(
			false,
		);
	});

	it("requires one matching root terminal for known outcomes", () => {
		const duplicateRoot = structuredClone(completeSuccess);
		duplicateRoot.events[1] = {
			...duplicateRoot.events[1],
			type: "agent.started",
			operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			parent_event_id: null,
			detail: { agent_key: "second-agent", version_fingerprint: null },
		};
		expect(AgentIntrospectionReportV1.safeParse(duplicateRoot).success).toBe(
			false,
		);

		const childTerminal = structuredClone(completeSuccess);
		childTerminal.events[3].parent_event_id = childTerminal.events[0].event_id;
		expect(AgentIntrospectionReportV1.safeParse(childTerminal).success).toBe(
			false,
		);

		const changedRootKey = structuredClone(completeSuccess);
		changedRootKey.events[3].detail.agent_key = "different-agent";
		expect(AgentIntrospectionReportV1.safeParse(changedRootKey).success).toBe(
			false,
		);
	});

	it("requires one root start even for incomplete unknown reports", () => {
		const missingRoot = structuredClone(partial) as any;
		missingRoot.events = [];
		expect(AgentIntrospectionReportV1.safeParse(missingRoot).success).toBe(
			false,
		);
	});

	it("enforces every lifecycle rule with one mutation from a valid report", () => {
		const mutations: Array<[string, (value: any) => void]> = [
			["known outcome mismatch", (value) => (value.outcome = "failed")],
			["sequence gap", (value) => (value.events[1].sequence = 4)],
			[
				"duplicate event ID",
				(value) => (value.events[1].event_id = value.events[0].event_id),
			],
			[
				"parent not yet observed",
				(value) =>
					(value.events[1].parent_event_id =
						"99999999-9999-4999-8999-999999999999"),
			],
			[
				"future stream operation",
				(value) => {
					value.events[1] = {
						...value.events[1],
						type: "stream.summary",
						detail: {
							streamed_operation_id: "99999999-9999-4999-8999-999999999999",
							chunk_count: 1,
							byte_count: 1,
							duration_ms: 1,
						},
					};
				},
			],
			[
				"retry without increasing attempt",
				(value) => {
					value.events[2] = {
						...value.events[2],
						type: "retry",
						detail: {
							retried_operation_id: value.events[1].operation_id,
							next_attempt: 1,
							classification: "timeout",
						},
					};
				},
			],
			[
				"too many events",
				(value) => (value.events = Array(257).fill(value.events[0])),
			],
			[
				"too many references",
				(value) =>
					(value.events[1].references = Array(9).fill(
						value.events[1].references[0],
					)),
			],
			[
				"root terminal cardinality",
				(value) => {
					value.events[2] = {
						...value.events[3],
						event_id: "99999999-9999-4999-8999-999999999999",
						sequence: 2,
					};
				},
			],
			[
				"unknown outcome with root terminal",
				(value) => {
					value.outcome = "unknown";
					value.completeness = "partial";
					value.omissions = ["flush_timeout"];
				},
			],
			[
				"forbidden field",
				(value) => (value.events[1].detail.prompt = "secret"),
			],
		];
		for (const [name, mutate] of mutations) {
			const invalid = structuredClone(completeSuccess) as any;
			mutate(invalid);
			expect(AgentIntrospectionReportV1.safeParse(invalid).success, name).toBe(
				false,
			);
		}
	});

	it("requires operation references to precede their event", () => {
		const selfStream = structuredClone(completeSuccess) as any;
		selfStream.events[1] = {
			...selfStream.events[1],
			type: "stream.summary",
			detail: {
				streamed_operation_id: selfStream.events[1].operation_id,
				chunk_count: 1,
				byte_count: 1,
				duration_ms: 1,
			},
		};
		expect(AgentIntrospectionReportV1.safeParse(selfStream).success).toBe(
			false,
		);

		const selfRetry = structuredClone(completeSuccess) as any;
		selfRetry.events[1] = {
			...selfRetry.events[1],
			type: "retry",
			detail: {
				retried_operation_id: selfRetry.events[1].operation_id,
				next_attempt: 2,
				classification: "timeout",
			},
		};
		expect(AgentIntrospectionReportV1.safeParse(selfRetry).success).toBe(false);

		const selfError = structuredClone(completeSuccess) as any;
		selfError.events[1] = {
			...selfError.events[1],
			type: "error",
			detail: {
				source: "model",
				classification: "timeout",
				retryable: true,
				affected_operation_id: selfError.events[1].operation_id,
			},
		};
		expect(AgentIntrospectionReportV1.safeParse(selfError).success).toBe(false);
	});

	it("advances a retried operation attempt", () => {
		const retryEnding = structuredClone(partial) as any;
		retryEnding.capabilities[1] = {
			capability: "model_calls",
			support: "supported",
			reason: null,
		};
		retryEnding.capabilities[6] = {
			capability: "retries",
			support: "supported",
			reason: null,
		};
		retryEnding.events.push(
			{
				event_id: "22222222-2222-4222-8222-222222222222",
				sequence: 1,
				occurred_at: "2026-09-12T00:00:01.000Z",
				type: "model.started",
				operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				parent_event_id: retryEnding.events[0].event_id,
				trace: { trace_id: null, span_id: null },
				references: [],
				detail: { provider: "fixture", model: "fixture-model", attempt: 1 },
			},
			{
				event_id: "33333333-3333-4333-8333-333333333333",
				sequence: 2,
				occurred_at: "2026-09-12T00:00:02.000Z",
				type: "retry",
				operation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				parent_event_id: retryEnding.events[0].event_id,
				trace: { trace_id: null, span_id: null },
				references: [],
				detail: {
					retried_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					next_attempt: 2,
					classification: "timeout",
				},
			},
		);
		expect(AgentIntrospectionReportV1.safeParse(retryEnding).success).toBe(
			true,
		);

		const repeatedRetry = structuredClone(retryEnding) as any;
		repeatedRetry.events.push({
			event_id: "44444444-4444-4444-8444-444444444444",
			sequence: 3,
			occurred_at: "2026-09-12T00:00:03.000Z",
			type: "retry",
			operation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			parent_event_id: retryEnding.events[0].event_id,
			trace: { trace_id: null, span_id: null },
			references: [],
			detail: {
				retried_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				next_attempt: 2,
				classification: "timeout",
			},
		});
		expect(AgentIntrospectionReportV1.safeParse(repeatedRetry).success).toBe(
			false,
		);
	});

	it("enforces exact canonical event and report byte boundaries", () => {
		const atEventLimit = structuredClone(completeSuccess) as any;
		atEventLimit.events[1] = eventAtNormalizedSize(4096);
		expect(AgentIntrospectionReportV1.safeParse(atEventLimit).success).toBe(
			true,
		);
		const overEventLimit = structuredClone(completeSuccess) as any;
		overEventLimit.events[1] = eventAtNormalizedSize(4097);
		expect(AgentIntrospectionReportV1.safeParse(overEventLimit).success).toBe(
			false,
		);

		expect(
			AgentIntrospectionReportV1.safeParse(reportAtNormalizedSize(262_144))
				.success,
		).toBe(true);
		expect(
			AgentIntrospectionReportV1.safeParse(reportAtNormalizedSize(262_145))
				.success,
		).toBe(false);
	});

	it("enforces cost capabilities and canonical evidence references", () => {
		const unsupportedCost = structuredClone(completeSuccess);
		unsupportedCost.capabilities[10] = {
			capability: "cost",
			support: "unsupported",
			reason: "adapter_unsupported",
		};
		expect(AgentIntrospectionReportV1.safeParse(unsupportedCost).success).toBe(
			false,
		);

		const canonicalPrompt = structuredClone(completeSuccess);
		canonicalPrompt.events[1].references = [
			{
				kind: "prompt",
				source: "prompt_version",
				id: "support-agent@2",
				sha256: null,
				byte_count: null,
				redacted: true,
			},
		];
		expect(AgentIntrospectionReportV1.safeParse(canonicalPrompt).success).toBe(
			true,
		);
		for (const id of [
			"Support-Agent@2",
			"support/agent@2",
			"support-agent@0",
			`${"a".repeat(65)}@2`,
		]) {
			const invalid = structuredClone(canonicalPrompt);
			invalid.events[1].references[0].id = id;
			expect(AgentIntrospectionReportV1.safeParse(invalid).success).toBe(false);
		}

		const observation = structuredClone(completeSuccess);
		observation.events[1].references = [
			{
				kind: "input",
				source: "observation",
				id: "0123456789abcdef",
				sha256: null,
				byte_count: null,
				redacted: true,
			},
		];
		expect(AgentIntrospectionReportV1.safeParse(observation).success).toBe(
			true,
		);
		for (const id of [
			"Bearer secret-token",
			"authorization: Basic dXNlcjpwYXNz",
			"https://example.test/observations/0123456789abcdef",
			"0123456789ABCDEF",
		]) {
			const invalid = structuredClone(observation);
			invalid.events[1].references[0].id = id;
			expect(AgentIntrospectionReportV1.safeParse(invalid).success).toBe(false);
		}
	});

	it("hashes recursively sorted object keys while preserving array order", () => {
		const reordered = JSON.parse(
			JSON.stringify(completeSuccess),
		) as typeof completeSuccess;
		reordered.adapter = {
			framework_version: reordered.adapter.framework_version,
			framework: reordered.adapter.framework,
			version: reordered.adapter.version,
			name: reordered.adapter.name,
		};
		expect(
			canonicalAgentIntrospectionRequestHash(completeSuccess, identity),
		).toBe(canonicalAgentIntrospectionRequestHash(reordered, identity));
		const changedOrder = structuredClone(completeSuccess);
		changedOrder.events.reverse();
		expect(
			canonicalAgentIntrospectionRequestHash(completeSuccess, identity),
		).not.toBe(canonicalAgentIntrospectionRequestHash(changedOrder, identity));
		const upperCaseIdentity = Object.fromEntries(
			Object.entries(identity).map(([key, value]) => [
				key,
				value.toUpperCase(),
			]),
		) as typeof identity;
		const upperCaseReport = structuredClone(completeSuccess);
		upperCaseReport.events[0].event_id =
			upperCaseReport.events[0].event_id.toUpperCase();
		expect(
			canonicalAgentIntrospectionRequestHash(completeSuccess, identity),
		).toBe(
			canonicalAgentIntrospectionRequestHash(
				upperCaseReport,
				upperCaseIdentity,
			),
		);
		const uuidShapedToken = structuredClone(completeSuccess);
		uuidShapedToken.adapter.name = "AbCdEf12-3456-4789-8AbC-dEf123456789";
		const changedTokenCase = structuredClone(uuidShapedToken);
		changedTokenCase.adapter.name = changedTokenCase.adapter.name.toLowerCase();
		expect(
			canonicalAgentIntrospectionRequestHash(uuidShapedToken, identity),
		).not.toBe(
			canonicalAgentIntrospectionRequestHash(changedTokenCase, identity),
		);
	});
});
