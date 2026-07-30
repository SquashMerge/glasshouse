import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";

const selection = vi.hoisted(() => ({ selectProject: vi.fn() }));

const projects = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		name: "Project One",
		slug: "project-one",
		created_at: "2026-07-15T10:00:00.000Z",
	},
	{
		id: "22222222-2222-4222-8222-222222222222",
		name: "Project Two",
		slug: "project-two",
		created_at: "2026-07-15T10:00:00.000Z",
	},
];

vi.mock("@tanstack/react-router", () => ({
	useLocation: () => ({ pathname: "/", searchStr: "" }),
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
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		projects,
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: projects[0],
		isLoading: false,
		error: null,
		selectProject: selection.selectProject,
		retry: vi.fn(),
	}),
}));

vi.mock("../../src/components/HealthBadge", () => ({
	HealthBadge: () => <div>Healthy</div>,
}));

import { APP_WORKSPACE_CLASS, AppShell } from "../../src/components/AppShell";
import { DashboardPage } from "../../src/routes/index";

describe("AppShell project selector", () => {
	beforeEach(() => {
		window.localStorage.clear();
		selection.selectProject.mockReset();
	});

	afterEach(cleanup);

	it("exposes the selected authenticated project and Prompts navigation", () => {
		render(
			<AppShell currentPath="/prompts">
				<div>Page</div>
			</AppShell>,
		);

		const selector = screen.getByLabelText("Selected project");
		expect(selector).toHaveValue("11111111-1111-4111-8111-111111111111");
		expect(screen.getByRole("link", { name: "Prompts" })).toHaveAttribute(
			"href",
			"/prompts",
		);
		fireEvent.change(selector, {
			target: { value: "11111111-1111-4111-8111-111111111111" },
		});
		expect(selection.selectProject).toHaveBeenCalledWith(
			"11111111-1111-4111-8111-111111111111",
		);
	});

	it("keeps compact project switching accessible by mouse and keyboard", () => {
		window.localStorage.setItem("astraea.nav.collapsed", "1");
		render(
			<AppShell currentPath="/">
				<div>Page</div>
			</AppShell>,
		);

		const trigger = screen.getByRole("button", {
			name: "Current project: Project One. Switch project",
		});
		expect(trigger).toHaveAttribute(
			"title",
			"Current project: Project One. Switch project",
		);
		expect(screen.getByTestId("active-project-indicator")).toBeInTheDocument();

		fireEvent.click(trigger);
		let menu = screen.getByRole("menu");
		expect(menu).toHaveClass("max-h-[calc(100vh-0.5rem)]", "overflow-y-auto");
		const projectTwo = within(menu).getByRole("menuitemradio", {
			name: "Project Two",
		});
		fireEvent.click(projectTwo);
		expect(selection.selectProject).toHaveBeenCalledWith(projects[1]!.id);

		selection.selectProject.mockReset();
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		menu = screen.getByRole("menu");
		const selectedProject = within(menu).getByRole("menuitemradio", {
			name: /Project One.*Current project/,
		});
		expect(selectedProject).toHaveFocus();
		fireEvent.keyDown(selectedProject, { key: "ArrowDown" });
		const keyboardProjectTwo = within(menu).getByRole("menuitemradio", {
			name: "Project Two",
		});
		expect(keyboardProjectTwo).toHaveFocus();
		fireEvent.keyDown(keyboardProjectTwo, { key: "Enter" });
		expect(selection.selectProject).toHaveBeenCalledWith(projects[1]!.id);

		fireEvent.click(trigger);
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("uses compact square controls below the expanded sidebar breakpoint", () => {
		const { container } = render(
			<AppShell currentPath="/">
				<div>Page</div>
			</AppShell>,
		);

		expect(screen.getByLabelText("Primary")).toHaveClass("w-14", "sm:w-56");
		expect(screen.getByTestId("compact-project-selector")).toHaveClass(
			"sm:hidden",
		);
		expect(screen.getByTestId("expanded-project-selector")).toHaveClass(
			"sm:block",
		);
		expect(screen.getByRole("link", { name: "Astraea home" })).toHaveClass(
			"h-9",
			"w-9",
		);
		expect(
			screen.getByRole("button", { name: "Collapse sidebar" }),
		).toHaveClass("max-sm:!hidden");

		for (const label of [
			"Dashboard",
			"Datasets",
			"Evaluations",
			"Feedback",
			"Observability",
			"Prompts",
		]) {
			expect(screen.getByRole("link", { name: label })).toHaveClass(
				"h-9",
				"w-9",
				"items-center",
				"justify-center",
			);
		}

		expect(container.querySelector("aside")).not.toHaveClass("overflow-hidden");
	});

	it("renders a mark-only named home control when explicitly collapsed", () => {
		window.localStorage.setItem("astraea.nav.collapsed", "1");
		render(
			<AppShell currentPath="/">
				<div>Page</div>
			</AppShell>,
		);

		expect(screen.getByRole("link", { name: "Astraea home" })).toHaveClass(
			"h-9",
			"w-9",
		);
		expect(
			screen.queryByText("Astraea", { exact: true }),
		).not.toBeInTheDocument();
	});

	it("uses the shared full-width workspace class for authenticated pages", () => {
		const { container } = render(
			<AppShell currentPath="/">
				<div>Page</div>
			</AppShell>,
		);

		expect(APP_WORKSPACE_CLASS).toBe("max-w-none");
		expect(container.querySelector("main > div")).toHaveClass(
			APP_WORKSPACE_CLASS,
		);
	});

	it("does not give the dashboard a narrower page shell", () => {
		const { container } = render(<DashboardPage />);

		expect(container.querySelector("main")).not.toHaveClass("max-w-3xl");
	});
});
