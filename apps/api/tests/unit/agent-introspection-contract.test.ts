import { describe, expect, it } from "bun:test";
import completeSuccess from "../fixtures/agent-introspection/valid-complete-success.json";
import partial from "../fixtures/agent-introspection/valid-partial.json";
import failed from "../fixtures/agent-introspection/valid-failed.json";
import cancelled from "../fixtures/agent-introspection/valid-cancelled.json";
import secondFramework from "../fixtures/agent-introspection/valid-second-framework.json";
import invalidSecurity from "../fixtures/agent-introspection/invalid-security.json";
import {
	AgentIntrospectionReportV1,
	canonicalAgentIntrospectionRequestHash,
} from "../../src/schemas/agent-introspection";

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
		]) {
			const invalid = structuredClone(canonicalPrompt);
			invalid.events[1].references[0].id = id;
			expect(AgentIntrospectionReportV1.safeParse(invalid).success).toBe(false);
		}
	});

	it("hashes recursively sorted object keys while preserving array order", () => {
		const identity = {
			organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			actor_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			task_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			invocation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		};
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
	});
});
