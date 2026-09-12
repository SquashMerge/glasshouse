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
		expect(AgentIntrospectionReportV1.safeParse(completeSuccess).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(partial).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(failed).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(cancelled).success).toBe(true);
		expect(AgentIntrospectionReportV1.safeParse(secondFramework).success).toBe(true);
	});

	it("rejects unsafe and arbitrary report content", () => {
		expect(AgentIntrospectionReportV1.safeParse(invalidSecurity).success).toBe(false);
		expect(
		AgentIntrospectionReportV1.safeParse({ ...completeSuccess, prompt: "secret" })
			.success,
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
		expect(AgentIntrospectionReportV1.safeParse(unsupported).success).toBe(false);
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
		const reordered = JSON.parse(JSON.stringify(completeSuccess)) as typeof completeSuccess;
		reordered.adapter = {
			framework_version: reordered.adapter.framework_version,
			framework: reordered.adapter.framework,
			version: reordered.adapter.version,
			name: reordered.adapter.name,
		};
		expect(canonicalAgentIntrospectionRequestHash(completeSuccess, identity)).toBe(
			canonicalAgentIntrospectionRequestHash(reordered, identity),
		);
		const changedOrder = structuredClone(completeSuccess);
		changedOrder.events.reverse();
		expect(canonicalAgentIntrospectionRequestHash(completeSuccess, identity)).not.toBe(
			canonicalAgentIntrospectionRequestHash(changedOrder, identity),
		);
	});
});
