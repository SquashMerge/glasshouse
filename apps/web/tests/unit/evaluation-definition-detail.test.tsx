import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const getEvaluation = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useParams: () => ({ slug: "quality-check" }),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
	}),
}));
vi.mock("../../src/lib/api", () => ({ getEvaluation }));

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
	});
});
