import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import {
	MAX_DIFF_INPUT_CHARS,
	MAX_PROMPT_SOURCE_CHARS,
} from "../../src/lib/prompt-limits";
import {
	createPrompt,
	createPromptVersion,
	deletePrompt,
	getPrompt,
	listProjects,
	listPromptVersions,
	normalizePromptSlug,
	promptProvenanceStatus,
	PromptRepositoryError,
	renderPrompt,
	rollbackLatestPromptVersion,
	textualVersionDiff,
} from "../../src/db/prompts";

type Reply = { rows: Record<string, unknown>[] } | { error: unknown };
type QueryCall = { text: string; values: unknown[] };

class MockClient {
	readonly calls: QueryCall[] = [];
	released = false;

	constructor(private readonly replies: Reply[]) {}

	async query(
		text: string,
		values: unknown[] = [],
	): Promise<{ rows: Record<string, unknown>[] }> {
		if (text.includes("p.status = ANY($5::text[])")) {
			const reply = this.replies.shift();
			if (!reply) return { rows: [{ id: PROJECT }] };
			if ("error" in reply) throw reply.error;
			this.calls.push({
				text: "SELECT authorization_allows_project($1, $2, $3, $4)",
				values,
			});
			return reply;
		}
		if (text.includes("FROM organization_memberships om"))
			return { rows: [{ actor_subject: "writer" }] };
		if (text.includes("FROM project_memberships pm"))
			return { rows: [{ actor_subject: "writer" }] };
		if (text.startsWith("SELECT authorization_allows_project"))
			return { rows: [{ allowed: true }] };
		this.calls.push({ text, values });
		const reply = this.replies.shift();
		if (!reply) throw new Error(`Unexpected query: ${text}`);
		if ("error" in reply) throw reply.error;
		return reply;
	}

	release(): void {
		this.released = true;
	}
}

class MockPool {
	readonly calls: QueryCall[] = [];
	readonly client: MockClient;

	constructor(readReplies: Reply[] = [], transactionReplies: Reply[] = []) {
		this.readReplies = readReplies;
		this.client = new MockClient(transactionReplies);
	}

	private readonly readReplies: Reply[];

	async query(
		text: string,
		values: unknown[] = [],
	): Promise<{ rows: Record<string, unknown>[] }> {
		this.calls.push({ text, values });
		const reply = this.readReplies.shift();
		if (!reply) throw new Error(`Unexpected query: ${text}`);
		if ("error" in reply) throw reply.error;
		return reply;
	}

	async connect(): Promise<MockClient> {
		return this.client;
	}
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-07-15T10:00:00.000Z";
const HASH = "a".repeat(64);
const authorization = {
	organization_id: "33333333-3333-4333-8333-333333333333",
	actor_id: "44444444-4444-4444-8444-444444444444",
	operation: "product_write" as const,
};

const versionRow = {
	slug: "support-agent",
	version: 2,
	messages: [{ role: "system", content: "Current {{customer}}" }],
	model: "gpt-test",
	settings: { temperature: 0.4 },
	change_summary: "Clarify customer context",
	created_by: "trusted-admin",
	created_at: CREATED_AT,
	content_hash: HASH,
	previous_messages: [{ role: "system", content: "Previous {{customer}}" }],
};

function transactionPool(pool: MockPool): Pick<Pool, "connect"> {
	return pool as unknown as Pick<Pool, "connect">;
}

function readPool(pool: MockPool): Pick<Pool, "query"> {
	return pool as unknown as Pick<Pool, "query">;
}

async function expectError(
	action: Promise<unknown>,
	code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
): Promise<void> {
	try {
		await action;
		throw new Error("Expected PromptRepositoryError");
	} catch (cause) {
		expect(cause).toBeInstanceOf(PromptRepositoryError);
		expect((cause as PromptRepositoryError).code).toBe(code);
	}
}

describe("prompt repository", () => {
	it("lists only projects belonging to the requested organization", async () => {
		const pool = new MockPool([
			{ rows: [{ total: "2" }] },
			{
				rows: [
					{
						id: PROJECT,
						name: "Project One",
						slug: "project-one",
						created_at: CREATED_AT,
					},
					{
						id: OTHER_PROJECT,
						name: "Project Two",
						slug: "project-two",
						created_at: CREATED_AT,
					},
				],
			},
		]);

		expect(
			await listProjects(
				readPool(pool),
				"00000000-0000-4000-8000-000000000001",
			),
		).toEqual({
			total: 2,
			items: [
				{
					id: PROJECT,
					name: "Project One",
					slug: "project-one",
					created_at: CREATED_AT,
				},
				{
					id: OTHER_PROJECT,
					name: "Project Two",
					slug: "project-two",
					created_at: CREATED_AT,
				},
			],
		});
		expect(pool.calls[1]?.text).toContain(
			"FROM projects WHERE organization_id = $1 ORDER BY slug ASC",
		);
		expect(pool.calls[1]?.values).toEqual([
			"00000000-0000-4000-8000-000000000001",
		]);
	});

	it("normalizes canonical slugs and generates a dependency-free textual diff", () => {
		expect(normalizePromptSlug("  Support__Agent !!  ")).toBe("support-agent");
		expect(normalizePromptSlug(" !!! ")).toBe("prompt");
		expect(normalizePromptSlug("a".repeat(80))).toBe("a".repeat(64));
		expect(textualVersionDiff("one\ntwo", "one\nthree")).toBe(
			"--- previous\n+++ current\n one\n+three\n-two",
		);
		try {
			textualVersionDiff("x".repeat(MAX_DIFF_INPUT_CHARS + 1), "changed");
			throw new Error("Expected PromptRepositoryError");
		} catch (cause) {
			expect(cause).toBeInstanceOf(PromptRepositoryError);
			expect((cause as PromptRepositoryError).code).toBe("BAD_REQUEST");
			expect((cause as PromptRepositoryError).message).toContain(
				"Prompt diff previous source exceeds",
			);
		}
		try {
			textualVersionDiff(`${"x\n".repeat(512)}x`, "changed");
			throw new Error("Expected PromptRepositoryError");
		} catch (cause) {
			expect(cause).toBeInstanceOf(PromptRepositoryError);
			expect((cause as PromptRepositoryError).message).toContain(
				"Prompt diff previous source exceeds 512 lines",
			);
		}
	});

	it("rejects oversized prompt messages before opening a transaction", async () => {
		const pool = new MockPool();
		await expectError(
			createPrompt(transactionPool(pool), {
				project_id: PROJECT,
				name: "Support Agent",
				messages: [
					{ role: "system", content: "x".repeat(MAX_PROMPT_SOURCE_CHARS + 1) },
				],
				actor: "trusted-admin",
				authorization,
			}),
			"BAD_REQUEST",
		);
		expect(pool.client.calls).toHaveLength(0);
	});

	it("creates a combined message snapshot with context actor and no public UUID", async () => {
		const pool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [] },
				{
					rows: [
						{
							project_id: PROJECT,
							name: "Support Agent",
							slug: "support-agent",
							description: null,
						},
					],
				},
				{
					rows: [
						{
							...versionRow,
							slug: "support-agent",
							version: 1,
							messages: [
								{ role: "system", content: "Help {{customer}}" },
								{ role: "user", content: "How can I help {{customer}}?" },
							],
							previous_messages: null,
							model: null,
							settings: {},
							change_summary: "Initial version",
						},
					],
				},
				{ rows: [] },
			],
		);

		const result = await createPrompt(transactionPool(pool), {
			project_id: PROJECT,
			name: "Support Agent",
			messages: [
				{ role: "system", content: "Help {{customer}}" },
				{ role: "user", content: "How can I help {{customer}}?" },
			],
			actor: "trusted-admin",
			authorization,
		});

		expect(result).toEqual({
			id: "support-agent",
			project_id: PROJECT,
			name: "Support Agent",
			description: null,
			version: 1,
			messages: [
				{ role: "system", content: "Help {{customer}}" },
				{ role: "user", content: "How can I help {{customer}}?" },
			],
			model: null,
			settings: {},
			change_summary: "Initial version",
			created_by: "trusted-admin",
			created_at: CREATED_AT,
			content_hash: HASH,
			diff: null,
		});
		expect(JSON.stringify(result)).not.toContain("internal-prompt-id");
		expect(pool.client.calls[2]?.text).toContain("pg_advisory_xact_lock");
		expect(pool.client.calls[2]?.values).toEqual([
			`prompt:${PROJECT}:support-agent`,
		]);
		expect(pool.client.calls[6]?.values?.slice(1, 8)).toEqual([
			1,
			"How can I help {{customer}}?",
			null,
			"{}",
			'[{"role":"system","content":"Help {{customer}}"},{"role":"user","content":"How can I help {{customer}}?"}]',
			"Initial version",
			"trusted-admin",
		]);
		expect(pool.client.calls.map((call) => call.text)).toEqual([
			"BEGIN",
			expect.stringContaining("authorization_allows_project"),
			expect.stringContaining("pg_advisory_xact_lock"),
			expect.stringContaining("prompt_tombstones"),
			expect.stringContaining("FROM prompts"),
			expect.stringContaining("INSERT INTO prompts"),
			expect.stringContaining("INSERT INTO prompt_versions"),
			"COMMIT",
		]);
	});

	it("uses stable numeric candidates when a project-local slug collides", async () => {
		const pool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [{ slug: "support-agent" }] },
				{ rows: [] },
				{ rows: [{ slug: "support-agent-2" }] },
				{ rows: [] },
				{ rows: [] },
				{
					rows: [
						{
							project_id: PROJECT,
							name: "Support Agent",
							slug: "support-agent-3",
							description: null,
						},
					],
				},
				{
					rows: [
						{
							...versionRow,
							slug: "support-agent-3",
							version: 1,
							messages: [{ role: "system", content: "source" }],
							previous_messages: null,
							model: null,
							settings: {},
							change_summary: "Initial version",
						},
					],
				},
				{ rows: [] },
			],
		);

		const result = await createPrompt(transactionPool(pool), {
			project_id: PROJECT,
			name: "Support Agent",
			messages: [{ role: "system", content: "source" }],
			actor: "trusted-admin",
			authorization,
		});

		expect(result.id).toBe("support-agent-3");
		expect(result.id.length).toBeLessThanOrEqual(64);
		expect(pool.client.calls[5]?.values).toEqual([PROJECT, "support-agent-2"]);
		expect(pool.client.calls[6]?.values).toEqual([PROJECT, "support-agent-2"]);
		expect(pool.client.calls[7]?.values).toEqual([PROJECT, "support-agent-3"]);
		expect(pool.client.calls[9]?.values?.[3]).toBe("support-agent-3");

		const longName = "a".repeat(64);
		const longPool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [{ slug: longName }] },
				{ rows: [] },
				{ rows: [] },
				{
					rows: [
						{
							project_id: PROJECT,
							name: longName,
							slug: `${"a".repeat(62)}-2`,
							description: null,
						},
					],
				},
				{
					rows: [
						{
							...versionRow,
							slug: `${"a".repeat(62)}-2`,
							version: 1,
							messages: [{ role: "system", content: "source" }],
							previous_messages: null,
							model: null,
							settings: {},
							change_summary: "Initial version",
						},
					],
				},
				{ rows: [] },
			],
		);
		const longResult = await createPrompt(transactionPool(longPool), {
			project_id: PROJECT,
			name: longName,
			messages: [{ role: "system", content: "source" }],
			actor: "trusted-admin",
			authorization,
		});
		expect(longResult.id).toBe(`${"a".repeat(62)}-2`);
		expect(longResult.id).toHaveLength(64);
	});

	it("prohibits recreation of a tombstoned canonical slug", async () => {
		const pool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [{ slug: "support-agent" }] },
				{ rows: [] },
			],
		);

		await expectError(
			createPrompt(transactionPool(pool), {
				project_id: PROJECT,
				name: "Support Agent",
				messages: [{ role: "system", content: "source" }],
				actor: "trusted-admin",
				authorization,
			}),
			"CONFLICT",
		);
		expect(pool.client.calls.map((call) => call.text)).toEqual([
			"BEGIN",
			expect.stringContaining("authorization_allows_project"),
			expect.stringContaining("pg_advisory_xact_lock"),
			expect.stringContaining("prompt_tombstones"),
			"ROLLBACK",
		]);
	});

	it("inherits omitted model and settings, replaces explicit settings, and rejects stale bases", async () => {
		const inheritancePool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [{ id: "internal-prompt-id", slug: "support-agent" }] },
				{ rows: [] },
				{
					rows: [
						{ version: 2, model: "gpt-test", settings: { temperature: 0.4 } },
					],
				},
				{
					rows: [
						{
							...versionRow,
							version: 3,
							messages: [{ role: "user", content: "new source" }],
							previous_messages: null,
						},
					],
				},
				{ rows: [] },
			],
		);

		const inherited = await createPromptVersion(
			transactionPool(inheritancePool),
			{
				project_id: PROJECT,
				slug: "support-agent",
				base_version: 2,
				messages: [{ role: "user", content: "new source" }],
				change_summary: "Add detail",
				actor: "trusted-admin",
				authorization,
			},
		);

		expect(inherited.version).toBe(3);
		expect(inheritancePool.client.calls[5]?.values?.slice(1, 6)).toEqual([
			3,
			"new source",
			"gpt-test",
			'{"temperature":0.4}',
			'[{"role":"user","content":"new source"}]',
		]);

		const stalePool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [{ id: "internal-prompt-id", slug: "support-agent" }] },
				{ rows: [] },
				{ rows: [{ version: 3, model: null, settings: {} }] },
				{ rows: [] },
			],
		);
		await expectError(
			createPromptVersion(transactionPool(stalePool), {
				project_id: PROJECT,
				slug: "support-agent",
				base_version: 2,
				messages: [{ role: "user", content: "new source" }],
				model: null,
				settings: {},
				change_summary: "Reset model and settings",
				actor: "trusted-admin",
				authorization,
			}),
			"CONFLICT",
		);
		expect(stalePool.client.calls.map((call) => call.text)).toEqual([
			"BEGIN",
			expect.stringContaining("authorization_allows_project"),
			expect.stringContaining("FROM prompts"),
			expect.stringContaining("prompt_optimization_jobs"),
			expect.stringContaining("FROM prompt_versions"),
			"ROLLBACK",
		]);

		const replacementPool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [{ id: "internal-prompt-id", slug: "support-agent" }] },
				{ rows: [] },
				{
					rows: [
						{ version: 2, model: "gpt-test", settings: { temperature: 0.4 } },
					],
				},
				{
					rows: [
						{
							...versionRow,
							version: 3,
							messages: [{ role: "user", content: "cleared source" }],
							model: null,
							settings: {},
							previous_messages: null,
						},
					],
				},
				{ rows: [] },
			],
		);
		const cleared = await createPromptVersion(
			transactionPool(replacementPool),
			{
				project_id: PROJECT,
				slug: "support-agent",
				base_version: 2,
				messages: [{ role: "user", content: "cleared source" }],
				model: null,
				settings: {},
				change_summary: "Clear model and settings",
				actor: "trusted-admin",
				authorization,
			},
		);
		expect(cleared.model).toBeNull();
		expect(cleared.settings).toEqual({});
		expect(replacementPool.client.calls[5]?.values?.slice(3, 5)).toEqual([
			null,
			"{}",
		]);

		const invalidSettingsPool = new MockPool();
		await expectError(
			createPromptVersion(transactionPool(invalidSettingsPool), {
				project_id: PROJECT,
				slug: "support-agent",
				base_version: 2,
				messages: [{ role: "user", content: "source" }],
				settings: null as never,
				change_summary: "Reject null settings",
				actor: "trusted-admin",
				authorization,
			}),
			"BAD_REQUEST",
		);
		expect(invalidSettingsPool.client.calls).toHaveLength(0);
	});

	it("returns exact message collections and version history only through project-scoped queries", async () => {
		const getPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						...versionRow,
						project_id: PROJECT,
						name: "Support Agent",
						description: "Helpful",
					},
				],
			},
		]);
		const prompt = await getPrompt(readPool(getPool), {
			project_id: PROJECT,
			slug: "support-agent",
			version: 2,
		});

		expect(prompt.messages).toEqual([
			{ role: "system", content: "Current {{customer}}" },
		]);
		expect(prompt.diff).toContain("Current {{customer}}");
		expect(getPool.calls[1]?.values).toEqual([PROJECT, "support-agent", 2]);
		expect(getPool.calls[1]?.text).toContain(
			"p.project_id = $1 AND p.slug = $2",
		);
		expect(JSON.stringify(prompt)).not.toContain("internal-prompt-id");

		const malformedPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						...versionRow,
						project_id: PROJECT,
						name: "Legacy Prompt",
						description: null,
						version: 1,
						messages: [{ role: "system", content: "Malformed {{template" }],
						previous_messages: null,
					},
				],
			},
		]);
		const malformed = await getPrompt(readPool(malformedPool), {
			project_id: PROJECT,
			slug: "support-agent",
			version: 1,
		});
		expect(malformed.messages).toEqual([
			{ role: "system", content: "Malformed {{template" },
		]);

		const oversizedLegacyPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						...versionRow,
						project_id: PROJECT,
						name: "Legacy Prompt",
						description: null,
						messages: [{ role: "system", content: "current legacy source" }],
						previous_messages: [
							{ role: "system", content: "x".repeat(MAX_DIFF_INPUT_CHARS + 1) },
						],
					},
				],
			},
		]);
		const oversizedLegacy = await getPrompt(readPool(oversizedLegacyPool), {
			project_id: PROJECT,
			slug: "support-agent",
			version: 2,
		});
		expect(oversizedLegacy.messages).toEqual([
			{ role: "system", content: "current legacy source" },
		]);
		expect(oversizedLegacy.diff).toBeNull();

		const historyPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					versionRow,
					{
						...versionRow,
						version: 1,
						messages: [{ role: "system", content: "Previous {{customer}}" }],
						previous_messages: null,
					},
				],
			},
		]);
		const history = await listPromptVersions(readPool(historyPool), {
			project_id: PROJECT,
			slug: "support-agent",
		});
		expect(history.items.map((item) => item.version)).toEqual([2, 1]);
		expect(history.items[0]?.messages).toEqual([
			{ role: "system", content: "Current {{customer}}" },
		]);
		expect(historyPool.calls[1]?.values).toEqual([PROJECT, "support-agent"]);
	});

	it("does not reveal a prompt from another project", async () => {
		const pool = new MockPool([
			{ rows: [{ id: OTHER_PROJECT }] },
			{ rows: [] },
		]);

		await expectError(
			getPrompt(readPool(pool), {
				project_id: OTHER_PROJECT,
				slug: "support-agent",
			}),
			"NOT_FOUND",
		);
		expect(pool.calls[1]?.values).toEqual([OTHER_PROJECT, "support-agent"]);
	});

	it("renders each stored prompt message from valid nested JSON with deterministic missing-variable warnings", async () => {
		const pool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						...versionRow,
						project_id: PROJECT,
						name: "Support Agent",
						description: null,
						version: 1,
						messages: [
							{
								role: "system",
								content: "Hello {{customer.name}} {{missing}}",
							},
							{ role: "user", content: "Help {{customer.name}}" },
						],
						previous_messages: null,
					},
				],
			},
		]);
		const rendered = await renderPrompt(readPool(pool), {
			project_id: PROJECT,
			slug: "support-agent",
			data: { customer: { name: "Ada" } },
		});

		expect(rendered).toEqual({
			id: "support-agent",
			version: 1,
			content_hash: HASH,
			messages: [
				{ role: "system", content: "Hello Ada " },
				{ role: "user", content: "Help Ada" },
			],
			warnings: [{ code: "MISSING_VARIABLE", role: "system", path: "missing" }],
		});

		const oversizedSourcePool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						...versionRow,
						project_id: PROJECT,
						name: "Legacy Prompt",
						description: null,
						messages: [
							{
								role: "system",
								content: "x".repeat(MAX_PROMPT_SOURCE_CHARS + 1),
							},
						],
						previous_messages: null,
					},
				],
			},
		]);
		await expectError(
			renderPrompt(readPool(oversizedSourcePool), {
				project_id: PROJECT,
				slug: "support-agent",
				data: {},
			}),
			"BAD_REQUEST",
		);
	});

	it("requires raw slug confirmation and only deletes same-project quarantine data with the prompt", async () => {
		const rejectedPool = new MockPool();
		await expectError(
			deletePrompt(transactionPool(rejectedPool), {
				project_id: PROJECT,
				slug: "support-agent",
				confirmation: "support-agent@2",
				actor: "trusted-admin",
				authorization,
			}),
			"BAD_REQUEST",
		);
		expect(rejectedPool.client.calls).toHaveLength(0);

		const pool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [{ id: "internal-prompt-id", slug: "support-agent" }] },
				{ rows: [{ total: "2" }] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [] },
				{ rows: [] },
			],
		);
		await deletePrompt(transactionPool(pool), {
			project_id: PROJECT,
			slug: "support-agent",
			confirmation: "support-agent",
			actor: "trusted-admin",
			authorization,
		});

		expect(pool.client.calls[2]?.text).toContain("pg_advisory_xact_lock");
		expect(pool.client.calls[2]?.values).toEqual([
			`prompt:${PROJECT}:support-agent`,
		]);
		expect(pool.client.calls[6]?.text).toContain("DELETE FROM prompt_labels");
		expect(pool.client.calls[7]?.text).toContain(
			"DELETE FROM prompt_label_quarantine",
		);
		expect(pool.client.calls[7]?.text).toContain("original_project_id = $2");
		expect(pool.client.calls[7]?.values).toEqual([
			"internal-prompt-id",
			PROJECT,
		]);
		expect(pool.client.calls[8]?.text).toContain(
			"prompt_deletion_audit (project_id, prompt_id, slug, deleted_by, deleted_version_count)",
		);
		expect(pool.client.calls[8]?.text).not.toContain("content");
		expect(pool.client.calls[8]?.text).not.toContain("settings");
		expect(pool.client.calls[8]?.values).toEqual([
			PROJECT,
			"internal-prompt-id",
			"support-agent",
			"trusted-admin",
			2,
		]);
		expect(pool.client.calls[9]?.text).toContain(
			"INSERT INTO prompt_tombstones",
		);
		expect(pool.client.calls[10]?.text).toContain("DELETE FROM prompts");
		expect(pool.client.released).toBe(true);
	});

	it("rolls back only the locked latest version, preserving its labels on the restored version", async () => {
		const previousRow = {
			...versionRow,
			version: 1,
			previous_messages: null,
			version_id: "previous-version-id",
		};
		const latestRow = {
			...versionRow,
			version: 2,
			version_id: "latest-version-id",
		};
		const pool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{
					rows: [
						{
							...latestRow,
							prompt_id: "internal-prompt-id",
							project_id: PROJECT,
							name: "Support Agent",
							description: null,
						},
						{
							...previousRow,
							prompt_id: "internal-prompt-id",
							project_id: PROJECT,
							name: "Support Agent",
							description: null,
						},
					],
				},
				{ rows: [] },
				{ rows: [] },
				{ rows: [{ id: "latest-version-id" }] },
				{ rows: [] },
			],
		);

		expect(
			await rollbackLatestPromptVersion(transactionPool(pool), {
				project_id: PROJECT,
				slug: "support-agent",
				authorization,
			}),
		).toMatchObject({ id: "support-agent", version: 1, project_id: PROJECT });
		expect(pool.client.calls[2]?.text).toContain("FOR UPDATE OF p, v");
		expect(pool.client.calls[3]?.text).toContain("prompt_optimization_jobs");
		expect(pool.client.calls[4]?.text).toContain("UPDATE prompt_labels");
		expect(pool.client.calls[4]?.values).toEqual([
			"previous-version-id",
			PROJECT,
			"internal-prompt-id",
			"latest-version-id",
		]);
		expect(pool.client.calls[5]?.text).toContain("DELETE FROM prompt_versions");

		const firstVersionPool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{
					rows: [
						{
							...previousRow,
							prompt_id: "internal-prompt-id",
							project_id: PROJECT,
							name: "Support Agent",
							description: null,
						},
					],
				},
				{ rows: [] },
			],
		);
		await expectError(
			rollbackLatestPromptVersion(transactionPool(firstVersionPool), {
				project_id: PROJECT,
				slug: "support-agent",
				authorization,
			}),
			"CONFLICT",
		);

		const activePool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{
					rows: [
						{
							...latestRow,
							prompt_id: "internal-prompt-id",
							project_id: PROJECT,
							name: "Support Agent",
							description: null,
						},
						{
							...previousRow,
							prompt_id: "internal-prompt-id",
							project_id: PROJECT,
							name: "Support Agent",
							description: null,
						},
					],
				},
				{ rows: [{ id: "active-job" }] },
				{ rows: [] },
			],
		);
		await expectError(
			rollbackLatestPromptVersion(transactionPool(activePool), {
				project_id: PROJECT,
				slug: "support-agent",
				authorization,
			}),
			"CONFLICT",
		);

		const isolatedPool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: OTHER_PROJECT }] },
				{ rows: [] },
				{ rows: [] },
			],
		);
		await expectError(
			rollbackLatestPromptVersion(transactionPool(isolatedPool), {
				project_id: OTHER_PROJECT,
				slug: "support-agent",
				authorization: { ...authorization, organization_id: OTHER_PROJECT },
			}),
			"NOT_FOUND",
		);
	});

	it("returns conflicts for tombstoned deletion and resolves provenance as deleted before historical tuple checks", async () => {
		const deletePool = new MockPool(
			[],
			[
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
				{ rows: [{ slug: "support-agent" }] },
				{ rows: [] },
			],
		);
		await expectError(
			deletePrompt(transactionPool(deletePool), {
				project_id: PROJECT,
				slug: "support-agent",
				confirmation: "support-agent",
				actor: "trusted-admin",
				authorization,
			}),
			"CONFLICT",
		);
		expect(deletePool.client.calls[4]?.text).toBe("ROLLBACK");

		const statusPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ status: "deleted" }] },
		]);
		expect(
			await promptProvenanceStatus(readPool(statusPool), {
				project_id: PROJECT,
				slug: "support-agent",
				version: 99,
				content_hash: "b".repeat(64),
			}),
		).toBe("deleted");
		expect(statusPool.calls).toHaveLength(2);

		expect(statusPool.calls[1]?.text).toContain("SELECT CASE");
		expect(statusPool.calls[1]?.text).toContain("prompt_tombstones");
		expect(statusPool.calls[1]?.text).toContain("INNER JOIN prompt_versions");

		const activePool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ status: "active" }] },
		]);
		expect(
			await promptProvenanceStatus(readPool(activePool), {
				project_id: PROJECT,
				slug: "support-agent",
				version: 2,
				content_hash: HASH,
			}),
		).toBe("active");

		const unknownPool = new MockPool([
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ status: "unknown" }] },
		]);
		expect(
			await promptProvenanceStatus(readPool(unknownPool), {
				project_id: PROJECT,
				slug: "support-agent",
				version: 2,
				content_hash: HASH,
			}),
		).toBe("unknown");
		expect(activePool.calls).toHaveLength(2);
		expect(unknownPool.calls).toHaveLength(2);

		const missingProjectPool = new MockPool([{ rows: [] }]);
		await expectError(
			promptProvenanceStatus(readPool(missingProjectPool), {
				project_id: OTHER_PROJECT,
				slug: "support-agent",
				version: 2,
				content_hash: HASH,
			}),
			"NOT_FOUND",
		);
		expect(missingProjectPool.calls).toHaveLength(1);
	});
});
