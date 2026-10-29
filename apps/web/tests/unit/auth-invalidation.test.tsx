import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const navigate = vi.hoisted(() => vi.fn());
const location = { pathname: "/access/otlp-credentials", searchStr: "" };
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useLocation: () => location,
}));
import { AuthGate } from "../../src/components/AuthGate";
import {
	ProjectProvider,
	useProjectSelection,
} from "../../src/components/ProjectProvider";
import { NewPromptPage } from "../../src/routes/prompts-new";
import { clearAuthSession, getAuthSession } from "../../src/lib/auth";
const showModalDescriptor = Object.getOwnPropertyDescriptor(
	HTMLDialogElement.prototype,
	"showModal",
);
beforeEach(() => {
	// jsdom does not implement the browser's top-layer modal API.
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value: vi.fn(function (this: HTMLDialogElement) {
			this.open = true;
		}),
	});
});
afterEach(() => {
	cleanup();
	clearAuthSession();
	window.localStorage.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	if (showModalDescriptor) {
		Object.defineProperty(
			HTMLDialogElement.prototype,
			"showModal",
			showModalDescriptor,
		);
	} else {
		Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
	}
	navigate.mockReset();
	location.pathname = "/access/otlp-credentials";
});
const session = {
	actor_id: "actor",
	organization_id: "organization",
	authentication: "local_session",
	username: "identity-a",
	csrf_token: "test-only",
	expires_at: null,
};

function DraftInput() {
	const [draft, setDraft] = React.useState("");
	return (
		<label>
			Unsaved draft
			<input value={draft} onChange={(event) => setDraft(event.target.value)} />
		</label>
	);
}

function SessionDraft() {
	const [identity] = React.useState(getAuthSession);
	return (
		<>
			<output aria-label="Mounted session identity">
				{JSON.stringify([
					identity?.actor_id,
					identity?.organization_id,
					identity?.authentication,
					identity?.username,
				])}
			</output>
			<DraftInput />
		</>
	);
}

function expectDraftHidden(input: HTMLElement) {
	expect(input).toBeInTheDocument();
	expect(input).not.toBeVisible();
	expect(input.closest("[inert]")).not.toBeNull();
	expect(input.closest('[aria-hidden="true"]')).not.toBeNull();
	expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	const overlay = screen.getByRole("status");
	expect(overlay).toHaveTextContent("Checking session…");
	expect(overlay).toBeVisible();
	const modal = overlay.closest("dialog");
	expect(modal).toHaveAttribute("open");
	expect(modal).toHaveAttribute("aria-modal", "true");
	expect(modal).toHaveClass("fixed", "inset-0", "bg-background");
	expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
	const cancel = new Event("cancel", { cancelable: true });
	modal?.dispatchEvent(cancel);
	expect(cancel.defaultPrevented).toBe(true);
}

it("overlapping focus checks request a fresh session and fence an older principal response", async () => {
	let finishOldSession!: (response: Response) => void;
	let finishNewSession!: (response: Response) => void;
	const oldResponse = Response.json(session);
	const replacement = {
		...session,
		actor_id: "actor-b",
		username: "identity-b",
	};
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(Response.json(session))
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishOldSession = resolve;
			}),
		)
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishNewSession = resolve;
			}),
		);
	vi.stubGlobal("fetch", fetchMock);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<AuthGate>
				<SessionDraft />
			</AuthGate>
		</QueryClientProvider>,
	);
	const oldInput = await screen.findByRole("textbox", {
		name: "Unsaved draft",
	});
	fireEvent.change(oldInput, {
		target: { value: "Identity A's private draft" },
	});

	fireEvent.focus(window);
	expectDraftHidden(oldInput);
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	// Another tab logs in as B without delivering a storage invalidation event.
	fireEvent.focus(window);
	expectDraftHidden(oldInput);
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
	expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
		"/v1/auth/session",
		"/v1/auth/session",
		"/v1/auth/session",
	]);
	await act(async () => finishNewSession(Response.json(replacement)));
	const currentInput = screen.getByRole("textbox", { name: "Unsaved draft" });
	expect(currentInput).not.toBe(oldInput);
	expect(currentInput).toHaveValue("");
	const replacementIdentity = JSON.stringify([
		replacement.actor_id,
		replacement.organization_id,
		replacement.authentication,
		replacement.username,
	]);
	expect(screen.getByLabelText("Mounted session identity")).toHaveTextContent(
		replacementIdentity,
	);
	expect(getAuthSession()).toEqual(replacement);
	fireEvent.change(currentInput, { target: { value: "Identity B's draft" } });

	await act(async () => finishOldSession(oldResponse));
	expect(getAuthSession()).toEqual(replacement);
	expect(screen.getByLabelText("Mounted session identity")).toHaveTextContent(
		replacementIdentity,
	);
	expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(
		currentInput,
	);
	expect(currentInput).toHaveValue("Identity B's draft");
	expect(navigate).not.toHaveBeenCalled();
});

function WorkspaceAuthority() {
	const { organizationRole, projects, selectedProject, canRecoverAdmin } =
		useProjectSelection();
	return (
		<>
			<output aria-label="Organization role">
				{organizationRole ?? "none"}
			</output>
			<output aria-label="Workspace projects">
				{projects.map((project) => project.name).join(",")}
			</output>
			<output aria-label="Selected project">{selectedProject?.name}</output>
			<output aria-label="Selected project role">
				{selectedProject?.project_role}
			</output>
			<output aria-label="Selected project management">
				{String(selectedProject?.can_manage)}
			</output>
			<output aria-label="Selected project governance">
				{String(selectedProject?.can_govern)}
			</output>
			<output aria-label="Admin recovery">{String(canRecoverAdmin)}</output>
		</>
	);
}

it.each(["session-first", "authority-first"])(
	"focus hides mounted drafts until session and ProjectProvider authority settle (%s)",
	async (order) => {
		const projectId = "11111111-1111-4111-8111-111111111111";
		const adminActor = {
			actor_id: session.actor_id,
			organization_id: session.organization_id,
			organization_role: "admin",
			can_recover_admin: true,
			default_project_id: projectId,
			projects: [{ id: projectId, name: "Private Admin project" }],
		};
		let finishActor!: (response: Response) => void;
		let finishSession!: (response: Response) => void;
		const actorFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(adminActor))
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					finishActor = resolve;
				}),
			);
		const sessionFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(session))
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					finishSession = resolve;
				}),
			);
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url === "/v1/auth/session") return sessionFetch();
				if (url === "/v1/me") return actorFetch();
				throw new Error(`Unexpected test request: ${url}`);
			}),
		);
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, refetchOnWindowFocus: false },
			},
		});
		render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<ProjectProvider>
						<WorkspaceAuthority />
						<DraftInput />
					</ProjectProvider>
				</AuthGate>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(screen.getByLabelText("Organization role")).toHaveTextContent(
				"admin",
			),
		);
		expect(screen.getByLabelText("Selected project")).toHaveTextContent(
			"Private Admin project",
		);
		expect(screen.getByLabelText("Admin recovery")).toHaveTextContent("true");
		const input = screen.getByRole("textbox", { name: "Unsaved draft" });
		fireEvent.change(input, {
			target: { value: "Same identity's private draft" },
		});

		fireEvent.focus(window);
		expectDraftHidden(input);
		await waitFor(() => expect(actorFetch).toHaveBeenCalledTimes(2));
		expect(sessionFetch).toHaveBeenCalledTimes(2);
		expect(client.getQueryData(["me"])).toBeUndefined();
		await waitFor(() =>
			expect(screen.getByLabelText("Organization role")).toHaveTextContent(
				"none",
			),
		);
		expect(screen.getByLabelText("Workspace projects")).toBeEmptyDOMElement();
		expect(screen.getByLabelText("Selected project")).toHaveTextContent(
			"Private Admin project",
		);
		expect(screen.getByLabelText("Selected project role")).toHaveTextContent(
			"read_only",
		);
		expect(
			screen.getByLabelText("Selected project management"),
		).toHaveTextContent("false");
		expect(
			screen.getByLabelText("Selected project governance"),
		).toHaveTextContent("false");
		expect(screen.getByLabelText("Admin recovery")).toHaveTextContent("false");
		expect(screen.getByText("Private Admin project")).not.toBeVisible();
		expect(screen.getByLabelText("Unsaved draft")).toBe(input);
		expect(input).toHaveValue("Same identity's private draft");

		const userActor = {
			...adminActor,
			organization_role: "user",
			can_recover_admin: false,
			projects: [
				{
					...adminActor.projects[0],
					name: "Current User project",
					project_role: "user",
					can_manage: false,
					can_govern: false,
				},
			],
		};
		const finishAuth = () => finishSession(Response.json(session));
		const finishAuthority = () => finishActor(Response.json(userActor));
		await act(async () =>
			order === "session-first" ? finishAuth() : finishAuthority(),
		);
		expectDraftHidden(input);
		expect(input).toHaveValue("Same identity's private draft");
		await act(async () =>
			order === "session-first" ? finishAuthority() : finishAuth(),
		);
		await waitFor(() =>
			expect(screen.getByLabelText("Organization role")).toHaveTextContent(
				"user",
			),
		);
		expect(screen.getByLabelText("Selected project")).toHaveTextContent(
			"Current User project",
		);
		expect(screen.getByLabelText("Selected project role")).toHaveTextContent(
			"user",
		);
		expect(screen.getByLabelText("Admin recovery")).toHaveTextContent("false");
		expect(client.getQueryData(["me"])).toEqual(userActor);
		expect(getAuthSession()).toEqual(session);
		expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(input);
		expect(input).toBeVisible();
		expect(input.closest("[inert]")).toBeNull();
		expect(screen.queryByText("Checking session…")).not.toBeInTheDocument();
		expect(input).toHaveValue("Same identity's private draft");
		expect(navigate).not.toHaveBeenCalled();
	},
);

it("focus preserves a real NewPromptPage draft while ProjectProvider authority refreshes", async () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const actor = {
		actor_id: session.actor_id,
		organization_id: session.organization_id,
		organization_role: "admin",
		can_recover_admin: true,
		default_project_id: projectId,
		projects: [
			{
				id: projectId,
				name: "Project One",
				slug: "project-one",
				status: "active",
				project_role: "admin",
			},
		],
	};
	let finishActor!: (response: Response) => void;
	let finishSession!: (response: Response) => void;
	const actorFetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(actor))
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishActor = resolve;
			}),
		);
	const sessionFetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(session))
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishSession = resolve;
			}),
		);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			if (url === "/v1/auth/session") return sessionFetch();
			if (url === "/v1/me") return actorFetch();
			throw new Error(`Unexpected test request: ${url}`);
		}),
	);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<AuthGate>
				<ProjectProvider>
					<NewPromptPage />
				</ProjectProvider>
			</AuthGate>
		</QueryClientProvider>,
	);
	const nameInput = await screen.findByLabelText("Name");
	const systemInput = screen.getByLabelText("System prompt (optional)");
	fireEvent.change(nameInput, { target: { value: "Private draft" } });
	fireEvent.change(systemInput, { target: { value: "Draft body" } });

	fireEvent.focus(window);
	await waitFor(() => expect(actorFetch).toHaveBeenCalledTimes(2));
	expect(sessionFetch).toHaveBeenCalledTimes(2);
	expectDraftHidden(systemInput);
	expect(systemInput).toHaveValue("Draft body");
	await act(async () => finishSession(Response.json(session)));
	expectDraftHidden(systemInput);
	expect(systemInput).toHaveValue("Draft body");
	await act(async () => finishActor(Response.json(actor)));
	await waitFor(() => expect(systemInput).toBeVisible());
	expect(screen.getByLabelText("Name")).toBe(nameInput);
	expect(systemInput).toBe(screen.getByLabelText("System prompt (optional)"));
	expect(nameInput).toHaveValue("Private draft");
	expect(systemInput).toHaveValue("Draft body");
	expect(navigate).not.toHaveBeenCalled();
});

it("superseded auth and authority completions cannot reveal a newer pending focus check", async () => {
	const actor = {
		actor_id: session.actor_id,
		organization_id: session.organization_id,
		organization_role: "user",
		can_recover_admin: false,
		default_project_id: null,
		projects: [],
	};
	const finishSessions: ((response: Response) => void)[] = [];
	const finishActors: ((response: Response) => void)[] = [];
	const sessionFetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(session))
		.mockImplementation(
			() => new Promise<Response>((resolve) => finishSessions.push(resolve)),
		);
	const actorFetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(actor))
		.mockImplementation(
			() => new Promise<Response>((resolve) => finishActors.push(resolve)),
		);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			if (url === "/v1/auth/session") return sessionFetch();
			if (url === "/v1/me") return actorFetch();
			throw new Error(`Unexpected test request: ${url}`);
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<AuthGate>
				<ProjectProvider>
					<WorkspaceAuthority />
					<DraftInput />
				</ProjectProvider>
			</AuthGate>
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(screen.getByLabelText("Organization role")).toHaveTextContent(
			"user",
		),
	);
	const input = screen.getByRole("textbox", { name: "Unsaved draft" });
	fireEvent.change(input, { target: { value: "Private draft" } });
	fireEvent.focus(window);
	await waitFor(() => expect(actorFetch).toHaveBeenCalledTimes(2));
	fireEvent.focus(window);
	await waitFor(() => expect(actorFetch).toHaveBeenCalledTimes(3));
	expect(sessionFetch).toHaveBeenCalledTimes(3);
	expectDraftHidden(input);

	await act(async () => {
		finishSessions[0]!(Response.json(session));
		finishActors[0]!(Response.json(actor));
	});
	expectDraftHidden(input);
	await act(async () => finishActors[1]!(Response.json(actor)));
	expectDraftHidden(input);
	await act(async () => finishSessions[1]!(Response.json(session)));
	expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(input);
	expect(input).toBeVisible();
	expect(input).toHaveValue("Private draft");
	expect(screen.queryByText("Checking session…")).not.toBeInTheDocument();
	expect(navigate).not.toHaveBeenCalled();
});

it("pending overlapping focus checks retain the cached session deadline", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
	const expiringSession = {
		...session,
		expires_at: new Date(Date.now() + 1_000).toISOString(),
	};
	const finishRevalidations: ((response: Response) => void)[] = [];
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(Response.json(expiringSession))
		.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					finishRevalidations.push(resolve);
				}),
		);
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient();
	await act(async () => {
		render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<DraftInput />
				</AuthGate>
			</QueryClientProvider>,
		);
	});
	const input = screen.getByRole("textbox", { name: "Unsaved draft" });
	fireEvent.change(input, { target: { value: "Expiring private draft" } });
	await act(async () => vi.advanceTimersByTime(400));
	fireEvent.focus(window);
	await act(async () => vi.advanceTimersByTime(200));
	fireEvent.focus(window);
	expect(fetchMock).toHaveBeenCalledTimes(3);
	client.setQueryData(["sensitive-trace"], { text: "Private content" });
	await act(async () => vi.advanceTimersByTime(399));
	expect(screen.getByLabelText("Unsaved draft")).toBe(input);
	expectDraftHidden(input);
	expect(input).toHaveValue("Expiring private draft");
	expect(navigate).not.toHaveBeenCalled();

	await act(async () => vi.advanceTimersByTime(1));
	expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	expect(navigate).toHaveBeenCalledWith({ to: "/login" });
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	expect(getAuthSession()).toBeNull();

	await act(async () => {
		for (const finish of finishRevalidations) {
			finish(
				Response.json({
					...expiringSession,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				}),
			);
		}
	});
	expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	expect(getAuthSession()).toBeNull();
});

it("unmount cancels the expiry timer even with a pending focus check", async () => {
	vi.useFakeTimers();
	const expiringSession = {
		...session,
		expires_at: new Date(Date.now() + 1_000).toISOString(),
	};
	let finishRevalidation!: (response: Response) => void;
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(Response.json(expiringSession))
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					finishRevalidation = resolve;
				}),
			),
	);
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<QueryClientProvider client={new QueryClient()}>
				<AuthGate>
					<DraftInput />
				</AuthGate>
			</QueryClientProvider>,
		);
	});
	fireEvent.focus(window);
	view.unmount();
	await act(async () => finishRevalidation(Response.json(expiringSession)));
	await act(async () => vi.advanceTimersByTime(1_000));
	expect(navigate).not.toHaveBeenCalled();
	expect(getAuthSession()).toEqual(expiringSession);
});

it.each([
	["actor_id", { ...session, actor_id: "other-actor" }],
	["organization_id", { ...session, organization_id: "other-organization" }],
	["authentication", { ...session, authentication: "basic", csrf_token: null }],
	["username", { ...session, username: "identity-b" }],
])(
	"focus revalidation discards a draft for a changed %s identity",
	async (_field, replacement) => {
		let finishRevalidation!: (response: Response) => void;
		let finishAuthority!: (response: Response) => void;
		const actor = {
			actor_id: session.actor_id,
			organization_id: session.organization_id,
			organization_role: "user",
			can_recover_admin: false,
			default_project_id: null,
			projects: [],
		};
		const actorFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(actor))
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					finishAuthority = resolve;
				}),
			);
		const sessionFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(session))
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					finishRevalidation = resolve;
				}),
			);
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url === "/v1/auth/session") return sessionFetch();
				if (url === "/v1/me") return actorFetch();
				throw new Error(`Unexpected test request: ${url}`);
			}),
		);
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, refetchOnWindowFocus: false },
			},
		});
		render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<ProjectProvider>
						<SessionDraft />
					</ProjectProvider>
				</AuthGate>
			</QueryClientProvider>,
		);
		const input = await screen.findByRole("textbox", { name: "Unsaved draft" });
		await waitFor(() => expect(client.getQueryData(["me"])).toEqual(actor));
		fireEvent.change(input, {
			target: { value: "Identity A's private draft" },
		});
		client.setQueryData(["sensitive-trace"], { text: "Identity A's content" });
		fireEvent.focus(window);
		await waitFor(() => expect(actorFetch).toHaveBeenCalledTimes(2));
		expect(sessionFetch).toHaveBeenCalledTimes(2);
		expect(screen.getByLabelText("Unsaved draft")).toBe(input);
		expectDraftHidden(input);
		expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
		await act(async () => finishRevalidation(Response.json(replacement)));
		expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

		const currentInput = screen.getByLabelText("Unsaved draft");
		expect(currentInput).toHaveValue("");
		expect(currentInput).not.toBe(input);
		expect(input).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("Identity A's private draft")).toBeNull();
		expectDraftHidden(currentInput);
		expect(screen.getByLabelText("Mounted session identity")).toHaveTextContent(
			JSON.stringify([
				replacement.actor_id,
				replacement.organization_id,
				replacement.authentication,
				replacement.username,
			]),
		);
		expect(getAuthSession()).toEqual(replacement);
		const replacementActor = {
			...actor,
			actor_id: replacement.actor_id,
			organization_id: replacement.organization_id,
		};
		await act(async () => finishAuthority(Response.json(replacementActor)));
		expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(
			currentInput,
		);
		expect(currentInput).toBeVisible();
		expect(currentInput).toHaveValue("");
		expect(screen.queryByText("Checking session…")).not.toBeInTheDocument();
		expect(client.getQueryData(["sensitive-trace"])).toBeUndefined();
		expect(client.getQueryData(["me"])).toEqual(replacementActor);
		expect(navigate).not.toHaveBeenCalled();
	},
);

it("focus revalidation preserves an unsaved draft for the same valid session while clearing private queries", async () => {
	let finishRevalidation!: (response: Response) => void;
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(Response.json(session))
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishRevalidation = resolve;
			}),
		);
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient();
	render(
		<QueryClientProvider client={client}>
			<AuthGate>
				<DraftInput />
			</AuthGate>
		</QueryClientProvider>,
	);
	const input = await screen.findByRole("textbox", { name: "Unsaved draft" });
	fireEvent.change(input, { target: { value: "An unsaved prompt draft" } });
	expect(input).toHaveValue("An unsaved prompt draft");
	client.setQueryData(["sensitive-trace"], {
		text: "test-only private content",
	});

	fireEvent.focus(window);
	expectDraftHidden(input);
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
		"/v1/auth/session",
		"/v1/auth/session",
	]);
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	const refreshedSession = {
		...session,
		csrf_token: "test-only-refreshed",
		expires_at: new Date(Date.now() + 60_000).toISOString(),
	};
	await act(async () => finishRevalidation(Response.json(refreshedSession)));

	expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toHaveValue(
		"An unsaved prompt draft",
	);
	expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(input);
	expect(input).toBeVisible();
	expect(input.closest("[inert]")).toBeNull();
	expect(screen.queryByText("Checking session…")).not.toBeInTheDocument();
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	expect(getAuthSession()).toEqual(refreshedSession);
	expect(navigate).not.toHaveBeenCalled();
});

it("a failed focus check keeps protected children hidden while retrying", async () => {
	let finishRetry!: (response: Response) => void;
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(Response.json(session))
		.mockResolvedValueOnce(Response.json({}, { status: 503 }))
		.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				finishRetry = resolve;
			}),
		);
	vi.stubGlobal("fetch", fetchMock);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<AuthGate>
				<div>test-only protected content</div>
			</AuthGate>
		</QueryClientProvider>,
	);
	expect(
		await screen.findByText("test-only protected content"),
	).toBeInTheDocument();
	fireEvent.focus(window);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Session could not be checked.",
	);

	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
	expect(
		screen.queryByText("test-only protected content"),
	).not.toBeInTheDocument();
	await act(async () => finishRetry(Response.json(session)));
	expect(screen.getByText("test-only protected content")).toBeInTheDocument();
});

it("entering a protected route from a public auth route waits for a valid session", async () => {
	let finishSession!: (response: Response) => void;
	const fetchMock = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				finishSession = resolve;
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient();
	location.pathname = "/login";
	const view = render(
		<QueryClientProvider client={client}>
			<AuthGate>Public auth route</AuthGate>
		</QueryClientProvider>,
	);
	expect(screen.getByText("Public auth route")).toBeInTheDocument();
	expect(fetchMock).not.toHaveBeenCalled();

	location.pathname = "/prompts/new";
	view.rerender(
		<QueryClientProvider client={client}>
			<AuthGate>
				<DraftInput />
			</AuthGate>
		</QueryClientProvider>,
	);
	await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
	expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	await act(async () => finishSession(Response.json(session)));
	expect(
		screen.getByRole("textbox", { name: "Unsaved draft" }),
	).toBeInTheDocument();
});

for (const signal of ["storage", "focus"] as const) {
	it(`${signal} invalidation clears the workspace cache and unmounts revealed state`, async () => {
		let signedIn = true;
		let finishSetup!: (response: Response) => void;
		const setupRequest = new Promise<Response>((resolve) => {
			finishSetup = resolve;
		});
		const fetchMock = vi.fn(async (url: string) =>
			url.includes("setup")
				? setupRequest
				: Response.json(signedIn ? session : {}, {
						status: signedIn ? 200 : 401,
					}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<div>test-only revealed credential</div>
				</AuthGate>
			</QueryClientProvider>,
		);
		expect(
			await screen.findByText("test-only revealed credential"),
		).toBeInTheDocument();
		client.setQueryData(["sensitive-trace"], {
			text: "test-only private content",
		});
		signedIn = false;
		fireEvent(
			window,
			signal === "storage"
				? new StorageEvent("storage", {
						key: "glasshouse.auth.invalidate",
						newValue: "another-tab-logout",
					})
				: new Event("focus"),
		);
		if (signal === "focus") {
			await waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith("/v1/auth/setup", {
					cache: "no-store",
				}),
			);
			expect(navigate).not.toHaveBeenCalled();
			expect(
				screen.queryByText("test-only revealed credential"),
			).not.toBeInTheDocument();
			expect(client.getQueryCache().getAll()).toHaveLength(0);
			await act(async () => finishSetup(Response.json({ available: false })));
		}
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: "/login" }),
		);
		expect(
			screen.queryByText("test-only revealed credential"),
		).not.toBeInTheDocument();
		expect(client.getQueryCache().getAll()).toHaveLength(0);
	});
}
