import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const navigate = vi.hoisted(() => vi.fn());
const location = { pathname: "/access/otlp-credentials", searchStr: "" };
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useLocation: () => location,
}));
import { AuthGate } from "../../src/components/AuthGate";
import { clearAuthSession } from "../../src/lib/auth";
afterEach(() => {
	cleanup();
	clearAuthSession();
	vi.unstubAllGlobals();
	navigate.mockReset();
});
const session = {
	actor_id: "actor",
	organization_id: "organization",
	authentication: "local_session",
	csrf_token: "test-only",
	expires_at: null,
};

for (const signal of ["storage", "focus"] as const) {
	it(`${signal} invalidation clears the workspace cache and unmounts revealed state`, async () => {
		let signedIn = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				Response.json(
					url.includes("setup")
						? { available: false }
						: signedIn
							? session
							: {},
					{ status: url.includes("setup") || signedIn ? 200 : 401 },
				),
			),
		);
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
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: "/login" }),
		);
		expect(
			screen.queryByText("test-only revealed credential"),
		).not.toBeInTheDocument();
		expect(client.getQueryCache().getAll()).toHaveLength(0);
	});
}
