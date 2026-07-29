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
import { useProjectSelection } from "./ProjectProvider";

const COLLAPSE_KEY = "astraea.nav.collapsed";

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
		isLoading: projectsLoading,
		error: projectsError,
		selectProject,
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
						collapsed ? "justify-center px-2" : "justify-between px-4",
					)}
				>
					<Link
						to="/"
						className={cn(
							"flex items-center gap-2 font-semibold tracking-tight",
							collapsed && "justify-center",
						)}
					>
						<LuHexagon className="h-5 w-5 shrink-0" aria-hidden="true" />
						<span
							className={cn(
								"hidden text-base sm:inline",
								collapsed && "sm:hidden",
							)}
						>
							Astraea
						</span>
					</Link>
					{!collapsed && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-8 w-8"
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
				</div>

				<nav
					className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2"
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
							className="h-8 w-8"
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
					className={cn("shrink-0 p-2", collapsed ? "flex justify-center" : "")}
				>
					{creds ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									collapsed ? "h-9 w-9 justify-center" : "justify-start",
								)}
								title={collapsed ? creds.username : undefined}
							>
								<UserAvatar
									username={creds.username}
									className="h-7 w-7 shrink-0"
								/>
								<span
									className={cn(
										"flex-1 truncate text-left",
										collapsed && "hidden",
									)}
								>
									{creds.username}
								</span>
								{!collapsed && (
									<LuChevronUp className="h-3.5 w-3.5 opacity-60" />
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
							className={cn(collapsed ? "h-9 w-9" : "w-full")}
							aria-label="Sign in"
							title="Sign in"
						>
							{collapsed ? <LuLogIn className="h-4 w-4" /> : "Sign in"}
						</Button>
					)}
				</div>
			</aside>

			<main className="flex-1 min-w-0">
				<div
					className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8"
					data-hydrated={hydrated ? "1" : "0"}
				>
					{children}
				</div>
			</main>
		</div>
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
		| "/feedback";
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
				"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
				active
					? "bg-accent text-accent-foreground"
					: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
				collapsed && "h-9 w-9 justify-center px-0",
			)}
			title={collapsed ? label : undefined}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center">
				{icon}
			</span>
			<span
				className={cn("hidden truncate sm:inline", collapsed && "sm:hidden")}
			>
				{label}
			</span>
		</Link>
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
