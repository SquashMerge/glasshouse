import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { DialogContent, DialogOverlay } from "../components/ui/dialog";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { PageHeader as SharedPageHeader } from "../components/ui/page-header";
import { ListLoadingSkeleton } from "../components/LoadingSkeletons";
import { LocalAccounts } from "../components/LocalAccounts";
import {
	getCurrentActor,
	listAdminActors,
	recoverAdmin,
	setAdminActorRole,
	type AdminActor,
	type CurrentActor,
} from "../lib/api";

export function AdminAccessPage() {
	const queryClient = useQueryClient();
	const [recoveryOpen, setRecoveryOpen] = React.useState(false);
	const [confirmation, setConfirmation] = React.useState("");
	const actorQuery = useQuery({ queryKey: ["me"], queryFn: getCurrentActor });
	const actorsQuery = useQuery({
		queryKey: ["admin", "actors"],
		queryFn: listAdminActors,
		enabled: actorQuery.data?.organization_role === "admin",
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
	const recoveryMutation = useMutation({
		mutationFn: recoverAdmin,
		onSuccess: () => {
			setRecoveryOpen(false);
			setConfirmation("");
			invalidate();
		},
	});

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
	if (actorsQuery.isLoading)
		return <ListLoadingSkeleton testId="admin-access-loading" />;
	if (actorsQuery.isError)
		return (
			<PageError
				message="Access data could not be loaded."
				retry={invalidate}
			/>
		);

	return (
		<div className="space-y-8">
			<PageHeader />
			<LocalAccounts />
			{roleMutation.isError || recoveryMutation.isError ? (
				<p className="text-sm text-destructive" role="alert">
					The access change could not be completed. Review the current access
					state and retry.
				</p>
			) : null}
			{roleMutation.isSuccess || recoveryMutation.isSuccess ? (
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
					<Button
						type="button"
						variant="destructive"
						aria-disabled={pending}
						onClick={() => {
							if (!pending) onOpen();
						}}
					>
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
				<DialogOverlay onEscape={onClose}>
					<DialogContent
						className="max-w-md space-y-4"
						role="dialog"
						aria-modal="true"
						aria-labelledby="recovery-title"
					>
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (!pending) onRecover();
							}}
						>
							<div>
								<h2 id="recovery-title" className="text-lg font-semibold">
									Restore Admin access?
								</h2>
								<p className="mt-2 text-sm text-muted-foreground">
									This destructive break-glass action is allowed only when the
									organization has no active Admin. It is rate-limited and
									audited without credentials or content.
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
					</DialogContent>
				</DialogOverlay>
			) : null}
		</>
	);
}

function PageHeader() {
	return (
		<SharedPageHeader
			title="Access"
			description="Manage organization roles across every Project in this organization."
		/>
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
	const controlName = actor.username ?? "unnamed account";
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
			<ActorIdentifier actor={actor} currentActor={currentActor} />
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

function ActorIdentifier({
	actor,
	currentActor,
}: {
	actor: AdminActor;
	currentActor: Pick<CurrentActor, "actor_id" | "actor_subject">;
}) {
	const username = actor.username ?? "Unnamed account";
	if (actor.actor_id === currentActor.actor_id)
		return (
			<span
				className="flex min-w-0 items-baseline gap-2"
				aria-label={`${username}, current user`}
			>
				<span className="truncate text-sm font-medium">{username}</span>
				<span className="text-xs text-muted-foreground" aria-hidden="true">
					(you)
				</span>
			</span>
		);
	return <span className="truncate text-sm font-medium">{username}</span>;
}
