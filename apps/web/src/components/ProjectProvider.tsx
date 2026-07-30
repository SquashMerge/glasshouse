import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentActor, type Project } from "../lib/api";

const SELECTED_PROJECT_KEY = "astraea.selected-project-id";
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProjectSelectionContextValue {
	projects: Project[];
	selectedProjectId: string | null;
	selectedProject: Project | null;
	organizationRole: "owner" | "member" | null;
	isLoading: boolean;
	error: Error | null;
	selectProject: (projectId: string) => void;
	retry: () => void;
}

const ProjectSelectionContext =
	React.createContext<ProjectSelectionContextValue | null>(null);

function storedProjectId(key: string): string | null {
	const value = window.localStorage.getItem(key);
	if (value && !UUID_PATTERN.test(value)) {
		window.localStorage.removeItem(key);
		return null;
	}
	return value;
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
		const key = `${SELECTED_PROJECT_KEY}:${projectsQuery.data.organization_id}:${projectsQuery.data.actor_subject}`;
		const stored = storedProjectId(key);
		const selected =
			stored && projects.some((project) => project.id === stored)
				? stored
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
					predicate: (query) => query.queryKey.includes(selectedProjectId),
				});
				queryClient.removeQueries({
					predicate: (query) => query.queryKey.includes(selectedProjectId),
				});
			}
			window.localStorage.setItem(
				`${SELECTED_PROJECT_KEY}:${identity.organization_id}:${identity.actor_subject}`,
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
			isLoading: projectsQuery.isLoading,
			error: (projectsQuery.error as Error | null) ?? null,
			selectProject,
			retry: () => void projectsQuery.refetch(),
		}),
		[
			projects,
			selectedProject,
			projectsQuery.data?.organization_role,
			projectsQuery.isLoading,
			projectsQuery.error,
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
