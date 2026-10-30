import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthSession } from "../../src/lib/auth";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useLocation: () => ({ searchStr: "", pathname: "/login" }),
	Link: ({
		to,
		children,
		...props
	}: {
		to: string;
		children: React.ReactNode;
	}) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}));
import { FirstPasswordForm } from "../../src/components/LocalAuthForm";
import { SetupPage } from "../../src/routes/setup";
import { LoginPage } from "../../src/routes/login";

function mount(node: React.ReactNode) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			{node}
		</QueryClientProvider>,
	);
}
const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status });
describe("local authentication pages", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		clearAuthSession();
		vi.clearAllMocks();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		clearAuthSession();
	});
	it("closed setup exposes no secret form or organization controls", async () => {
		fetchMock.mockResolvedValue(json({ available: false }));
		mount(<SetupPage />);
		expect(
			await screen.findByText(/unavailable or already initialized/),
		).toBeVisible();
		expect(screen.queryByLabelText("Setup secret")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
	});
	it("enrollment rejects short Unicode passwords before submitting", async () => {
		mount(<FirstPasswordForm setup={false} onComplete={vi.fn()} />);
		for (const label of ["New password", "Confirm password"])
			fireEvent.change(screen.getByLabelText(label), {
				target: { value: "😀".repeat(11) },
			});
		fireEvent.submit(
			screen.getByRole("button", { name: "Set password" }).closest("form")!,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("at least 12");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("setup sends only operator secret, username and password, then clears sensitive fields", async () => {
		fetchMock.mockResolvedValue(json({ ok: true }));
		const completed = vi.fn();
		mount(<FirstPasswordForm setup onComplete={completed} />);
		fireEvent.change(screen.getByLabelText("Username"), {
			target: { value: "Test.Admin" },
		});
		fireEvent.change(screen.getByLabelText("Setup secret"), {
			target: { value: "test-code".padEnd(43, "x") },
		});
		for (const name of ["New password", "Confirm password"])
			fireEvent.change(screen.getByLabelText(name), {
				target: { value: "test-only-password" },
			});
		fireEvent.submit(
			screen
				.getByRole("button", { name: "Create first Admin" })
				.closest("form")!,
		);
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
		expect(Object.keys(sent).sort()).toEqual(["password", "token", "username"]);
		expect(screen.getByLabelText("Setup secret")).toHaveValue("");
		expect(screen.getByLabelText("New password")).toHaveValue("");
	});
	it("invalid enrollment uses safe recovery text, clears secrets and focuses the error", async () => {
		fetchMock.mockResolvedValue(json({ code: "UNAUTHORIZED" }, 401));
		mount(<FirstPasswordForm setup={false} onComplete={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("Enrollment code"), {
			target: { value: "test-code".padEnd(43, "x") },
		});
		for (const name of ["New password", "Confirm password"])
			fireEvent.change(screen.getByLabelText(name), {
				target: { value: "test-only-password" },
			});
		fireEvent.submit(
			screen.getByRole("button", { name: "Set password" }).closest("form")!,
		);
		const error = await screen.findByRole("alert");
		expect(error).toHaveTextContent(/expired, revoked or already used/);
		await waitFor(() => expect(error).toHaveFocus());
		expect(screen.getByLabelText("Enrollment code")).toHaveValue("");
	});
	it("shows clear password guidance and blocks a password that is too short", async () => {
		fetchMock.mockResolvedValue(json({ ok: true }));
		mount(<FirstPasswordForm setup={false} onComplete={vi.fn()} />);
		expect(
			screen.getByText(
				"Use at least 12 characters. Longer, unique passphrases are easier to remember. Don’t reuse a password from another site.",
			),
		).toBeVisible();
		fireEvent.change(screen.getByLabelText("Enrollment code"), {
			target: { value: "test-code".padEnd(43, "x") },
		});
		for (const name of ["New password", "Confirm password"])
			fireEvent.change(screen.getByLabelText(name), {
				target: { value: "short" },
			});
		fireEvent.submit(
			screen.getByRole("button", { name: "Set password" }).closest("form")!,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/Use at least 12 characters/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("login sends local credentials once, obtains safe session context and stores nothing", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("setup")
				? json({ available: false })
				: url.endsWith("session")
					? json({
							actor_id: "test-actor",
							organization_id: "test-org",
							username: "test.admin",
							authentication: "local_session",
							expires_at: "2099-01-01T00:00:00Z",
							csrf_token: "test-only-csrf",
						})
					: json({ ok: true }),
		);
		mount(<LoginPage />);
		expect(screen.getByLabelText("Password")).toHaveAttribute(
			"minLength",
			"12",
		);
		fireEvent.change(screen.getByLabelText("Username"), {
			target: { value: "test.admin" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "test-only-password" },
		});
		fireEvent.submit(
			screen.getByRole("button", { name: "Sign in" }).closest("form")!,
		);
		await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
		const login = fetchMock.mock.calls.find(
			([url]) => url === "/v1/auth/login",
		)!;
		expect(JSON.parse(login[1].body)).toEqual({
			username: "test.admin",
			password: "test-only-password",
		});
		expect(login[1].headers.authorization).toBeUndefined();
		expect(screen.getByLabelText("Password")).toHaveValue("");
		for (const store of [window.localStorage, window.sessionStorage])
			expect(JSON.stringify(store)).not.toContain("test-only-password");
	});
});
