import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const router = vi.hoisted(() => ({
	navigate: vi.fn(),
	location: { searchStr: "" },
}));
const sse = vi.hoisted(() => ({ onMessage: vi.fn() }));
const {
	getPrompt,
	listPromptVersions,
	deletePrompt,
	rollbackLatestPromptVersion,
	getActivePromptOptimization,
	getPromptOptimization,
	startPromptOptimization,
	stopPromptOptimization,
} = vi.hoisted(() => ({
	getPrompt: vi.fn(),
	listPromptVersions: vi.fn(),
	deletePrompt: vi.fn(),
	rollbackLatestPromptVersion: vi.fn(),
	getActivePromptOptimization: vi.fn(),
	getPromptOptimization: vi.fn(),
	startPromptOptimization: vi.fn(),
	stopPromptOptimization: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useParams: () => ({ slug: "support-agent" }),
		useLocation: () => router.location,
		useNavigate: () => router.navigate,
	};
});
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Project One",
		},
	}),
}));
vi.mock("../../src/lib/api", () => ({
	getPrompt,
	listPromptVersions,
	deletePrompt,
	rollbackLatestPromptVersion,
	getActivePromptOptimization,
	getPromptOptimization,
	promptOptimizationEventsUrl: ({
		project_id,
		id,
	}: {
		project_id: string;
		id: string;
	}) => `/v1/prompt-optimizations/${id}/events?project_id=${project_id}`,
	startPromptOptimization,
	stopPromptOptimization,
}));
vi.mock("../../src/hooks/useEventSource", () => ({
	useEventSource: (
		_url: string,
		options: { onMessage: (message: unknown) => void },
	) => {
		sse.onMessage.mockImplementation(options.onMessage);
		return {
			status: "closed",
			paused: false,
			lastEventAt: null,
			reconnect: vi.fn(),
			debug: {
				framesReceived: 0,
				bufferDepth: 0,
				reconnectAttempts: 0,
				lastError: null,
			},
		};
	},
}));

import { PromptDetailPage } from "../../src/routes/prompts-detail";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function prompt(version = 3) {
	return {
		id: "support-agent",
		project_id: PROJECT_ID,
		name: "Support Agent",
		description: null,
		version,
		messages: [
			{ role: "system" as const, content: "Current {{customer}}" },
			{ role: "user" as const, content: "How can I help {{customer}}?" },
		],
		model: "gpt-4o",
		settings: { temperature: 0.2 },
		change_summary: "Current version",
		created_by: "admin",
		created_at: "2026-07-15T10:00:00.000Z",
		content_hash: HASH,
		diff: "--- v2\n+++ v3\n+Current {{customer}}",
	};
}

function renderDetail() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(["prompts", PROJECT_ID], { items: [], total: 0 });
	render(
		<QueryClientProvider client={client}>
			<PromptDetailPage />
		</QueryClientProvider>,
	);
	return client;
}

describe("PromptDetailPage", () => {
	beforeEach(() => {
		router.navigate.mockReset();
		router.location.searchStr = "";
		getPrompt.mockReset();
		listPromptVersions.mockReset();
		deletePrompt.mockReset();
		rollbackLatestPromptVersion.mockReset();
		getActivePromptOptimization.mockReset();
		getPromptOptimization.mockReset();
		sse.onMessage.mockReset();
		startPromptOptimization.mockReset();
		stopPromptOptimization.mockReset();
		getPrompt.mockResolvedValue(prompt());
		getActivePromptOptimization.mockResolvedValue(null);
		startPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "pending",
			result_version: null,
			error_message: null,
		});
		listPromptVersions.mockResolvedValue({
			items: [
				prompt(),
				{
					...prompt(2),
					messages: [{ role: "system", content: "Previous {{customer}}" }],
					change_summary: "Previous version",
					diff: "--- v1\n+++ v2",
				},
			],
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("shows immutable version details and drives history selection through the version query", async () => {
		renderDetail();

		await screen.findByTestId("prompt-message-system");
		expect(screen.getByTestId("prompt-message-system")).toHaveTextContent(
			"Current {{customer}}",
		);
		expect(screen.getByTestId("prompt-diff")).toHaveTextContent("+++ v3");
		expect(screen.getByText(HASH)).toBeInTheDocument();
		fireEvent.click(screen.getAllByTestId("prompt-version")[1]!);

		expect(router.navigate).toHaveBeenLastCalledWith({
			to: "/prompts/$slug",
			params: { slug: "support-agent" },
			search: { version: 2 },
		});
	});

	it("requires the exact canonical slug, reports delete errors, then invalidates the prompt list and navigates", async () => {
		const client = renderDetail();
		await screen.findByTestId("prompt-message-system");
		deletePrompt.mockRejectedValueOnce(
			new Error("Prompt has active references"),
		);
		deletePrompt.mockResolvedValueOnce(undefined);

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmation = await screen.findByTestId("delete-confirmation");
		const confirmButton = screen.getByTestId("confirm-delete");
		expect(confirmButton).toBeDisabled();
		fireEvent.change(confirmation, {
			target: { value: "DELETE support-agent" },
		});
		expect(confirmButton).toBeDisabled();
		fireEvent.change(confirmation, { target: { value: "support-agent" } });
		expect(confirmButton).toBeEnabled();
		fireEvent.click(confirmButton);

		await screen.findByText("Prompt has active references");
		expect(deletePrompt).toHaveBeenCalledWith({
			project_id: PROJECT_ID,
			slug: "support-agent",
			confirmation: "support-agent",
		});

		fireEvent.click(confirmButton);
		await waitFor(() =>
			expect(router.navigate).toHaveBeenCalledWith({ to: "/prompts" }),
		);
		expect(client.getQueryState(["prompts", PROJECT_ID])?.isInvalidated).toBe(
			true,
		);
	});

	it("confirms rollback, refreshes current prompt and history, and shows rollback errors", async () => {
		renderDetail();
		await screen.findByTestId("prompt-message-system");
		rollbackLatestPromptVersion.mockRejectedValueOnce(
			new Error("Stop the active optimization before rolling back a version"),
		);
		rollbackLatestPromptVersion.mockResolvedValueOnce(prompt(2));

		fireEvent.click(
			screen.getByRole("button", { name: "Rollback latest version" }),
		);
		expect(
			await screen.findByText(
				"The latest version will be permanently removed and the previous version restored.",
			),
		).toBeInTheDocument();
		const confirm = screen.getByRole("button", { name: "Rollback version" });
		fireEvent.click(confirm);
		expect(
			await screen.findByText(
				"Stop the active optimization before rolling back a version",
			),
		).toBeInTheDocument();
		fireEvent.click(confirm);

		await waitFor(() =>
			expect(rollbackLatestPromptVersion).toHaveBeenLastCalledWith({
				project_id: PROJECT_ID,
				slug: "support-agent",
			}),
		);
		await waitFor(() =>
			expect(router.navigate).toHaveBeenCalledWith({
				to: "/prompts/$slug",
				params: { slug: "support-agent" },
				search: {},
			}),
		);
		await waitFor(() => {
			expect(getPrompt).toHaveBeenCalledTimes(2);
			expect(listPromptVersions).toHaveBeenCalledTimes(2);
		});
	});

	it("requires an explicit stop confirmation before entering the editor while optimization is active", async () => {
		getActivePromptOptimization.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			status: "optimizing",
			result_version: null,
			error_message: null,
		});
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: "New version" }));
		expect(
			await screen.findByText("Stop optimization before editing?"),
		).toBeInTheDocument();
		expect(router.navigate).not.toHaveBeenCalled();
	});

	it("keeps the stop dialog open and visible when stopping optimization is rejected", async () => {
		getActivePromptOptimization.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			status: "optimizing",
			result_version: null,
			error_message: null,
		});
		stopPromptOptimization.mockRejectedValueOnce(new Error("Stop failed"));
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: "New version" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop and continue" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Stop failed");
		expect(router.navigate).not.toHaveBeenCalled();
	});

	it("submits stop once and navigates only after the stopped response", async () => {
		getActivePromptOptimization.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			status: "optimizing",
			result_version: null,
			error_message: null,
		});
		let resolveStop: (value: unknown) => void = () => {};
		stopPromptOptimization.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveStop = resolve;
			}),
		);
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: "New version" }));
		const confirm = screen.getByRole("button", { name: "Stop and continue" });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		await waitFor(() =>
			expect(stopPromptOptimization).toHaveBeenCalledTimes(1),
		);
		expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
		expect(router.navigate).not.toHaveBeenCalled();

		resolveStop({
			id: "11111111-1111-4111-8111-111111111111",
			status: "stopped",
			result_version: null,
			error_message: null,
		});
		await waitFor(() =>
			expect(router.navigate).toHaveBeenCalledWith({
				to: "/prompts/$slug/edit",
				params: { slug: "support-agent" },
				search: { from: 3 },
			}),
		);
	});

	it("opens one optimization dialog with a single target radio group and useful input placeholders", async () => {
		renderDetail();

		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		expect(
			screen.queryByRole("button", { name: "Optimize system" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Optimize user" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Start optimization" }),
		).toBeInTheDocument();

		const systemRadio = screen.getByRole("radio", { name: "System prompt" });
		const userRadio = screen.getByRole("radio", { name: "User prompt" });
		expect(systemRadio).toBeChecked();
		expect(userRadio).not.toBeChecked();
		expect(screen.getByLabelText("Representative input")).toHaveAttribute(
			"placeholder",
			"e.g. A customer asks how to reset their password",
		);
		expect(screen.getByLabelText("Expected answer")).toHaveAttribute(
			"placeholder",
			"e.g. Explain the steps clearly and include the support link",
		);
		expect(screen.getByLabelText("Task model")).toHaveAttribute(
			"placeholder",
			"e.g. openai/gpt-4o-mini",
		);
		expect(screen.getByLabelText("Reflection model")).toHaveAttribute(
			"placeholder",
			"e.g. openai/gpt-4o-mini",
		);
		expect(screen.getByLabelText("Metric-call budget")).toHaveAttribute(
			"placeholder",
			"e.g. 20",
		);
	});

	it("refreshes the current prompt and version history after optimization completes", async () => {
		getActivePromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
		});
		renderDetail();
		await waitFor(() => expect(getActivePromptOptimization).toHaveBeenCalled());
		await act(async () => {
			sse.onMessage({
				event: "status",
				data: {
					id: 1,
					status: "completed",
					detail: { result_version: 4, score: 0.9 },
					created_at: "2026-07-15T10:00:01.000Z",
				},
			});
		});

		await waitFor(() => {
			expect(getPrompt).toHaveBeenCalledTimes(2);
			expect(listPromptVersions).toHaveBeenCalledTimes(2);
		});
	});

	it("renders score and configured budget from validated SSE progress", async () => {
		getActivePromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			target: "system",
			source_version: 3,
			budget: { max_metric_calls: 20 },
			created_at: "2026-07-15T10:00:00.000Z",
		});
		renderDetail();
		await screen.findByText("Support Agent optimizing…");

		await act(async () => {
			sse.onMessage({
				event: "status",
				data: {
					id: 2,
					status: "evaluating",
					detail: { score: 0.875 },
					created_at: "2026-07-15T10:00:01.000Z",
				},
			});
		});

		expect(await screen.findByText("evaluating")).toBeInTheDocument();
		expect(screen.getByText("Not reported / 20")).toBeInTheDocument();
		expect(screen.getByText("0.875")).toBeInTheDocument();
	});

	it("fills the development example when explicitly enabled", async () => {
		vi.stubEnv("VITE_SHOW_DEV_OPTIMIZATION_EXAMPLE", "true");
		renderDetail();

		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Fill development example" }),
		);

		expect(screen.getByLabelText("Representative input")).toHaveValue(
			"Here is my task list for today:\n\n- Finish the quarterly status report and send it to the team by 2:00 PM.\n- Pick up groceries after work.\n- Review and approve the open pull request for the API changes.\n- Call the dentist to schedule a cleaning.\n- Take the dog for a 30-minute walk in the evening.",
		);
		expect(screen.getByLabelText("Expected answer")).toHaveValue(
			"**Today’s priorities:** Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.  \n**After work:** Pick up groceries, schedule a dental cleaning, and take the dog for a 30-minute walk.",
		);
		expect(screen.getByLabelText("Task model")).toHaveValue("gpt-5.6-terra");
		expect(screen.getByLabelText("Reflection model")).toHaveValue(
			"gpt-5.6-terra",
		);
		expect(screen.getByLabelText("Metric-call budget")).toHaveValue(5);
	});

	it("does not show the development example without the opt-in", async () => {
		renderDetail();

		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		expect(
			screen.queryByRole("button", { name: "Fill development example" }),
		).not.toBeInTheDocument();
	});

	it("submits the selected historical version and target role", async () => {
		router.location.searchStr = "?version=2";
		getPrompt.mockImplementation(({ version }: { version?: number }) =>
			Promise.resolve(version === 2 ? prompt(2) : prompt()),
		);
		renderDetail();

		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		fireEvent.click(screen.getByRole("radio", { name: "User prompt" }));
		fireEvent.change(screen.getByLabelText("Representative input"), {
			target: { value: "Question" },
		});
		fireEvent.change(screen.getByLabelText("Expected answer"), {
			target: { value: "Answer" },
		});
		fireEvent.change(screen.getByLabelText("Task model"), {
			target: { value: "gpt-4o" },
		});
		fireEvent.change(screen.getByLabelText("Reflection model"), {
			target: { value: "gpt-4o-mini" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Start optimization" }));

		await waitFor(() =>
			expect(startPromptOptimization).toHaveBeenCalledWith(
				expect.objectContaining({ source_version: 2, target: "user" }),
			),
		);
	});
});
