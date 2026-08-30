import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selection = vi.hoisted(() => ({
	isLoading: false,
	selectProject: vi.fn(),
	organizationRole: "admin" as "admin" | "user" | "read_only",
	canRecoverAdmin: false,
}));

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
		isLoading: selection.isLoading,
		error: null,
		organizationRole: selection.organizationRole,
		canRecoverAdmin: selection.canRecoverAdmin,
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
		selection.isLoading = false;
		selection.selectProject.mockReset();
		selection.organizationRole = "admin";
		selection.canRecoverAdmin = false;
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

	it("places the Settings group last after Prompts with nested route links", () => {
		render(
			<AppShell currentPath="/governance">
				<div>Page</div>
			</AppShell>,
		);

		const navigation = screen.getByRole("navigation", { name: "Sections" });
		const settings = within(navigation).getByRole("group", {
			name: "Settings",
		});
		expect(navigation.lastElementChild).toBe(settings);
		expect(
			screen
				.getByRole("link", { name: "Prompts" })
				.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(settings).toHaveAttribute("data-active", "true");
		expect(
			within(settings).queryByRole("button", { name: "Settings" }),
		).toBeNull();
		const settingsLinks = within(settings).getAllByRole("link");
		expect(
			settingsLinks.map((link) => link.getAttribute("aria-label")),
		).toEqual(["Governance", "Access", "Projects"]);
		expect(settingsLinks.map((link) => link.getAttribute("href"))).toEqual([
			"/governance",
			"/access",
			"/projects",
		]);
		expect(settingsLinks[0]).toHaveAttribute("aria-current", "page");
		const icons = settingsLinks.map(
			(link) => link.querySelector("svg")?.innerHTML,
		);
		expect(new Set(icons).size).toBe(3);
	});

	it("keeps Access hidden inside Settings without Admin or recovery access", () => {
		selection.organizationRole = "user";
		render(
			<AppShell currentPath="/projects">
				<div>Page</div>
			</AppShell>,
		);

		const settings = screen.getByRole("group", { name: "Settings" });
		expect(
			within(settings).getByRole("link", { name: "Governance" }),
		).toBeVisible();
		expect(
			within(settings).getByRole("link", { name: "Projects" }),
		).toHaveAttribute("aria-current", "page");
		expect(within(settings).queryByRole("link", { name: "Access" })).toBeNull();
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

	it("uses a layout-shaped skeleton while the project switcher is initially loading", () => {
		selection.isLoading = true;
		render(
			<AppShell currentPath="/">
				<div>Page</div>
			</AppShell>,
		);

		expect(screen.getByTestId("project-selector-skeleton")).toHaveAttribute(
			"aria-label",
			"Loading projects",
		);
		expect(
			screen.getByTestId("compact-project-selector-skeleton"),
		).toHaveAttribute("aria-label", "Loading projects");
		expect(screen.queryByText("Loading projects...")).not.toBeInTheDocument();
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
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { container } = render(
			<QueryClientProvider client={client}>
				<DashboardPage />
			</QueryClientProvider>,
		);

		expect(container.querySelector("main")?.className).not.toMatch(/\bmax-w-/);
	});
});
