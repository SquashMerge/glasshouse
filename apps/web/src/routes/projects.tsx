import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { DialogContent, DialogOverlay } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	archiveProject,
	createProject,
	deleteProject,
	getProjectDeletionStatus,
	listProjects,
	restoreProject,
	setDefaultProject,
	updateProject,
	type Project,
} from "../lib/api";
import { ListLoadingSkeleton } from "../components/LoadingSkeletons";
import { PageMessage } from "./prompts";

export function ProjectsPage() {
	const queryClient = useQueryClient();
	const { organizationRole, selectProject } = useProjectSelection();
	const projectsQuery = useQuery({
		queryKey: ["projects", "management"],
		queryFn: () => listProjects(true),
	});
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [editing, setEditing] = React.useState<Project | null>(null);
	const [editedName, setEditedName] = React.useState("");
	const [editedSlug, setEditedSlug] = React.useState("");
	const [operationError, setOperationError] = React.useState<string | null>(
		null,
	);
	const [deleting, setDeleting] = React.useState<Project | null>(null);
	const [confirmationName, setConfirmationName] = React.useState("");
	const isOwner = organizationRole === "admin";
	const canManage = (project: Project) => project.can_manage;

	function failed(error: unknown) {
		setOperationError(projectOperationError(error));
	}
	function replaceProject(project: Project) {
		queryClient.setQueryData<{ items: Project[]; total: number }>(
			["projects", "management"],
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
	function refreshSelector() {
		void queryClient.invalidateQueries({ queryKey: ["me"] });
	}
	const createMutation = useMutation({
		mutationFn: createProject,
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["projects", "management"],
			});
			setName("");
			setSlug("");
			refreshSelector();
		},
		onError: failed,
	});
	const updateMutation = useMutation({
		mutationFn: updateProject,
		onSuccess: (project) => {
			replaceProject(project);
			setEditing(null);
			refreshSelector();
		},
		onError: failed,
	});
	const archiveMutation = useMutation({
		mutationFn: archiveProject,
		onSuccess: (project) => {
			replaceProject(project);
			refreshSelector();
		},
		onError: failed,
	});
	const restoreMutation = useMutation({
		mutationFn: restoreProject,
		onSuccess: (project) => {
			replaceProject(project);
			refreshSelector();
		},
		onError: failed,
	});
	const defaultMutation = useMutation({
		mutationFn: setDefaultProject,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			refreshSelector();
		},
		onError: failed,
	});
	const deleteMutation = useMutation({
		mutationFn: deleteProject,
		onSuccess: (_, input) => {
			queryClient.removeQueries({
				predicate: (query) => JSON.stringify(query.queryKey).includes(input.id),
			});
			setDeleting(null);
			setConfirmationName("");
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			refreshSelector();
			selectProject(
				projectsQuery.data?.items.find((project) => project.is_default)?.id ??
					"",
			);
		},
		onError: failed,
	});

	if (projectsQuery.isLoading && !projectsQuery.data)
		return <ListLoadingSkeleton testId="projects-list-skeleton" />;
	if (projectsQuery.isError)
		return (
			<PageMessage title="Projects">Projects could not be loaded.</PageMessage>
		);
	const active =
		projectsQuery.data?.items.filter(
			(project) => project.status === "active",
		) ?? [];
	const archived =
		projectsQuery.data?.items.filter(
			(project) => project.status === "archived",
		) ?? [];
	const deletingProjects =
		projectsQuery.data?.items.filter(
			(project) => project.status === "deleting",
		) ?? [];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Projects"
				description="Manage the projects you can access."
			/>
			{operationError && !deleting && (
				<p className="text-sm text-destructive" role="alert">
					{operationError}
				</p>
			)}
			{isOwner && (
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						setOperationError(null);
						createMutation.mutate({ name, slug });
					}}
				>
					<label className="grid gap-1 text-sm">
						Project name
						<Input
							aria-label="Project name"
							required
							value={name}
							onChange={(event) => setName(event.target.value)}
							className="h-9 px-2"
						/>
					</label>
					<label className="grid gap-1 text-sm">
						Project slug
						<Input
							aria-label="Project slug"
							required
							pattern="[a-z0-9][a-z0-9-]*"
							value={slug}
							onChange={(event) => setSlug(event.target.value)}
							className="h-9 px-2"
						/>
					</label>
					<Button type="submit" disabled={createMutation.isPending}>
						Create project
					</Button>
				</form>
			)}
			<ProjectList
				projects={active}
				editing={editing}
				editedName={editedName}
				editedSlug={editedSlug}
				canManage={canManage}
				isOwner={isOwner}
				onEdit={(project) => {
					setEditing(project);
					setEditedName(project.name);
					setEditedSlug(project.slug);
				}}
				onEditedName={setEditedName}
				onEditedSlug={setEditedSlug}
				onSave={(project) => {
					setOperationError(null);
					updateMutation.mutate({
						id: project.id,
						name: editedName,
						slug: editedSlug,
					});
				}}
				onArchive={(project) => {
					setOperationError(null);
					archiveMutation.mutate(project.id);
				}}
				onRestore={(project) => {
					setOperationError(null);
					restoreMutation.mutate(project.id);
				}}
				onSetDefault={(project) => {
					setOperationError(null);
					defaultMutation.mutate(project.id);
				}}
				onDelete={(project) => {
					setDeleting(project);
					setConfirmationName("");
					setOperationError(null);
				}}
			/>
			{archived.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">Archived projects</h2>
					<ProjectList
						projects={archived}
						editing={editing}
						editedName={editedName}
						editedSlug={editedSlug}
						canManage={canManage}
						isOwner={isOwner}
						onEdit={(project) => {
							setEditing(project);
							setEditedName(project.name);
							setEditedSlug(project.slug);
						}}
						onEditedName={setEditedName}
						onEditedSlug={setEditedSlug}
						onSave={(project) => {
							setOperationError(null);
							updateMutation.mutate({
								id: project.id,
								name: editedName,
								slug: editedSlug,
							});
						}}
						onArchive={() => {}}
						onRestore={(project) => {
							setOperationError(null);
							restoreMutation.mutate(project.id);
						}}
						onSetDefault={() => {}}
						onDelete={() => {}}
					/>
				</section>
			)}
			{deletingProjects.length > 0 && (
				<section className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
					<div>
						<h2 className="text-lg font-semibold">Deletion recovery</h2>
						<p className="text-sm text-muted-foreground">
							These projects are unavailable while their permanent deletion is
							completed or retried.
						</p>
					</div>
					{deletingProjects.map((project) => (
						<DeletingProjectRecovery
							key={project.id}
							project={project}
							canManage={canManage(project)}
							onFailure={failed}
							onRecovered={() => {
								void queryClient.invalidateQueries({ queryKey: ["projects"] });
								refreshSelector();
							}}
						/>
					))}
				</section>
			)}
			{deleting && (
				<DialogOverlay>
					<DialogContent
						className="max-w-md space-y-4"
						role="dialog"
						aria-modal="true"
						aria-labelledby="delete-project-title"
					>
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								setOperationError(null);
								deleteMutation.mutate({
									id: deleting.id,
									confirmation_name: confirmationName,
								});
							}}
						>
							<div>
								<h2 id="delete-project-title" className="text-lg font-semibold">
									Delete {deleting.name}?
								</h2>
								<p className="mt-2 text-sm text-muted-foreground">
									This permanently deletes this Project and its project-owned
									data. This cannot be undone.
								</p>
							</div>
							{operationError && (
								<p className="text-sm text-destructive" role="alert">
									{operationError}
								</p>
							)}
							<label className="grid gap-2 text-sm font-medium">
								Type {deleting.name} to confirm
								<Input
									aria-label="Project deletion confirmation"
									autoFocus
									value={confirmationName}
									onChange={(event) => setConfirmationName(event.target.value)}
									className="h-9 px-2 font-normal"
								/>
							</label>
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setDeleting(null)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									variant="destructive"
									disabled={
										confirmationName !== deleting.name ||
										deleteMutation.isPending
									}
								>
									Delete project
								</Button>
							</div>
						</form>
					</DialogContent>
				</DialogOverlay>
			)}
		</div>
	);
}

function DeletingProjectRecovery({
	project,
	canManage,
	onFailure,
	onRecovered,
}: {
	project: Project;
	canManage: boolean;
	onFailure: (error: unknown) => void;
	onRecovered: () => void;
}) {
	const [confirmationName, setConfirmationName] = React.useState("");
	const statusQuery = useQuery({
		queryKey: ["project-deletion", project.id],
		queryFn: () => getProjectDeletionStatus(project.id),
		enabled: canManage,
	});
	const retryMutation = useMutation({
		mutationFn: deleteProject,
		onSuccess: onRecovered,
		onError: onFailure,
	});
	const stage = statusQuery.data?.status ?? "pending";

	return (
		<div className="space-y-3 rounded-md border border-border bg-background p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">{project.name}</span>
				<span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">
					Deletion {stage.replaceAll("_", " ")}
				</span>
			</div>
			{statusQuery.isError ? (
				<p className="text-sm text-destructive" role="alert">
					Deletion status could not be loaded.
				</p>
			) : canManage ? (
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						retryMutation.mutate({
							id: project.id,
							confirmation_name: confirmationName,
						});
					}}
				>
					<label className="grid gap-1 text-sm">
						Type {project.name} to retry
						<Input
							aria-label={`Deletion confirmation for ${project.name}`}
							value={confirmationName}
							onChange={(event) => setConfirmationName(event.target.value)}
							className="h-9 px-2"
						/>
					</label>
					<Button
						type="submit"
						variant="destructive"
						disabled={
							confirmationName !== project.name || retryMutation.isPending
						}
					>
						Retry deletion
					</Button>
				</form>
			) : null}
		</div>
	);
}

function ProjectList({
	projects,
	editing,
	editedName,
	editedSlug,
	canManage,
	isOwner,
	onEdit,
	onEditedName,
	onEditedSlug,
	onSave,
	onArchive,
	onRestore,
	onSetDefault,
	onDelete,
}: {
	projects: Project[];
	editing: Project | null;
	editedName: string;
	editedSlug: string;
	canManage: (project: Project) => boolean;
	isOwner: boolean;
	onEdit: (project: Project) => void;
	onEditedName: (value: string) => void;
	onEditedSlug: (value: string) => void;
	onSave: (project: Project) => void;
	onArchive: (project: Project) => void;
	onRestore: (project: Project) => void;
	onSetDefault: (project: Project) => void;
	onDelete: (project: Project) => void;
}) {
	return (
		<div className="space-y-3">
			{projects.map((project) => (
				<div
					key={project.id}
					className="flex flex-wrap items-center justify-between gap-3"
				>
					{editing?.id === project.id ? (
						<form
							className="flex flex-wrap items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								onSave(project);
							}}
						>
							<Input
								aria-label={`New name for ${project.name}`}
								required
								value={editedName}
								onChange={(event) => onEditedName(event.target.value)}
								className="h-9 px-2"
							/>
							<Input
								aria-label={`New slug for ${project.name}`}
								required
								pattern="[a-z0-9][a-z0-9-]*"
								value={editedSlug}
								onChange={(event) => onEditedSlug(event.target.value)}
								className="h-9 px-2"
							/>
							<Button type="submit" size="sm">
								Save name
							</Button>
						</form>
					) : (
						<span className="font-medium">
							{project.name}{" "}
							{project.is_default && (
								<span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">
									Default
								</span>
							)}
						</span>
					)}
					{canManage(project) && (
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onEdit(project)}
								aria-label={`Rename ${project.name}`}
							>
								Rename
							</Button>
							{!project.is_default &&
								project.status === "active" &&
								isOwner && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => onSetDefault(project)}
									>
										Set as default
									</Button>
								)}
							{!project.is_default && isOwner && (
								<Button
									type="button"
									variant="destructive"
									size="sm"
									onClick={() => onDelete(project)}
									aria-label={`Delete ${project.name}`}
								>
									Delete
								</Button>
							)}
							{project.status === "active" ? (
								!project.is_default && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => onArchive(project)}
										aria-label={`Archive ${project.name}`}
									>
										Archive
									</Button>
								)
							) : (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => onRestore(project)}
									aria-label={`Restore ${project.name}`}
								>
									Restore
								</Button>
							)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

function projectOperationError(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
	if (code === "FORBIDDEN")
		return "You no longer have permission to manage projects. Refresh your access and retry.";
	if (
		error instanceof Error &&
		(code === "BAD_REQUEST" || code === "CONFLICT" || code === "NOT_FOUND")
	)
		return error.message;
	return "Project operation could not be completed. Refresh the page and retry.";
}
