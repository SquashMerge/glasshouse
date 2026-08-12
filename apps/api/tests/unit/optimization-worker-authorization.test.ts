import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
	resolve(import.meta.dir, "../../src/db/prompt-optimizations.ts"),
	"utf8",
);

test("rechecks the requesting actor's effective execution access before worker claim and every persistence transition", () => {
	expect(source).toContain("lockOptimizationExecution");
	expect(source).toContain("lockActiveAuthorizedProject");
	expect(source).toContain('operation: "execute"');
	for (const functionName of [
		"claimOptimizationJob",
		"renewOptimizationJobLease",
		"recordOptimizationMetricCalls",
		"transitionOptimizationJob",
		"completeOptimizationResult",
		"publishOptimizationResult",
	]) {
		const start = source.indexOf(`export async function ${functionName}`);
		const next = source.indexOf("export async function", start + 1);
		expect(source.slice(start, next === -1 ? undefined : next)).toContain(
			"lockOptimizationExecution",
		);
	}
});

test("commits a bounded requester admission before provider invocation", () => {
	expect(source).toContain("admitOptimizationExecution");
	expect(source).toContain("createExecutionAdmission");
	expect(source).toContain("status = 'optimizing'");
	expect(source).not.toContain("value: await invoke()");
});
