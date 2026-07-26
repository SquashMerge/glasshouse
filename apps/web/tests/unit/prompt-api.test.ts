import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPrompt,
	createPromptVersion,
	deletePrompt,
	getPrompt,
	getPromptProvenance,
	listProjects,
	listPromptVersions,
	listPrompts,
	previewPrompt,
	renderPrompt,
} from "../../src/lib/api";
import { setCredentials } from "../../src/lib/auth";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("prompt management API client", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		window.localStorage.clear();
		setCredentials("admin", "secret");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("uses authenticated project-scoped list and read request shapes", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ items: [], total: 0 }))
			.mockResolvedValueOnce(jsonResponse({ items: [], total: 0 }))
			.mockResolvedValueOnce(jsonResponse({ id: "support-agent", version: 2 }))
			.mockResolvedValueOnce(jsonResponse({ items: [] }));

		await listProjects();
		await listPrompts(PROJECT_ID);
		await getPrompt({
			project_id: PROJECT_ID,
			slug: "support-agent",
			version: 2,
		});
		await listPromptVersions({ project_id: PROJECT_ID, slug: "support-agent" });

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"/v1/projects",
			`/v1/prompts?project_id=${PROJECT_ID}`,
			`/v1/prompts/support-agent?project_id=${PROJECT_ID}&version=2`,
			`/v1/prompts/support-agent/versions?project_id=${PROJECT_ID}`,
		]);
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		expect(headers.get("authorization")).toBe("Basic YWRtaW46c2VjcmV0");
	});

	it("sends exact create, version, render, draft preview, delete, and provenance payloads", async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					id: "support-agent",
					project_id: PROJECT_ID,
					version: 1,
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ id: "support-agent", version: 2 }))
			.mockResolvedValueOnce(
				jsonResponse({
					id: "support-agent",
					version: 2,
					content_hash: HASH,
					messages: [{ role: "user", content: "Hello Ada" }],
					warnings: [],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					messages: [
						{ role: "system", content: "System Ada" },
						{ role: "user", content: "User Ada" },
					],
					warnings: [],
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse({ status: "active" }));

		await createPrompt({
			project_id: PROJECT_ID,
			name: "Support Agent",
			messages: [{ role: "system", content: "Hello {{name}}" }],
			settings: { temperature: 0.2 },
		});
		await createPromptVersion({
			project_id: PROJECT_ID,
			slug: "support-agent",
			base_version: 1,
			messages: [{ role: "user", content: "Hi {{name}}" }],
			model: null,
			settings: { temperature: 0.3 },
			change_summary: "Improve greeting",
		});
		await renderPrompt({
			project_id: PROJECT_ID,
			slug: "support-agent",
			version: 2,
			data: { name: "Ada" },
		});
		await previewPrompt({
			messages: [
				{ role: "system", content: "System {{name}}" },
				{ role: "user", content: "User {{name}}" },
			],
			data: { name: "Ada" },
		});
		await deletePrompt({
			project_id: PROJECT_ID,
			slug: "support-agent",
			confirmation: "support-agent",
		});
		await getPromptProvenance({
			project_id: PROJECT_ID,
			id: "support-agent",
			version: 2,
			content_hash: HASH,
		});

		expect(
			fetchMock.mock.calls.map(([url, init]) => ({
				url,
				method: init?.method ?? "GET",
				body: init?.body,
			})),
		).toEqual([
			{
				url: "/v1/prompts",
				method: "POST",
				body: JSON.stringify({
					project_id: PROJECT_ID,
					name: "Support Agent",
					messages: [{ role: "system", content: "Hello {{name}}" }],
					settings: { temperature: 0.2 },
				}),
			},
			{
				url: `/v1/prompts/support-agent/versions?project_id=${PROJECT_ID}`,
				method: "POST",
				body: JSON.stringify({
					base_version: 1,
					messages: [{ role: "user", content: "Hi {{name}}" }],
					model: null,
					settings: { temperature: 0.3 },
					change_summary: "Improve greeting",
				}),
			},
			{
				url: `/v1/prompts/support-agent/render?project_id=${PROJECT_ID}&version=2`,
				method: "POST",
				body: JSON.stringify({ data: { name: "Ada" } }),
			},
			{
				url: "/v1/prompts/preview",
				method: "POST",
				body: JSON.stringify({
					messages: [
						{ role: "system", content: "System {{name}}" },
						{ role: "user", content: "User {{name}}" },
					],
					data: { name: "Ada" },
				}),
			},
			{
				url: `/v1/prompts/support-agent?project_id=${PROJECT_ID}`,
				method: "DELETE",
				body: JSON.stringify({ confirmation: "support-agent" }),
			},
			{
				url: `/v1/prompt-provenance/support-agent?project_id=${PROJECT_ID}&version=2&content_hash=${HASH}`,
				method: "GET",
				body: undefined,
			},
		]);
	});
});
