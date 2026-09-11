import { describe, expect, it } from "bun:test";
import { claimExecutionAdmission } from "../../src/db/execution-admissions";
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
				return { status: "unavailable" };
			},
			cancel: async () => {
				cancellations += 1;
			},
			invoke: async () => {
				providerCalls += 1;
				return "must not run";
			},
		} as never);

		expect(result).toEqual({ admitted: false, reason: "unavailable" });
		expect(claims).toBe(1);
		expect(providerCalls).toBe(0);
		expect(cancellations).toBe(1);
	});

	it("claims a caller-stable effect key as created rather than an anonymous insert", async () => {
		const calls: Array<{ statement: string; values: unknown[] }> = [];
		const client = {
			query: async (statement: string, values: unknown[]) => {
				calls.push({ statement, values });
				return { rows: [{ created: true }] };
			},
		};

		await expect(
			claimExecutionAdmission(
				client as never,
				{
					id: "11111111-1111-4111-8111-111111111111",
					project_id: "22222222-2222-4222-8222-222222222222",
					effect: "provider_dispatch",
					effect_key: "provider",
				} as never,
			),
		).resolves.toEqual({ status: "created" });
		expect(calls[0]?.statement).toContain("effect_key");
		expect(calls[0]?.values).toContain("provider");
	});

	it("does not repeat an external dispatch when a committed claim is replayed", async () => {
		let claimAttempts = 0;
		let dispatches = 0;
		const claimDispatch = async () => {
			claimAttempts += 1;
			return (
				claimAttempts === 1 ? { status: "created" } : { status: "existing" }
			) as never;
		};
		const invoke = async () => {
			dispatches += 1;
			return "provider response";
		};

		await invokeWithExecutionAdmission({
			isActive: async () => true,
			claimDispatch,
			cancel: async () => {},
			invoke,
		} as never);
		await invokeWithExecutionAdmission({
			isActive: async () => true,
			claimDispatch,
			cancel: async () => {},
			invoke,
		} as never);

		expect(dispatches).toBe(1);
	});

	it("reports a prior durable dispatch as unknown without invoking it again", async () => {
		let providerCalls = 0;
		const result = await invokeWithExecutionAdmission({
			isActive: async () => true,
			claimDispatch: async () => ({ status: "existing" }),
			cancel: async () => {},
			invoke: async () => {
				providerCalls += 1;
				return "must not run";
			},
		} as never);

		expect(result).toEqual({ admitted: false, reason: "existing" });
		expect(providerCalls).toBe(0);
	});

	it("distinguishes an admission deadline from authorization unavailability", async () => {
		const result = await invokeWithExecutionAdmission({
			isActive: async () => true,
			claimDispatch: async () => ({ status: "created" }),
			cancel: async () => {},
			invoke: async () =>
				await new Promise<never>(() => {
					// The admission deadline must end an in-flight provider call.
				}),
			timeoutMs: 1,
			pollMs: 1_000,
		} as never);

		expect(result).toEqual({ admitted: false, reason: "timeout" });
	});
});
