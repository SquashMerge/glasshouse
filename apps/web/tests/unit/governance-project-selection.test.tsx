import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";

const selection = vi.hoisted(() => ({
	projectId: "11111111-1111-4111-8111-111111111111",
}));
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

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const POLICY_A = "33333333-3333-4333-8333-333333333333";
const POLICY_B = "44444444-4444-4444-8444-444444444444";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function policy(id: string) {
	return {
		id,
		version: 1,
		retention: { traces: 30 },
		redaction: { mode: "all_text" as const, keys: [] },
		content_hash: "a".repeat(64),
		created_by: "owner",
		created_at: "2026-01-01T00:00:00.000Z",
		approved_by: "owner",
		approved_at: "2026-01-01T00:00:00.000Z",
	};
}

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<GovernancePage />
		</QueryClientProvider>,
	);
}

describe("GovernancePage project-scoped mutations", () => {
	beforeEach(() => {
		selection.projectId = PROJECT_A;
		api.getEffectiveGovernancePolicy.mockImplementation((projectId: string) =>
			Promise.resolve({
				policy: policy(projectId === PROJECT_A ? POLICY_A : POLICY_B),
			}),
		);
		api.listGovernancePolicyHistory.mockResolvedValue({ items: [] });
		api.listGovernanceRetentionRuns.mockResolvedValue({ items: [] });
		api.previewGovernanceRetention.mockReset();
	});
	afterEach(cleanup);

	it("drops a deferred preview from the previously selected project", async () => {
		const delayed = deferred<{
			policy_version_id: string;
			counts: Record<string, number>;
		}>();
		api.previewGovernanceRetention.mockImplementationOnce(
			() => delayed.promise,
		);
		const page = renderPage();
		await screen.findByText(/Approved version\s+1/);
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);

		selection.projectId = PROJECT_B;
		page.rerender(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<GovernancePage />
			</QueryClientProvider>,
		);
		await screen.findByText(/Approved version\s+1/);
		delayed.resolve({ policy_version_id: POLICY_A, counts: { traces: 91 } });
		await act(async () => {
			await Promise.resolve();
		});

		expect(screen.queryByText("traces: 91")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Run one bounded batch" }),
		).toBeDisabled();
	});
});
