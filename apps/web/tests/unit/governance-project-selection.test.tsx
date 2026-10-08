import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
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
		vi.clearAllMocks();
		selection.projectId = PROJECT_A;
		api.getEffectiveGovernancePolicy.mockImplementation((projectId: string) =>
			Promise.resolve({
				policy: policy(projectId === PROJECT_A ? POLICY_A : POLICY_B),
			}),
		);
		api.listGovernancePolicyHistory.mockResolvedValue({ items: [] });
		api.listGovernanceRetentionRuns.mockResolvedValue({ items: [] });
		api.runGovernanceRetention.mockResolvedValue({
			policy_version_id: POLICY_A,
			counts: { traces: 3 },
			run_id: "66666666-6666-4666-8666-666666666666",
			status: "completed",
		});
	});
	afterEach(cleanup);

	it("starts a policy draft at the documented baseline with text retention selected first", async () => {
		renderPage();
		await screen.findByTestId("active-policy-card");

		const redaction = screen.getByLabelText("Ingress redaction");
		expect(redaction).toHaveValue("none");
		expect(
			within(redaction)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			"Keep trace input/output text",
			"Replace all trace input/output text",
		]);

		fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
		await waitFor(() => {
			expect(api.createGovernancePolicyDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					project_id: PROJECT_A,
					retention: { traces: 30, datasets: 90, feedback: 90 },
					redaction: { mode: "none", keys: [] },
				}),
				expect.anything(),
			);
		});
	});

	it("drops a deferred preview from the previously selected project", async () => {
		const delayed = deferred<{
			policy_version_id: string;
			counts: Record<string, number>;
			preview_id: string;
			preview_expires_at: string;
		}>();
		api.previewGovernanceRetention.mockImplementationOnce(
			() => delayed.promise,
		);
		const page = renderPage();
		await screen.findByTestId("active-policy-card");
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
		await screen.findByTestId("active-policy-card");
		delayed.resolve({
			policy_version_id: POLICY_A,
			counts: { traces: 91 },
			preview_id: "55555555-5555-4555-8555-555555555555",
			preview_expires_at: "2026-08-29T20:00:00.000Z",
		});
		await act(async () => {
			await Promise.resolve();
		});

		expect(screen.queryByText("traces: 91")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Run one bounded batch" }),
		).toBeDisabled();
	});

	it("preserves the selected project's preview when an earlier preview fails", async () => {
		const delayed = deferred<{
			policy_version_id: string;
			counts: Record<string, number>;
			preview_id: string;
			preview_expires_at: string;
		}>();
		api.previewGovernanceRetention
			.mockImplementationOnce(() => delayed.promise)
			.mockResolvedValueOnce({
				policy_version_id: POLICY_B,
				counts: { traces: 7 },
				preview_id: "77777777-7777-4777-8777-777777777777",
				preview_expires_at: "2099-08-29T20:00:00.000Z",
			});
		const page = renderPage();
		await screen.findByTestId("active-policy-card");
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
		await screen.findByTestId("active-policy-card");
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		expect(await screen.findByText("traces: 7")).toBeVisible();

		delayed.reject(new Error("Project A preview failed"));
		await act(async () => {
			await Promise.resolve();
		});

		const runButton = screen.getByRole("button", {
			name: "Run one bounded batch",
		});
		expect(runButton).toBeEnabled();
		fireEvent.click(runButton);
		await waitFor(() =>
			expect(api.runGovernanceRetention.mock.calls[0]?.[0]).toEqual({
				project_id: PROJECT_B,
				policy_version_id: POLICY_B,
				preview_id: "77777777-7777-4777-8777-777777777777",
				batch_size: 100,
			}),
		);
	});

	it("preserves the selected project's preview when an earlier run fails", async () => {
		const delayed = deferred<{
			policy_version_id: string;
			counts: Record<string, number>;
			run_id: string;
			status: string;
		}>();
		api.previewGovernanceRetention.mockImplementation((projectId: string) =>
			Promise.resolve({
				policy_version_id: projectId === PROJECT_A ? POLICY_A : POLICY_B,
				counts: { traces: projectId === PROJECT_A ? 4 : 8 },
				preview_id:
					projectId === PROJECT_A
						? "55555555-5555-4555-8555-555555555555"
						: "88888888-8888-4888-8888-888888888888",
				preview_expires_at: "2099-08-29T20:00:00.000Z",
			}),
		);
		api.runGovernanceRetention
			.mockImplementationOnce(() => delayed.promise)
			.mockResolvedValueOnce({
				policy_version_id: POLICY_B,
				counts: { traces: 8 },
				run_id: "99999999-9999-4999-8999-999999999999",
				status: "completed",
			});
		const page = renderPage();
		await screen.findByTestId("active-policy-card");
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		expect(await screen.findByText("traces: 4")).toBeVisible();
		fireEvent.click(
			screen.getByRole("button", { name: "Run one bounded batch" }),
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
		await screen.findByTestId("active-policy-card");
		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		expect(await screen.findByText("traces: 8")).toBeVisible();

		delayed.reject(new Error("Project A retention run failed"));
		await act(async () => {
			await Promise.resolve();
		});

		const runButton = screen.getByRole("button", {
			name: "Run one bounded batch",
		});
		expect(runButton).toBeEnabled();
		fireEvent.click(runButton);
		await waitFor(() =>
			expect(api.runGovernanceRetention.mock.calls[1]?.[0]).toEqual({
				project_id: PROJECT_B,
				policy_version_id: POLICY_B,
				preview_id: "88888888-8888-4888-8888-888888888888",
				batch_size: 100,
			}),
		);
	});

	it("passes the server-issued preview authorization into a bounded run", async () => {
		api.previewGovernanceRetention.mockResolvedValue({
			policy_version_id: POLICY_A,
			counts: { traces: 4, datasets: 2 },
			preview_id: "55555555-5555-4555-8555-555555555555",
			preview_expires_at: "2099-08-29T20:00:00.000Z",
		});
		renderPage();
		await screen.findByTestId("active-policy-card");

		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);
		expect(await screen.findByText("traces: 4, datasets: 2")).toBeVisible();
		const runButton = screen.getByRole("button", {
			name: "Run one bounded batch",
		});
		expect(runButton).toBeEnabled();
		fireEvent.click(runButton);

		await waitFor(() =>
			expect(api.runGovernanceRetention.mock.calls[0]?.[0]).toEqual({
				project_id: PROJECT_A,
				policy_version_id: POLICY_A,
				preview_id: "55555555-5555-4555-8555-555555555555",
				batch_size: 100,
			}),
		);
	});

	it("does not offer a retention run for an expired preview", async () => {
		api.previewGovernanceRetention.mockResolvedValue({
			policy_version_id: POLICY_A,
			counts: { traces: 4 },
			preview_id: "55555555-5555-4555-8555-555555555555",
			preview_expires_at: "2020-01-01T00:00:00.000Z",
		});
		renderPage();
		await screen.findByTestId("active-policy-card");

		fireEvent.click(
			screen.getByRole("button", { name: "Preview eligible counts" }),
		);

		expect(
			await screen.findByText(
				"Preview expired. Preview eligible counts again before running retention.",
			),
		).toHaveAttribute("role", "alert");
		const runButton = screen.getByRole("button", {
			name: "Run one bounded batch",
		});
		expect(runButton).toBeDisabled();
		fireEvent.click(runButton);
		expect(api.runGovernanceRetention).not.toHaveBeenCalled();
	});

	it("separates the active policy from a draft and names the activation step", async () => {
		const activePolicy = policy(POLICY_A);
		const pendingDraft = {
			...policy(POLICY_B),
			version: 2,
			retention: { traces: 14, datasets: 45, feedback: 60 },
			redaction: { mode: "none" as const, keys: ["user.email"] },
			created_by: "reviewer",
			approved_by: null,
			approved_at: null,
		};
		api.getEffectiveGovernancePolicy.mockResolvedValue({
			policy: activePolicy,
		});
		api.listGovernancePolicyHistory.mockResolvedValue({
			items: [pendingDraft, activePolicy],
		});
		api.approveGovernancePolicy.mockResolvedValue({
			policy: {
				...pendingDraft,
				approved_by: "owner",
				approved_at: "2026-01-02T00:00:00.000Z",
			},
		});
		renderPage();

		const activeCard = await screen.findByTestId("active-policy-card");
		expect(
			within(activeCard).getByRole("heading", {
				name: "Active approved policy",
			}),
		).toBeVisible();
		expect(within(activeCard).getByText("Active")).toBeVisible();
		expect(within(activeCard).getByText("Version 1")).toBeVisible();
		expect(within(activeCard).getByText("traces 30 days")).toBeVisible();
		expect(within(activeCard).queryByRole("button")).toBeNull();

		const draftCard = screen.getByTestId(`draft-policy-${POLICY_B}`);
		expect(within(draftCard).getByText("Draft")).toBeVisible();
		expect(within(draftCard).getByText("Version 2")).toBeVisible();
		expect(
			within(draftCard).getByText(
				"traces 14 days, datasets 45 days, feedback 60 days",
			),
		).toBeVisible();
		expect(
			within(draftCard).getByText(
				"Next action: Review and approve this draft.",
			),
		).toBeVisible();
		expect(
			within(draftCard).getByText(
				"Approval activates it as the current policy.",
			),
		).toBeVisible();
		const approveButton = within(draftCard).getByRole("button", {
			name: "Approve and activate version 2",
		});
		fireEvent.click(approveButton);
		await waitFor(() =>
			expect(api.approveGovernancePolicy.mock.calls[0]?.[0]).toEqual({
				project_id: PROJECT_A,
				id: POLICY_B,
			}),
		);

		expect(screen.getByLabelText("Ingress redaction")).toHaveClass(
			"h-10",
			"w-full",
		);
	});
});
