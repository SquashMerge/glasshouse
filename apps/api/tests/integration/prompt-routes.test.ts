import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { PromptRepositoryError } from "../../src/db/prompts";
import {
	TRUSTED_ACTOR_CONTEXT_KEY,
	TRUSTED_TENANT_CONTEXT_KEY,
} from "../../src/middleware/auth";
import {
	createPrompt,
	createPromptRouteHandlers,
	createPromptVersion,
	deletePrompt,
	getPrompt,
	listPromptVersions,
	listPrompts,
	previewPrompt,
	renderPrompt,
	rollbackLatestPromptVersion,
} from "../../src/routes/prompts";
import {
	createProjectRouteHandlers,
	listProjects,
} from "../../src/routes/projects";
import {
	createPromptProvenanceRouteHandlers,
	getPromptProvenance,
} from "../../src/routes/prompt-provenance";

const createPromptRecord = mock(
	async (_pool: unknown, input: Record<string, unknown>) => ({
		id: "support-agent",
		project_id: input.project_id,
		name: input.name,
		description: null,
		version: 1,
		messages: input.messages,
		model: null,
		settings: {},
		change_summary: "Initial version",
		created_by: input.actor,
		created_at: "2026-07-15T10:00:00.000Z",
		content_hash: "a".repeat(64),
		diff: null,
	}),
);
const deletePromptRecord = mock(
	async (_pool: unknown, input: { slug: string; confirmation: string }) => {
		if (input.slug !== input.confirmation) {
			throw new PromptRepositoryError(
				"BAD_REQUEST",
				"confirmation must equal the prompt identifier",
			);
		}
	},
);
const getPromptRecord = mock(async () => {
	throw new PromptRepositoryError("NOT_FOUND", "Prompt or version not found");
});
const listProjectsRecord = mock(async () => ({
	items: [
		{
			id: "11111111-1111-4111-8111-111111111111",
			name: "Project One",
			slug: "project-one",
			created_at: "2026-07-15T10:00:00.000Z",
		},
	],
	total: 1,
}));
const PROMPT_VERSION = {
	id: "support-agent",
	version: 2,
	messages: [
		{ role: "system" as const, content: "Follow up for {{customer}}" },
		{ role: "user" as const, content: "How can I help {{customer}}?" },
	],
	model: null,
	settings: {},
	change_summary: "Add follow-up",
	created_by: "context-admin",
	created_at: "2026-07-15T10:00:00.000Z",
	content_hash: "b".repeat(64),
	diff: "--- previous\n+++ current\n+Follow up for {{customer}}",
};
const PROMPT = {
	...PROMPT_VERSION,
	version: 1,
	messages: [
		{ role: "system" as const, content: "Help {{customer}}" },
		{ role: "user" as const, content: "How can I help {{customer}}?" },
	],
	content_hash: "a".repeat(64),
	diff: null,
	project_id: "11111111-1111-4111-8111-111111111111",
	name: "Support Agent",
	description: null,
};
const listPromptsRecord = mock(async (_pool: unknown, projectId: string) => {
	if (projectId === OTHER_PROJECT)
		throw new PromptRepositoryError("NOT_FOUND", "Project not found");
	return { items: [PROMPT], total: 1 };
});
const listPromptVersionsRecord = mock(
	async (_pool: unknown, input: { project_id: string }) => {
		if (input.project_id === OTHER_PROJECT)
			throw new PromptRepositoryError("NOT_FOUND", "Prompt not found");
		return { items: [PROMPT_VERSION] };
	},
);
const createPromptVersionRecord = mock(
	async (_pool: unknown, input: { base_version: number }) => {
		if (input.base_version !== 1)
			throw new PromptRepositoryError(
				"CONFLICT",
				"Prompt base version is stale",
			);
		return PROMPT_VERSION;
	},
);
const rollbackLatestPromptVersionRecord = mock(async () => PROMPT);
const promptProvenanceStatus = mock(
	async (_pool: unknown, input: { project_id: string }) => {
		if (input.project_id === OTHER_PROJECT)
			throw new PromptRepositoryError("NOT_FOUND", "Project not found");
		return "active" as const;
	},
);
const renderPromptRecord = mock(async () => ({
	id: "support-agent",
	version: 1,
	content_hash: "a".repeat(64),
	messages: [{ role: "user" as const, content: "Hello Ada" }],
	warnings: [],
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

function app() {
	const pool = () => ({}) as never;
	const promptHandlers = createPromptRouteHandlers({
		pool,
		createPrompt: createPromptRecord,
		createPromptVersion: createPromptVersionRecord,
		deletePrompt: deletePromptRecord,
		getPrompt: getPromptRecord,
		listPromptVersions: listPromptVersionsRecord,
		listPrompts: listPromptsRecord,
		renderPrompt: renderPromptRecord,
		rollbackLatestPromptVersion: rollbackLatestPromptVersionRecord,
	});
	const projectHandlers = createProjectRouteHandlers({
		pool,
		listProjects: listProjectsRecord,
	});
	const promptProvenanceHandlers = createPromptProvenanceRouteHandlers({
		pool,
		promptProvenanceStatus,
	});
	const api = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	api.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_ACTOR_CONTEXT_KEY, "context-admin");
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "context-admin",
			organizationId: "00000000-0000-4000-8000-000000000001",
		});
		await next();
	});
	api.use("/v1/prompts/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	api.use("/v1/prompt-provenance/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	api.openapi(createPrompt, promptHandlers.handleCreatePrompt);
	api.openapi(deletePrompt, promptHandlers.handleDeletePrompt);
	api.openapi(getPrompt, promptHandlers.handleGetPrompt);
	api.openapi(listPrompts, promptHandlers.handleListPrompts);
	api.openapi(listPromptVersions, promptHandlers.handleListPromptVersions);
	api.openapi(createPromptVersion, promptHandlers.handleCreatePromptVersion);
	api.openapi(
		rollbackLatestPromptVersion,
		promptHandlers.handleRollbackLatestPromptVersion,
	);
	api.openapi(previewPrompt, promptHandlers.handlePreviewPrompt);
	api.openapi(renderPrompt, promptHandlers.handleRenderPrompt);
	api.openapi(listProjects, projectHandlers.handleListProjects);
	api.openapi(
		getPromptProvenance,
		promptProvenanceHandlers.handleGetPromptProvenance,
	);
	return api;
}

describe("prompt route contracts", () => {
	it("lists all projects for the globally trusted administrator", async () => {
		listProjectsRecord.mockClear();
		const response = await app().request("/v1/projects");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			items: [
				{
					id: PROJECT,
					name: "Project One",
					slug: "project-one",
					created_at: "2026-07-15T10:00:00.000Z",
				},
			],
			total: 1,
		});
		expect(listProjectsRecord.mock.calls[0]).toEqual([
			expect.anything(),
			"00000000-0000-4000-8000-000000000001",
		]);
	});

	it("uses the trusted context actor rather than a request actor and returns public prompt ids", async () => {
		createPromptRecord.mockClear();
		const response = await app().request("/v1/prompts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: PROJECT,
				name: "Support Agent",
				messages: [
					{ role: "system", content: "Help {{customer}}" },
					{ role: "user", content: "How can I help {{customer}}?" },
				],
			}),
		});

		expect(response.status).toBe(201);
		const body = await response.json();
		expect(body).toEqual({
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
			created_by: "context-admin",
			created_at: "2026-07-15T10:00:00.000Z",
			content_hash: "a".repeat(64),
			diff: null,
		});
		expect(createPromptRecord.mock.calls[0]?.[1]).toMatchObject({
			actor: "context-admin",
		});
		expect(JSON.stringify(body)).not.toContain("internal-prompt-id");
	});

	it("rejects unknown body fields with the standard error envelope", async () => {
		const response = await app().request("/v1/prompts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: PROJECT,
				name: "Support Agent",
				messages: [{ role: "system", content: "source" }],
				actor: "spoofed",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: "BAD_REQUEST",
			message: "Request validation failed",
		});
	});

	it("rejects source character and line budgets at the strict API boundary", async () => {
		createPromptRecord.mockClear();
		const longSource = await app().request("/v1/prompts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: PROJECT,
				name: "Support Agent",
				messages: [{ role: "system", content: "x".repeat(32_769) }],
			}),
		});
		const manyLines = await app().request("/v1/prompts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: PROJECT,
				name: "Support Agent",
				messages: [{ role: "system", content: `${"x\n".repeat(512)}x` }],
			}),
		});

		expect(longSource.status).toBe(400);
		expect(manyLines.status).toBe(400);
		expect(createPromptRecord).not.toHaveBeenCalled();
	});

	it("lists, histories, and versions prompts with project-scoped route errors", async () => {
		listPromptsRecord.mockClear();
		listPromptVersionsRecord.mockClear();
		createPromptVersionRecord.mockClear();
		const listed = await app().request(`/v1/prompts?project_id=${PROJECT}`);
		const missingProject = await app().request("/v1/prompts");
		const crossProject = await app().request(
			`/v1/prompts?project_id=${OTHER_PROJECT}`,
		);
		const history = await app().request(
			`/v1/prompts/support-agent/versions?project_id=${PROJECT}`,
		);
		const crossProjectHistory = await app().request(
			`/v1/prompts/support-agent/versions?project_id=${OTHER_PROJECT}`,
		);
		const created = await app().request(
			`/v1/prompts/support-agent/versions?project_id=${PROJECT}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					base_version: 1,
					messages: [
						{ role: "system", content: "Follow up for {{customer}}" },
						{ role: "user", content: "How can I help {{customer}}?" },
					],
					settings: {},
					change_summary: "Add follow-up",
				}),
			},
		);
		const stale = await app().request(
			`/v1/prompts/support-agent/versions?project_id=${PROJECT}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					base_version: 2,
					messages: [{ role: "system", content: "Follow up for {{customer}}" }],
					change_summary: "Stale",
				}),
			},
		);

		expect(await listed.json()).toEqual({ items: [PROMPT], total: 1 });
		expect(missingProject.status).toBe(400);
		expect(await missingProject.json()).toEqual({
			code: "BAD_REQUEST",
			message: "Request validation failed",
		});
		expect(crossProject.status).toBe(404);
		expect(await crossProject.json()).toEqual({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(await history.json()).toEqual({ items: [PROMPT_VERSION] });
		expect(crossProjectHistory.status).toBe(404);
		expect(await crossProjectHistory.json()).toEqual({
			code: "NOT_FOUND",
			message: "Prompt not found",
		});
		expect(created.status).toBe(201);
		expect(created.headers.get("Cache-Control")).toBe("no-store");
		expect(await created.json()).toEqual(PROMPT_VERSION);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			code: "CONFLICT",
			message: "Prompt base version is stale",
		});
		expect(listPromptsRecord.mock.calls[0]?.[1]).toBe(PROJECT);
		expect(listPromptVersionsRecord.mock.calls[0]?.[1]).toEqual({
			project_id: PROJECT,
			slug: "support-agent",
		});
		expect(createPromptVersionRecord.mock.calls[0]?.[1]).toMatchObject({
			project_id: PROJECT,
			slug: "support-agent",
			actor: "context-admin",
		});
	});

	it("authenticates and returns the restored prompt from a project-scoped rollback", async () => {
		rollbackLatestPromptVersionRecord.mockClear();
		const response = await app().request(
			`/v1/prompts/support-agent/versions/rollback?project_id=${PROJECT}`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(PROMPT);
		expect(rollbackLatestPromptVersionRecord).toHaveBeenCalledWith(
			expect.anything(),
			{ project_id: PROJECT, slug: "support-agent" },
		);
	});

	it("rejects oversized render data before the render handler and preserves normal rendering", async () => {
		renderPromptRecord.mockClear();
		const oversized = await app().request(
			`/v1/prompts/support-agent/render?project_id=${PROJECT}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ data: { x: "x".repeat(32_767) } }),
			},
		);
		const normal = await app().request(
			`/v1/prompts/support-agent/render?project_id=${PROJECT}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ data: { name: "Ada" } }),
			},
		);

		expect(oversized.status).toBe(400);
		expect(normal.status).toBe(200);
		expect(await normal.json()).toEqual({
			id: "support-agent",
			version: 1,
			content_hash: "a".repeat(64),
			messages: [{ role: "user", content: "Hello Ada" }],
			warnings: [],
		});
		expect(renderPromptRecord).toHaveBeenCalledTimes(1);
	});

	it("renders unsaved system and user drafts with injected variables without reading a saved prompt", async () => {
		const renderCalls = renderPromptRecord.mock.calls.length;
		const response = await app().request("/v1/prompts/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ role: "system", content: "You are helping {{customer.name}}." },
					{
						role: "user",
						content: "Resolve {{ticket}} for {{customer.name}}.",
					},
				],
				data: { customer: { name: "Ada" }, ticket: "INC-42" },
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			messages: [
				{ role: "system", content: "You are helping Ada." },
				{ role: "user", content: "Resolve INC-42 for Ada." },
			],
			warnings: [],
		});
		expect(renderPromptRecord.mock.calls).toHaveLength(renderCalls);
	});

	it("marks prompt provenance responses no-store", async () => {
		promptProvenanceStatus.mockClear();
		const response = await app().request(
			`/v1/prompt-provenance/support-agent?project_id=${PROJECT}&version=1&content_hash=${"a".repeat(64)}`,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ status: "active" });
		expect(promptProvenanceStatus).toHaveBeenCalledTimes(1);
		const missingProject = await app().request(
			`/v1/prompt-provenance/support-agent?project_id=${OTHER_PROJECT}&version=1&content_hash=${"a".repeat(64)}`,
		);
		expect(missingProject.status).toBe(404);
		expect(missingProject.headers.get("Cache-Control")).toBe("no-store");
		expect(await missingProject.json()).toEqual({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	});

	it("returns a project-scoped 404 envelope for an absent or cross-project prompt", async () => {
		const response = await app().request(
			`/v1/prompts/support-agent?project_id=${PROJECT}`,
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			code: "NOT_FOUND",
			message: "Prompt or version not found",
		});
	});

	it("requires raw deletion confirmation and marks successful delete responses no-store", async () => {
		deletePromptRecord.mockClear();
		const invalid = await app().request(
			`/v1/prompts/support-agent?project_id=${PROJECT}`,
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirmation: "other-prompt" }),
			},
		);
		expect(invalid.status).toBe(400);
		expect(invalid.headers.get("Cache-Control")).toBe("no-store");
		expect(await invalid.json()).toEqual({
			code: "BAD_REQUEST",
			message: "confirmation must equal the prompt identifier",
		});

		const deleted = await app().request(
			`/v1/prompts/support-agent?project_id=${PROJECT}`,
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirmation: "support-agent" }),
			},
		);
		expect(deleted.status).toBe(204);
		expect(deleted.headers.get("Cache-Control")).toBe("no-store");
		expect(deletePromptRecord).toHaveBeenCalledTimes(2);
		expect(deletePromptRecord.mock.calls[1]?.[1]).toEqual({
			project_id: PROJECT,
			slug: "support-agent",
			confirmation: "support-agent",
			actor: "context-admin",
		});
	});
});
