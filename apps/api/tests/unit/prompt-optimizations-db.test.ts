import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import {
	createOptimizationJob,
	publishOptimizationResult,
	stopOptimizationJob,
} from "../../src/db/prompt-optimizations";
import { PromptRepositoryError } from "../../src/db/prompts";

type Reply = { rows: Record<string, unknown>[] };
type Call = { text: string; values: unknown[] };

class MockClient {
	readonly calls: Call[] = [];

	constructor(private readonly replies: Reply[]) {}

	async query(text: string, values: unknown[] = []) {
		this.calls.push({ text, values });
		const reply = this.replies.shift();
		if (!reply) throw new Error(`Unexpected query: ${text}`);
		return reply;
	}

	release() {}
}

class MockPool {
	readonly client: MockClient;

	constructor(replies: Reply[]) {
		this.client = new MockClient(replies);
	}

	async connect() {
		return this.client;
	}
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PROMPT = "33333333-3333-4333-8333-333333333333";
const CREATED = "2026-07-15T10:00:00.000Z";

function job(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: JOB,
		project_id: PROJECT,
		prompt_id: PROMPT,
		prompt_slug: "support-agent",
		source_version: 3,
		target_role: "system",
		evaluator: { type: "default_adapter" },
		examples: [{ input: "question", answer: "answer" }],
		model_config: { task_lm: "task", reflection_lm: "reflection" },
		budget: { max_metric_calls: 1 },
		status: "evaluating",
		requested_by: "admin",
		result_version: null,
		error_message: null,
		created_at: CREATED,
		updated_at: CREATED,
		...overrides,
	};
}

function transactionPool(pool: MockPool): Pick<Pool, "connect"> {
	return pool as unknown as Pick<Pool, "connect">;
}

describe("prompt optimization repository", () => {
	it("publishes a system target while preserving canonical user content and replacing only the target message", async () => {
		const pool = new MockPool([
			{ rows: [] },
			{ rows: [job()] },
			{
				rows: [
					{
						id: PROMPT,
						slug: "support-agent",
						version: 3,
						model: "gpt-test",
						settings: { temperature: 0.2 },
					},
				],
			},
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		]);
		const messages = [
			{ role: "system" as const, content: "Improved system {{name}}" },
			{ role: "user" as const, content: "Original user {{name}}" },
		];

		expect(
			await publishOptimizationResult(transactionPool(pool), {
				id: JOB,
				messages,
			}),
		).toBe(4);
		const insert = pool.client.calls[3];
		expect(insert?.values[2]).toBe("Original user {{name}}");
		expect(JSON.parse(insert?.values[5] as string)).toEqual(messages);
	});

	it("reuses the active start row without recording a second queued event", async () => {
		const pool = new MockPool([
			{ rows: [] },
			{
				rows: [
					{
						prompt_id: PROMPT,
						messages: [{ role: "system", content: "Source" }],
					},
				],
			},
			{ rows: [{ ...job({ created: false }), created: false }] },
			{ rows: [] },
		]);

		const result = await createOptimizationJob(transactionPool(pool), {
			project_id: PROJECT,
			slug: "support-agent",
			source_version: 3,
			target: "system",
			evaluator: { type: "default_adapter" },
			examples: [{ input: "question", answer: "answer" }],
			model_config: { task_lm: "task", reflection_lm: "reflection" },
			budget: { max_metric_calls: 1 },
			actor: "admin",
		});

		expect(result.id).toBe(JOB);
		expect(pool.client.calls).toHaveLength(4);
		expect(pool.client.calls[2]?.text).toContain("ON CONFLICT");
	});

	it("does not turn a completed optimization into stopped when stop races completion", async () => {
		const pool = new MockPool([
			{ rows: [] },
			{ rows: [] },
			{ rows: [job({ status: "completed", result_version: 4 })] },
			{ rows: [] },
		]);

		await expect(
			stopOptimizationJob(transactionPool(pool), {
				project_id: PROJECT,
				id: JOB,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
		} satisfies Partial<PromptRepositoryError>);
		expect(pool.client.calls.map((call) => call.text)).not.toContain(
			expect.stringContaining("INSERT INTO prompt_optimization_events"),
		);
	});
});
