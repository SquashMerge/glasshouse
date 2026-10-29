import "./setup";
import type * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const clearSession = vi.hoisted(() => vi.fn());
const location = { pathname: "/", searchStr: "" };
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useLocation: () => location,
	Link: ({
		children,
		to,
		...props
	}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}));
vi.mock("../../src/components/ProjectProvider", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../src/components/ProjectProvider")
	>()),
	useProjectSelection: () => ({
		projects: [],
		selectedProjectId: null,
		selectedProject: null,
		isLoading: false,
		error: null,
		organizationRole: "admin",
		canRecoverAdmin: false,
		selectProject: vi.fn(),
		clearSession,
		retry: vi.fn(),
	}),
}));

import { AppShell } from "../../src/components/AppShell";
import { AuthGate } from "../../src/components/AuthGate";
import { clearAuthSession, getAuthSession } from "../../src/lib/auth";

const session = {
	actor_id: "actor",
	organization_id: "organization",
	authentication: "local_session",
	username: "test.admin",
	csrf_token: "test-only-csrf",
	expires_at: null,
};
let client: QueryClient;
let resolveLogout: (response: Response) => void;
let fetchMock: ReturnType<typeof vi.fn>;
let view: ReturnType<typeof render>;

beforeEach(async () => {
	clearAuthSession();
	localStorage.clear();
	navigate.mockReset();
	clearSession.mockReset();
	const logoutResponse = new Promise<Response>((resolve) => {
		resolveLogout = resolve;
	});
	fetchMock = vi.fn((url: string) => {
		if (url === "/v1/auth/session")
			return Promise.resolve(Response.json(session));
		if (url === "/v1/auth/logout") return logoutResponse;
		throw new Error("Unexpected request");
	});
	vi.stubGlobal("fetch", fetchMock);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	view = render(
		<QueryClientProvider client={client}>
			<AuthGate>
				<AppShell>
					<div>Private workspace</div>
				</AppShell>
			</AuthGate>
		</QueryClientProvider>,
	);
	await view.findByText("Private workspace");
	client.setQueryData(["private"], "test-only private data");
	fireEvent.click(
		view.getByRole("button", { name: "Account menu for test.admin" }),
	);
	fireEvent.click(view.getByRole("menuitem", { name: "Log out" }));
});

afterEach(() => {
	cleanup();
	client.clear();
	clearAuthSession();
	localStorage.clear();
	vi.unstubAllGlobals();
});

it("waits for revocation, then lets AuthGate redirect and clear private state", async () => {
	expect(getAuthSession()).toEqual(session);
	expect(client.getQueryData(["private"])).toBe("test-only private data");
	expect(navigate).not.toHaveBeenCalled();
	expect(clearSession).not.toHaveBeenCalled();
	const [url, init] = fetchMock.mock.lastCall!;
	expect(url).toBe("/v1/auth/logout");
	expect(init.method).toBe("POST");
	expect(init.credentials).toBe("same-origin");
	expect(init.headers.get("x-glasshouse-csrf")).toBe(session.csrf_token);
	await act(async () => resolveLogout(Response.json({ ok: true })));
	expect(getAuthSession()).toBeNull();
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	expect(view.queryByText("Private workspace")).toBeNull();
	expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/login" });
});

it("keeps the session and private workspace available for retry when revocation fails", async () => {
	await act(async () => resolveLogout(Response.json({}, { status: 500 })));
	expect(view.getByRole("alert").textContent).toContain("Sign out failed");
	expect(getAuthSession()).toEqual(session);
	expect(client.getQueryData(["private"])).toBe("test-only private data");
	expect(view.getByText("Private workspace")).not.toBeNull();
	expect(clearSession).not.toHaveBeenCalled();
	expect(navigate).not.toHaveBeenCalled();
});
