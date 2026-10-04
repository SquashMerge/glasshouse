import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { ListLoadingSkeleton } from "../components/LoadingSkeletons";
import { LocalAccounts } from "../components/LocalAccounts";
import {
	getCurrentActor,
	listAdminActors,
	listProjectGrants,
	listProjects,
	recoverAdmin,
	revokeProjectGrant,
	setAdminActorRole,
	setProjectGrant,
	type AdminActor,
	type CurrentActor,
} from "../lib/api";

const shortActor = (actorId: string) => actorId.slice(0, 8);

export function AdminAccessPage() {
	const queryClient = useQueryClient();
	const [projectId, setProjectId] = React.useState("");
	const [grantActorId, setGrantActorId] = React.useState("");
	const [grantRole, setGrantRole] = React.useState<"user" | "read_only">(
		"read_only",
	);
	const [recoveryOpen, setRecoveryOpen] = React.useState(false);
	const [confirmation, setConfirmation] = React.useState("");
	const actorQuery = useQuery({ queryKey: ["me"], queryFn: getCurrentActor });
	const actorsQuery = useQuery({
		queryKey: ["admin", "actors"],
		queryFn: listAdminActors,
		enabled: actorQuery.data?.organization_role === "admin",
	});
	const projectsQuery = useQuery({
		queryKey: ["projects", "management"],
		queryFn: () => listProjects(true),
		enabled: actorQuery.data?.organization_role === "admin",
	});
	const grantsQuery = useQuery({
		queryKey: ["admin", "grants", projectId],
		queryFn: () => listProjectGrants(projectId),
		enabled:
			actorQuery.data?.organization_role === "admin" && Boolean(projectId),
	});
	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: ["admin"] });
		void queryClient.invalidateQueries({ queryKey: ["me"] });
		void queryClient.invalidateQueries({ queryKey: ["projects"] });
	};
	const roleMutation = useMutation({
		mutationFn: setAdminActorRole,
		onSuccess: invalidate,
	});
	const grantMutation = useMutation({
		mutationFn: setProjectGrant,
		onSuccess: () => {
			setGrantActorId("");
			invalidate();
		},
	});
	const revokeMutation = useMutation({
		mutationFn: revokeProjectGrant,
		onSuccess: invalidate,
	});
	const recoveryMutation = useMutation({
		mutationFn: recoverAdmin,
		onSuccess: () => {
			setRecoveryOpen(false);
			setConfirmation("");
			invalidate();
		},
	});

	React.useEffect(() => {
		if (projectId || !projectsQuery.data) return;
		setProjectId(
			projectsQuery.data.items.find((project) => project.status === "active")
				?.id ?? "",
		);
	}, [projectId, projectsQuery.data]);

	if (actorQuery.isLoading)
		return <ListLoadingSkeleton testId="admin-access-loading" />;
	if (actorQuery.isError)
		return (
			<PageError
				message="Access status could not be loaded."
				retry={actorQuery.refetch}
			/>
		);
	const currentActor = actorQuery.data;
	if (!currentActor)
		return (
			<PageError
				message="Access status could not be loaded."
				retry={actorQuery.refetch}
			/>
		);
	if (currentActor.organization_role !== "admin")
		return (
			<div className="space-y-6">
				<PageHeader />
				{currentActor.can_recover_admin ? (
					<RecoveryCard
						open={recoveryOpen}
						confirmation={confirmation}
						pending={recoveryMutation.isPending}
						error={recoveryMutation.isError}
						onOpen={() => setRecoveryOpen(true)}
						onClose={() => setRecoveryOpen(false)}
						onConfirmationChange={setConfirmation}
						onRecover={() => recoveryMutation.mutate()}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						Access management is restricted to Admins.
					</p>
				)}
			</div>
		);
	if (actorsQuery.isLoading || projectsQuery.isLoading)
		return <ListLoadingSkeleton testId="admin-access-loading" />;
	if (actorsQuery.isError || projectsQuery.isError)
		return (
			<PageError
				message="Access data could not be loaded."
				retry={invalidate}
			/>
		);

	const activeProjects = projectsQuery.data?.items.filter(
		(project) => project.status === "active",
	);
	return (
		<div className="space-y-8">
			<PageHeader />
			<LocalAccounts />
			{roleMutation.isError ||
			grantMutation.isError ||
			revokeMutation.isError ||
			recoveryMutation.isError ? (
				<p className="text-sm text-destructive" role="alert">
					The access change could not be completed. Review the current access
					state and retry.
				</p>
			) : null}
			{roleMutation.isSuccess ||
			grantMutation.isSuccess ||
			revokeMutation.isSuccess ||
			recoveryMutation.isSuccess ? (
				<p
					className="text-sm text-emerald-700 dark:text-emerald-400"
					role="status"
				>
					Access changes saved.
				</p>
			) : null}
			<Card>
				<CardHeader>
					<CardTitle>Organization actors</CardTitle>
					<p className="text-sm text-muted-foreground">
						Roles stay bound to durable actors. Your signed-in username is shown
						when available.
					</p>
				</CardHeader>
				<CardContent className="space-y-3">
					{actorsQuery.data?.items.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No actors are available.
						</p>
					) : (
						actorsQuery.data?.items.map((actor) => (
							<ActorRoleRow
								key={actor.actor_id}
								actor={actor}
								currentActor={currentActor}
								disabled={roleMutation.isPending}
								onChange={(role) =>
									roleMutation.mutate({ actorId: actor.actor_id, role })
								}
							/>
						))
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Project grants</CardTitle>
					<p className="text-sm text-muted-foreground">
						User and Read-only actors need an explicit grant for each active
						Project.
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<Label className="grid max-w-sm gap-2">
						Project
						<Select
							value={projectId}
							onChange={(event) => setProjectId(event.target.value)}
						>
							<option value="">Select an active Project</option>
							{activeProjects?.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</Select>
					</Label>
					{projectId ? (
						<>
							<form
								className="flex flex-wrap items-end gap-3 border-y border-border py-4"
								onSubmit={(event) => {
									event.preventDefault();
									grantMutation.mutate({
										projectId,
										actorId: grantActorId,
										role: grantRole,
									});
								}}
							>
								<Label className="grid min-w-56 gap-2">
									Actor ID
									<Input
										aria-label="Actor ID for grant"
										required
										value={grantActorId}
										onChange={(event) => setGrantActorId(event.target.value)}
									/>
								</Label>
								<Label className="grid gap-2">
									Grant role
									<Select
										aria-label="Grant role"
										value={grantRole}
										onChange={(event) =>
											setGrantRole(event.target.value as "user" | "read_only")
										}
									>
										<option value="read_only">Read-only</option>
										<option value="user">User</option>
									</Select>
								</Label>
								<Button
									type="submit"
									disabled={grantMutation.isPending || !grantActorId}
								>
									Set grant
								</Button>
							</form>
							{grantsQuery.isLoading ? (
								<p className="text-sm text-muted-foreground" role="status">
									Loading grants...
								</p>
							) : grantsQuery.isError ? (
								<PageError
									message="Grants could not be loaded."
									retry={grantsQuery.refetch}
								/>
							) : grantsQuery.data?.items.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No explicit grants for this Project.
								</p>
							) : (
								grantsQuery.data?.items.map((grant) => (
									<div
										key={grant.actor_id}
										className="flex flex-wrap items-center justify-between gap-3"
									>
										<ActorIdentifier
											actorId={grant.actor_id}
											currentActor={currentActor}
										/>
										<div className="flex items-center gap-3">
											<span className="text-sm text-muted-foreground">
												{grant.role === "read_only" ? "Read-only" : "User"}
											</span>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													revokeMutation.mutate({
														projectId,
														actorId: grant.actor_id,
													})
												}
												disabled={revokeMutation.isPending}
											>
												Revoke grant
											</Button>
										</div>
									</div>
								))
							)}
						</>
					) : null}
				</CardContent>
			</Card>
			{currentActor.can_recover_admin && (
				<RecoveryCard
					open={recoveryOpen}
					confirmation={confirmation}
					pending={recoveryMutation.isPending}
					error={recoveryMutation.isError}
					onOpen={() => setRecoveryOpen(true)}
					onClose={() => setRecoveryOpen(false)}
					onConfirmationChange={setConfirmation}
					onRecover={() => recoveryMutation.mutate()}
				/>
			)}
		</div>
	);
}

function RecoveryCard({
	open,
	confirmation,
	pending,
	error,
	onOpen,
	onClose,
	onConfirmationChange,
	onRecover,
}: {
	open: boolean;
	confirmation: string;
	pending: boolean;
	error: boolean;
	onOpen: () => void;
	onClose: () => void;
	onConfirmationChange: (value: string) => void;
	onRecover: () => void;
}) {
	return (
		<>
			<Card className="border-destructive/40">
				<CardHeader>
					<CardTitle>Break-glass recovery</CardTitle>
					<p className="text-sm text-muted-foreground">
						Only the configured bootstrap Basic Auth owner can recover Admin
						access when no active Admin remains.
					</p>
				</CardHeader>
				<CardContent>
					<Button type="button" variant="destructive" onClick={onOpen}>
						Recover Admin access
					</Button>
				</CardContent>
			</Card>
			{error ? (
				<p className="text-sm text-destructive" role="alert">
					Recovery could not be completed. Review the current access state and
					retry.
				</p>
			) : null}
			{open ? (
				<div
					className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
					role="dialog"
					aria-modal="true"
					aria-labelledby="recovery-title"
				>
					<form
						className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg"
						onSubmit={(event) => {
							event.preventDefault();
							onRecover();
						}}
					>
						<div>
							<h2 id="recovery-title" className="text-lg font-semibold">
								Restore Admin access?
							</h2>
							<p className="mt-2 text-sm text-muted-foreground">
								This destructive break-glass action is allowed only when the
								organization has no active Admin. It is rate-limited and audited
								without credentials or content.
							</p>
						</div>
						<Label className="grid gap-2">
							Type RESTORE ADMIN to confirm
							<Input
								autoFocus
								aria-label="Recovery confirmation"
								value={confirmation}
								onChange={(event) => onConfirmationChange(event.target.value)}
							/>
						</Label>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={onClose}>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="destructive"
								disabled={confirmation !== "RESTORE ADMIN" || pending}
							>
								Restore Admin
							</Button>
						</div>
					</form>
				</div>
			) : null}
		</>
	);
}

function PageHeader() {
	return (
		<div>
			<h1 className="text-2xl font-semibold tracking-tight">Access</h1>
			<p className="text-sm text-muted-foreground">
				Manage organization roles and explicit Project grants.
			</p>
		</div>
	);
}

function PageError({ message, retry }: { message: string; retry: () => void }) {
	return (
		<div className="space-y-3" role="alert">
			<p className="text-sm text-destructive">{message}</p>
			<Button type="button" variant="outline" onClick={() => retry()}>
				Retry
			</Button>
		</div>
	);
}

function ActorRoleRow({
	actor,
	currentActor,
	disabled,
	onChange,
}: {
	actor: AdminActor;
	currentActor: CurrentActor;
	disabled: boolean;
	onChange: (role: Exclude<AdminActor["organization_role"], null>) => void;
}) {
	const subject = actorSubject(actor.actor_id, currentActor);
	const controlName = subject ?? `actor ${shortActor(actor.actor_id)}`;
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
			<ActorIdentifier actorId={actor.actor_id} currentActor={currentActor} />
			<Label className="flex items-center gap-2 text-sm">
				<span className="sr-only">Role for {controlName}</span>
				<Select
					aria-label={`Role for ${controlName}`}
					value={actor.organization_role ?? ""}
					disabled={disabled}
					onChange={(event) =>
						onChange(
							event.target.value as Exclude<
								AdminActor["organization_role"],
								null
							>,
						)
					}
				>
					<option value="" disabled>
						Unassigned
					</option>
					<option value="admin">Admin</option>
					<option value="user">User</option>
					<option value="read_only">Read-only</option>
				</Select>
			</Label>
		</div>
	);
}

function actorSubject(
	actorId: string,
	currentActor: Pick<CurrentActor, "actor_id" | "actor_subject">,
): string | null {
	if (actorId !== currentActor.actor_id) return null;
	return currentActor.actor_subject.trim() || null;
}

function ActorIdentifier({
	actorId,
	currentActor,
}: {
	actorId: string;
	currentActor: Pick<CurrentActor, "actor_id" | "actor_subject">;
}) {
	const subject = actorSubject(actorId, currentActor);
	if (subject)
		return (
			<span
				className="flex min-w-0 items-baseline gap-2"
				aria-label={`${subject}, current user`}
			>
				<span className="truncate text-sm font-medium">{subject}</span>
				<span className="text-xs text-muted-foreground" aria-hidden="true">
					(you)
				</span>
			</span>
		);
	return (
		<span
			className="font-mono text-sm"
			aria-label={`Actor ID ${actorId}`}
			title={actorId}
		>
			Actor {shortActor(actorId)}
		</span>
	);
}
