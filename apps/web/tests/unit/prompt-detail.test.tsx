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
const sse = vi.hoisted(() => ({
	onMessage: vi.fn(),
	onOpen: vi.fn(),
	onError: vi.fn(),
	reconnect: vi.fn(),
	url: null as string | null,
	status: "closed" as "connecting" | "open" | "closed",
}));
const {
	getPrompt,
	listPromptVersions,
	deletePrompt,
	rollbackLatestPromptVersion,
	getPromptOptimization,
	getLatestPromptOptimization,
	promotePromptOptimization,
	startPromptOptimization,
	stopPromptOptimization,
} = vi.hoisted(() => ({
	getPrompt: vi.fn(),
	listPromptVersions: vi.fn(),
	deletePrompt: vi.fn(),
	rollbackLatestPromptVersion: vi.fn(),
	getPromptOptimization: vi.fn(),
	getLatestPromptOptimization: vi.fn(),
	promotePromptOptimization: vi.fn(),
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
	getPromptOptimization,
	getLatestPromptOptimization,
	promotePromptOptimization,
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
		url: string | null,
		options: {
			onMessage: (message: unknown) => void;
			onOpen?: () => void;
			onError?: (cause: unknown) => void;
		},
	) => {
		sse.url = url;
		sse.onMessage.mockImplementation(options.onMessage);
		sse.onOpen.mockImplementation(() => options.onOpen?.());
		sse.onError.mockImplementation((cause) => options.onError?.(cause));
		return {
			status: sse.status,
			paused: false,
			lastEventAt: null,
			reconnect: sse.reconnect,
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
		created_by: "actor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		created_by_username: "admin.user",
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
		getPromptOptimization.mockReset();
		getLatestPromptOptimization.mockReset();
		promotePromptOptimization.mockReset();
		sse.onMessage.mockReset();
		sse.onOpen.mockReset();
		sse.onError.mockReset();
		sse.reconnect.mockReset();
		sse.url = null;
		sse.status = "closed";
		startPromptOptimization.mockReset();
		stopPromptOptimization.mockReset();
		getPrompt.mockResolvedValue(prompt());
		getLatestPromptOptimization.mockResolvedValue(null);
		getPromptOptimization.mockResolvedValue(null);
		startPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "queued",
			result_version: null,
			error_message: null,
			metric_calls_used: null,
		});
		getPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "completed",
			result_version: 4,
			error_message: null,
			promotion_status: "auto_promoted",
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

	it("renders a detail-shaped skeleton on the initial prompt load", () => {
		getPrompt.mockReturnValue(new Promise(() => undefined));
		listPromptVersions.mockReturnValue(new Promise(() => undefined));
		getLatestPromptOptimization.mockReturnValue(new Promise(() => undefined));
		getPromptOptimization.mockReturnValue(new Promise(() => undefined));

		renderDetail();

		expect(screen.getByTestId("prompt-detail-skeleton")).toBeInTheDocument();
		expect(screen.queryByText("Loading prompt…")).not.toBeInTheDocument();
	});

	it("shows immutable version details and drives history selection through the version query", async () => {
		renderDetail();

		await screen.findByTestId("prompt-message-system");
		expect(screen.getByTestId("prompt-message-system")).toHaveTextContent(
			"Current {{customer}}",
		);
		expect(screen.getByTestId("prompt-diff")).toHaveTextContent("+++ v3");
		expect(screen.getByText(HASH)).toBeInTheDocument();
		expect(screen.getByText("admin.user")).toBeInTheDocument();
		expect(
			screen.queryByText("actor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		).toBeNull();
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

	it("disables prompt actions while optimization is active", async () => {
		const activeJob = {
			id: "11111111-1111-4111-8111-111111111111",
			status: "optimizing",
			result_version: null,
			error_message: null,
		};
		getLatestPromptOptimization.mockResolvedValue(activeJob);
		getPromptOptimization.mockResolvedValue(activeJob);
		renderDetail();

		expect(
			await screen.findByRole("button", { name: "New version" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Optimize prompt" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Rollback latest version" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
		for (const versionButton of screen.getAllByTestId("prompt-version")) {
			expect(versionButton).toBeDisabled();
		}
		expect(router.navigate).not.toHaveBeenCalled();
	});

	it("opens one optimization dialog with separate train and held-out validation inputs", async () => {
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

		expect(
			screen.queryByRole("radio", { name: "System prompt" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: "User prompt" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByLabelText("Reflection rubric / objective"),
		).toHaveAttribute(
			"placeholder",
			"e.g. Prioritize urgent work, preserve deadlines, and use concise grouped headings",
		);
		expect(screen.getByLabelText("Training 1 input")).toBeInTheDocument();
		expect(
			screen.getByLabelText("Training 1 expected answer"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("Held-out validation 1 input"),
		).toBeInTheDocument();
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
			"e.g. 5",
		);
		expect(screen.getByLabelText("Metric-call budget")).toHaveAttribute(
			"min",
			"2",
		);
		expect(screen.getByLabelText("Metric-call budget")).toHaveAttribute(
			"max",
			"100",
		);
		expect(
			screen.getByText(
				"The budget caps metric evaluations and must cover every held-out example. Larger budgets can take longer and increase provider cost.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Examples GEPA can learn from while improving the prompt. Use real input and its evaluator label.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Separate examples used to check whether the candidate improves on unseen work. Do not reuse training inputs.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"The task model runs candidate work; the reflection model analyzes feedback and suggests improvements. Both use provider calls.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Expected-answer labels determine metric scores; the rubric guides reflection feedback.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"After completion, review the candidate, before/after diff, scores, metric calls, and promotion state. Automatic promotion requires at least two held-out examples and a validation score above its baseline; otherwise a valid candidate is marked for review. Invalid or leaking candidates are blocked from promotion.",
			),
		).toBeInTheDocument();
	});

	it("requires the budget to cover every held-out validation example", async () => {
		renderDetail();
		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		const addExampleButtons = screen.getAllByRole("button", {
			name: "Add example",
		});
		fireEvent.click(addExampleButtons[1]!);
		fireEvent.click(addExampleButtons[1]!);
		fireEvent.change(screen.getByLabelText("Reflection rubric / objective"), {
			target: { value: "Preserve concise summaries." },
		});
		for (const [label, value] of [
			["Training 1 input", "delta"],
			["Training 1 expected answer", "training answer"],
			["Held-out validation 1 input", "alpha"],
			["Held-out validation 1 expected answer", "validation answer one"],
			["Held-out validation 2 input", "bravo"],
			["Held-out validation 2 expected answer", "validation answer two"],
			["Held-out validation 3 input", "charlie"],
			["Held-out validation 3 expected answer", "validation answer three"],
			["Task model", "task-model"],
			["Reflection model", "reflection-model"],
		] as const)
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		fireEvent.change(screen.getByLabelText("Metric-call budget"), {
			target: { value: "2" },
		});

		expect(screen.getByLabelText("Metric-call budget")).toHaveAttribute(
			"min",
			"3",
		);
		expect(
			screen.getByRole("button", { name: "Start optimization" }),
		).toBeDisabled();

		fireEvent.change(screen.getByLabelText("Metric-call budget"), {
			target: { value: "3" },
		});
		expect(
			screen.getByRole("button", { name: "Start optimization" }),
		).toBeEnabled();
	});

	it("rejects materially overlapping training and held-out inputs", async () => {
		renderDetail();
		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);

		fireEvent.change(screen.getByLabelText("Training 1 input"), {
			target: { value: "Please summarize today tasks" },
		});
		fireEvent.change(screen.getByLabelText("Held-out validation 1 input"), {
			target: { value: "Please summarize today tasks with dates" },
		});

		expect(
			screen.getByText(
				"Training and held-out validation inputs must be unique and not materially overlap.",
			),
		).toBeInTheDocument();
	});

	it("rejects reordered near-identical training and held-out inputs", async () => {
		renderDetail();
		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);

		fireEvent.change(screen.getByLabelText("Training 1 input"), {
			target: { value: "order a salad with fries" },
		});
		fireEvent.change(screen.getByLabelText("Held-out validation 1 input"), {
			target: { value: "fries with a salad order" },
		});

		expect(
			screen.getByText(
				"Training and held-out validation inputs must be unique and not materially overlap.",
			),
		).toBeInTheDocument();
	});

	it("rejects near-duplicate training and held-out inputs", async () => {
		renderDetail();
		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);
		const trainingInput = Array.from(
			{ length: 100 },
			(_, index) => `training${index}`,
		).join(" ");
		const validationInput = [
			...Array.from({ length: 79 }, (_, index) => `training${index}`),
			...Array.from({ length: 21 }, (_, index) => `validation${index}`),
		].join(" ");

		fireEvent.change(screen.getByLabelText("Training 1 input"), {
			target: { value: trainingInput },
		});
		fireEvent.change(screen.getByLabelText("Held-out validation 1 input"), {
			target: { value: validationInput },
		});

		expect(
			screen.getByText(
				"Training and held-out validation inputs must be unique and not materially overlap.",
			),
		).toBeInTheDocument();
	});

	it("rejects single-token training and held-out containment", async () => {
		renderDetail();
		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);

		fireEvent.change(screen.getByLabelText("Training 1 input"), {
			target: { value: "refund" },
		});
		fireEvent.change(screen.getByLabelText("Held-out validation 1 input"), {
			target: { value: "refund now" },
		});

		expect(
			screen.getByText(
				"Training and held-out validation inputs must be unique and not materially overlap.",
			),
		).toBeInTheDocument();
	});

	it("refreshes the current prompt and version history after optimization completes", async () => {
		getLatestPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			metric_calls_used: null,
		});
		getPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "completed",
			result_version: 4,
			error_message: null,
			metric_calls_used: 3,
			completed_at: "2026-07-15T10:02:00.000Z",
		});
		renderDetail();
		await waitFor(() => expect(getLatestPromptOptimization).toHaveBeenCalled());
		await act(async () => {
			sse.onOpen();
		});

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Stop" }),
			).not.toBeInTheDocument();
			expect(screen.getByText("Published as v4.")).toBeInTheDocument();
			expect(getPrompt).toHaveBeenCalledTimes(2);
			expect(listPromptVersions).toHaveBeenCalledTimes(2);
		});
	});

	it("renders distinct training and held-out evidence instead of an ambiguous score", async () => {
		getLatestPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			target: "system",
			source_version: 3,
			budget: { max_metric_calls: 20 },
			evidence: {
				metric: "default_adapter.expected_answer_contains",
				rubric: "Preserve deadlines and concise grouping.",
				training: { sample_count: 1, score: 1 },
				validation: {
					sample_count: 1,
					score: 0.875,
					baseline_score: 0.5,
					held_out: true,
				},
				leakage: { status: "passed", reason: null },
			},
			promotion_status: "review_required",
			promotion_reason: "insufficient_held_out_validation",
			created_at: "2026-07-15T10:00:00.000Z",
			metric_calls_used: null,
		});
		getPromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			target: "system",
			source_version: 3,
			budget: { max_metric_calls: 20 },
			evidence: {
				metric: "default_adapter.expected_answer_contains",
				rubric: "Preserve deadlines and concise grouping.",
				training: { sample_count: 1, score: 1 },
				validation: {
					sample_count: 1,
					score: 0.875,
					baseline_score: 0.5,
					held_out: true,
				},
				leakage: { status: "passed", reason: null },
			},
			promotion_status: "review_required",
			promotion_reason: "insufficient_held_out_validation",
			created_at: "2026-07-15T10:00:00.000Z",
			metric_calls_used: null,
		});
		renderDetail();
		await screen.findByText("Support Agent optimizing…");

		expect(
			await screen.findByText("Training score (diagnostic)"),
		).toBeInTheDocument();
		expect(screen.getByText("Held-out validation score")).toBeInTheDocument();
		expect(screen.getByText("Telemetry unavailable / 20")).toBeInTheDocument();
		expect(screen.getByText("0.875")).toBeInTheDocument();
	});

	it("keeps a one-sample held-out result as a reviewable draft", async () => {
		const draft = {
			id: "22222222-2222-4222-8222-222222222222",
			status: "completed",
			result_version: null,
			error_message: null,
			source_version: 3,
			target: "system",
			candidate_content: "Improved {{customer}}",
			evidence: {
				metric: "default_adapter.expected_answer_contains",
				rubric: "Preserve customer details.",
				training: { sample_count: 1, score: 1 },
				validation: {
					sample_count: 1,
					score: 1,
					baseline_score: 0,
					held_out: true,
				},
				leakage: { status: "passed", reason: null },
			},
			promotion_status: "review_required",
			promotion_reason: "insufficient_held_out_validation",
		};
		getLatestPromptOptimization.mockResolvedValue({
			id: draft.id,
			status: draft.status,
			result_version: draft.result_version,
			error_message: draft.error_message,
			metric_calls_used: null,
		});
		getPromptOptimization.mockResolvedValue(draft);
		promotePromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			status: "completed",
			result_version: 4,
			error_message: null,
			promotion_status: "reviewed_promoted",
		});
		renderDetail();

		expect(
			await screen.findByText(
				"Draft only: fewer than two independent held-out examples.",
			),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Promote reviewed draft" }),
		);
		await waitFor(() =>
			expect(promotePromptOptimization).toHaveBeenCalledWith({
				project_id: PROJECT_ID,
				id: "22222222-2222-4222-8222-222222222222",
			}),
		);
	});

	it("uses no placeholder events URL when no optimization exists", async () => {
		renderDetail();

		await screen.findByTestId("prompt-detail");
		expect(sse.url).toBeNull();
	});

	it("shows stream failures while retaining authoritative status polling", async () => {
		const activeJob = {
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			metric_calls_used: null,
			budget: { max_metric_calls: 5 },
		};
		getLatestPromptOptimization.mockResolvedValue(activeJob);
		getPromptOptimization.mockResolvedValue(activeJob);
		renderDetail();

		await screen.findByTestId("optimization-status");
		expect(screen.getByText("Telemetry unavailable / 5")).toBeInTheDocument();
		await act(async () => {
			sse.onMessage({
				event: "error",
				data: { message: "server stream unavailable" },
			});
		});
		expect(
			await screen.findByText("server stream unavailable"),
		).toBeInTheDocument();
		await act(async () => {
			sse.onError(new Error("connection reset"));
		});
		expect(await screen.findByText("connection reset")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
		expect(sse.reconnect).toHaveBeenCalled();
	});

	it("keeps a completed optimization visible after closing and reopening its panel", async () => {
		const activeJob = {
			id: "22222222-2222-4222-8222-222222222222",
			status: "optimizing",
			result_version: null,
			error_message: null,
			metric_calls_used: null,
			budget: { max_metric_calls: 5 },
		};
		const completedJob = {
			...activeJob,
			status: "completed",
			result_version: 4,
			metric_calls_used: 3,
			completed_at: "2026-07-15T10:02:00.000Z",
		};
		getLatestPromptOptimization.mockResolvedValue(activeJob);
		getPromptOptimization.mockResolvedValue(activeJob);
		renderDetail();

		await screen.findByTestId("optimization-status");
		fireEvent.click(screen.getByRole("button", { name: "Close status" }));
		expect(screen.queryByTestId("optimization-status")).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "View optimization status" }),
		);
		expect(screen.getByTestId("optimization-status")).toBeInTheDocument();

		getPromptOptimization.mockResolvedValue(completedJob);
		await act(async () => {
			sse.onOpen();
		});
		await screen.findByText("Published as v4.");
		expect(
			screen.queryByRole("button", { name: "Stop" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close status" }));
		fireEvent.click(
			screen.getByRole("button", { name: "View optimization status" }),
		);
		expect(screen.getByText("Published as v4.")).toBeInTheDocument();
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

		expect(screen.getByLabelText("Training 1 input")).toHaveValue(
			"Here is my task list for today:\n\n- Finish the quarterly status report and send it to the team by 2:00 PM.\n- Pick up groceries after work.\n- Review and approve the open pull request for the API changes.\n- Call the dentist to schedule a cleaning.\n- Take the dog for a 30-minute walk in the evening.",
		);
		expect(screen.getByLabelText("Training 1 expected answer")).toHaveValue(
			"**Today’s priorities:** Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.  \n**After work:** Pick up groceries, schedule a dental cleaning, and take the dog for a 30-minute walk.",
		);
		expect(screen.getByLabelText("Held-out validation 2 input")).toHaveValue(
			"My list:\n\n- Book travel for next week’s conference.\n- Respond to the security review comments by end of day.\n- Make dinner.\n- Return the library books before they are due tomorrow.",
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

	it("submits the selected historical version for system-prompt optimization", async () => {
		router.location.searchStr = "?version=2";
		getPrompt.mockImplementation(({ version }: { version?: number }) =>
			Promise.resolve(version === 2 ? prompt(2) : prompt()),
		);
		renderDetail();

		fireEvent.click(
			await screen.findByRole("button", { name: "Optimize prompt" }),
		);

		fireEvent.change(screen.getByLabelText("Reflection rubric / objective"), {
			target: { value: "Answer with a concise, accurate explanation." },
		});
		fireEvent.change(screen.getByLabelText("Training 1 input"), {
			target: { value: "Question" },
		});
		fireEvent.change(screen.getByLabelText("Training 1 expected answer"), {
			target: { value: "Answer" },
		});
		fireEvent.change(screen.getByLabelText("Held-out validation 1 input"), {
			target: { value: "Separate query" },
		});
		fireEvent.change(
			screen.getByLabelText("Held-out validation 1 expected answer"),
			{ target: { value: "Different answer" } },
		);
		fireEvent.change(screen.getByLabelText("Task model"), {
			target: { value: "gpt-4o" },
		});
		fireEvent.change(screen.getByLabelText("Reflection model"), {
			target: { value: "gpt-4o-mini" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Start optimization" }));

		await waitFor(() =>
			expect(startPromptOptimization).toHaveBeenCalledWith(
				expect.objectContaining({ source_version: 2, target: "system" }),
			),
		);
	});
});
