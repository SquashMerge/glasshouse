import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const { getActivePromptOptimization, getPrompt, stopPromptOptimization } =
	vi.hoisted(() => ({
		getActivePromptOptimization: vi.fn(),
		getPrompt: vi.fn(),
		stopPromptOptimization: vi.fn(),
	}));

vi.mock("@tanstack/react-router", () => ({
	useLocation: () => ({ searchStr: "" }),
	useNavigate: () => vi.fn(),
	useParams: () => ({ slug: "support-agent" }),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: { name: "Project One" },
	}),
}));
vi.mock("../../src/lib/api", () => ({
	getActivePromptOptimization,
	getPrompt,
	stopPromptOptimization,
}));
vi.mock("../../src/routes/prompts-new", () => ({
	PromptComposer: () => <div>Prompt composer</div>,
}));

import { EditPromptPage } from "../../src/routes/prompts-edit";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe("EditPromptPage loading", () => {
	it("renders a form-shaped skeleton while the source prompt is initially loading", () => {
		getPrompt.mockReturnValue(new Promise(() => undefined));
		getActivePromptOptimization.mockResolvedValue(null);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<EditPromptPage />
			</QueryClientProvider>,
		);

		expect(screen.getByTestId("prompt-edit-skeleton")).toBeInTheDocument();
		expect(screen.queryByText("Loading prompt…")).not.toBeInTheDocument();
	});
});
