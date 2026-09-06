import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const getEvaluation = vi.hoisted(() => vi.fn());
const getEvaluationDraft = vi.hoisted(() => vi.fn());
const listEvaluationVersions = vi.hoisted(() => vi.fn());
const getEvaluationVersion = vi.hoisted(() => vi.fn());
const updateEvaluationDraft = vi.hoisted(() => vi.fn());
const publishEvaluationDraft = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useParams: () => ({ slug: "quality-check" }),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: { project_role: "user" },
	}),
}));
vi.mock("../../src/lib/api", () => ({
	getEvaluation,
	getEvaluationDraft,
	listEvaluationVersions,
	getEvaluationVersion,
	updateEvaluationDraft,
	publishEvaluationDraft,
}));

import { EvaluationDefinitionDetailPage } from "../../src/routes/evaluations";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe("EvaluationDefinitionDetailPage", () => {
	it("loads and renders the stable-slug Evaluation detail", async () => {
		getEvaluation.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			project_id: "11111111-1111-4111-8111-111111111111",
			slug: "quality-check",
			name: "Quality check",
			description: "Release gate",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		getEvaluationDraft.mockResolvedValue({
			evaluation_id: "22222222-2222-4222-8222-222222222222",
			project_id: "11111111-1111-4111-8111-111111111111",
			revision: 2,
			definition_contract: "v1",
			dataset_version_id: "33333333-3333-4333-8333-333333333333",
			sampling: { strategy: "first_n", sample_size: 10, seed: 7 },
			evaluator: {
				kind: "exact_match",
				version: "v1",
				expected_output_path: "$.expected_output",
				output_path: "$.output",
			},
			target: {
				kind: "configured_llm",
				model: "gpt",
				system_prompt: "Be precise",
			},
			execution_defaults: { temperature: 0, max_tokens: null },
			limits: { max_cost_usd: 1, max_duration_seconds: 60 },
			thresholds: { minimum_pass_rate: 0.9 },
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		listEvaluationVersions.mockResolvedValue({
			items: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					evaluation_id: "22222222-2222-4222-8222-222222222222",
					project_id: "11111111-1111-4111-8111-111111111111",
					version: 1,
					content_hash: "a".repeat(64),
					published_by: "55555555-5555-4555-8555-555555555555",
					published_draft_revision: 1,
					created_at: "2026-01-01T00:00:00.000Z",
					definition_contract: "v1",
				},
			],
		});
		getEvaluationVersion.mockResolvedValue({
			definition_contract: "v1",
			dataset_version_id: "33333333-3333-4333-8333-333333333333",
			sampling: { strategy: "first_n", sample_size: 10, seed: 7 },
			evaluator: { kind: "exact_match", version: "v1" },
			target: {
				kind: "configured_llm",
				model: "gpt",
				system_prompt: "Be precise",
			},
			execution_defaults: { temperature: 0, max_tokens: null },
			limits: { max_cost_usd: 1, max_duration_seconds: 60 },
			thresholds: { minimum_pass_rate: 0.9 },
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<EvaluationDefinitionDetailPage />
			</QueryClientProvider>,
		);

		expect(
			await screen.findByRole("heading", { name: "Quality check" }),
		).toBeTruthy();
		expect(screen.getByText("Stable ID: quality-check")).toBeTruthy();
		expect(getEvaluation).toHaveBeenCalledWith({
			project_id: "11111111-1111-4111-8111-111111111111",
			slug: "quality-check",
		});
		expect(await screen.findByRole("heading", { name: "Draft" })).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Immutable version history" }),
		).toBeTruthy();
		expect(
			await screen.findByText(
				"Published by 55555555-5555-4555-8555-555555555555",
			),
		).toBeTruthy();
		expect(await screen.findByDisplayValue("Be precise")).toBeTruthy();
	});
	it("renders a selected historical version from its immutable payload, not the current draft", async () => {
		getEvaluation.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			project_id: "11111111-1111-4111-8111-111111111111",
			slug: "quality-check",
			name: "Quality check",
			description: null,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		getEvaluationDraft.mockResolvedValue({
			evaluation_id: "22222222-2222-4222-8222-222222222222",
			project_id: "11111111-1111-4111-8111-111111111111",
			revision: 3,
			definition_contract: "v1",
			dataset_version_id: "33333333-3333-4333-8333-333333333333",
			sampling: { strategy: "first_n", sample_size: 10, seed: 7 },
			evaluator: {
				kind: "contains",
				version: "v1",
				expected_output_path: "$.expected_output",
				output_path: "$.output",
			},
			target: {
				kind: "configured_llm",
				model: "draft-v2-model",
				system_prompt: "draft v2 prompt",
			},
			execution_defaults: { temperature: 0.8, max_tokens: null },
			limits: { max_cost_usd: 1, max_duration_seconds: 60 },
			thresholds: { minimum_pass_rate: 0.9 },
			updated_at: "2026-01-02T00:00:00.000Z",
		});
		listEvaluationVersions.mockResolvedValue({
			items: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					evaluation_id: "22222222-2222-4222-8222-222222222222",
					project_id: "11111111-1111-4111-8111-111111111111",
					version: 2,
					content_hash: "b".repeat(64),
					published_by: "55555555-5555-4555-8555-555555555555",
					published_draft_revision: 2,
					created_at: "2026-01-02T00:00:00.000Z",
					definition_contract: "v1",
				},
				{
					id: "66666666-6666-4666-8666-666666666666",
					evaluation_id: "22222222-2222-4222-8222-222222222222",
					project_id: "11111111-1111-4111-8111-111111111111",
					version: 1,
					content_hash: "a".repeat(64),
					published_by: "55555555-5555-4555-8555-555555555555",
					published_draft_revision: 1,
					created_at: "2026-01-01T00:00:00.000Z",
					definition_contract: "v1",
				},
			],
		});
		getEvaluationVersion.mockImplementation(
			({ version }: { version: number }) =>
				Promise.resolve({
					definition_contract: "v1",
					dataset_version_id: "33333333-3333-4333-8333-333333333333",
					sampling: { strategy: "first_n", sample_size: 10, seed: 7 },
					evaluator: {
						kind: version === 1 ? "exact_match" : "contains",
						version: "v1",
					},
					target: {
						kind: "configured_llm",
						model: version === 1 ? "released-v1-model" : "released-v2-model",
						system_prompt:
							version === 1 ? "released v1 prompt" : "released v2 prompt",
					},
					execution_defaults: {
						temperature: version === 1 ? 0.1 : 0.2,
						max_tokens: null,
					},
					limits: { max_cost_usd: 1, max_duration_seconds: 60 },
					thresholds: { minimum_pass_rate: 0.9 },
				}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<EvaluationDefinitionDetailPage />
			</QueryClientProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Version 1" }));
		expect(await screen.findByText(/released v1 prompt/)).toBeTruthy();
		expect(getEvaluationVersion).toHaveBeenCalledWith({
			project_id: "11111111-1111-4111-8111-111111111111",
			slug: "quality-check",
			version: 1,
		});
		expect(screen.queryByText(/draft v2 prompt/)).toBeNull();
	});
});
