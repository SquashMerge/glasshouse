import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	executeEvaluationRun,
	executeExperiment,
	type ExperimentDependencies,
} from "../../src/routes/experiments";
import { LlmProviderError } from "../../src/lib/llm";

const projectId = "11111111-1111-4111-8111-111111111111";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0083_durable_evaluation_run_execution.sql",
	),
	"utf8",
);

describe("durable Evaluation Run execution", () => {
	it("charges a provider call only after the dispatch effect is admitted", async () => {
		const events: string[] = [];
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-existing-dispatch",
					dataset_item_id: "item-existing-dispatch",
					attempt_count: 1,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "bounded" },
					expected_output: { value: "answer" },
				};
			},
			reserveProviderCall: async () => {
				events.push("charge");
				return { reserved: true as const, used: 1, limit: 1 };
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => {
				events.push("dispatch");
				return { status: "existing" as const };
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => true,
			finalizeTask: async () => true,
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				throw new Error("must not invoke an existing dispatch");
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: { model: "test-model", evaluator: "exact_match" },
		});

		expect(events).toEqual(["dispatch"]);
	});

	it("charges the immutable provider-call budget before provider dispatch", async () => {
		let invoked = 0;
		let claimed = false;
		const finalizations: Record<string, unknown>[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-provider-call-limit",
					dataset_item_id: "item-provider-call-limit",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "bounded" },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => ({ reserved: true as const, amount: 1 }),
			reserveProviderCall: async () => ({
				reserved: false as const,
				reason: "provider_call_limit_exceeded" as const,
			}),
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalizations.push(input);
				return true;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				invoked += 1;
				return { output: { value: "answer" }, model: "test-model" };
			},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: { model: "test-model", evaluator: "exact_match" },
		});

		expect(invoked).toBe(0);
		expect(finalizations[0]).toMatchObject({
			status: "failed",
			retryable: false,
			error_classification: "provider_call_limit_exceeded",
		});
	});

	for (const reason of ["cost_limit_exceeded", "snapshot_missing"] as const) {
		it(`does not dispatch when cost reservation returns ${reason}`, async () => {
			const events: string[] = [];
			const finalizations: Record<string, unknown>[] = [];
			let admissions = 0;
			let dispatches = 0;
			let invocations = 0;
			const deps = {
				pool: () => ({}) as never,
				updateExperiment: async (
					_db: unknown,
					input: Record<string, unknown>,
				) => {
					events.push(`status:${String(input.status)}`);
					return { status: input.status } as never;
				},
				claimTask: async () => ({
					id: `task-${reason}`,
					dataset_item_id: `item-${reason}`,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: reason },
					expected_output: { value: "answer" },
				}),
				reserveCost: async () => {
					events.push("reserve");
					return { reserved: false as const, reason };
				},
				admitExecution: async () => {
					admissions += 1;
					return {
						id: "77777777-7777-4777-8777-777777777777",
						project_id: projectId,
						requester_actor_id: "88888888-8888-4888-8888-888888888888",
						authorization_epoch: 1,
					};
				},
				claimExecution: async () => {
					dispatches += 1;
					return { status: "created" as const };
				},
				cancelAdmission: async () => {},
				completeAdmission: async () => {},
				reconcileUnknownProviderDispatch: async () => false,
				finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
					finalizations.push(input);
					return true;
				},
				completeExperiment: async () => true,
				nextTaskRetryDelay: async () => null,
				waitForTaskRetry: async () => {},
				invokeLlm: async () => {
					invocations += 1;
					return { output: { value: "answer" }, model: "test-model" };
				},
				trace: async () => {},
			} as unknown as ExperimentDependencies;

			await executeExperiment(deps, {
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: { model: "test-model", evaluator: "exact_match" },
			});

			expect(events).toEqual(["status:running", "reserve", "status:failed"]);
			expect(admissions).toBe(0);
			expect(dispatches).toBe(0);
			expect(invocations).toBe(0);
			expect(finalizations).toHaveLength(1);
			expect(finalizations[0]).toMatchObject({
				status: "failed",
				retryable: false,
				error_classification: reason,
				error_message:
					reason === "snapshot_missing"
						? "evaluation run snapshot missing"
						: "evaluation cost limit exceeded",
			});
		});
	}

	it("reserves before provider dispatch and settles the reservation on finalize", async () => {
		const events: string[] = [];
		let reservationActive = false;
		let finalized: Record<string, unknown> | undefined;
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-order",
					dataset_item_id: "item-order",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "order" },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => {
				events.push("reserve");
				reservationActive = true;
				return { reserved: true as const, amount: 1 };
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async (_db: unknown, input: { effect: string }) => {
				if (input.effect === "provider_dispatch") events.push("dispatch");
				return { status: "created" as const };
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				events.push("finalize");
				finalized = input;
				reservationActive = false;
				return true;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				events.push("invoke");
				return {
					output: { value: "answer" },
					model: "test-model",
					cost_usd: 0.25,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: {
				model: "test-model",
				evaluator: "exact_match",
				limits: { max_cost_usd: 1 },
			},
		});

		expect(events).toEqual(["reserve", "dispatch", "invoke", "finalize"]);
		expect(reservationActive).toBe(false);
		expect(finalized).toMatchObject({ cost_usd: 0.25, status: "completed" });
	});

	it("claims immutable run items with bounded worker concurrency", async () => {
		let claims = 0;
		let activeProviders = 0;
		let maximumProviders = 0;
		const deps = {
			pool: () => ({}) as never,
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claims += 1;
				if (claims > 4) return null;
				return {
					id: `task-${claims}`,
					dataset_item_id: `item-${claims}`,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: String(claims) },
					expected_output: { value: "answer" },
				};
			},
			finalizeTask: async () => true,
			completeExperiment: async () => claims > 4,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				activeProviders += 1;
				maximumProviders = Math.max(maximumProviders, activeProviders);
				await Bun.sleep(10);
				activeProviders -= 1;
				return { output: { value: "answer" }, model: "test-model" };
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				evaluation_run_id: "99999999-9999-4999-8999-999999999999",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: { model: "test-model", evaluator: "exact_match" },
			},
			undefined,
			2,
		);

		expect(claims).toBeGreaterThanOrEqual(5);
		expect(maximumProviders).toBeLessThanOrEqual(2);
	});

	it("defines leases, attempts, replay-safe evidence, and run event retention", () => {
		for (const fragment of [
			"max_attempts",
			"next_attempt_at",
			"heartbeat_at",
			"error_classification",
			"trace_id",
			"evaluator_rationale",
			"evaluation_run_events",
			"Last-Event-ID",
		]) {
			expect(migration).toContain(fragment);
		}
		expect(migration).toContain("evaluation_run_items");
		expect(migration).toContain("ON CONFLICT");
	});

	it("terminalizes a claimed task when the run duration limit aborts execution", async () => {
		let finalized: Record<string, unknown> | undefined;
		const statuses: Record<string, unknown>[] = [];
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				statuses.push(input);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-timeout",
					dataset_item_id: "item-timeout",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "wait" },
					expected_output: { value: "answer" },
				};
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalized = input;
				return true;
			},
			reconcileUnknownProviderDispatch: async () => false,
			completeExperiment: async () => false,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async (
				_input: unknown,
				_config: unknown,
				signal?: AbortSignal,
			) =>
				await new Promise<never>((_resolve, reject) =>
					signal?.addEventListener(
						"abort",
						() => reject(new Error("provider aborted")),
						{ once: true },
					),
				),
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				evaluation_run_id: "99999999-9999-4999-8999-999999999999",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: {
					model: "test-model",
					evaluator: "exact_match",
					limits: { max_duration_seconds: 0.01, max_cost_usd: 10 },
				},
			},
			undefined,
			1,
		);

		expect(finalized).toMatchObject({
			status: "failed",
			retryable: false,
			error_classification: "duration_limit",
			error_message: "evaluation run duration limit exceeded",
		});
		expect(statuses.at(-1)).toMatchObject({
			status: "failed",
			terminal_reason: "duration_limit",
		});
	});

	it("continues to completion after an admission failure before an admission is created", async () => {
		let claims = 0;
		let completions = 0;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claims += 1;
				if (claims > 1) return null;
				return {
					id: "task-admission-error",
					dataset_item_id: "item-admission-error",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "admission" },
					expected_output: { value: "answer" },
				};
			},
			admitExecution: async () => {
				throw new Error("admission database unavailable");
			},
			finalizeTask: async () => true,
			completeExperiment: async () => {
				completions += 1;
				return true;
			},
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: { model: "test-model", evaluator: "exact_match" },
		});

		expect(claims).toBe(2);
		expect(completions).toBe(1);
	});

	it("preserves duration-limit evidence through the outer abort handler", async () => {
		const controller = new AbortController();
		const statuses: Record<string, unknown>[] = [];
		let finalized: Record<string, unknown> | undefined;
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				statuses.push(input);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-outer-timeout",
					dataset_item_id: "item-outer-timeout",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "outer timeout" },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => ({ reserved: true as const, amount: 1 }),
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => {
				controller.abort("duration_limit");
				throw new Error("dispatch claim failed");
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalized = input;
				return true;
			},
			reconcileUnknownProviderDispatch: async () => false,
			completeExperiment: async () => false,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => ({ output: {}, model: "test-model" }),
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: { model: "test-model", evaluator: "exact_match" },
			},
			controller.signal,
		);

		expect(finalized).toMatchObject({
			error_classification: "duration_limit",
		});
		expect(statuses.at(-1)).toMatchObject({
			status: "failed",
			terminal_reason: "duration_limit",
		});
	});

	it("persists provider-reported cost and uses a new dispatch key for each retry attempt", async () => {
		let claimCount = 0;
		let reservationCount = 0;
		let reservationActive = false;
		const finalizations: Record<string, unknown>[] = [];
		const dispatchKeys: string[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claimCount += 1;
				if (claimCount > 2) return null;
				return {
					id: "task-retry",
					dataset_item_id: "item-retry",
					attempt_count: claimCount,
					last_error_classification: claimCount === 1 ? null : "provider_error",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "retry" },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => {
				reservationCount += 1;
				reservationActive = true;
				return { reserved: true as const, amount: 1 };
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async (
				_db: unknown,
				{ effect, effect_key }: { effect: string; effect_key: string },
			) => {
				if (effect === "provider_dispatch") dispatchKeys.push(effect_key);
				return { status: "created" as const };
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalizations.push(input);
				reservationActive = false;
				return true;
			},
			completeExperiment: async () => claimCount > 2,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				if (dispatchKeys.length === 1)
					throw new LlmProviderError(
						"deterministic provider failure",
						"deterministic_failure",
					);
				return {
					output: { value: "answer" },
					model: "test-model",
					cost_usd: 0.25,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: { model: "test-model", evaluator: "exact_match" },
			},
			undefined,
			1,
		);

		expect(finalizations[0]).toMatchObject({
			retryable: true,
			error_classification: "provider_error",
		});
		expect(finalizations.at(-1)).toMatchObject({ cost_usd: 0.25 });
		expect(dispatchKeys).toHaveLength(2);
		expect(dispatchKeys[0]).not.toBe(dispatchKeys[1]);
		expect(reservationCount).toBe(2);
		expect(reservationActive).toBe(false);
	});

	it("terminalizes at the configured cost limit and stops further dispatch", async () => {
		let claims = 0;
		let invocations = 0;
		const finalizations: Record<string, unknown>[] = [];
		const statuses: Record<string, unknown>[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				statuses.push(input);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				claims += 1;
				if (claims > 2) return null;
				return claims === 1
					? {
							id: "task-cost-limit",
							dataset_item_id: "item-cost-limit",
							lease_token: "66666666-6666-4666-8666-666666666666",
							input: { question: "cost" },
							expected_output: { value: "answer" },
						}
					: {
							id: "task-must-not-dispatch",
							dataset_item_id: "item-must-not-dispatch",
							lease_token: "66666666-6666-4666-8666-666666666666",
							input: { question: "second" },
							expected_output: { value: "answer" },
						};
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalizations.push(input);
				return true;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				invocations += 1;
				return {
					output: { value: "answer" },
					model: "test-model",
					cost_usd: 1,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: {
					model: "test-model",
					evaluator: "exact_match",
					limits: { max_cost_usd: 1 },
				},
			},
			undefined,
			1,
		);

		expect(invocations).toBe(1);
		expect(claims).toBe(1);
		expect(finalizations).toHaveLength(1);
		expect(finalizations[0]).toMatchObject({
			status: "failed",
			cost_usd: 1,
			error_classification: "cost_limit_exceeded",
			error_message: "evaluation cost limit exceeded",
		});
		expect(
			(finalizations[0]?.error_message as string).length,
		).toBeLessThanOrEqual(512);
		expect(statuses.at(-1)).toMatchObject({
			status: "failed",
			terminal_reason: "cost_limit_exceeded",
		});
	});

	it("does not let concurrent workers dispatch beyond one reserved budget", async () => {
		let claims = 0;
		let invocations = 0;
		let reservationActive = false;
		const reservationTasks: string[] = [];
		const finalizations: Record<string, unknown>[] = [];
		const statuses: Record<string, unknown>[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				statuses.push(input);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				claims += 1;
				if (claims > 2) return null;
				return {
					id: `task-budget-${claims}`,
					dataset_item_id: `item-budget-${claims}`,
					attempt_count: 1,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: String(claims) },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => {
				reservationTasks.push("reserved");
				if (reservationActive)
					return {
						reserved: false as const,
						reason: "cost_limit_exceeded" as const,
					};
				reservationActive = true;
				return { reserved: true as const, amount: 1 };
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalizations.push(input);
				if (input.cost_usd === 1) reservationActive = false;
				return true;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				invocations += 1;
				await Bun.sleep(5);
				return {
					output: { value: "answer" },
					model: "test-model",
					cost_usd: 1,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: {
					model: "test-model",
					evaluator: "exact_match",
					limits: { max_cost_usd: 1 },
				},
			},
			undefined,
			2,
		);

		expect(invocations).toBe(1);
		expect(reservationTasks).toHaveLength(2);
		expect(finalizations).toHaveLength(2);
		expect(finalizations[1]).toMatchObject({
			status: "failed",
			error_classification: "cost_limit_exceeded",
		});
		expect(statuses).toContainEqual(
			expect.objectContaining({ terminal_reason: "cost_limit_exceeded" }),
		);
	});

	it("replays a leased dispatch with the same key and does not invoke twice", async () => {
		let claims = 0;
		let invocations = 0;
		let reconciliations = 0;
		const dispatchKeys: string[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claims += 1;
				if (claims > 2) return null;
				return {
					id: "task-replay",
					dataset_item_id: "item-replay",
					attempt_count: claims,
					last_error_classification: null,
					lease_token: `66666666-6666-4666-8666-66666666666${claims}`,
					input: { question: "replay" },
					expected_output: { value: "answer" },
				};
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async (
				_db: unknown,
				input: { effect: string; effect_key: string },
			) => {
				if (input.effect === "provider_dispatch") {
					dispatchKeys.push(input.effect_key);
					return {
						status:
							dispatchKeys.length === 1
								? ("created" as const)
								: ("existing" as const),
					};
				}
				return { status: "created" as const };
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => {
				reconciliations += 1;
				return true;
			},
			finalizeTask: async () => false,
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				invocations += 1;
				return {
					output: { value: "answer" },
					model: "test-model",
					cost_usd: 0.1,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		const input = {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: { model: "test-model", evaluator: "exact_match" },
		};
		await executeEvaluationRun(deps, input, undefined, 1);
		await executeEvaluationRun(deps, input, undefined, 1);

		expect(invocations).toBe(1);
		expect(dispatchKeys).toEqual([
			"glasshouse:experiment_task:task-replay:provider_dispatch:1",
			"glasshouse:experiment_task:task-replay:provider_dispatch:2",
		]);
		expect(reconciliations).toBe(1);
	});

	it("uses an attempt-specific trace effect key after a retry", async () => {
		let claimCount = 0;
		const traceKeys: string[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claimCount += 1;
				if (claimCount > 2) return null;
				return {
					id: "task-trace-retry",
					dataset_item_id: "item-trace-retry",
					attempt_count: claimCount,
					last_error_classification: claimCount === 1 ? null : "provider_error",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "trace" },
					expected_output: { value: "answer" },
				};
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async (
				_db: unknown,
				input: { effect: string; effect_key: string },
			) => {
				if (input.effect === "trace_write") traceKeys.push(input.effect_key);
				return { status: "created" as const };
			},
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async () => true,
			completeExperiment: async () => claimCount > 2,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => ({
				output: { value: "answer" },
				model: "test-model",
				cost_usd: 0.1,
			}),
			trace: async () => "trace-id",
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: "33333333-3333-4333-8333-333333333333",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			config: { model: "test-model", evaluator: "exact_match" },
		});

		expect(traceKeys).toEqual(["trace_write:1", "trace_write:2"]);
	});

	it("fails closed on unknown provider cost and does not dispatch another item", async () => {
		let claims = 0;
		let invocations = 0;
		const finalizations: Record<string, unknown>[] = [];
		const statuses: Record<string, unknown>[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				statuses.push(input);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				claims += 1;
				if (claims > 2) return null;
				return {
					id: `task-unknown-${claims}`,
					dataset_item_id: `item-unknown-${claims}`,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "unknown" },
					expected_output: { value: "answer" },
				};
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			reconcileUnknownProviderDispatch: async () => false,
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalizations.push(input);
				return true;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				invocations += 1;
				return {
					output: { value: "answer" },
					model: "test-model",
					prompt_tokens: 1_000_000,
					completion_tokens: 1_000_000,
				};
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: {
					model: "test-model",
					evaluator: "exact_match",
					limits: { max_cost_usd: 1 },
				},
			},
			undefined,
			1,
		);

		expect(invocations).toBe(1);
		expect(claims).toBe(1);
		expect(finalizations[0]).toMatchObject({
			status: "failed",
			cost_usd: null,
			error_classification: "cost_unknown",
			error_message: "provider did not return billable cost",
		});
		expect(statuses.at(-1)).toMatchObject({
			status: "failed",
			terminal_reason: "cost_unknown",
		});
	});

	it("terminalizes an uncertain provider dispatch without making it retryable", async () => {
		let finalized: Record<string, unknown> | undefined;
		let reservationActive = false;
		let reconciliations = 0;
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task-uncertain",
					dataset_item_id: "item-uncertain",
					attempt_count: 1,
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "uncertain" },
					expected_output: { value: "answer" },
				};
			},
			reserveCost: async () => {
				reservationActive = true;
				return { reserved: true as const, amount: 1 };
			},
			admitExecution: async () => ({
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			}),
			isAdmissionActive: async () => true,
			claimExecution: async () => ({ status: "created" as const }),
			cancelAdmission: async () => {},
			completeAdmission: async () => {},
			finalizeTask: async (_db: unknown, input: Record<string, unknown>) => {
				finalized = input;
				reservationActive = false;
				return true;
			},
			reconcileUnknownProviderDispatch: async () => {
				reconciliations += 1;
				return false;
			},
			completeExperiment: async () => true,
			nextTaskRetryDelay: async () => null,
			waitForTaskRetry: async () => {},
			invokeLlm: async () => {
				throw new LlmProviderError(
					"LLM request outcome is unknown",
					"uncertain",
				);
			},
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeEvaluationRun(
			deps,
			{
				project_id: projectId,
				experiment_id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				config: { model: "test-model", evaluator: "exact_match" },
			},
			undefined,
			1,
		);

		expect(finalized).toMatchObject({
			retryable: false,
			error_classification: "unknown_dispatch",
		});
		expect(reservationActive).toBe(false);
		expect(reconciliations).toBe(0);
	});
});
