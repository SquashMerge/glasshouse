import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	archiveProject,
	createProject,
	listProjects,
	restoreProject,
	updateProject,
	type Project,
} from "../lib/api";
import { PageMessage } from "./prompts";

export function ProjectsPage() {
	const queryClient = useQueryClient();
	const { organizationRole } = useProjectSelection();
	const projectsQuery = useQuery({
		queryKey: ["projects"],
		queryFn: listProjects,
	});
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [editing, setEditing] = React.useState<Project | null>(null);
	const [editedName, setEditedName] = React.useState("");
	const [archived, setArchived] = React.useState<Project[]>([]);
	const [operationFailed, setOperationFailed] = React.useState(false);
	const isOwner = organizationRole === "owner";

	function replaceProject(project: Project) {
		queryClient.setQueryData<{ items: Project[]; total: number }>(
			["projects"],
			(current) =>
				current
					? {
							...current,
							items: current.items.map((item) =>
								item.id === project.id ? project : item,
							),
						}
					: current,
		);
	}
	function failed() {
		setOperationFailed(true);
	}
	const createMutation = useMutation({
		mutationFn: createProject,
		onSuccess: (project) => {
			queryClient.setQueryData<{ items: Project[]; total: number }>(
				["projects"],
				(current) =>
					current
						? { items: [...current.items, project], total: current.total + 1 }
						: current,
			);
			setName("");
			setSlug("");
			void queryClient.invalidateQueries({ queryKey: ["me"] });
		},
		onError: failed,
	});
	const updateMutation = useMutation({
		mutationFn: updateProject,
		onSuccess: (project) => {
			replaceProject(project);
			setEditing(null);
			void queryClient.invalidateQueries({ queryKey: ["me"] });
		},
		onError: failed,
	});
	const archiveMutation = useMutation({
		mutationFn: archiveProject,
		onSuccess: (project) => {
			const current = projectsQuery.data?.items.find(
				(item) => item.id === project.id,
			);
			setArchived((items) => [
				...items.filter((item) => item.id !== project.id),
				{ ...project, name: current?.name ?? project.name },
			]);
			queryClient.setQueryData<{ items: Project[]; total: number }>(
				["projects"],
				(data) =>
					data
						? {
								items: data.items.filter((item) => item.id !== project.id),
								total: data.total - 1,
							}
						: data,
			);
			void queryClient.invalidateQueries({ queryKey: ["me"] });
		},
		onError: failed,
	});
	const restoreMutation = useMutation({
		mutationFn: restoreProject,
		onSuccess: (project) => {
			setArchived((items) => items.filter((item) => item.id !== project.id));
			queryClient.setQueryData<{ items: Project[]; total: number }>(
				["projects"],
				(data) =>
					data
						? { items: [...data.items, project], total: data.total + 1 }
						: data,
			);
			void queryClient.invalidateQueries({ queryKey: ["me"] });
		},
		onError: failed,
	});

	if (projectsQuery.isLoading)
		return <PageMessage title="Projects">Loading projects...</PageMessage>;
	if (projectsQuery.isError)
		return (
			<PageMessage title="Projects">Projects could not be loaded.</PageMessage>
		);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
				<p className="text-sm text-muted-foreground">
					Manage the projects you can access.
				</p>
			</div>
			{operationFailed && (
				<p className="text-sm text-destructive" role="alert">
					Project operation could not be completed.
				</p>
			)}
			{isOwner && (
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						setOperationFailed(false);
						createMutation.mutate({ name, slug });
					}}
				>
					<label className="grid gap-1 text-sm">
						Project name
						<input
							aria-label="Project name"
							required
							value={name}
							onChange={(event) => setName(event.target.value)}
							className="h-9 rounded-md border border-input bg-background px-2"
						/>
					</label>
					<label className="grid gap-1 text-sm">
						Project slug
						<input
							aria-label="Project slug"
							required
							pattern="[a-z0-9][a-z0-9-]*"
							value={slug}
							onChange={(event) => setSlug(event.target.value)}
							className="h-9 rounded-md border border-input bg-background px-2"
						/>
					</label>
					<Button type="submit" disabled={createMutation.isPending}>
						Create project
					</Button>
				</form>
			)}
			<div className="space-y-3">
				{projectsQuery.data?.items.map((project) => (
					<div
						key={project.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
					>
						{editing?.id === project.id ? (
							<form
								className="flex items-center gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									setOperationFailed(false);
									updateMutation.mutate({ id: project.id, name: editedName });
								}}
							>
								<input
									aria-label={`New name for ${project.name}`}
									required
									value={editedName}
									onChange={(event) => setEditedName(event.target.value)}
									className="h-9 rounded-md border border-input bg-background px-2"
								/>
								<Button type="submit" size="sm">
									Save name
								</Button>
							</form>
						) : (
							<span className="font-medium">{project.name}</span>
						)}
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setEditing(project);
									setEditedName(project.name);
								}}
								aria-label={`Rename ${project.name}`}
							>
								Rename
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setOperationFailed(false);
									archiveMutation.mutate(project.id);
								}}
								aria-label={`Archive ${project.name}`}
							>
								Archive
							</Button>
						</div>
					</div>
				))}
			</div>
			{archived.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">Archived this session</h2>
					{archived.map((project) => (
						<div
							key={project.id}
							className="flex items-center justify-between rounded-md border border-border p-3"
						>
							<span className="font-medium">{project.name}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setOperationFailed(false);
									restoreMutation.mutate(project.id);
								}}
								aria-label={`Restore ${project.name}`}
							>
								Restore
							</Button>
						</div>
					))}
				</section>
			)}
		</div>
	);
}
