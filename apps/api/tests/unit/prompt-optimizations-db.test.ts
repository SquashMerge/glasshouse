import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import {
	claimOptimizationJob,
	createOptimizationJob,
	publishOptimizationResult,
	renewOptimizationJobLease,
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

class ClaimPool {
	private claimed = false;
	readonly calls: string[] = [];

	async connect() {
		return {
			query: async (text: string) => {
				this.calls.push(text);
				if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK")
					return { rows: [] };
				if (!this.claimed) {
					this.claimed = true;
					return { rows: [{ id: JOB }] };
				}
				return { rows: [] };
			},
			release() {},
		};
	}
}

class ReclaimPool {
	readonly calls: string[] = [];
	private attempt = 0;

	async connect() {
		return {
			query: async (text: string) => {
				this.calls.push(text);
				if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK")
					return { rows: [] };
				this.attempt += 1;
				return { rows: this.attempt === 1 ? [] : [{ id: JOB }] };
			},
			release() {},
		};
	}
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
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
	it("publishes a system target with canonical system content and replaces only the target message", async () => {
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
				worker_id: WORKER,
				messages,
			}),
		).toBe(4);
		const insert = pool.client.calls[3];
		expect(insert?.values[2]).toBe("Improved system {{name}}");
		expect(JSON.parse(insert?.values[5] as string)).toEqual(messages);
		expect(JSON.parse(pool.client.calls[5]?.values[1] as string)).toEqual({
			result_version: 4,
		});
	});

	it("persists a finite final score without candidate content in the event", async () => {
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

		await publishOptimizationResult(transactionPool(pool), {
			id: JOB,
			worker_id: WORKER,
			messages: [{ role: "system", content: "Improved system {{name}}" }],
			score: 0.875,
		});

		expect(JSON.parse(pool.client.calls[5]?.values[1] as string)).toEqual({
			result_version: 4,
			score: 0.875,
		});
	});

	it("publishes a historical snapshot as the next version", async () => {
		const pool = new MockPool([
			{ rows: [] },
			{ rows: [job({ source_version: 2 })] },
			{
				rows: [
					{
						id: PROMPT,
						slug: "support-agent",
						version: 4,
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
		const snapshot = [
			{ role: "system" as const, content: "Improved historical system" },
			{ role: "user" as const, content: "Historical user" },
		];

		expect(
			await publishOptimizationResult(transactionPool(pool), {
				id: JOB,
				worker_id: WORKER,
				messages: snapshot,
			}),
		).toBe(5);
		const insert = pool.client.calls[3];
		expect(insert?.values[1]).toBe(5);
		expect(JSON.parse(insert?.values[5] as string)).toEqual(snapshot);
	});

	it("allows exactly one concurrent worker claim", async () => {
		const pool = new ClaimPool();
		const [first, second] = await Promise.all([
			claimOptimizationJob(pool as unknown as Pick<Pool, "connect">, {
				id: JOB,
				worker_id: "11111111-1111-4111-8111-111111111111",
			}),
			claimOptimizationJob(pool as unknown as Pick<Pool, "connect">, {
				id: JOB,
				worker_id: "22222222-2222-4222-8222-222222222222",
			}),
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(
			pool.calls.some((call) =>
				call.includes("worker_lease_expires_at < now()"),
			),
		).toBe(true);
	});

	it("renews only the current worker lease", async () => {
		const calls: Call[] = [];
		const pool = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [{ id: JOB }] };
			},
		};

		expect(
			await renewOptimizationJobLease(pool, { id: JOB, worker_id: WORKER }),
		).toBe(true);
		expect(calls[0]?.text).toContain("worker_claim_id=$2");
		expect(calls[0]?.text).toContain("worker_lease_expires_at >= now()");
	});

	it("reclaims an expired lease while preserving one owner per claim attempt", async () => {
		const pool = new ReclaimPool();
		expect(
			await claimOptimizationJob(pool as unknown as Pick<Pool, "connect">, {
				id: JOB,
				worker_id: WORKER,
			}),
		).toBe(false);
		expect(
			await claimOptimizationJob(pool as unknown as Pick<Pool, "connect">, {
				id: JOB,
				worker_id: "22222222-2222-4222-8222-222222222222",
			}),
		).toBe(true);
		expect(pool.calls.find((call) => call.startsWith("UPDATE"))).toContain(
			"worker_lease_expires_at < now()",
		);
	});

	it("rejects publication by a worker whose lease was reclaimed", async () => {
		const pool = new MockPool([{ rows: [] }, { rows: [] }, { rows: [] }]);
		await expect(
			publishOptimizationResult(transactionPool(pool), {
				id: JOB,
				worker_id: WORKER,
				messages: [{ role: "system", content: "Improved" }],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(pool.client.calls[1]?.text).toContain(
			"worker_lease_expires_at >= now()",
		);
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
