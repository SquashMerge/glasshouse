import { describe, expect, it } from "bun:test";
import { updateExperiment } from "../../src/db/experiments";
import { evaluationWorkerActorId } from "../../src/db/actors";
import { logger } from "../../src/lib/logger";
import { createOtlpIngestHandler } from "../../src/routes/otlp";
import { scoreCase } from "../../src/lib/evaluator";
import { ExportTraceServiceRequest } from "../../src/schemas/otlp";
import { ExperimentCreate } from "../../src/schemas/experiments";
import {
	createEvaluationTracePayload,
	createExperimentHandlers,
	createProductionTrace,
	executeExperiment,
	type ExperimentDependencies,
} from "../../src/routes/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const datasetId = "22222222-2222-4222-8222-222222222222";
const experimentId = "33333333-3333-4333-8333-333333333333";
const organizationId = "00000000-0000-4000-8000-000000000001";

const baseExperiment = {
	project_id: projectId,
	dataset_id: datasetId,
	name: "smoke",
	config: {
		model: "test-model",
		evaluator: "contains" as const,
		temperature: 0,
	},
};

const admittedExecution = {
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
};

describe("evaluation MVP", () => {
	it("persists and publishes the production evaluation trace with project provenance", async () => {
		const persistedTraces: Array<Record<string, unknown>> = [];
		const persistedObservations: Array<Record<string, unknown>> = [];
		const published: Array<{
			event: string;
			payload: Record<string, unknown>;
		}> = [];
		const payload = createEvaluationTracePayload({
			project_id: projectId,
			experiment_id: experimentId,
			item_id: "44444444-4444-4444-8444-444444444444",
			model: "test-model",
			input: { question: "one" },
			output: JSON.stringify({ value: "answer" }),
			duration_ms: 25,
		});

		expect(ExportTraceServiceRequest.safeParse(payload).success).toBe(true);
		expect(payload.resource_spans[0]?.resource.attributes).toContainEqual({
			key: "astraea.project.id",
			value: { stringValue: projectId },
		});

		const handler = createOtlpIngestHandler({
			defaultClient: () => ({}) as never,
			insertTraces: async (_client, traces) => {
				persistedTraces.push(...(traces as Array<Record<string, unknown>>));
			},
			insertObservations: async (_client, observations) => {
				persistedObservations.push(
					...(observations as Array<Record<string, unknown>>),
				);
			},
			publishSync: (event, payload) => {
				published.push({ event, payload: payload as Record<string, unknown> });
			},
			approvedRedaction: async () => null,
			withActiveAuthorizedProjectLock: async (_tenant, callback) => callback(),
		});
		const response = await handler(
			new Request("http://internal/v1/otel/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}),
			{ actor: "evaluation-worker", organizationId, projectId },
		);

		expect(response.status).toBe(200);
		expect(persistedTraces[0]).toMatchObject({
			organization_id: organizationId,
			project_id: projectId,
		});
		expect(persistedObservations[0]).toMatchObject({
			organization_id: organizationId,
			project_id: projectId,
			type: "generation",
			model: "test-model",
			input_text: JSON.stringify({ question: "one" }),
			output_text: JSON.stringify({ value: "answer" }),
		});
		expect(persistedObservations[0]?.metadata).toMatchObject({
			attributes: [
				{ key: "gen_ai.response.model", value: { stringValue: "test-model" } },
				{
					key: "input.value",
					value: { stringValue: JSON.stringify({ question: "one" }) },
				},
				{
					key: "output.value",
					value: { stringValue: JSON.stringify({ value: "answer" }) },
				},
			],
		});
		expect(published).toHaveLength(2);
		expect(published[0]).toMatchObject({
			event: "trace.created",
			payload: {
				trace: { organization_id: organizationId, project_id: projectId },
			},
		});
		expect(published[1]).toMatchObject({
			event: "observation.created",
			payload: {
				observation: {
					organization_id: organizationId,
					project_id: projectId,
					type: "generation",
					model: "test-model",
					input_text: JSON.stringify({ question: "one" }),
					output_text: JSON.stringify({ value: "answer" }),
					metadata: {
						attributes: [
							{
								key: "gen_ai.response.model",
								value: { stringValue: "test-model" },
							},
							{
								key: "input.value",
								value: { stringValue: JSON.stringify({ question: "one" }) },
							},
							{
								key: "output.value",
								value: { stringValue: JSON.stringify({ value: "answer" }) },
							},
						],
					},
				},
			},
		});
	});

	it("derives the evaluation worker actor from the selected project organization", async () => {
		let tenant: Record<string, unknown> | undefined;
		const productionTrace = createProductionTrace(
			async (_request, receivedTenant) => {
				tenant = receivedTenant;
				return new Response(null, { status: 200 });
			},
			() =>
				({
					query: async () => ({ rows: [{ organization_id: organizationId }] }),
				}) as never,
		);

		await productionTrace({
			project_id: projectId,
			experiment_id: experimentId,
			item_id: "44444444-4444-4444-8444-444444444444",
			model: "test-model",
			input: { question: "one" },
			output: JSON.stringify({ value: "answer" }),
			duration_ms: 25,
		});

		expect(tenant).toEqual({
			actorId: evaluationWorkerActorId(organizationId),
			organizationId,
			projectId,
		});
		expect(tenant?.actorId).not.toBe("00000000-0000-5000-8000-000000000001");
	});

	it("defaults to the exact-match evaluator and temperature", () => {
		const parsed = ExperimentCreate.parse({
			project_id: projectId,
			dataset_id: datasetId,
		});
		expect(parsed.config).toEqual({ evaluator: "exact_match", temperature: 0 });
	});

	it("does not overwrite a concurrent cancellation with a terminal worker update", async () => {
		const cancelled = {
			id: experimentId,
			project_id: projectId,
			agent_id: null,
			dataset_id: datasetId,
			name: null,
			config: {},
			status: "cancelled",
			created_at: "2026-07-29T00:00:00.000Z",
			updated_at: "2026-07-29T00:00:00.000Z",
		};
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const client = {
			query: async (sql: string, values: unknown[]) => {
				calls.push({ sql, values });
				if (sql.startsWith("SELECT p.id AS authorization_project_id"))
					return {
						rows: [
							{
								...cancelled,
								authorization_project_id: projectId,
								organization_id: "66666666-6666-4666-8666-666666666666",
								requested_by_actor_id: "77777777-7777-4777-8777-777777777777",
							},
						],
					};
				if (sql.startsWith("SELECT e.* FROM experiments"))
					return {
						rows: [
							{
								...cancelled,
								requested_by_actor_id: "77777777-7777-4777-8777-777777777777",
							},
						],
					};
				if (sql.includes("p.status = ANY($5::text[])"))
					return { rows: [{ id: projectId }] };
				if (sql.includes("organization_memberships")) return { rows: [{}] };
				if (sql.includes("project_memberships")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				return { rows: [] };
			},
			release() {},
		};
		const db = { connect: async () => client };

		const result = await updateExperiment(db as never, {
			project_id: projectId,
			id: experimentId,
			status: "completed",
			if_status: "running",
		});

		expect(calls.some((call) => call.sql.includes("FOR UPDATE OF p"))).toBe(
			true,
		);
		expect(result.status).toBe("cancelled");
	});

	it("scores exact matches and case-insensitive containment", () => {
		expect(
			scoreCase("exact_match", { value: "yes" }, { value: "yes" }),
		).toEqual({ exact_match: 1 });
		expect(scoreCase("contains", "YES", { value: "yes, definitely" })).toEqual({
			contains: 1,
		});
	});

	it("rejects creation when any dataset item lacks expected output", async () => {
		let created = false;
		const handlers = createExperimentHandlers({
			pool: () => ({}) as never,
			getDataset: async () => ({ id: datasetId }),
			listDatasetItems: async () => ({
				items: [{ id: "case", input: {}, expected_output: null }],
			}),
			createExperiment: async () => {
				created = true;
				return {} as never;
			},
			listExperiments: async () => ({ items: [], total: 0 }),
			getExperiment: async () => ({ status: "completed" }) as never,
			updateExperiment: async () => ({}) as never,
			cancelExperiment: async () => ({}) as never,
			listResults: async () => ({ items: [] }) as never,
			insertResult: async () => ({}) as never,
			summary: async () => ({}) as never,
			invokeLlm: async () => ({ output: {}, model: "test" }),
			trace: async () => {},
		} as never);
		const response = await handlers.handleCreateExperiment({
			req: { valid: () => baseExperiment },
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(409);
		expect(created).toBe(false);
	});

	it("runs every dataset item, stores results, and emits one trace per item", async () => {
		const statuses: string[] = [];
		const results: unknown[] = [];
		const traces: unknown[] = [];
		let claims = 0;
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({ id: datasetId }),
			updateExperiment: async (_db: unknown, input: { status: string }) => {
				statuses.push(input.status);
				return {} as never;
			},
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: { question: "one" },
						expected_output: { value: "answer" },
					},
					{
						id: "55555555-5555-4555-8555-555555555555",
						input: { question: "two" },
						expected_output: { value: "answer" },
					},
				],
			}),
			claimTask: async () => {
				claims += 1;
				return claims <= 2
					? {
							id: `task-${claims}`,
							dataset_item_id:
								claims === 1
									? "44444444-4444-4444-8444-444444444444"
									: "55555555-5555-4555-8555-555555555555",
							lease_token: "66666666-6666-4666-8666-666666666666",
							input: { question: claims === 1 ? "one" : "two" },
							expected_output: { value: "answer" },
						}
					: null;
			},
			finalizeTask: async (_db: unknown, input: unknown) => {
				results.push(input);
				return true;
			},
			completeExperiment: async () => {
				statuses.push("completed");
				return true;
			},
			invokeLlm: async () => ({
				output: { value: "answer" },
				model: "test-model",
			}),
			insertResult: async (_db: unknown, input: unknown) => {
				results.push(input);
				return {} as never;
			},
			trace: async (input: unknown) => {
				traces.push(input);
			},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});
		expect(statuses).toEqual(["running", "completed"]);
		expect(results).toHaveLength(2);
		expect(traces).toHaveLength(2);
		expect((results[0] as { scores: Record<string, number> }).scores).toEqual({
			contains: 1,
		});
	});

	it("waits for an inherited unexpired lease and retries the task after it expires", async () => {
		let claims = 0;
		const retryDelays: number[] = [];
		const finalized: unknown[] = [];
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			updateExperiment: async () => ({ status: "running" }) as never,
			claimTask: async () => {
				claims += 1;
				return claims === 2
					? {
							id: "44444444-4444-4444-8444-444444444444",
							dataset_item_id: "55555555-5555-4555-8555-555555555555",
							lease_token: "66666666-6666-4666-8666-666666666666",
							input: { question: "one" },
							expected_output: { value: "answer" },
						}
					: null;
			},
			completeExperiment: async () => claims > 2,
			nextTaskRetryDelay: async () => 2_500,
			waitForTaskRetry: async (delay: number) => {
				retryDelays.push(delay);
			},
			finalizeTask: async (_db: unknown, input: unknown) => {
				finalized.push(input);
				return true;
			},
			invokeLlm: async () => ({
				output: { value: "answer" },
				model: "test-model",
			}),
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});

		expect(retryDelays).toEqual([2_501]);
		expect(finalized).toHaveLength(1);
	});

	it("does not persist a result when cancellation wins after provider invocation", async () => {
		let claims = 0;
		const finalized: unknown[] = [];
		const statuses: string[] = [];
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			updateExperiment: async (_db: unknown, input: { status: string }) => {
				statuses.push(input.status);
				return { status: input.status } as never;
			},
			claimTask: async () => {
				claims += 1;
				return claims === 1
					? {
							id: "44444444-4444-4444-8444-444444444444",
							dataset_item_id: "55555555-5555-4555-8555-555555555555",
							lease_token: "66666666-6666-4666-8666-666666666666",
							input: { question: "one" },
							expected_output: { value: "answer" },
						}
					: null;
			},
			finalizeTask: async (_db: unknown, input: unknown) => {
				finalized.push(input);
				return false;
			},
			completeExperiment: async () => false,
			invokeLlm: async () => ({
				output: { value: "answer" },
				model: "test-model",
			}),
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});

		expect(finalized).toHaveLength(1);
		expect(statuses).toEqual(["running"]);
	});

	it("logs an OTLP error response without changing a successful evaluation result", async () => {
		const statuses: string[] = [];
		const results: Array<{ status: string }> = [];
		let claimed = false;
		const warnings: Array<{
			event: string;
			cause: unknown;
			fields: Record<string, unknown>;
		}> = [];
		const productionTrace = createProductionTrace(
			async () => new Response("provider config: secret", { status: 500 }),
			() =>
				({
					query: async () => ({ rows: [{ organization_id: organizationId }] }),
				}) as never,
		);
		await expect(
			productionTrace({
				project_id: projectId,
				experiment_id: experimentId,
				item_id: "44444444-4444-4444-8444-444444444444",
				model: "test-model",
				input: { question: "one" },
				output: JSON.stringify({ value: "answer" }),
				duration_ms: 25,
			}),
		).rejects.toThrow("OTLP trace ingestion failed");
		const trace = async () => {
			const error = new Error("trace failure");
			Object.defineProperty(error, "name", {
				get() {
					throw new Error("untrusted-name-getter");
				},
			});
			throw error;
		};
		const originalWarn = logger.warn;
		logger.warn = (event, cause, fields = {}) =>
			warnings.push({ event, cause, fields });
		try {
			const deps = {
				pool: () => ({}) as never,
				...admittedExecution,
				getExperiment: async () => ({ status: "running" }),
				getDataset: async () => ({ id: datasetId }),
				updateExperiment: async (_db: unknown, input: { status: string }) => {
					statuses.push(input.status);
					return {} as never;
				},
				listDatasetItems: async () => ({
					items: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							input: { question: "one" },
							expected_output: { value: "answer" },
						},
					],
				}),
				claimTask: async () => {
					if (claimed) return null;
					claimed = true;
					return {
						id: "task",
						dataset_item_id: "44444444-4444-4444-8444-444444444444",
						lease_token: "66666666-6666-4666-8666-666666666666",
						input: { question: "one" },
						expected_output: { value: "answer" },
					};
				},
				finalizeTask: async (_db: unknown, result: { status: string }) => {
					results.push(result);
					return true;
				},
				completeExperiment: async () => {
					statuses.push("completed");
					return true;
				},
				invokeLlm: async () => ({
					output: { value: "answer" },
					model: "test-model",
				}),
				insertResult: async (_db: unknown, result: { status: string }) => {
					results.push(result);
					return {} as never;
				},
				trace,
			} as unknown as ExperimentDependencies;

			await executeExperiment(deps, {
				project_id: projectId,
				experiment_id: experimentId,
				dataset_id: datasetId,
				config: baseExperiment.config,
			});
		} finally {
			logger.warn = originalWarn;
		}

		expect(statuses).toEqual(["running", "completed"]);
		expect(results[0]).toMatchObject({ status: "completed" });
		expect(warnings).toEqual([
			expect.objectContaining({
				event: "evaluation.trace_failed",
				cause: expect.any(Error),
				fields: {
					experiment_id: experimentId,
					dataset_item_id: "44444444-4444-4444-8444-444444444444",
				},
			}),
		]);
	});

	it("emits a failure trace when an LLM call fails", async () => {
		const results: unknown[] = [];
		const traces: unknown[] = [];
		let claimed = false;
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({ id: datasetId }),
			updateExperiment: async () => ({}) as never,
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: { question: "one" },
						expected_output: null,
					},
				],
			}),
			claimTask: async () => {
				if (claimed) return null;
				claimed = true;
				return {
					id: "task",
					dataset_item_id: "44444444-4444-4444-8444-444444444444",
					lease_token: "66666666-6666-4666-8666-666666666666",
					input: { question: "one" },
					expected_output: null,
				};
			},
			finalizeTask: async (_db: unknown, input: unknown) => {
				results.push(input);
				return true;
			},
			completeExperiment: async () => true,
			invokeLlm: async () => {
				throw new Error("provider unavailable");
			},
			insertResult: async (_db: unknown, input: unknown) => {
				results.push(input);
				return {} as never;
			},
			trace: async (input: unknown) => {
				traces.push(input);
			},
		} as unknown as ExperimentDependencies;
		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});
		expect(results).toHaveLength(1);
		expect(traces).toHaveLength(1);
		expect((traces[0] as { output: string }).output).toBe("evaluation_failed");
	});

	it("does not start when cancellation wins the pending-to-running transition", async () => {
		let listed = false;
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			updateExperiment: async () => ({ status: "cancelled" }) as never,
			listDatasetItems: async () => {
				listed = true;
				return { items: [] };
			},
			getExperiment: async () => ({ status: "cancelled" }) as never,
			invokeLlm: async () => ({ output: {}, model: "test" }),
			insertResult: async () => ({}) as never,
			trace: async () => {},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});

		expect(listed).toBe(false);
	});

	it("stops before the first item when cancellation is already requested", async () => {
		const controller = new AbortController();
		controller.abort();
		const statuses: string[] = [];
		let invoked = false;
		const deps = {
			pool: () => ({}) as never,
			...admittedExecution,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({
				id: datasetId,
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: {},
						expected_output: null,
					},
				],
			}),
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: {},
						expected_output: null,
					},
				],
			}),
			updateExperiment: async (_db: unknown, input: { status: string }) => {
				statuses.push(input.status);
				return {} as never;
			},
			invokeLlm: async () => {
				invoked = true;
				return { output: {}, model: "test" };
			},
			insertResult: async () => ({}) as never,
			trace: async () => {},
		} as unknown as ExperimentDependencies;
		await executeExperiment(
			deps,
			{
				project_id: projectId,
				experiment_id: experimentId,
				dataset_id: datasetId,
				config: baseExperiment.config,
			},
			controller.signal,
		);
		expect(invoked).toBe(false);
		expect(statuses).toEqual(["running", "cancelled"]);
	});
});
