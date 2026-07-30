import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	archiveProject,
	createProject,
	deleteProjectMember,
	listProjectMembers,
	listProjects,
	putProjectMember,
	restoreProject,
	updateProject,
	type Project,
} from "../lib/api";
import { PageMessage } from "./prompts";

export function ProjectsPage() {
	const queryClient = useQueryClient();
	const { organizationRole } = useProjectSelection();
	const projectsQuery = useQuery({
		queryKey: ["projects", "management"],
		queryFn: () => listProjects(true),
	});
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [editing, setEditing] = React.useState<Project | null>(null);
	const [editedName, setEditedName] = React.useState("");
	const [editedSlug, setEditedSlug] = React.useState("");
	const [membersProject, setMembersProject] = React.useState<Project | null>(
		null,
	);
	const [memberActor, setMemberActor] = React.useState("");
	const [memberRole, setMemberRole] = React.useState<"manager" | "member">(
		"member",
	);
	const [operationFailed, setOperationFailed] = React.useState(false);
	const isOwner = organizationRole === "owner";
	const canManage = (project: Project) => project.project_role !== "member";
	const membersQuery = useQuery({
		queryKey: ["project-members", membersProject?.id],
		queryFn: () => listProjectMembers(membersProject!.id),
		enabled: Boolean(membersProject),
	});

	function failed() {
		setOperationFailed(true);
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
	const putMemberMutation = useMutation({
		mutationFn: putProjectMember,
		onSuccess: () => {
			setMemberActor("");
			void queryClient.invalidateQueries({
				queryKey: ["project-members", membersProject?.id],
			});
		},
		onError: failed,
	});
	const deleteMemberMutation = useMutation({
		mutationFn: deleteProjectMember,
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["project-members", membersProject?.id],
			});
		},
		onError: failed,
	});

	if (projectsQuery.isLoading)
		return <PageMessage title="Projects">Loading projects...</PageMessage>;
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
			<ProjectList
				projects={active}
				editing={editing}
				editedName={editedName}
				editedSlug={editedSlug}
				canManage={canManage}
				onEdit={(project) => {
					setEditing(project);
					setEditedName(project.name);
					setEditedSlug(project.slug);
				}}
				onEditedName={setEditedName}
				onEditedSlug={setEditedSlug}
				onSave={(project) => {
					setOperationFailed(false);
					updateMutation.mutate({
						id: project.id,
						name: editedName,
						slug: editedSlug,
					});
				}}
				onArchive={(project) => {
					setOperationFailed(false);
					archiveMutation.mutate(project.id);
				}}
				onRestore={(project) => {
					setOperationFailed(false);
					restoreMutation.mutate(project.id);
				}}
				onMembers={(project) => {
					setMembersProject(project);
					setOperationFailed(false);
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
						onEdit={(project) => {
							setEditing(project);
							setEditedName(project.name);
							setEditedSlug(project.slug);
						}}
						onEditedName={setEditedName}
						onEditedSlug={setEditedSlug}
						onSave={(project) => {
							setOperationFailed(false);
							updateMutation.mutate({
								id: project.id,
								name: editedName,
								slug: editedSlug,
							});
						}}
						onArchive={() => {}}
						onRestore={(project) => {
							setOperationFailed(false);
							restoreMutation.mutate(project.id);
						}}
						onMembers={(project) => {
							setMembersProject(project);
							setOperationFailed(false);
						}}
					/>
				</section>
			)}
			{membersProject && (
				<section className="space-y-3 rounded-md border border-border p-3">
					<h2 className="text-lg font-semibold">
						Members for {membersProject.name}
					</h2>
					{membersQuery.isError ? (
						<p className="text-sm text-destructive" role="alert">
							Project operation could not be completed.
						</p>
					) : (
						<>
							<form
								className="flex flex-wrap items-end gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									setOperationFailed(false);
									putMemberMutation.mutate({
										projectId: membersProject.id,
										actorSubject: memberActor,
										role: memberRole,
									});
								}}
							>
								<label className="grid gap-1 text-sm">
									Member actor
									<input
										aria-label="Member actor"
										required
										value={memberActor}
										onChange={(event) => setMemberActor(event.target.value)}
										className="h-9 rounded-md border border-input bg-background px-2"
									/>
								</label>
								<label className="grid gap-1 text-sm">
									Member role
									<select
										aria-label="Member role"
										value={memberRole}
										onChange={(event) =>
											setMemberRole(event.target.value as "manager" | "member")
										}
										className="h-9 rounded-md border border-input bg-background px-2"
									>
										<option value="member">Member</option>
										<option value="manager">Manager</option>
									</select>
								</label>
								<Button
									type="submit"
									size="sm"
									disabled={putMemberMutation.isPending}
								>
									Add member
								</Button>
							</form>
							{membersQuery.data?.items.map((member) => (
								<div
									key={member.actor_subject}
									className="flex items-center justify-between gap-3"
								>
									<span>
										{member.actor_subject} ({member.role})
									</span>
									<select
										aria-label={`Role for ${member.actor_subject}`}
										value={member.role}
										onChange={(event) => {
											setOperationFailed(false);
											putMemberMutation.mutate({
												projectId: membersProject.id,
												actorSubject: member.actor_subject,
												role: event.target.value as "manager" | "member",
											});
										}}
										className="h-9 rounded-md border border-input bg-background px-2"
									>
										<option value="member">Member</option>
										<option value="manager">Manager</option>
									</select>
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={`Remove ${member.actor_subject}`}
										onClick={() => {
											setOperationFailed(false);
											deleteMemberMutation.mutate({
												projectId: membersProject.id,
												actorSubject: member.actor_subject,
											});
										}}
									>
										Remove member
									</Button>
								</div>
							))}
						</>
					)}
				</section>
			)}
		</div>
	);
}

function ProjectList({
	projects,
	editing,
	editedName,
	editedSlug,
	canManage,
	onEdit,
	onEditedName,
	onEditedSlug,
	onSave,
	onArchive,
	onRestore,
	onMembers,
}: {
	projects: Project[];
	editing: Project | null;
	editedName: string;
	editedSlug: string;
	canManage: (project: Project) => boolean;
	onEdit: (project: Project) => void;
	onEditedName: (value: string) => void;
	onEditedSlug: (value: string) => void;
	onSave: (project: Project) => void;
	onArchive: (project: Project) => void;
	onRestore: (project: Project) => void;
	onMembers: (project: Project) => void;
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
							<input
								aria-label={`New name for ${project.name}`}
								required
								value={editedName}
								onChange={(event) => onEditedName(event.target.value)}
								className="h-9 rounded-md border border-input bg-background px-2"
							/>
							<input
								aria-label={`New slug for ${project.name}`}
								required
								pattern="[a-z0-9][a-z0-9-]*"
								value={editedSlug}
								onChange={(event) => onEditedSlug(event.target.value)}
								className="h-9 rounded-md border border-input bg-background px-2"
							/>
							<Button type="submit" size="sm">
								Save name
							</Button>
						</form>
					) : (
						<span className="font-medium">{project.name}</span>
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
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onMembers(project)}
								aria-label={`Manage members for ${project.name}`}
							>
								Members
							</Button>
							{project.status === "active" ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => onArchive(project)}
									aria-label={`Archive ${project.name}`}
								>
									Archive
								</Button>
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
