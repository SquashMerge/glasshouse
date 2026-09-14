import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	admitEvaluationRun,
	EvaluationRunRepositoryError,
	type EvaluationRunAdmissionInput,
} from "../../src/db/evaluation-runs";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "00000000-0000-4000-8000-000000000001";
const actorId = "22222222-2222-4222-8222-222222222222";
const evaluationId = "33333333-3333-4333-8333-333333333333";
const definitionVersionId = "44444444-4444-4444-8444-444444444444";
const datasetVersionId = "55555555-5555-4555-8555-555555555555";
const datasetId = "66666666-6666-4666-8666-666666666666";
const experimentId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";
const itemOneId = "99999999-9999-4999-8999-999999999999";
const itemTwoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const definitionRow = {
	id: definitionVersionId,
	evaluation_id: evaluationId,
	evaluation_name: "Support quality",
	organization_id: organizationId,
	project_id: projectId,
	version: 3,
	dataset_version_id: datasetVersionId,
	dataset_id: datasetId,
	sampling: { strategy: "first_n", sample_size: 2, seed: 0 },
	evaluator: {
		kind: "exact_match",
		version: "v1",
		expected_output_path: "$.expected_output",
		output_path: "$.output",
	},
	target: {
		kind: "configured_llm",
		model: "gpt-4o-mini",
		system_prompt: null,
	},
	execution_defaults: { temperature: 0, max_tokens: null },
	limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
	thresholds: { minimum_pass_rate: null },
};

const selectedItems = [
	{
		id: itemOneId,
		project_id: projectId,
		dataset_version_id: datasetVersionId,
		item_key: "first",
		position: 0,
		input: { question: "one" },
		expected_output: { value: "one" },
		metadata: { source: "test" },
		source_trace_id: null,
		source_observation_id: null,
	},
	{
		id: itemTwoId,
		project_id: projectId,
		dataset_version_id: datasetVersionId,
		item_key: "second",
		position: 1,
		input: { question: "two" },
		expected_output: { value: "two" },
		metadata: { source: "test" },
		source_trace_id: null,
		source_observation_id: null,
	},
];

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0080_evaluation_run_admission.sql",
	),
	"utf8",
);

function admissionInput(
	overrides: Partial<EvaluationRunAdmissionInput> = {},
): EvaluationRunAdmissionInput {
	return {
		project_id: projectId,
		evaluation_selector: "support-quality",
		definition_version: 3,
		idempotency_key: "run-once",
		trigger_metadata: { source: "dashboard" },
		authorization: {
			organization_id: organizationId,
			actor_id: actorId,
			operation: "execute",
		},
		...overrides,
	};
}

function transactionPool(options: {
	existing?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	admittedItems?: Record<string, unknown>[];
	definition?: Record<string, unknown>;
	items?: Record<string, unknown>[];
	activeCapacity?: { project: number; actor: number };
}) {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			calls.push({ text, values });
			if (text.startsWith("SELECT p.id FROM projects"))
				return { rows: [{ id: projectId }] };
			if (text.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (text.includes("FROM evaluation_runs"))
				return { rows: options.existing ? [options.existing] : [] };
			if (text.includes("FROM evaluation_definition_versions"))
				return { rows: options.definition ? [options.definition] : [] };
			if (text.startsWith("SELECT item.* FROM dataset_version_items"))
				return { rows: options.items ?? selectedItems };
			if (text.includes("FROM evaluation_run_capacity_admissions"))
				return {
					rows: [
						{
							project_active: options.activeCapacity?.project ?? 0,
							actor_active: options.activeCapacity?.actor ?? 0,
						},
					],
				};
			if (text.startsWith("SELECT input.* FROM evaluation_run_inputs"))
				return { rows: options.snapshot ? [options.snapshot] : [] };
			if (text.startsWith("SELECT item.* FROM evaluation_run_items"))
				return { rows: options.admittedItems ?? [] };
			if (text.startsWith("INSERT INTO evaluation_runs"))
				return {
					rows: [
						{
							id: runId,
							organization_id: organizationId,
							project_id: projectId,
							evaluation_id: evaluationId,
							definition_version_id: definitionVersionId,
							dataset_version_id: datasetVersionId,
							status: "pending",
							requested_by_actor_id: actorId,
							idempotency_key: "run-once",
							request_hash: values[8],
							resolved_inputs_hash: values[9],
							trigger_metadata: { source: "dashboard" },
							created_at: new Date("2026-09-10T00:00:00.000Z"),
							updated_at: new Date("2026-09-10T00:00:00.000Z"),
						},
					],
				};
			if (text.startsWith("INSERT INTO evaluation_run_capacity_admissions"))
				return { rows: [{ run_id: runId }] };
			if (text.startsWith("INSERT INTO experiments"))
				return {
					rows: [
						{
							id: experimentId,
							project_id: projectId,
							agent_id: null,
							dataset_id: datasetId,
							name: "Support quality run v3",
							status: "pending",
						},
					],
				};
			return { rows: [] };
		},
		release() {},
	};
	return { connect: async () => client, calls };
}

describe("Evaluation Run admission", () => {
	it("resolves an immutable definition and ordered item snapshot before seeding work", async () => {
		const db = transactionPool({ definition: definitionRow });

		const result = await admitEvaluationRun(db as never, admissionInput());

		expect(result).toMatchObject({
			id: runId,
			project_id: projectId,
			evaluation_id: evaluationId,
			definition_version_id: definitionVersionId,
			dataset_version_id: datasetVersionId,
			experiment_id: experimentId,
			experiment_agent_id: null,
			experiment_name: "Support quality run v3",
			snapshot: {
				sampling: definitionRow.sampling,
				sample_identity: expect.any(String),
				ordered_item_snapshot: selectedItems,
			},
		});
		expect(db.calls.some((call) => call.text.includes("SERIALIZABLE"))).toBe(
			true,
		);
		const definitionCall = db.calls.find((call) =>
			call.text.includes("FROM evaluation_definition_versions"),
		);
		expect(definitionCall?.text).toContain("FOR UPDATE");
		const insertRun = db.calls.find((call) =>
			call.text.startsWith("INSERT INTO evaluation_runs"),
		);
		const insertExperiment = db.calls.find((call) =>
			call.text.startsWith("INSERT INTO experiments"),
		);
		expect(insertRun).toBeDefined();
		expect(insertExperiment).toBeDefined();
		expect(db.calls.indexOf(insertRun!)).toBeLessThan(
			db.calls.indexOf(insertExperiment!),
		);
	});

	it("replays the identical persisted snapshot without creating another run", async () => {
		const firstDb = transactionPool({ definition: definitionRow });
		const first = await admitEvaluationRun(firstDb as never, admissionInput());
		const persistedInputs = firstDb.calls.find((call) =>
			call.text.startsWith("INSERT INTO evaluation_run_inputs"),
		)!.values;
		const db = transactionPool({
			snapshot: {
				...first.snapshot,
				ordered_item_snapshot: JSON.parse(persistedInputs[13] as string),
			},
			admittedItems: selectedItems.map(({ id, ...item }) => ({
				...item,
				dataset_version_item_id: id,
			})),
			existing: {
				id: runId,
				organization_id: organizationId,
				project_id: projectId,
				evaluation_id: evaluationId,
				definition_version_id: definitionVersionId,
				dataset_version_id: datasetVersionId,
				dataset_id: datasetId,
				experiment_id: experimentId,
				status: "pending",
				requested_by_actor_id: actorId,
				idempotency_key: "run-once",
				request_hash: first.request_hash,
				resolved_inputs_hash: first.resolved_inputs_hash,
				trigger_metadata: { source: "dashboard" },
				created_at: new Date("2026-09-10T00:00:00.000Z"),
				updated_at: new Date("2026-09-10T00:00:00.000Z"),
			},
		});

		const result = await admitEvaluationRun(db as never, admissionInput());

		expect(result).toMatchObject({ id: runId, replayed: true });
		expect(result.snapshot).toEqual(first.snapshot);
		expect(
			db.calls.some(
				(call) =>
					call.text.includes("FROM evaluation_definition_versions") ||
					call.text.includes("FROM dataset_version_items") ||
					call.text.includes("FROM dataset_items"),
			),
		).toBe(false);
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
		expect(
			db.calls.some((call) => call.text.startsWith("INSERT INTO experiments")),
		).toBe(false);
	});

	it("fails closed when a replay has no persisted input snapshot", async () => {
		const first = await admitEvaluationRun(
			transactionPool({ definition: definitionRow }) as never,
			admissionInput(),
		);
		const db = transactionPool({ existing: { ...first } });
		await expect(
			admitEvaluationRun(db as never, admissionInput()),
		).rejects.toMatchObject({ code: "INTERNAL" });
	});

	it("rejects reuse of an idempotency key for a different immutable request", async () => {
		const db = transactionPool({
			existing: {
				id: runId,
				project_id: projectId,
				request_hash: "different".repeat(8),
			},
		});

		await expect(
			admitEvaluationRun(
				db as never,
				admissionInput({ definition_version: 4 }),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
	});

	it("rejects a replay when an accepted benchmark label changes", async () => {
		const benchmark = {
			suite_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			label: "baseline",
			prompt_version: "v1",
		};
		const first = await admitEvaluationRun(
			transactionPool({ definition: definitionRow }) as never,
			admissionInput({ benchmark }),
		);
		const db = transactionPool({
			existing: {
				id: runId,
				project_id: projectId,
				request_hash: first.request_hash,
			},
		});

		await expect(
			admitEvaluationRun(
				db as never,
				admissionInput({ benchmark: { ...benchmark, label: "candidate" } }),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
	});

	it("fails closed when the definition or its Dataset Version is unavailable", async () => {
		const db = transactionPool({ definition: undefined });

		await expect(
			admitEvaluationRun(db as never, admissionInput()),
		).rejects.toBeInstanceOf(EvaluationRunRepositoryError);
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
		expect(
			db.calls.some((call) => call.text.startsWith("INSERT INTO experiments")),
		).toBe(false);
	});

	it("rejects an unapproved immutable target before persisting a runnable run", async () => {
		const previous = process.env.EVALUATION_ALLOWED_MODELS;
		process.env.EVALUATION_ALLOWED_MODELS = "openai/gpt-4o-mini";
		const db = transactionPool({
			definition: {
				...definitionRow,
				target: {
					...definitionRow.target,
					model: "gpt-expensive",
				},
			},
		});
		try {
			await expect(
				admitEvaluationRun(db as never, admissionInput()),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		} finally {
			if (previous === undefined) delete process.env.EVALUATION_ALLOWED_MODELS;
			else process.env.EVALUATION_ALLOWED_MODELS = previous;
		}
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
		expect(
			db.calls.some((call) => call.text.startsWith("INSERT INTO experiments")),
		).toBe(false);
	});

	it("rejects an oversized Dataset Version before materializing its items", async () => {
		const previous = process.env.EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN;
		process.env.EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN = "1";
		const db = transactionPool({ definition: definitionRow });
		try {
			await expect(
				admitEvaluationRun(db as never, admissionInput()),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		} finally {
			if (previous === undefined)
				delete process.env.EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN;
			else process.env.EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN = previous;
		}
		expect(
			db.calls.some((call) =>
				call.text.startsWith("SELECT item.* FROM dataset_version_items"),
			),
		).toBe(false);
	});

	it("rejects a concurrent project admission before it persists runnable work", async () => {
		const db = transactionPool({
			definition: definitionRow,
			activeCapacity: { project: 4, actor: 0 },
		});

		await expect(
			admitEvaluationRun(db as never, admissionInput()),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		expect(
			db.calls.some((call) =>
				call.text.startsWith("INSERT INTO evaluation_runs"),
			),
		).toBe(false);
		expect(
			db.calls.some((call) => call.text.startsWith("INSERT INTO experiments")),
		).toBe(false);
	});

	it("installs database fences for immutable run items and linked requester", () => {
		expect(migration).toContain(
			"current_setting('astraea.evaluation_run_admission_run_id', true)",
		);
		expect(migration).toContain(
			"NEW.requested_by_actor_id IS DISTINCT FROM OLD.requested_by_actor_id",
		);
		expect(migration).toContain(
			"BEFORE INSERT OR UPDATE OR DELETE ON evaluation_run_inputs",
		);
		expect(migration).toContain(
			"BEFORE INSERT OR UPDATE OR DELETE ON evaluation_run_items",
		);
	});
});
