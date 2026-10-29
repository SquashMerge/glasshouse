import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const selection = vi.hoisted(() => ({
	projectId: "11111111-1111-4111-8111-111111111111",
	role: "admin" as string,
}));
const api = vi.hoisted(() => ({
	createOtlpCredential: vi.fn(),
	listOtlpCredentials: vi.fn(),
	revokeOtlpCredential: vi.fn(),
	rotateOtlpCredential: vi.fn(),
}));

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		organizationRole: selection.role,
		selectedProjectId: selection.projectId,
		selectedProject: { id: selection.projectId, name: "Project A" },
	}),
}));
vi.mock("../../src/lib/api", () => api);

import { OtlpCredentialsPage } from "../../src/routes/otlp-credentials";

const SECRET = `gh_ing_${"a".repeat(43)}`;
const credential = {
	id: "33333333-3333-4333-8333-333333333333",
	project_id: selection.projectId,
	name: "Production collector",
	secret_prefix: "gh_ing_abcdefgh",
	created_by_actor_id: "55555555-5555-4555-8555-555555555555",
	created_at: "2026-10-01T00:00:00.000Z",
	rotated_at: null,
	revoked_at: null,
	last_used_at: null,
};

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<OtlpCredentialsPage />
		</QueryClientProvider>,
	);
}

describe("OtlpCredentialsPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selection.projectId = "11111111-1111-4111-8111-111111111111";
		selection.role = "admin";
		api.listOtlpCredentials.mockResolvedValue({ items: [credential] });
		api.createOtlpCredential.mockResolvedValue({ credential, secret: SECRET });
		api.rotateOtlpCredential.mockResolvedValue({
			credential: { ...credential, rotated_at: "2026-10-02T00:00:00.000Z" },
			secret: SECRET,
		});
		api.revokeOtlpCredential.mockResolvedValue({
			...credential,
			revoked_at: "2026-10-02T00:00:00.000Z",
		});
	});
	afterEach(cleanup);

	it("creates a credential for the selected Project and reveals the secret only in the one-time panel", async () => {
		renderPage();
		fireEvent.change(screen.getByLabelText("Credential name"), {
			target: { value: "Production collector" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create credential" }));
		await waitFor(() =>
			expect(api.createOtlpCredential.mock.calls[0]?.[0]).toEqual({
				project_id: selection.projectId,
				name: "Production collector",
			}),
		);
		expect(
			await screen.findByTestId("created-credential-secret"),
		).toHaveTextContent(SECRET);
		expect(
			screen.getByText("Production collector", { selector: "h3" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss secret" }));
		expect(
			screen.queryByTestId("created-credential-secret"),
		).not.toBeInTheDocument();
	});

	it("rotates and confirms revocation for the selected Project", async () => {
		renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));
		await waitFor(() =>
			expect(api.rotateOtlpCredential.mock.calls[0]?.[0]).toEqual({
				project_id: selection.projectId,
				id: credential.id,
			}),
		);
		expect(
			await screen.findByTestId("created-credential-secret"),
		).toHaveTextContent(SECRET);
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
		await waitFor(() =>
			expect(api.revokeOtlpCredential.mock.calls[0]?.[0]).toEqual({
				project_id: selection.projectId,
				id: credential.id,
			}),
		);
	});

	it("does not render a one-time secret after the selected Project changes", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let secretVisibleAtProjectBCommit = false;
		function CommitProbe() {
			const root = React.useRef<HTMLDivElement>(null);
			React.useLayoutEffect(() => {
				if (selection.projectId === "66666666-6666-4666-8666-666666666666")
					secretVisibleAtProjectBCommit =
						root.current?.textContent?.includes(SECRET) ?? false;
			});
			return (
				<div ref={root}>
					<QueryClientProvider client={client}>
						<OtlpCredentialsPage />
					</QueryClientProvider>
				</div>
			);
		}
		const view = render(<CommitProbe />);
		fireEvent.change(screen.getByLabelText("Credential name"), {
			target: { value: "Production collector" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create credential" }));
		expect(
			await screen.findByTestId("created-credential-secret"),
		).toHaveTextContent(SECRET);

		selection.projectId = "66666666-6666-4666-8666-666666666666";
		view.rerender(<CommitProbe />);
		expect(secretVisibleAtProjectBCommit).toBe(false);
		expect(
			screen.queryByTestId("created-credential-secret"),
		).not.toBeInTheDocument();
	});

	it("does not render management controls for non-Admins", () => {
		selection.role = "user";
		renderPage();
		expect(
			screen.queryByRole("button", { name: "Create credential" }),
		).not.toBeInTheDocument();
		expect(api.listOtlpCredentials).not.toHaveBeenCalled();
	});
});
