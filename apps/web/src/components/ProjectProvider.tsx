import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjects, type Project } from "../lib/api";

const SELECTED_PROJECT_KEY = "astraea.selected-project-id";
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProjectSelectionContextValue {
	projects: Project[];
	selectedProjectId: string | null;
	selectedProject: Project | null;
	isLoading: boolean;
	error: Error | null;
	selectProject: (projectId: string) => void;
	retry: () => void;
}

const ProjectSelectionContext =
	React.createContext<ProjectSelectionContextValue | null>(null);

function storedProjectId(): string | null {
	const value = window.localStorage.getItem(SELECTED_PROJECT_KEY);
	if (value && !UUID_PATTERN.test(value)) {
		window.localStorage.removeItem(SELECTED_PROJECT_KEY);
		return null;
	}
	return value;
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
	const projectsQuery = useQuery({
		queryKey: ["projects"],
		queryFn: listProjects,
	});
	const [selectedProjectId, setSelectedProjectId] = React.useState<
		string | null
	>(null);

	React.useEffect(() => {
		storedProjectId();
	}, []);

	React.useEffect(() => {
		if (!projectsQuery.data) return;

		const projects = projectsQuery.data.items.filter((project) =>
			UUID_PATTERN.test(project.id),
		);
		const stored = storedProjectId();
		const selected =
			stored && projects.some((project) => project.id === stored)
				? stored
				: (projects[0]?.id ?? null);

		if (!selected) {
			window.localStorage.removeItem(SELECTED_PROJECT_KEY);
			setSelectedProjectId(null);
			return;
		}

		window.localStorage.setItem(SELECTED_PROJECT_KEY, selected);
		setSelectedProjectId(selected);
	}, [projectsQuery.data]);

	const projects =
		projectsQuery.data?.items.filter((project) =>
			UUID_PATTERN.test(project.id),
		) ?? [];
	const selectedProject =
		projects.find((project) => project.id === selectedProjectId) ?? null;

	const selectProject = React.useCallback(
		(projectId: string) => {
			const project = projects.find((candidate) => candidate.id === projectId);
			if (!project || !UUID_PATTERN.test(project.id)) return;
			window.localStorage.setItem(SELECTED_PROJECT_KEY, project.id);
			setSelectedProjectId(project.id);
		},
		[projects],
	);

	const value = React.useMemo<ProjectSelectionContextValue>(
		() => ({
			projects,
			selectedProjectId: selectedProject?.id ?? null,
			selectedProject,
			isLoading: projectsQuery.isLoading,
			error: (projectsQuery.error as Error | null) ?? null,
			selectProject,
			retry: () => void projectsQuery.refetch(),
		}),
		[
			projects,
			selectedProject,
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

export { SELECTED_PROJECT_KEY };
