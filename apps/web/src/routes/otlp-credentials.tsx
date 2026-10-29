import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	createOtlpCredential,
	listOtlpCredentials,
	revokeOtlpCredential,
	rotateOtlpCredential,
	type OtlpCredentialWithSecret,
} from "../lib/api";

function dateLabel(value: string | null) {
	return value ? new Date(value).toLocaleString() : "Never";
}

export function OtlpCredentialsPage() {
	const queryClient = useQueryClient();
	const { organizationRole, selectedProject, selectedProjectId } =
		useProjectSelection();
	const selectedProjectIdRef = React.useRef(selectedProjectId);
	selectedProjectIdRef.current = selectedProjectId;
	const isAdmin = organizationRole === "admin";
	const [name, setName] = React.useState("");
	const [shown, setShown] = React.useState<OtlpCredentialWithSecret | null>(
		null,
	);
	const [error, setError] = React.useState<string | null>(null);
	const [revokeId, setRevokeId] = React.useState<string | null>(null);
	const query = useQuery({
		queryKey: ["otlp-credentials", selectedProjectId],
		queryFn: () => listOtlpCredentials(selectedProjectId!),
		enabled: isAdmin && Boolean(selectedProjectId),
	});
	const refresh = (projectId: string) =>
		queryClient.invalidateQueries({
			queryKey: ["otlp-credentials", projectId],
		});
	const create = useMutation({
		mutationFn: createOtlpCredential,
		onSuccess: (value, input) => {
			if (input.project_id === selectedProjectIdRef.current) {
				setName("");
				setError(null);
				setShown(value);
			}
			void refresh(input.project_id);
		},
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not create credential.",
			),
	});
	const rotate = useMutation({
		mutationFn: rotateOtlpCredential,
		onSuccess: (value, input) => {
			if (input.project_id === selectedProjectIdRef.current) {
				setError(null);
				setShown(value);
			}
			void refresh(input.project_id);
		},
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not rotate credential.",
			),
	});
	const revoke = useMutation({
		mutationFn: revokeOtlpCredential,
		onSuccess: (_, input) => {
			setRevokeId(null);
			setError(null);
			void refresh(input.project_id);
		},
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not revoke credential.",
			),
	});

	React.useEffect(() => {
		setShown(null);
		setError(null);
	}, [selectedProjectId]);
	const visibleSecret =
		selectedProjectId &&
		shown?.credential.project_id.toLowerCase() ===
			selectedProjectId.toLowerCase()
			? shown
			: null;

	if (!isAdmin)
		return (
			<PageHeader
				title="OTLP credentials"
				description="Only organization Admins can manage ingestion credentials."
			/>
		);

	return (
		<div className="space-y-6">
			<PageHeader
				title="OTLP credentials"
				description="Create Project-bound secrets for sending traces. Credentials cannot access the dashboard or read telemetry."
			/>
			{!selectedProjectId ? (
				<Card>
					<CardContent className="py-6 text-sm text-muted-foreground">
						Select a Project to manage its credentials.
					</CardContent>
				</Card>
			) : (
				<>
					<Card>
						<CardHeader>
							<CardTitle>Create credential</CardTitle>
							<CardDescription>
								Each secret can send OTLP traces only to{" "}
								{selectedProject?.name ?? "the selected Project"}. Copy it now;
								it will not be shown again.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<form
								className="flex flex-col items-start gap-3 sm:flex-row sm:items-end"
								onSubmit={(event) => {
									event.preventDefault();
									setError(null);
									create.mutate({ project_id: selectedProjectId, name });
								}}
							>
								<div className="w-full max-w-sm space-y-2">
									<Label htmlFor="credential-name">Credential name</Label>
									<Input
										id="credential-name"
										value={name}
										maxLength={100}
										required
										onChange={(event) => setName(event.target.value)}
										placeholder="Production collector"
									/>
								</div>
								<Button
									type="submit"
									disabled={create.isPending || !name.trim()}
								>
									{create.isPending ? "Creating…" : "Create credential"}
								</Button>
							</form>
						</CardContent>
					</Card>
					{visibleSecret && (
						<Card className="border-primary/40" role="status">
							<CardHeader>
								<CardTitle>Copy this secret now</CardTitle>
								<CardDescription>
									The secret is shown once. Store it in your application’s
									secret manager; dismissing this panel cannot be undone.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-3">
								<code
									className="block break-all rounded-md bg-muted p-3 text-sm"
									data-testid="created-credential-secret"
								>
									{visibleSecret.secret}
								</code>
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="secondary"
										onClick={() =>
											void navigator.clipboard?.writeText(visibleSecret.secret)
										}
									>
										Copy secret
									</Button>
									<Button
										type="button"
										variant="outline"
										onClick={() => setShown(null)}
									>
										Dismiss secret
									</Button>
								</div>
							</CardContent>
						</Card>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<Card>
						<CardHeader>
							<CardTitle>Credentials</CardTitle>
							<CardDescription>
								Active and revoked credentials for{" "}
								{selectedProject?.name ?? "this Project"}.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-3">
							{query.isLoading && (
								<p role="status" className="text-sm text-muted-foreground">
									Loading credentials…
								</p>
							)}
							{query.isError && (
								<div role="alert" className="flex items-center gap-3 text-sm">
									<span>Credentials could not be loaded.</span>
									<Button
										type="button"
										variant="outline"
										onClick={() => void query.refetch()}
									>
										Retry
									</Button>
								</div>
							)}
							{query.data?.items.length === 0 && (
								<p className="text-sm text-muted-foreground">
									No ingestion credentials yet.
								</p>
							)}
							{query.data?.items.map((credential) => {
								const revoked = Boolean(credential.revoked_at);
								return (
									<div
										key={credential.id}
										className="flex flex-col gap-4 rounded-md border border-border p-4 md:flex-row md:items-center md:justify-between"
									>
										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<h3 className="font-medium">{credential.name}</h3>
												<Badge variant={revoked ? "secondary" : "default"}>
													{revoked ? "Revoked" : "Active"}
												</Badge>
											</div>
											<p className="font-mono text-xs text-muted-foreground">
												{credential.secret_prefix}••••••••••••••••
											</p>
											<p className="text-xs text-muted-foreground">
												Created {dateLabel(credential.created_at)} · Last used{" "}
												{dateLabel(credential.last_used_at)}
											</p>
										</div>
										<div className="flex flex-wrap items-center gap-2">
											{!revoked && (
												<Button
													type="button"
													variant="outline"
													disabled={rotate.isPending}
													onClick={() =>
														rotate.mutate({
															project_id: selectedProjectId,
															id: credential.id,
														})
													}
												>
													Rotate
												</Button>
											)}
											{!revoked &&
												(revokeId === credential.id ? (
													<>
														<span className="text-sm">
															Revoke this credential?
														</span>
														<Button
															type="button"
															variant="destructive"
															disabled={revoke.isPending}
															onClick={() =>
																revoke.mutate({
																	project_id: selectedProjectId,
																	id: credential.id,
																})
															}
														>
															Confirm revoke
														</Button>
														<Button
															type="button"
															variant="ghost"
															onClick={() => setRevokeId(null)}
														>
															Cancel
														</Button>
													</>
												) : (
													<Button
														type="button"
														variant="destructive"
														onClick={() => setRevokeId(credential.id)}
													>
														Revoke
													</Button>
												))}
										</div>
									</div>
								);
							})}
						</CardContent>
					</Card>
				</>
			)}
		</div>
	);
}
