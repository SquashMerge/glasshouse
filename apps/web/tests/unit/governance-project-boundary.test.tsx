import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const selection = vi.hoisted(() => ({ projectId: "A" }));
const api = vi.hoisted(() => ({
	approveGovernancePolicy: vi.fn(),
	createGovernancePolicyDraft: vi.fn(),
	getEffectiveGovernancePolicy: vi.fn(),
	listGovernancePolicyHistory: vi.fn(),
	listGovernanceRetentionRuns: vi.fn(),
	previewGovernanceRetention: vi.fn(),
	runGovernanceRetention: vi.fn(),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: selection.projectId }),
}));
vi.mock("../../src/lib/api", () => api);
import { GovernancePage } from "../../src/routes/governance";

function cachedClient() {
	selection.projectId = "A";
	vi.clearAllMocks();
	api.getEffectiveGovernancePolicy.mockImplementation((id: string) =>
		Promise.resolve({ policy: policy(id) }),
	);
	api.listGovernancePolicyHistory.mockResolvedValue({ items: [] });
	api.listGovernanceRetentionRuns.mockResolvedValue({ items: [] });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	for (const id of ["A", "B"]) {
		client.setQueryData(["governance-policy", id], { policy: policy(id) });
		client.setQueryData(["governance-history", id], { items: [] });
		client.setQueryData(["governance-retention-runs", id], { items: [] });
	}
	return client;
}

function policy(id: string) {
	return {
		id,
		version: 1,
		retention: { traces: 30 },
		redaction: { mode: "none", keys: [] },
		content_hash: "a".repeat(64),
		approved_at: "2026-01-01T00:00:00.000Z",
	};
}

afterEach(cleanup);

describe("governance project boundary", () => {
	it("never commits the previous project's draft when switching to cached data", () => {
		const client = cachedClient();
		const commits: Array<{ project: string; value: string | undefined }> = [];
		function Observer() {
			React.useLayoutEffect(() => {
				const input =
					document.querySelector<HTMLInputElement>("#redaction-keys");
				commits.push({ project: selection.projectId, value: input?.value });
			});
			return null;
		}
		const view = () => (
			<QueryClientProvider client={client}>
				<GovernancePage />
				<Observer />
			</QueryClientProvider>
		);
		const page = render(view());
		fireEvent.change(screen.getByLabelText("Attribute keys to redact"), {
			target: { value: "project-A-secret" },
		});
		selection.projectId = "B";
		page.rerender(view());
		expect(commits.find((commit) => commit.project === "B")?.value).toBe("");
		expect(api.getEffectiveGovernancePolicy).not.toHaveBeenCalled();
	});

	it("keeps the current A preview and authorization when an older A preview resolves after A-B-A", async () => {
		const client = cachedClient();
		let resolveOld!: (value: {
			policy_version_id: string;
			counts: Record<string, number>;
			preview_id: string;
			preview_expires_at: string;
		}) => void;
		api.previewGovernanceRetention
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockResolvedValueOnce({
				policy_version_id: "A",
				counts: { traces: 2 },
				preview_id: "new-authorization",
				preview_expires_at: "2099-01-01T00:00:00.000Z",
			});
		api.runGovernanceRetention.mockResolvedValue({ counts: { traces: 2 } });
		const view = () => (
			<QueryClientProvider client={client}>
				<GovernancePage />
			</QueryClientProvider>
		);
		const page = render(view());
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		selection.projectId = "B";
		page.rerender(view());
		selection.projectId = "A";
		page.rerender(view());
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		expect(await screen.findByText("traces: 2")).toBeVisible();
		await act(async () => {
			resolveOld({
				policy_version_id: "A",
				counts: { traces: 91 },
				preview_id: "old-authorization",
				preview_expires_at: "2099-01-01T00:00:00.000Z",
			});
			await Promise.resolve();
		});
		expect(screen.queryByText("traces: 91")).not.toBeInTheDocument();
		expect(screen.getByText("traces: 2")).toBeVisible();
		fireEvent.click(
			screen.getByRole("button", { name: "Run one bounded batch" }),
		);
		await waitFor(() =>
			expect(api.runGovernanceRetention.mock.calls[0]?.[0]).toEqual({
				project_id: "A",
				policy_version_id: "A",
				preview_id: "new-authorization",
				batch_size: 100,
			}),
		);
	});
});
