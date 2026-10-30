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
import type { Prompt } from "../../src/lib/api";

const {
	getActivePromptOptimization,
	getPrompt,
	stopPromptOptimization,
	route,
	selection,
} = vi.hoisted(() => ({
	getActivePromptOptimization: vi.fn(),
	getPrompt: vi.fn(),
	stopPromptOptimization: vi.fn(),
	route: { slug: "support-agent", searchStr: "" },
	selection: {
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: { name: "Project One" },
	},
}));

vi.mock("@tanstack/react-router", () => ({
	useLocation: () => route,
	useNavigate: () => vi.fn(),
	useParams: () => route,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => selection,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	getActivePromptOptimization,
	getPrompt,
	stopPromptOptimization,
}));

import { EditPromptPage } from "../../src/routes/prompts-edit";

const clients: QueryClient[] = [];

function prompt(
	projectId = selection.selectedProjectId,
	slug = route.slug,
	version = 2,
	source = `Source version ${version}`,
): Prompt {
	return {
		id: slug,
		project_id: projectId,
		name: "Support Agent",
		description: null,
		version,
		messages: [{ role: "system", content: source }],
		model: null,
		settings: {},
		change_summary: "Published version",
		created_by: "actor-id",
		created_by_username: "admin.user",
		created_at: "2026-10-29T10:00:00.000Z",
		content_hash: "a".repeat(64),
		diff: null,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

function renderEditor() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	clients.push(client);
	const view = render(<EditPromptPage />, {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return { client, rerender: () => view.rerender(<EditPromptPage />) };
}

beforeEach(() => {
	route.slug = "support-agent";
	route.searchStr = "";
	selection.selectedProjectId = "11111111-1111-4111-8111-111111111111";
	getPrompt.mockImplementation(({ project_id, slug, version }) =>
		Promise.resolve(prompt(project_id, slug, version)),
	);
	getActivePromptOptimization.mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
	vi.resetAllMocks();
});

describe("EditPromptPage loading", () => {
	it("renders a form-shaped skeleton while the source prompt is initially loading", () => {
		getPrompt.mockReturnValue(new Promise(() => undefined));
		renderEditor();

		expect(screen.getByTestId("prompt-edit-skeleton")).toBeInTheDocument();
		expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
		expect(screen.queryByText("Loading prompt…")).not.toBeInTheDocument();
	});

	it.each([undefined, 1])(
		"preserves the mounted draft through a focus-style query reset (from=%s)",
		async (fromVersion) => {
			route.searchStr = fromVersion ? `?from=${fromVersion}` : "";
			const { client } = renderEditor();
			const composer = await screen.findByTestId("prompt-composer");
			const systemInput = screen.getByLabelText("System prompt (optional)");
			await waitFor(() =>
				expect(systemInput).toHaveValue(`Source version ${fromVersion ?? 2}`),
			);
			const draft = {
				"System prompt (optional)": "Unsaved system draft",
				"User prompt (optional)": "Unsaved user draft",
				"Model (optional)": "draft-model",
				"Settings JSON": '{"temperature":0.3}',
				"Change summary": "Unsaved change summary",
				"Variables JSON": '{"name":"Ada"}',
			};
			for (const [label, value] of Object.entries(draft)) {
				fireEvent.change(screen.getByLabelText(label), { target: { value } });
			}
			const current = deferred<Prompt>();
			const selected = deferred<Prompt>();
			getPrompt.mockImplementation(({ version }) =>
				version ? selected.promise : current.promise,
			);
			let refresh!: Promise<void>;
			await act(async () => {
				refresh = client.resetQueries();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(
				client.getQueryData([
					"prompt",
					selection.selectedProjectId,
					route.slug,
					"current",
				]),
			).toBeUndefined();
			expect(
				screen.queryByTestId("prompt-edit-skeleton"),
			).not.toBeInTheDocument();
			expect(screen.getByTestId("prompt-composer")).toBe(composer);
			expect(screen.getByLabelText("System prompt (optional)")).toBe(
				systemInput,
			);
			for (const [label, value] of Object.entries(draft)) {
				expect(screen.getByLabelText(label)).toHaveValue(value);
			}

			await act(async () => current.resolve(prompt()));
			if (fromVersion) {
				expect(
					client.getQueryData([
						"prompt",
						selection.selectedProjectId,
						route.slug,
						fromVersion,
					]),
				).toBeUndefined();
				expect(screen.getByTestId("prompt-composer")).toBe(composer);
				expect(systemInput).toHaveValue(draft["System prompt (optional)"]);
			}
			await act(async () => {
				selected.resolve(prompt(undefined, undefined, fromVersion));
				await refresh;
			});
			expect(screen.getByTestId("prompt-composer")).toBe(composer);
			expect(screen.getByLabelText("System prompt (optional)")).toBe(
				systemInput,
			);
			for (const [label, value] of Object.entries(draft)) {
				expect(screen.getByLabelText(label)).toHaveValue(value);
			}
		},
	);

	it.each(["project", "slug", "source version"])(
		"does not show a previous draft while a different %s loads",
		async (context) => {
			route.searchStr = "?from=1";
			const { rerender } = renderEditor();
			const systemInput = await screen.findByLabelText(
				"System prompt (optional)",
			);
			fireEvent.change(systemInput, { target: { value: "Private old draft" } });
			getPrompt.mockReturnValue(new Promise(() => undefined));
			if (context === "project") {
				selection.selectedProjectId = "22222222-2222-4222-8222-222222222222";
			} else if (context === "slug") {
				route.slug = "another-agent";
			} else {
				route.searchStr = "?from=2";
			}
			rerender();

			expect(screen.getByTestId("prompt-edit-skeleton")).toBeInTheDocument();
			expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
			expect(systemInput).not.toBeInTheDocument();
		},
	);

	it.each(["project", "slug", "source version"])(
		"discards the whole draft when switching to a cached different %s",
		async (context) => {
			route.searchStr = "?from=1";
			const { client, rerender } = renderEditor();
			const composer = await screen.findByTestId("prompt-composer");
			fireEvent.change(screen.getByLabelText("System prompt (optional)"), {
				target: { value: "Private old draft" },
			});
			fireEvent.change(screen.getByLabelText("Change summary"), {
				target: { value: "Private old summary" },
			});
			fireEvent.change(screen.getByLabelText("Variables JSON"), {
				target: { value: '{"private":"old variables"}' },
			});
			getPrompt.mockReturnValue(new Promise(() => undefined));
			if (context === "project") {
				selection.selectedProjectId = "22222222-2222-4222-8222-222222222222";
			} else if (context === "slug") {
				route.slug = "another-agent";
			} else {
				route.searchStr = "?from=2";
			}
			const sourceVersion = context === "source version" ? 2 : 1;
			client.setQueryData(
				["prompt", selection.selectedProjectId, route.slug, "current"],
				prompt(),
			);
			client.setQueryData(
				["prompt", selection.selectedProjectId, route.slug, sourceVersion],
				prompt(undefined, undefined, sourceVersion, "Different context source"),
			);
			rerender();

			await waitFor(() =>
				expect(screen.getByLabelText("System prompt (optional)")).toHaveValue(
					"Different context source",
				),
			);
			expect(screen.getByTestId("prompt-composer")).not.toBe(composer);
			expect(screen.getByLabelText("Change summary")).toHaveValue("");
			expect(screen.getByLabelText("Variables JSON")).toHaveValue("{}");
		},
	);

	it("discards the draft when the refreshed current prompt becomes a different source version", async () => {
		const { client } = renderEditor();
		const composer = await screen.findByTestId("prompt-composer");
		fireEvent.change(screen.getByLabelText("Change summary"), {
			target: { value: "Summary for the old source version" },
		});
		getPrompt.mockResolvedValue(prompt(undefined, undefined, 3));
		await act(async () => client.resetQueries());

		await waitFor(() =>
			expect(screen.getByLabelText("System prompt (optional)")).toHaveValue(
				"Source version 3",
			),
		);
		expect(screen.getByTestId("prompt-composer")).not.toBe(composer);
		expect(screen.getByLabelText("Change summary")).toHaveValue("");
	});

	it("still replaces the composer with an error when the refreshed prompt fails", async () => {
		const { client } = renderEditor();
		await screen.findByTestId("prompt-composer");
		getPrompt.mockRejectedValue(new Error("Prompt is no longer available."));
		await act(async () => client.resetQueries());

		expect(
			await screen.findByText("Prompt is no longer available."),
		).toBeInTheDocument();
		expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
	});

	it("still blocks editing when an optimization is found during refresh", async () => {
		const { client } = renderEditor();
		await screen.findByTestId("prompt-composer");
		getActivePromptOptimization.mockResolvedValue({
			id: "active-optimization",
		});
		await act(async () => client.resetQueries());

		expect(
			await screen.findByText(
				"An optimization is active. Stop it before editing this prompt.",
			),
		).toBeInTheDocument();
		expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
	});
});
