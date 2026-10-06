import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { PageHeader } from "../components/ui/page-header";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	approveGovernancePolicy,
	createGovernancePolicyDraft,
	getEffectiveGovernancePolicy,
	listGovernancePolicyHistory,
	listGovernanceRetentionRuns,
	previewGovernanceRetention,
	runGovernanceRetention,
} from "../lib/api";
import { FormLoadingSkeleton } from "../components/LoadingSkeletons";
import { PageMessage } from "./prompts";

export function GovernancePage() {
	const { selectedProjectId } = useProjectSelection();
	const selectedProjectIdRef = React.useRef(selectedProjectId);
	selectedProjectIdRef.current = selectedProjectId;
	const queryClient = useQueryClient();
	const [traces, setTraces] = React.useState("30");
	const [datasets, setDatasets] = React.useState("90");
	const [feedback, setFeedback] = React.useState("90");
	const [mode, setMode] = React.useState<"none" | "all_text">("all_text");
	const [keys, setKeys] = React.useState("");
	const [preview, setPreview] = React.useState<Record<string, number> | null>(
		null,
	);
	const [previewedPolicyId, setPreviewedPolicyId] = React.useState<
		string | null
	>(null);
	const [previewId, setPreviewId] = React.useState<string | null>(null);
	const [previewExpiresAt, setPreviewExpiresAt] = React.useState<string | null>(
		null,
	);
	const [previewExpired, setPreviewExpired] = React.useState(false);
	const effective = useQuery({
		queryKey: ["governance-policy", selectedProjectId],
		queryFn: () => getEffectiveGovernancePolicy(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const history = useQuery({
		queryKey: ["governance-history", selectedProjectId],
		queryFn: () => listGovernancePolicyHistory(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const retentionRuns = useQuery({
		queryKey: ["governance-retention-runs", selectedProjectId],
		queryFn: () => listGovernanceRetentionRuns(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const refresh = (projectId: string) => {
		void queryClient.invalidateQueries({
			queryKey: ["governance-policy", projectId],
		});
		void queryClient.invalidateQueries({
			queryKey: ["governance-history", projectId],
		});
		void queryClient.invalidateQueries({
			queryKey: ["governance-retention-runs", projectId],
		});
	};
	const draft = useMutation({
		mutationFn: createGovernancePolicyDraft,
		onSuccess: (_, variables) => {
			if (variables.project_id !== selectedProjectIdRef.current) return;
			setPreview(null);
			setPreviewedPolicyId(null);
			setPreviewId(null);
			setPreviewExpiresAt(null);
			refresh(variables.project_id);
		},
	});
	const approve = useMutation({
		mutationFn: approveGovernancePolicy,
		onSuccess: (_, variables) => {
			if (variables.project_id !== selectedProjectIdRef.current) return;
			setPreview(null);
			setPreviewedPolicyId(null);
			setPreviewId(null);
			setPreviewExpiresAt(null);
			refresh(variables.project_id);
		},
	});
	const previewMutation = useMutation({
		mutationFn: previewGovernanceRetention,
		onSuccess: (result, projectId) => {
			if (projectId !== selectedProjectIdRef.current) return;
			setPreview(result.counts);
			setPreviewedPolicyId(result.policy_version_id);
			setPreviewId(result.preview_id);
			setPreviewExpiresAt(result.preview_expires_at);
		},
		onError: (_error, projectId) => {
			if (projectId !== selectedProjectIdRef.current) return;
			setPreviewedPolicyId(null);
			setPreviewId(null);
			setPreviewExpiresAt(null);
		},
	});
	const run = useMutation({
		mutationFn: runGovernanceRetention,
		onSuccess: (result, variables) => {
			if (variables.project_id !== selectedProjectIdRef.current) return;
			setPreview(result.counts);
			setPreviewedPolicyId(null);
			setPreviewId(null);
			setPreviewExpiresAt(null);
			refresh(variables.project_id);
		},
		onError: (_error, variables) => {
			if (variables.project_id !== selectedProjectIdRef.current) return;
			setPreviewedPolicyId(null);
			setPreviewId(null);
			setPreviewExpiresAt(null);
		},
	});
	React.useEffect(() => {
		if (!previewExpiresAt) {
			setPreviewExpired(false);
			return;
		}
		const expiresAt = Date.parse(previewExpiresAt);
		const remaining = expiresAt - Date.now();
		if (!Number.isFinite(expiresAt) || remaining <= 0) {
			setPreviewExpired(true);
			return;
		}
		setPreviewExpired(false);
		const timeout = window.setTimeout(
			() => setPreviewExpired(true),
			Math.min(remaining, 2_147_483_647),
		);
		return () => window.clearTimeout(timeout);
	}, [previewExpiresAt]);
	React.useEffect(() => {
		setPreview(null);
		setPreviewedPolicyId(null);
		setPreviewId(null);
		setPreviewExpiresAt(null);
		draft.reset();
		approve.reset();
		previewMutation.reset();
		run.reset();
	}, [selectedProjectId]);
	if (!selectedProjectId)
		return (
			<PageMessage title="Governance">
				Select a project to manage its governed retention policy.
			</PageMessage>
		);
	if (
		(effective.isLoading && !effective.data) ||
		(history.isLoading && !history.data) ||
		(retentionRuns.isLoading && !retentionRuns.data)
	)
		return <FormLoadingSkeleton testId="governance-form-skeleton" />;
	if (effective.isError || history.isError || retentionRuns.isError)
		return (
			<PageMessage title="Governance">
				<p role="alert">Governance policy could not be loaded.</p>
				<Button
					type="button"
					variant="outline"
					onClick={() => refresh(selectedProjectId)}
				>
					Retry
				</Button>
			</PageMessage>
		);
	const policy = effective.data?.policy;
	const policyVersions = history.data?.items ?? [];
	const pendingDrafts = policyVersions.filter(
		(version) => !version.approved_at,
	);
	const approvedHistory = policyVersions.filter(
		(version) => version.approved_at && version.id !== policy?.id,
	);
	return (
		<div className="space-y-8">
			<PageHeader
				title="Governance"
				description="Review policy state, approve drafts, and run bounded retention."
			/>
			<section
				className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
				aria-label="Policy status"
			>
				<Card data-testid="active-policy-card" className="border-primary/30">
					<CardHeader>
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="space-y-1.5">
								<CardTitle className="text-xl">
									Active approved policy
								</CardTitle>
								<CardDescription>
									This is the policy currently enforced for ingress and
									retention.
								</CardDescription>
							</div>
							<Badge variant={policy ? "success" : "outline"}>
								{policy ? "Active" : "Not configured"}
							</Badge>
						</div>
					</CardHeader>
					<CardContent>
						{policy ? (
							<div className="space-y-5">
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<p className="text-lg font-semibold">
										Version {policy.version}
									</p>
									<code className="text-xs text-muted-foreground">
										{policy.content_hash.slice(0, 12)}
									</code>
								</div>
								<dl className="grid gap-3 sm:grid-cols-2">
									<div className="rounded-md bg-muted/50 p-3">
										<dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Retention
										</dt>
										<dd className="mt-1 text-sm">
											{retentionSummary(policy.retention)}
										</dd>
									</div>
									<div className="rounded-md bg-muted/50 p-3">
										<dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Ingress redaction
										</dt>
										<dd className="mt-1 text-sm">
											{redactionSummary(policy.redaction)}
										</dd>
									</div>
								</dl>
								<p className="text-xs text-muted-foreground">
									Approved by {policy.approved_by} on{" "}
									{new Date(policy.approved_at!).toLocaleString()}.
								</p>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								No approved policy is active. Retention cannot run until a draft
								is approved.
							</p>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="space-y-1.5">
								<CardTitle className="text-xl">
									Drafts awaiting approval
								</CardTitle>
								<CardDescription>
									Drafts have no runtime effect until they are approved.
								</CardDescription>
							</div>
							<Badge variant="secondary">
								{pendingDrafts.length}{" "}
								{pendingDrafts.length === 1 ? "draft" : "drafts"}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="space-y-4">
						{pendingDrafts.length ? (
							pendingDrafts.map((version) => {
								const activates = !policy || version.version > policy.version;
								return (
									<div
										key={version.id}
										className="space-y-4 rounded-md border border-border p-4"
										data-testid={`draft-policy-${version.id}`}
									>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<p className="font-semibold">Version {version.version}</p>
											<Badge variant="secondary">Draft</Badge>
										</div>
										<dl className="grid gap-3 text-sm sm:grid-cols-2">
											<div>
												<dt className="text-xs text-muted-foreground">
													Retention
												</dt>
												<dd className="mt-1">
													{retentionSummary(version.retention)}
												</dd>
											</div>
											<div>
												<dt className="text-xs text-muted-foreground">
													Ingress redaction
												</dt>
												<dd className="mt-1">
													{redactionSummary(version.redaction)}
												</dd>
											</div>
										</dl>
										<div className="space-y-2 border-t border-border pt-3">
											<p className="text-sm font-medium">
												Next action: Review and approve this draft.
											</p>
											<p className="text-sm text-muted-foreground">
												{activates
													? "Approval activates it as the current policy."
													: "Approval records this version; the newer approved policy remains active."}
											</p>
											<Button
												size="sm"
												type="button"
												disabled={approve.isPending}
												onClick={() =>
													approve.mutate({
														project_id: selectedProjectId,
														id: version.id,
													})
												}
											>
												{activates
													? `Approve and activate version ${version.version}`
													: `Approve version ${version.version}`}
											</Button>
										</div>
									</div>
								);
							})
						) : (
							<p className="text-sm text-muted-foreground">
								No drafts are waiting for approval.
							</p>
						)}
						{approve.isSuccess && (
							<p className="text-sm" role="status">
								Draft approved. The active policy has been refreshed.
							</p>
						)}
						{approve.isError && (
							<p className="text-sm text-destructive" role="alert">
								Draft approval failed. Review the policy state and retry.
							</p>
						)}
					</CardContent>
				</Card>
			</section>
			<Card>
				<CardHeader>
					<CardTitle className="text-xl">Create policy draft</CardTitle>
					<CardDescription>
						Creates an immutable draft without changing the active policy.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form
						className="grid gap-4 sm:grid-cols-2"
						onSubmit={(event) => {
							event.preventDefault();
							draft.mutate({
								project_id: selectedProjectId,
								retention: {
									traces: Number(traces),
									datasets: Number(datasets),
									feedback: Number(feedback),
								},
								redaction: {
									mode,
									keys: keys
										.split(",")
										.map((key) => key.trim())
										.filter(Boolean),
								},
							});
						}}
					>
						<Field
							label="Trace retention (days)"
							value={traces}
							setValue={setTraces}
						/>
						<Field
							label="Dataset retention (days)"
							value={datasets}
							setValue={setDatasets}
						/>
						<Field
							label="Feedback retention (days)"
							value={feedback}
							setValue={setFeedback}
						/>
						<div className="grid gap-2">
							<Label htmlFor="redaction-mode">Ingress redaction</Label>
							<Select
								id="redaction-mode"
								value={mode}
								onChange={(event) =>
									setMode(event.target.value as "none" | "all_text")
								}
							>
								<option value="all_text">
									Replace all trace input/output text
								</option>
								<option value="none">Keep trace input/output text</option>
							</Select>
						</div>
						<div className="grid gap-2 sm:col-span-2">
							<Label htmlFor="redaction-keys">Attribute keys to redact</Label>
							<Input
								id="redaction-keys"
								value={keys}
								onChange={(event) => setKeys(event.target.value)}
								placeholder="user.email, http.url"
							/>
							<p className="text-xs text-muted-foreground">
								Comma-separated literal attribute names only. Existing data is
								never rewritten.
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-3 sm:col-span-2">
							<Button type="submit" disabled={draft.isPending}>
								Create draft
							</Button>
							{draft.isSuccess && (
								<p className="text-sm" role="status">
									Draft created and ready for review.
								</p>
							)}
							{draft.isError && (
								<p className="text-sm text-destructive" role="alert">
									The policy draft could not be created.
								</p>
							)}
						</div>
					</form>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Retention preview and run</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-sm text-muted-foreground">
						Preview reports counts only. A run deletes at most 100 eligible
						trace groups, with no more than 100 physical trace/observation rows
						total, or 100 datasets or feedback records per class.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={!policy || previewMutation.isPending}
							onClick={() => {
								setPreview(null);
								setPreviewedPolicyId(null);
								setPreviewId(null);
								setPreviewExpiresAt(null);
								previewMutation.mutate(selectedProjectId);
							}}
						>
							Preview eligible counts
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={
								!policy ||
								run.isPending ||
								previewedPolicyId !== policy.id ||
								!previewId ||
								previewExpired
							}
							onClick={() =>
								run.mutate({
									project_id: selectedProjectId,
									policy_version_id: previewedPolicyId!,
									preview_id: previewId!,
									batch_size: 100,
								})
							}
						>
							Run one bounded batch
						</Button>
					</div>
					{preview && (
						<p className="text-sm" role="status">
							{Object.entries(preview)
								.map(([name, count]) => `${name}: ${count}`)
								.join(", ") || "No eligible data."}
						</p>
					)}
					{previewExpiresAt && (
						<p
							className={
								previewExpired
									? "text-sm text-destructive"
									: "text-sm text-muted-foreground"
							}
							role={previewExpired ? "alert" : "status"}
						>
							{previewExpired
								? "Preview expired. Preview eligible counts again before running retention."
								: `Preview authorization expires ${new Date(previewExpiresAt).toLocaleString()}.`}
						</p>
					)}
					{previewMutation.isError && (
						<p className="text-sm text-destructive" role="alert">
							Preview failed. Retry before running retention.
						</p>
					)}
					{run.isSuccess && (
						<p className="text-sm" role="status">
							Retention batch completed.
						</p>
					)}
					{run.isError && (
						<p className="text-sm text-destructive" role="alert">
							Retention batch failed. Preview again before retrying.
						</p>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Retention run summaries</CardTitle>
				</CardHeader>
				<CardContent>
					{retentionRuns.data?.items.length ? (
						<ul className="space-y-3 text-sm">
							{retentionRuns.data.items.map((retentionRun) => (
								<li
									key={retentionRun.id}
									className="border-b border-border pb-3 last:border-0 last:pb-0"
								>
									<p className="font-medium capitalize">
										{retentionRun.status}
									</p>
									<p className="text-muted-foreground">
										Started {new Date(retentionRun.started_at).toLocaleString()}
										{retentionRun.duration_ms !== null
											? `, ${retentionRun.duration_ms} ms`
											: ""}
										.{" "}
										{Object.entries(retentionRun.counts)
											.map(([name, count]) => `${name}: ${count}`)
											.join(", ") || "No records deleted."}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							No retention runs have been recorded for this project.
						</p>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-xl">Approved policy history</CardTitle>
					<CardDescription>
						Previous approvals remain available as policy evidence.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{approvedHistory.length ? (
						<ul className="space-y-3 text-sm">
							{approvedHistory.map((version) => (
								<li
									key={version.id}
									className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
								>
									<div>
										<p className="font-medium">Version {version.version}</p>
										<p className="mt-1 text-muted-foreground">
											{retentionSummary(version.retention)}
										</p>
									</div>
									<p className="text-xs text-muted-foreground">
										Approved by {version.approved_by}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							No previous approved policies.
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
function Field({
	label,
	value,
	setValue,
}: {
	label: string;
	value: string;
	setValue: (value: string) => void;
}) {
	const id = label.toLowerCase().replaceAll(" ", "-");
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type="number"
				min="1"
				max="3650"
				required
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
		</div>
	);
}

function retentionSummary(
	retention: Partial<Record<"traces" | "datasets" | "feedback", number>>,
): string {
	const values = (["traces", "datasets", "feedback"] as const).flatMap(
		(name) => {
			const days = retention[name];
			return days === undefined ? [] : [`${name} ${days} days`];
		},
	);
	return values.join(", ") || "No automated retention";
}

function redactionSummary(redaction: {
	mode: "none" | "all_text";
	keys: string[];
}): string {
	const mode =
		redaction.mode === "all_text"
			? "All trace input/output text"
			: "Trace input/output text retained";
	return redaction.keys.length
		? `${mode}; ${redaction.keys.length} attribute ${redaction.keys.length === 1 ? "key" : "keys"}`
		: mode;
}
