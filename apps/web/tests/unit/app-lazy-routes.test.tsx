import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, type AnyRouter } from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
	router: null as AnyRouter | null,
	history: null as ReturnType<typeof createMemoryHistory> | null,
	getCurrentActor: vi.fn(),
	getPrompt: vi.fn(),
	getActivePromptOptimization: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	const { useState } = await import("react");
	return {
		...actual,
		RouterProvider: ({ router }: { router: AnyRouter }) => {
			const [testRouter] = useState(() =>
				actual.createRouter({ ...router.options, history: state.history! }),
			);
			state.router = testRouter;
			return <actual.RouterProvider router={testRouter} />;
		},
	};
});
vi.mock("../../src/components/AppShell", () => ({
	AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	getCurrentActor: state.getCurrentActor,
	getPrompt: state.getPrompt,
	getActivePromptOptimization: state.getActivePromptOptimization,
}));

import { App } from "../../src/App";
import { clearAuthSession } from "../../src/lib/auth";

const projectId = "11111111-1111-4111-8111-111111111111";
const session = {
	actor_id: "actor-a",
	organization_id: "organization-a",
	username: "user-a",
	authentication: "local_session",
	csrf_token: "synthetic-test-value",
	expires_at: null,
};
let client: QueryClient;
const showModalDescriptor = Object.getOwnPropertyDescriptor(
	HTMLDialogElement.prototype,
	"showModal",
);

beforeEach(() => {
	state.history = createMemoryHistory({
		initialEntries: ["/prompts/support-agent/edit?from=1"],
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	});
	state.getCurrentActor.mockResolvedValue({
		...session,
		organization_role: "admin",
		default_project_id: projectId,
		projects: [{ id: projectId, name: "Test Project" }],
	});
	state.getPrompt.mockImplementation(({ slug, version }) =>
		Promise.resolve({
			id: slug,
			name: "Support Agent",
			project_id: projectId,
			version: version ?? 2,
			messages: [{ role: "system", content: `Source ${version ?? 2}` }],
			settings: {},
			model: null,
		}),
	);
	state.getActivePromptOptimization.mockResolvedValue(null);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(() => Promise.resolve(Response.json(session))),
	);
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value: function (this: HTMLDialogElement) {
			this.open = true;
		},
	});
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	client.clear();
	clearAuthSession();
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	if (showModalDescriptor)
		Object.defineProperty(
			HTMLDialogElement.prototype,
			"showModal",
			showModalDescriptor,
		);
	else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});

function renderApp() {
	return render(
		<QueryClientProvider client={client}>
			<App />
		</QueryClientProvider>,
	);
}

it("keeps route components preloadable without changing route IDs or public/protected parents", () => {
	state.history = createMemoryHistory({ initialEntries: ["/login"] });
	renderApp();
	const routes = Object.values(state.router!.routesById);
	const pages = routes.filter(
		(route) => route.options.path !== undefined && route.id !== "__root__",
	);
	expect(pages).toHaveLength(21);
	for (const route of pages) {
		expect(route.options.component).toHaveProperty(
			"preload",
			expect.any(Function),
		);
		expect(route.parentRoute?.id).toBe(
			["/login", "/setup", "/enroll"].includes(route.fullPath)
				? "__root__"
				: "/protected",
		);
	}
	expect(state.router!.options.defaultPreload).toBe(false);
	expect(
		state.router!.routesById["/protected/prompts/$slug/edit"]?.fullPath,
	).toBe("/prompts/$slug/edit");
});

it("loads a deep-linked editor, retains same-identity drafts on focus, and isolates replacement identities", async () => {
	renderApp();
	const input = await screen.findByLabelText("System prompt (optional)");
	await waitFor(() => expect(input).toHaveValue("Source 1"));
	expect(state.getPrompt).toHaveBeenCalledWith({
		project_id: projectId,
		slug: "support-agent",
		version: 1,
	});
	fireEvent.change(input, { target: { value: "Private unsaved draft" } });
	fireEvent.focus(window);
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	expect(screen.getByLabelText("System prompt (optional)")).toBe(input);
	expect(input).toHaveValue("Private unsaved draft");
	client.setQueryData(["inactive-private-query"], "Identity A data");
	vi.mocked(fetch).mockImplementation(async () =>
		Response.json({ ...session, actor_id: "actor-b", username: "user-b" }),
	);
	fireEvent.focus(window);
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	await waitFor(() =>
		expect(screen.getByLabelText("System prompt (optional)")).not.toBe(input),
	);
	await waitFor(() =>
		expect(screen.getByLabelText("System prompt (optional)")).toHaveValue(
			"Source 1",
		),
	);
	expect(client.getQueryData(["inactive-private-query"])).toBeUndefined();
	await act(async () =>
		state.router!.navigate({
			to: "/prompts/$slug/edit",
			params: { slug: "other-agent" },
			search: { from: 2 },
		}),
	);
	await waitFor(() =>
		expect(screen.getByLabelText("System prompt (optional)")).toHaveValue(
			"Source 2",
		),
	);
	expect(state.getPrompt).toHaveBeenCalledWith({
		project_id: projectId,
		slug: "other-agent",
		version: 2,
	});
});

it("redirects an unauthenticated lazy deep link before mounting private page queries", async () => {
	vi.mocked(fetch).mockImplementation(async (url) =>
		url === "/v1/auth/setup"
			? Response.json({ available: false })
			: new Response(null, { status: 401 }),
	);
	renderApp();
	await screen.findByRole("heading", { name: "Sign in" });
	expect(state.router!.state.location.pathname).toBe("/login");
	expect(state.getCurrentActor).not.toHaveBeenCalled();
	expect(state.getPrompt).not.toHaveBeenCalled();
});
