import type { ReactNode } from "react";
import { createMemoryHistory, type AnyRouter } from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	history: null as ReturnType<typeof createMemoryHistory> | null,
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
			return <actual.RouterProvider router={testRouter} />;
		},
	};
});
vi.mock("../../src/components/AuthGate", () => ({
	AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	ProjectProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
	useProjectSelection: () => ({
		projects: [],
		selectedProjectId: null,
		selectedProject: null,
		isLoading: false,
		error: null,
		organizationRole: "read_only",
		canRecoverAdmin: false,
		selectProject: vi.fn(),
		retry: vi.fn(),
	}),
}));
vi.mock("../../src/routes/index", () => ({
	DashboardPage: () => <h1>Dashboard</h1>,
}));

import { App } from "../../src/App";

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("navigates to informational instance recovery guidance without privileged actions", async () => {
	state.history = createMemoryHistory({ initialEntries: ["/"] });
	const fetchSpy = vi.fn();
	vi.stubGlobal("fetch", fetchSpy);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	render(<App />);
	await screen.findByRole("heading", { name: "Dashboard" });
	const link = screen.getByRole("link", { name: "Instance recovery" });
	expect(link).toHaveAttribute("href", "/instance-recovery");
	fireEvent.click(link);
	const heading = await screen.findByRole("heading", {
		level: 1,
		name: "Instance recovery",
	});
	expect(heading).toBeVisible();
	expect(
		screen.getByRole("link", { name: "Instance recovery" }),
	).toHaveAttribute("aria-current", "page");
	const main = screen.getByRole("main");
	expect(
		within(main).getByText(/all Organizations and Projects/i),
	).toBeVisible();
	expect(within(main).getByText(/no selective restore/i)).toBeVisible();
	expect(within(main).getByText(/PostgreSQL and ClickHouse/)).toBeVisible();
	expect(within(main).getByText(/not atomic/i)).toBeVisible();
	expect(
		within(main).getByText(/pause ingestion and application writes/i),
	).toBeVisible();
	expect(within(main).getByText(/credentials and sessions/i)).toBeVisible();
	expect(
		within(main).getByRole("link", {
			name: /operator backup and restore guide/i,
		}),
	).toHaveAttribute(
		"href",
		"https://github.com/SquashMerge/glasshouse/blob/main/docs/backup-restore.md",
	);
	expect(within(main).queryAllByRole("button")).toHaveLength(0);
	expect(main.querySelectorAll("form, input, select, [download]")).toHaveLength(
		0,
	);
	expect(fetchSpy).not.toHaveBeenCalled();
});
