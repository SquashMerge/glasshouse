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
		},
	});
	const run = useMutation({
		mutationFn: runGovernanceRetention,
		onSuccess: (result, variables) => {
			if (variables.project_id !== selectedProjectIdRef.current) return;
			setPreview(result.counts);
			setPreviewedPolicyId(null);
			setPreviewId(null);
			refresh(variables.project_id);
		},
	});
	React.useEffect(() => {
		setPreview(null);
		setPreviewedPolicyId(null);
		setPreviewId(null);
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
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Governance</h1>
				<p className="text-sm text-muted-foreground">
					Approved policies govern future ingress redaction and bounded
					retention. Drafts have no runtime effect.
				</p>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>Effective policy</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2 text-sm">
					{policy ? (
						<>
							<p>
								Approved version {policy.version} by {policy.approved_by} on{" "}
								{new Date(policy.approved_at!).toLocaleString()}.
							</p>
							<p>
								Redaction: {policy.redaction.mode}, version hash{" "}
								{policy.content_hash.slice(0, 12)}.
							</p>
							<p>
								Retention:{" "}
								{Object.entries(policy.retention)
									.map(([name, days]) => `${name} ${days} days`)
									.join(", ") || "none"}
								.
							</p>
						</>
					) : (
						<p className="text-muted-foreground">
							No approved policy. No retention will run and ingress keeps its
							current unmodified fields.
						</p>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Create immutable draft</CardTitle>
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
							<select
								id="redaction-mode"
								value={mode}
								onChange={(event) =>
									setMode(event.target.value as "none" | "all_text")
								}
								className="h-9 rounded-md border border-input bg-background px-2"
							>
								<option value="all_text">
									Replace all trace input/output text
								</option>
								<option value="none">Keep trace input/output text</option>
							</select>
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
						<Button type="submit" disabled={draft.isPending}>
							Create draft
						</Button>
						{draft.isSuccess && (
							<p className="text-sm" role="status">
								Draft created.
							</p>
						)}
						{draft.isError && (
							<p className="text-sm text-destructive" role="alert">
								The policy draft could not be created.
							</p>
						)}
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
							onClick={() => previewMutation.mutate(selectedProjectId)}
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
								!previewId
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
					<CardTitle>Version history</CardTitle>
				</CardHeader>
				<CardContent>
					<ul className="space-y-3 text-sm">
						{history.data?.items.map((version) => (
							<li
								key={version.id}
								className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"
							>
								<span>
									v{version.version}{" "}
									{version.approved_at
										? `approved by ${version.approved_by}`
										: `draft by ${version.created_by}`}
								</span>
								{!version.approved_at && (
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
										Approve draft
									</Button>
								)}
							</li>
						))}
					</ul>
					{approve.isSuccess && (
						<p className="text-sm" role="status">
							Draft approved.
						</p>
					)}
					{approve.isError && (
						<p className="text-sm text-destructive" role="alert">
							Draft approval failed. Retry when ready.
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
