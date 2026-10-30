import * as React from "react";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ changeOwnPassword: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
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
vi.mock("../../src/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api")>();
	return { ...actual, changeOwnPassword: api.changeOwnPassword };
});

import { ApiError } from "../../src/lib/api";
import { PasswordChangePage } from "../../src/routes/password-change";

describe("self-service password change", () => {
	beforeEach(() => {
		api.changeOwnPassword.mockReset();
		window.localStorage.clear();
		window.sessionStorage.clear();
	});
	afterEach(cleanup);

	it("shows password guidance and blocks a new password that is too short", async () => {
		render(<PasswordChangePage />);
		expect(
			screen.getByText(
				"Use at least 12 characters. Longer, unique passphrases are easier to remember. Don’t reuse a password from another site.",
			),
		).toBeVisible();
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: "current-test-password" },
		});
		fireEvent.change(screen.getByLabelText("New password"), {
			target: { value: "short" },
		});
		fireEvent.change(screen.getByLabelText("Confirm new password"), {
			target: { value: "short" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/Use at least 12 characters/,
		);
		expect(api.changeOwnPassword).not.toHaveBeenCalled();
	});

	it("explains an incorrect current password without discarding the session", async () => {
		api.changeOwnPassword.mockRejectedValueOnce(
			new ApiError(
				422,
				"INVALID_CURRENT_PASSWORD",
				"Current password is incorrect",
			),
		);
		render(<PasswordChangePage />);
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: "incorrect-test-password" },
		});
		fireEvent.change(screen.getByLabelText("New password"), {
			target: { value: "replacement-test-password" },
		});
		fireEvent.change(screen.getByLabelText("Confirm new password"), {
			target: { value: "replacement-test-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The current password is incorrect");
		expect(screen.getByLabelText("Current password")).toHaveValue("");
		expect(screen.getByLabelText("New password")).toHaveValue("");
		expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
		expect(window.localStorage.length).toBe(0);
		expect(window.sessionStorage.length).toBe(0);
		expect(api.changeOwnPassword).toHaveBeenCalledWith(
			"incorrect-test-password",
			"replacement-test-password",
		);
	});

	it("explains rate limiting so the user can retry later", async () => {
		api.changeOwnPassword.mockRejectedValueOnce(
			new ApiError(429, "TOO_MANY_REQUESTS", "Too many attempts"),
		);
		render(<PasswordChangePage />);
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: "current-test-password" },
		});
		fireEvent.change(screen.getByLabelText("New password"), {
			target: { value: "replacement-test-password" },
		});
		fireEvent.change(screen.getByLabelText("Confirm new password"), {
			target: { value: "replacement-test-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Too many attempts. Wait before trying again.",
		);
		expect(api.changeOwnPassword).toHaveBeenCalledOnce();
	});

	it("does not send passwords when confirmation differs", async () => {
		render(<PasswordChangePage />);
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: "current-test-password" },
		});
		fireEvent.change(screen.getByLabelText("New password"), {
			target: { value: "replacement-test-password" },
		});
		fireEvent.change(screen.getByLabelText("Confirm new password"), {
			target: { value: "different-test-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"New passwords do not match",
			),
		);
		expect(api.changeOwnPassword).not.toHaveBeenCalled();
	});
	it("rejects short Unicode new passwords before submitting", async () => {
		render(<PasswordChangePage />);
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: "current-test-password" },
		});
		for (const label of ["New password", "Confirm new password"])
			fireEvent.change(screen.getByLabelText(label), {
				target: { value: "😀".repeat(11) },
			});
		fireEvent.submit(
			screen.getByRole("button", { name: "Change password" }).closest("form")!,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("at least 12");
		expect(api.changeOwnPassword).not.toHaveBeenCalled();
	});
});
