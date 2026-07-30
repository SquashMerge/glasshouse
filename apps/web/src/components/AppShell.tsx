import * as React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
	LuHexagon,
	LuHouse,
	LuActivity,
	LuFileText,
	LuLogOut,
	LuLogIn,
	LuChevronLeft,
	LuChevronRight,
	LuChevronUp,
	LuDatabase,
	LuChartLine,
	LuMessageSquare,
	LuCheck,
	LuSettings,
} from "react-icons/lu";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { cn } from "../lib/utils";
import { clearCredentials, getCredentials } from "../lib/auth";
import type { Project } from "../lib/api";
import { useProjectSelection } from "./ProjectProvider";

const COLLAPSE_KEY = "astraea.nav.collapsed";

export const APP_WORKSPACE_CLASS = "max-w-none";

interface AppShellProps {
	children: React.ReactNode;
	currentPath?: string;
}

export function AppShell({ children, currentPath }: AppShellProps) {
	const location = useLocation();
	const activePath = currentPath ?? location.pathname;
	const [creds, setCreds] = React.useState(getCredentials());
	const [collapsed, setCollapsed] = React.useState(false);
	const [hydrated, setHydrated] = React.useState(false);
	const {
		projects,
		selectedProjectId,
		selectedProject,
		isLoading: projectsLoading,
		error: projectsError,
		organizationRole,
		selectProject,
		clearSession,
		retry: retryProjects,
	} = useProjectSelection();

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
		setHydrated(true);
	}, []);

	function toggleCollapsed() {
		setCollapsed((prev) => {
			const next = !prev;
			if (typeof window !== "undefined") {
				window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
			}
			return next;
		});
	}

	function logout() {
		clearSession();
		clearCredentials();
		setCreds(null);
		if (typeof window !== "undefined") {
			window.location.href = "/login";
		}
	}

	function isActive(path: string) {
		return activePath === path || (path !== "/" && activePath.startsWith(path));
	}

	const width = collapsed ? "w-14" : "w-14 sm:w-56";

	return (
		<div className="flex bg-background text-foreground">
			<aside
				aria-label="Primary"
				className={cn(
					"sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200",
					width,
				)}
			>
				<div
					className={cn(
						"flex h-14 shrink-0 items-center border-b border-border",
						collapsed
							? "justify-center px-2"
							: "justify-center px-2 sm:justify-between sm:px-4",
					)}
				>
					<Link
						to="/"
						aria-label="Astraea home"
						aria-current={activePath === "/" ? "page" : undefined}
						title="Astraea home"
						className={cn(
							"flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-semibold tracking-tight transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
							!collapsed &&
								"sm:h-auto sm:w-auto sm:justify-start sm:gap-2 sm:px-0",
						)}
					>
						<LuHexagon className="h-5 w-5 shrink-0" aria-hidden="true" />
						{!collapsed && (
							<span className="hidden text-base sm:inline">Astraea</span>
						)}
					</Link>
					{!collapsed && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="max-sm:!hidden sm:inline-flex"
							onClick={toggleCollapsed}
							aria-label="Collapse sidebar"
							title="Collapse sidebar"
						>
							<LuChevronLeft className="h-4 w-4" />
						</Button>
					)}
				</div>

				<div
					className={cn(
						"hidden border-b border-border p-2 sm:block",
						collapsed && "sm:hidden",
					)}
					data-testid="expanded-project-selector"
				>
					<label htmlFor="selected-project" className="sr-only">
						Selected project
					</label>
					<select
						id="selected-project"
						aria-label="Selected project"
						value={selectedProjectId ?? ""}
						disabled={projectsLoading || projects.length === 0}
						onChange={(event) => selectProject(event.target.value)}
						className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
						data-testid="project-selector"
					>
						<option value="">
							{projectsLoading ? "Loading projects…" : "Select a project"}
						</option>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
					{projectsError && (
						<div
							className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive"
							role="alert"
						>
							<span>Projects could not be loaded.</span>
							<button
								type="button"
								className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								onClick={retryProjects}
							>
								Retry
							</button>
						</div>
					)}
					{!projectsLoading && !projectsError && projects.length === 0 && (
						<p className="mt-2 text-xs text-muted-foreground">
							No accessible projects.
						</p>
					)}
				</div>

				<div
					className={cn(
						"flex shrink-0 justify-center border-b border-border p-2",
						!collapsed && "sm:hidden",
					)}
					data-testid="compact-project-selector"
				>
					<CompactProjectSelector
						projects={projects}
						selectedProject={selectedProject}
						isLoading={projectsLoading}
						error={projectsError}
						selectProject={selectProject}
						retry={retryProjects}
					/>
				</div>

				<nav
					className={cn(
						"min-h-0 flex flex-1 flex-col gap-1 overflow-y-auto p-2",
						collapsed ? "items-center" : "items-center sm:items-stretch",
					)}
					aria-label="Sections"
				>
					<SidebarLink
						to="/"
						label="Dashboard"
						icon={<LuHouse className="h-4 w-4" />}
						active={isActive("/")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/datasets"
						label="Datasets"
						icon={<LuDatabase className="h-4 w-4" />}
						active={isActive("/datasets")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/evaluations"
						label="Evaluations"
						icon={<LuChartLine className="h-4 w-4" />}
						active={isActive("/evaluations")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/feedback"
						label="Feedback"
						icon={<LuMessageSquare className="h-4 w-4" />}
						active={isActive("/feedback")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/observability"
						label="Observability"
						icon={<LuActivity className="h-4 w-4" />}
						active={isActive("/observability") || isActive("/traces")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/projects"
						label={
							organizationRole === "owner"
								? "Create / manage projects"
								: "Manage projects"
						}
						icon={<LuSettings className="h-4 w-4" />}
						active={isActive("/projects")}
						collapsed={collapsed}
					/>
					<SidebarLink
						to="/prompts"
						label="Prompts"
						icon={<LuFileText className="h-4 w-4" />}
						active={isActive("/prompts")}
						collapsed={collapsed}
					/>
				</nav>

				{collapsed && (
					<div className="flex shrink-0 justify-center border-t border-border p-2">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={toggleCollapsed}
							aria-label="Expand sidebar"
							title="Expand sidebar"
						>
							<LuChevronRight className="h-4 w-4" />
						</Button>
					</div>
				)}

				<Separator className="shrink-0" />

				<div
					className={cn(
						"shrink-0 p-2",
						collapsed ? "flex justify-center" : "flex justify-center sm:block",
					)}
				>
					{creds ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								className={cn(
									"flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
									!collapsed &&
										"sm:w-full sm:justify-start sm:gap-2 sm:px-2 sm:py-1.5",
								)}
								aria-label={`Account menu for ${creds.username}`}
								title={creds.username}
							>
								<UserAvatar
									username={creds.username}
									className="h-7 w-7 shrink-0"
								/>
								<span
									className={cn(
										"hidden flex-1 truncate text-left",
										!collapsed && "sm:block",
									)}
								>
									{creds.username}
								</span>
								{!collapsed && (
									<LuChevronUp className="hidden h-3.5 w-3.5 opacity-60 sm:block" />
								)}
							</DropdownMenuTrigger>
							<DropdownMenuContent align={collapsed ? "end" : "start"}>
								<DropdownMenuLabel>Signed in as</DropdownMenuLabel>
								<div className="px-2 pb-1.5 text-xs text-muted-foreground">
									{creds.username}
								</div>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={logout}>
									<LuLogOut className="h-4 w-4" />
									Log out
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : (
						<Button
							variant={collapsed ? "ghost" : "default"}
							size={collapsed ? "icon" : "default"}
							onClick={() => (window.location.href = "/login")}
							className={cn(
								collapsed ? "h-9 w-9" : "h-9 w-9 px-0 sm:w-full sm:px-4",
							)}
							aria-label="Sign in"
							title="Sign in"
						>
							{collapsed ? (
								<LuLogIn className="h-4 w-4" aria-hidden="true" />
							) : (
								<>
									<LuLogIn className="h-4 w-4 sm:hidden" aria-hidden="true" />
									<span className="hidden sm:inline">Sign in</span>
								</>
							)}
						</Button>
					)}
				</div>
			</aside>

			<main className="flex-1 min-w-0">
				<div
					className={cn(
						"mx-auto w-full px-4 py-5 sm:px-6 sm:py-8",
						APP_WORKSPACE_CLASS,
					)}
					data-hydrated={hydrated ? "1" : "0"}
				>
					{children}
				</div>
			</main>
		</div>
	);
}

function CompactProjectSelector({
	projects,
	selectedProject,
	isLoading,
	error,
	selectProject,
	retry,
}: {
	projects: Project[];
	selectedProject: Project | null;
	isLoading: boolean;
	error: Error | null;
	selectProject: (projectId: string) => void;
	retry: () => void;
}) {
	const projectName = selectedProject?.name ?? "No project selected";
	const label = `Current project: ${projectName}. Switch project`;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				title={label}
				className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			>
				<ProjectMark name={selectedProject?.name} className="h-7 w-7" />
				{selectedProject && (
					<span
						className="absolute right-0 bottom-0 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground"
						data-testid="active-project-indicator"
						aria-hidden="true"
					>
						<LuCheck className="h-2.5 w-2.5" />
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuLabel>Projects</DropdownMenuLabel>
				{error ? (
					<>
						<div className="px-2 py-1.5 text-xs text-destructive" role="alert">
							Projects could not be loaded.
						</div>
						<DropdownMenuItem onSelect={retry}>
							Retry loading projects
						</DropdownMenuItem>
					</>
				) : isLoading ? (
					<DropdownMenuLabel>Loading projects...</DropdownMenuLabel>
				) : projects.length === 0 ? (
					<DropdownMenuLabel>No projects available</DropdownMenuLabel>
				) : (
					projects.map((project) => {
						const isSelected = project.id === selectedProject?.id;
						return (
							<DropdownMenuItem
								key={project.id}
								role="menuitemradio"
								aria-checked={isSelected}
								aria-current={isSelected ? "true" : undefined}
								onSelect={() => selectProject(project.id)}
								className={cn(isSelected && "bg-accent text-accent-foreground")}
							>
								<ProjectMark
									name={project.name}
									className="h-5 w-5 text-[10px]"
								/>
								<span className="min-w-0 flex-1 truncate">{project.name}</span>
								{isSelected && (
									<>
										<LuCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
										<span className="sr-only">Current project</span>
									</>
								)}
							</DropdownMenuItem>
						);
					})
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function SidebarLink({
	to,
	label,
	icon,
	active,
	collapsed,
}: {
	to:
		| "/"
		| "/observability"
		| "/prompts"
		| "/datasets"
		| "/evaluations"
		| "/feedback"
		| "/projects";
	label: string;
	icon: React.ReactNode;
	active: boolean;
	collapsed: boolean;
}) {
	return (
		<Link
			to={to}
			aria-label={label}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-9 w-9 shrink-0 items-center justify-center rounded-md px-0 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
				active
					? "bg-accent text-accent-foreground"
					: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
				!collapsed &&
					"sm:h-auto sm:w-auto sm:justify-start sm:gap-2 sm:px-2 sm:py-1.5",
			)}
			title={label}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center">
				{icon}
			</span>
			<span className={cn("hidden truncate", !collapsed && "sm:inline")}>
				{label}
			</span>
		</Link>
	);
}

function ProjectMark({
	name,
	className,
}: {
	name?: string;
	className?: string;
}) {
	const initial = (name?.trim()[0] ?? "?").toUpperCase();
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground",
				className,
			)}
			aria-hidden="true"
		>
			{initial}
		</span>
	);
}

function UserAvatar({
	username,
	className,
}: {
	username: string;
	className?: string;
}) {
	const initial = (username?.[0] ?? "?").toUpperCase();
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground",
				className,
			)}
			aria-hidden="true"
		>
			{initial}
		</span>
	);
}
