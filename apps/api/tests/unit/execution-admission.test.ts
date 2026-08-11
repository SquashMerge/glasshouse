import { describe, expect, it } from "bun:test";
import { invokeWithExecutionAdmission } from "../../src/lib/execution-admission";

describe("execution admission dispatch", () => {
	it("does not invoke a provider when revocation wins between validation and dispatch claim", async () => {
		let validations = 0;
		let claims = 0;
		let providerCalls = 0;
		let cancellations = 0;

		const result = await invokeWithExecutionAdmission({
			isActive: async () => validations++ === 0,
			claimDispatch: async () => {
				claims += 1;
				return false;
			},
			cancel: async () => {
				cancellations += 1;
			},
			invoke: async () => {
				providerCalls += 1;
				return "must not run";
			},
		} as never);

		expect(result).toEqual({ admitted: false });
		expect(claims).toBe(1);
		expect(providerCalls).toBe(0);
		expect(cancellations).toBe(1);
	});
});
