import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentActor, type Project } from "../lib/api";

const SELECTED_PROJECT_KEY = "glasshouse.selected-project-id";
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProjectSelectionContextValue {
	projects: Project[];
	selectedProjectId: string | null;
	selectedProject: Project | null;
	organizationRole: "admin" | "user" | "read_only" | null;
	canRecoverAdmin: boolean;
	isLoading: boolean;
	error: Error | null;
	selectProject: (projectId: string) => void;
	clearSession: () => void;
	retry: () => void;
}

const ProjectSelectionContext =
	React.createContext<ProjectSelectionContextValue | null>(null);

export function clearWorkspaceSession(queryClient: {
	clear: () => void;
}): void {
	queryClient.clear();
	for (const key of Object.keys(window.localStorage)) {
		if (key.startsWith(`${SELECTED_PROJECT_KEY}:`))
			window.localStorage.removeItem(key);
	}
}

function hasProjectId(value: unknown, projectId: string): boolean {
	if (value === projectId) return true;
	if (Array.isArray(value))
		return value.some((item) => hasProjectId(item, projectId));
	if (value && typeof value === "object")
		return Object.values(value).some((item) => hasProjectId(item, projectId));
	return false;
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
	const projectsQuery = useQuery({
		queryKey: ["me"],
		queryFn: getCurrentActor,
	});
	const queryClient = useQueryClient();
	const [selectedProjectId, setSelectedProjectId] = React.useState<
		string | null
	>(null);

	React.useEffect(() => {
		if (!projectsQuery.data) return;

		const projects = projectsQuery.data.projects.filter((project) =>
			UUID_PATTERN.test(project.id),
		);
		const key = `${SELECTED_PROJECT_KEY}:${projectsQuery.data.organization_id}:${projectsQuery.data.actor_id}`;
		const defaultProjectId = projectsQuery.data.default_project_id;
		const storedProjectId = window.localStorage.getItem(key);
		const selected = projects.some((project) => project.id === storedProjectId)
			? storedProjectId
			: projects.some((project) => project.id === defaultProjectId)
				? defaultProjectId
				: null;

		if (!selected) {
			window.localStorage.removeItem(key);
			setSelectedProjectId(null);
			return;
		}

		window.localStorage.setItem(key, selected);
		setSelectedProjectId(selected);
	}, [projectsQuery.data]);

	const projects =
		projectsQuery.data?.projects.filter((project) =>
			UUID_PATTERN.test(project.id),
		) ?? [];
	const selectedProject =
		projects.find((project) => project.id === selectedProjectId) ?? null;

	const selectProject = React.useCallback(
		(projectId: string) => {
			const project = projects.find((candidate) => candidate.id === projectId);
			if (!project || !UUID_PATTERN.test(project.id)) return;
			const identity = projectsQuery.data;
			if (!identity) return;
			if (selectedProjectId && selectedProjectId !== project.id) {
				void queryClient.cancelQueries({
					predicate: (query) => hasProjectId(query.queryKey, selectedProjectId),
				});
				queryClient.removeQueries({
					predicate: (query) => hasProjectId(query.queryKey, selectedProjectId),
				});
			}
			window.localStorage.setItem(
				`${SELECTED_PROJECT_KEY}:${identity.organization_id}:${identity.actor_id}`,
				project.id,
			);
			setSelectedProjectId(project.id);
		},
		[projects, projectsQuery.data, queryClient, selectedProjectId],
	);

	const value = React.useMemo<ProjectSelectionContextValue>(
		() => ({
			projects,
			selectedProjectId: selectedProject?.id ?? null,
			selectedProject,
			organizationRole: projectsQuery.data?.organization_role ?? null,
			canRecoverAdmin: projectsQuery.data?.can_recover_admin ?? false,
			isLoading: projectsQuery.isLoading,
			error: (projectsQuery.error as Error | null) ?? null,
			selectProject,
			clearSession: () => clearWorkspaceSession(queryClient),
			retry: () => void projectsQuery.refetch(),
		}),
		[
			projects,
			selectedProject,
			projectsQuery.data?.organization_role,
			projectsQuery.data?.can_recover_admin,
			projectsQuery.isLoading,
			projectsQuery.error,
			queryClient,
			selectProject,
			projectsQuery.refetch,
		],
	);

	return (
		<ProjectSelectionContext.Provider value={value}>
			{children}
		</ProjectSelectionContext.Provider>
	);
}

export function useProjectSelection(): ProjectSelectionContextValue {
	const context = React.useContext(ProjectSelectionContext);
	if (!context)
		throw new Error("useProjectSelection must be used within ProjectProvider");
	return context;
}

export function useOptionalProjectSelection(): ProjectSelectionContextValue | null {
	return React.useContext(ProjectSelectionContext);
}

export { SELECTED_PROJECT_KEY };
