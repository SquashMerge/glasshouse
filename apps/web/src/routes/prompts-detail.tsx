import * as React from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LuLoaderCircle } from "react-icons/lu";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useEventSource } from "../hooks/useEventSource";
import {
	isOptimizationActive,
	usePromptOptimizationStatus,
} from "../hooks/usePromptOptimizationStatus";
import { RollbackLatestVersionDialog } from "./rollback-latest-version-dialog";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	deletePrompt,
	getPrompt,
	getPromptOptimization,
	listPromptVersions,
	promptOptimizationEventsUrl,
	promotePromptOptimization,
	rollbackLatestPromptVersion,
	startPromptOptimization,
	stopPromptOptimization,
	type OptimizationEvent,
	type OptimizationJob,
	type OptimizationDataset,
	type Prompt,
	type PromptVersion,
} from "../lib/api";
import {
	optimizationDiff,
	parseOptimizationEvent,
	progressScore,
} from "../lib/optimization-progress";
import { formatDate, PageMessage } from "./prompts";

const DEV_OPTIMIZATION_EXAMPLE_ENV = "true";
const MIN_OPTIMIZATION_METRIC_CALLS = 2;
const MAX_OPTIMIZATION_METRIC_CALLS = 20;

export function PromptDetailPage() {
	const { slug } = useParams({ from: "/protected/prompts/$slug" });
	const location = useLocation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const [deleteOpen, setDeleteOpen] = React.useState(false);
	const [rollbackOpen, setRollbackOpen] = React.useState(false);
	const [optimizeTarget, setOptimizeTarget] = React.useState<
		"system" | "user" | null
	>(null);
	const [optimizationEvent, setOptimizationEvent] =
		React.useState<OptimizationEvent | null>(null);
	const [optimizationPanelOpen, setOptimizationPanelOpen] =
		React.useState(false);
	const [stopError, setStopError] = React.useState<string | null>(null);
	const deleteTriggerRef = React.useRef<HTMLButtonElement>(null);
	const selectedVersion = queryVersion(location.searchStr, "version");

	const currentQuery = useQuery({
		queryKey: ["prompt", selectedProjectId, slug, "current"],
		queryFn: () => getPrompt({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	const selectedQuery = useQuery({
		queryKey: ["prompt", selectedProjectId, slug, selectedVersion],
		queryFn: () =>
			getPrompt({
				project_id: selectedProjectId!,
				slug,
				version: selectedVersion!,
			}),
		enabled: Boolean(selectedProjectId && selectedVersion),
	});
	const historyQuery = useQuery({
		queryKey: ["prompt-versions", selectedProjectId, slug],
		queryFn: () => listPromptVersions({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	const optimizationStatus = usePromptOptimizationStatus({
		projectId: selectedProjectId ?? null,
		slug,
	});

	const deleteMutation = useMutation({
		mutationFn: (confirmation: string) => {
			if (!selectedProjectId)
				throw new Error("Select a project before deleting a prompt.");
			return deletePrompt({
				project_id: selectedProjectId,
				slug,
				confirmation,
			});
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["prompts", selectedProjectId],
			});
			await navigate({ to: "/prompts" });
		},
	});
	const rollbackMutation = useMutation({
		mutationFn: () => {
			if (!selectedProjectId)
				throw new Error(
					"Select a project before rolling back a prompt version.",
				);
			return rollbackLatestPromptVersion({
				project_id: selectedProjectId,
				slug,
			});
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["prompt", selectedProjectId, slug, "current"],
				}),
				queryClient.invalidateQueries({
					queryKey: ["prompt-versions", selectedProjectId, slug],
				}),
			]);
			setRollbackOpen(false);
			await navigate({
				to: "/prompts/$slug",
				params: { slug },
				search: {},
			});
		},
	});
	const stopMutation = useMutation({
		mutationFn: () => {
			if (!selectedProjectId || !optimizationStatus.job)
				throw new Error("Optimization status is unavailable.");
			return stopPromptOptimization({
				project_id: selectedProjectId,
				id: optimizationStatus.job.id,
			});
		},
		onSuccess: (job) => {
			setStopError(null);
			optimizationStatus.adopt(job);
		},
		onError: (cause) => {
			setStopError(
				cause instanceof Error
					? cause.message
					: "Optimization could not be stopped.",
			);
			void optimizationStatus.reconcile();
		},
	});
	const optimizeMutation = useMutation({
		mutationFn: (input: {
			target: "system" | "user";
			dataset: OptimizationDataset;
			taskModel: string;
			reflectionModel: string;
			maxMetricCalls: number;
		}) =>
			startPromptOptimization({
				project_id: selectedProjectId!,
				slug,
				source_version: selectedVersion
					? selectedQuery.data!.version
					: currentQuery.data!.version,
				target: input.target,
				evaluator: { type: "default_adapter" },
				dataset: input.dataset,
				model_config: {
					task_lm: input.taskModel,
					reflection_lm: input.reflectionModel,
				},
				budget: { max_metric_calls: input.maxMetricCalls },
			}),
		onSuccess: (job) => {
			setOptimizationEvent(null);
			optimizationStatus.adoptStartedJob(job);
			setOptimizationPanelOpen(true);
		},
	});
	const promoteMutation = useMutation({
		mutationFn: (id: string) =>
			promotePromptOptimization({ project_id: selectedProjectId!, id }),
		onSuccess: async (job) => {
			optimizationStatus.adopt(job);
			queryClient.setQueryData(
				["prompt-optimization-detail", selectedProjectId, job.id],
				job,
			);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["prompt", selectedProjectId, slug, "current"],
				}),
				queryClient.invalidateQueries({
					queryKey: ["prompt-versions", selectedProjectId, slug],
				}),
				queryClient.invalidateQueries({
					queryKey: ["prompts", selectedProjectId],
				}),
			]);
		},
	});
	const activeOptimization = optimizationStatus.job;
	const optimizationActive = isOptimizationActive(activeOptimization?.status);
	const optimizationDetailQuery = useQuery({
		queryKey: [
			"prompt-optimization-detail",
			selectedProjectId,
			activeOptimization?.id,
		],
		queryFn: () =>
			getPromptOptimization({
				project_id: selectedProjectId!,
				id: activeOptimization!.id,
			}),
		enabled: Boolean(
			activeOptimization && selectedProjectId && !optimizationActive,
		),
	});
	const displayedOptimization =
		optimizationDetailQuery.data?.id === activeOptimization?.id
			? optimizationDetailQuery.data
			: activeOptimization;
	const optimizationStream = useEventSource<OptimizationEvent>(
		activeOptimization && selectedProjectId && optimizationActive
			? promptOptimizationEventsUrl({
					project_id: selectedProjectId,
					id: activeOptimization.id,
				})
			: null,
		{
			enabled: optimizationActive,
			coalesce: false,
			onOpen: optimizationStatus.reportStreamOpen,
			onError: optimizationStatus.reportStreamError,
			onMessage: ({ event, data }) => {
				if (event === "error") {
					const streamMessage =
						data &&
						typeof data === "object" &&
						"message" in data &&
						typeof data.message === "string"
							? data.message
							: "Optimization event stream failed";
					optimizationStatus.reportStreamError(new Error(streamMessage));
					return;
				}
				if (event !== "status") return;
				const optimizationEvent = parseOptimizationEvent(data);
				if (!optimizationEvent) return;
				setOptimizationEvent(optimizationEvent);
				void optimizationStatus.reconcile();
			},
		},
	);
	const seenOptimizationRef = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (
			!activeOptimization ||
			seenOptimizationRef.current === activeOptimization.id
		)
			return;
		seenOptimizationRef.current = activeOptimization.id;
		setOptimizationPanelOpen(true);
		setOptimizationEvent(null);
		setStopError(null);
	}, [activeOptimization?.id]);
	const completedOptimizationRef = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (
			activeOptimization?.status !== "completed" ||
			completedOptimizationRef.current === activeOptimization.id
		)
			return;
		completedOptimizationRef.current = activeOptimization.id;
		void Promise.all([
			queryClient.invalidateQueries({
				queryKey: ["prompt", selectedProjectId, slug, "current"],
			}),
			queryClient.invalidateQueries({
				queryKey: ["prompt-versions", selectedProjectId, slug],
			}),
			queryClient.invalidateQueries({
				queryKey: ["prompts", selectedProjectId],
			}),
		]);
	}, [
		activeOptimization?.id,
		activeOptimization?.status,
		queryClient,
		selectedProjectId,
		slug,
	]);

	if (!selectedProjectId || !selectedProject) {
		return (
			<PageMessage title="Prompt">
				Select a project to view this prompt.
			</PageMessage>
		);
	}

	if (
		currentQuery.isLoading ||
		(selectedVersion && selectedQuery.isLoading) ||
		historyQuery.isLoading
	) {
		return <PageMessage title="Prompt">Loading prompt…</PageMessage>;
	}

	const error = currentQuery.error ?? selectedQuery.error ?? historyQuery.error;
	if (error) {
		return (
			<Alert variant="destructive" aria-live="assertive">
				<AlertTitle>Prompt could not be loaded</AlertTitle>
				<AlertDescription>
					{error instanceof Error
						? error.message
						: "Prompt could not be loaded."}
				</AlertDescription>
			</Alert>
		);
	}

	const prompt = selectedVersion ? selectedQuery.data : currentQuery.data;
	if (!prompt || !currentQuery.data)
		return (
			<PageMessage title="Prompt">Prompt could not be loaded.</PageMessage>
		);

	return (
		<div className="space-y-6" data-testid="prompt-detail">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">
						{prompt.name}
					</h1>
					<p className="font-mono text-sm text-muted-foreground">
						{prompt.id}@{prompt.version}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={() =>
							void navigate({
								to: "/prompts/$slug/edit",
								params: { slug: prompt.id },
								search: { from: prompt.version },
							})
						}
						disabled={optimizationActive}
					>
						New version
					</Button>
					{prompt.messages.some(
						(message) => message.role === "system" || message.role === "user",
					) && (
						<Button
							variant="outline"
							onClick={() =>
								setOptimizeTarget(
									prompt.messages.some((message) => message.role === "system")
										? "system"
										: "user",
								)
							}
							disabled={optimizationActive}
						>
							Optimize prompt
						</Button>
					)}
					<Button
						variant="outline"
						onClick={() => {
							rollbackMutation.reset();
							setRollbackOpen(true);
						}}
						disabled={optimizationActive || historyQuery.data!.items.length < 2}
					>
						Rollback latest version
					</Button>
					<Button
						ref={deleteTriggerRef}
						variant="destructive"
						onClick={() => {
							deleteMutation.reset();
							setDeleteOpen(true);
						}}
						disabled={optimizationActive}
					>
						Delete
					</Button>
					{activeOptimization && !optimizationPanelOpen && (
						<Button
							variant="outline"
							onClick={() => setOptimizationPanelOpen(true)}
						>
							View optimization status
						</Button>
					)}
				</div>
			</div>
			{optimizationStatus.snapshotError && (
				<Alert variant="destructive" aria-live="assertive">
					<AlertTitle>Optimization status could not be refreshed</AlertTitle>
					<AlertDescription className="flex items-center justify-between gap-3">
						<span>{optimizationStatus.snapshotError}</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								optimizationStatus.retry();
								optimizationStream.reconnect();
							}}
						>
							Retry now
						</Button>
					</AlertDescription>
				</Alert>
			)}

			<div className="grid gap-6 lg:grid-cols-[minmax(14rem,0.38fr)_minmax(0,1fr)]">
				<Card>
					<CardHeader>
						<CardTitle>Version history</CardTitle>
					</CardHeader>
					<CardContent>
						<ol className="space-y-2" aria-label="Prompt versions">
							{historyQuery.data?.items.map((version) => (
								<li key={version.version}>
									<button
										type="button"
										onClick={() =>
											navigate({
												to: "/prompts/$slug",
												params: { slug },
												search: { version: version.version },
											})
										}
										className={`w-full rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${version.version === prompt.version ? "border-primary bg-muted" : "border-border hover:bg-muted/60"}`}
										aria-current={
											version.version === prompt.version ? "page" : undefined
										}
										disabled={optimizationActive}
										data-testid="prompt-version"
										data-version={version.version}
									>
										<span className="flex items-center justify-between gap-2">
											<span className="font-medium">v{version.version}</span>
											<time
												className="text-xs text-muted-foreground"
												dateTime={version.created_at}
											>
												{formatDate(version.created_at)}
											</time>
										</span>
										<span className="mt-1 block truncate text-xs text-muted-foreground">
											{version.change_summary}
										</span>
									</button>
								</li>
							))}
						</ol>
					</CardContent>
				</Card>

				<div className="space-y-6">
					<PromptVersionDetails prompt={prompt} />
					<Card>
						<CardHeader>
							<CardTitle>Current / previous diff</CardTitle>
						</CardHeader>
						<CardContent>
							<pre
								className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"
								data-testid="prompt-diff"
							>
								{prompt.diff ??
									"No previous version is available for comparison."}
							</pre>
						</CardContent>
					</Card>
				</div>
			</div>

			{deleteOpen && (
				<DeletePromptDialog
					slug={prompt.id}
					isDeleting={deleteMutation.isPending}
					error={
						deleteMutation.error instanceof Error
							? deleteMutation.error.message
							: null
					}
					onClose={() => {
						if (deleteMutation.isPending) return;
						setDeleteOpen(false);
						deleteTriggerRef.current?.focus();
					}}
					onDelete={(confirmation) => deleteMutation.mutate(confirmation)}
				/>
			)}
			{rollbackOpen && (
				<RollbackLatestVersionDialog
					pending={rollbackMutation.isPending}
					error={
						rollbackMutation.error instanceof Error
							? rollbackMutation.error.message
							: null
					}
					onClose={() => {
						if (!rollbackMutation.isPending) setRollbackOpen(false);
					}}
					onConfirm={() => rollbackMutation.mutate()}
				/>
			)}
			{optimizeTarget && (
				<OptimizationConfirmDialog
					target={optimizeTarget}
					hasSystem={prompt.messages.some(
						(message) => message.role === "system",
					)}
					hasUser={prompt.messages.some((message) => message.role === "user")}
					onTargetChange={setOptimizeTarget}
					pending={optimizeMutation.isPending}
					error={
						optimizeMutation.error instanceof Error
							? optimizeMutation.error.message
							: null
					}
					onClose={() => setOptimizeTarget(null)}
					onConfirm={(input) =>
						optimizeMutation.mutate(
							{ ...input, target: optimizeTarget },
							{
								onSuccess: () => setOptimizeTarget(null),
							},
						)
					}
				/>
			)}
			{displayedOptimization && optimizationPanelOpen && (
				<OptimizationStatus
					job={displayedOptimization}
					latestEvent={optimizationEvent}
					versions={historyQuery.data?.items}
					promptName={prompt.name}
					streamStatus={optimizationStream.status}
					streamError={optimizationStatus.streamError}
					stopPending={stopMutation.isPending}
					stopError={stopError}
					onClose={() => setOptimizationPanelOpen(false)}
					onRetry={() => {
						optimizationStatus.retry();
						optimizationStream.reconnect();
					}}
					onStop={() => {
						setStopError(null);
						stopMutation.mutate();
					}}
					onPromote={() => promoteMutation.mutate(displayedOptimization.id)}
					promotionPending={promoteMutation.isPending}
					promotionError={
						promoteMutation.error instanceof Error
							? promoteMutation.error.message
							: null
					}
				/>
			)}
		</div>
	);
}

function OptimizationConfirmDialog({
	target,
	hasSystem,
	hasUser,
	onTargetChange,
	pending,
	error,
	onClose,
	onConfirm,
}: {
	target: "system" | "user";
	hasSystem: boolean;
	hasUser: boolean;
	onTargetChange: (target: "system" | "user") => void;
	pending: boolean;
	error: string | null;
	onClose: () => void;
	onConfirm: (input: {
		dataset: OptimizationDataset;
		taskModel: string;
		reflectionModel: string;
		maxMetricCalls: number;
	}) => void;
}) {
	const [rubric, setRubric] = React.useState("");
	const [trainingExamples, setTrainingExamples] = React.useState([
		{ input: "", answer: "" },
	]);
	const [validationExamples, setValidationExamples] = React.useState([
		{ input: "", answer: "" },
	]);
	const [taskModel, setTaskModel] = React.useState("");
	const [reflectionModel, setReflectionModel] = React.useState("");
	const [maxMetricCalls, setMaxMetricCalls] = React.useState("20");
	const showDevExample =
		import.meta.env.DEV &&
		import.meta.env.VITE_SHOW_DEV_OPTIMIZATION_EXAMPLE ===
			DEV_OPTIMIZATION_EXAMPLE_ENV;
	const fillDevExample = () => {
		setRubric(
			"Produce a concise daily summary that prioritizes deadlines, preserves task details, groups work by urgency or timing, and does not invent tasks.",
		);
		setTrainingExamples([
			{
				input:
					"Here is my task list for today:\n\n- Finish the quarterly status report and send it to the team by 2:00 PM.\n- Pick up groceries after work.\n- Review and approve the open pull request for the API changes.\n- Call the dentist to schedule a cleaning.\n- Take the dog for a 30-minute walk in the evening.",
				answer:
					"**Today’s priorities:** Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.  \n**After work:** Pick up groceries, schedule a dental cleaning, and take the dog for a 30-minute walk.",
			},
		]);
		setValidationExamples([
			{
				input:
					"Tasks for today:\n\n- Send the customer renewal proposal before 11:00 AM.\n- Prepare notes for the 3:00 PM planning meeting.\n- Refill the prescription on the way home.\n- Water the plants tonight.",
				answer:
					"**Before noon:** Send the customer renewal proposal before 11:00 AM.\n**This afternoon:** Prepare notes for the 3:00 PM planning meeting.\n**Later:** Refill the prescription on the way home and water the plants tonight.",
			},
			{
				input:
					"My list:\n\n- Book travel for next week’s conference.\n- Respond to the security review comments by end of day.\n- Make dinner.\n- Return the library books before they are due tomorrow.",
				answer:
					"**Priority work:** Respond to the security review comments by end of day and book travel for next week’s conference.\n**Personal:** Return the library books before tomorrow’s due date, then make dinner.",
			},
		]);
		setTaskModel("gpt-5.6-terra");
		setReflectionModel("gpt-5.6-terra");
		setMaxMetricCalls("5");
	};
	const overlaps = hasOverlappingOptimizationInputs(
		trainingExamples,
		validationExamples,
	);
	const complete = (examples: Array<{ input: string; answer: string }>) =>
		examples.every((example) => example.input.trim() && example.answer.trim());
	const valid = Boolean(
		rubric.trim() &&
			complete(trainingExamples) &&
			complete(validationExamples) &&
			!overlaps &&
			taskModel.trim() &&
			reflectionModel.trim() &&
			Number.isSafeInteger(Number(maxMetricCalls)) &&
			Number(maxMetricCalls) >= MIN_OPTIMIZATION_METRIC_CALLS &&
			Number(maxMetricCalls) <= MAX_OPTIMIZATION_METRIC_CALLS,
	);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="optimization-title"
				className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg"
			>
				<h2 id="optimization-title" className="text-lg font-semibold">
					Start optimization
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					GEPA optimizes one prompt role per run. Expected answers are evaluator
					labels: they are never inserted into the production prompt.
				</p>
				{showDevExample && (
					<Button
						className="mt-3"
						variant="secondary"
						onClick={fillDevExample}
						disabled={pending}
					>
						Fill development example
					</Button>
				)}
				<div className="mt-4 space-y-3">
					<fieldset>
						<legend className="text-sm font-medium">Prompt role</legend>
						<div className="mt-2 flex gap-4">
							{hasSystem && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name="optimization-target"
										value="system"
										checked={target === "system"}
										onChange={() => onTargetChange("system")}
										disabled={pending}
									/>
									System prompt
								</label>
							)}
							{hasUser && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name="optimization-target"
										value="user"
										checked={target === "user"}
										onChange={() => onTargetChange("user")}
										disabled={pending}
									/>
									User prompt
								</label>
							)}
						</div>
					</fieldset>
					<label className="block text-sm font-medium">
						Scoring rubric / objective
						<textarea
							className="mt-1 min-h-20 w-full rounded-md border p-2"
							placeholder="e.g. Prioritize urgent work, preserve deadlines, and use concise grouped headings"
							value={rubric}
							onChange={(event) => setRubric(event.target.value)}
						/>
					</label>
					<OptimizationExampleList
						idPrefix="training"
						title="Training examples"
						examples={trainingExamples}
						disabled={pending}
						onAdd={() =>
							setTrainingExamples((examples) => [
								...examples,
								{ input: "", answer: "" },
							])
						}
						onRemove={(index) =>
							setTrainingExamples((examples) =>
								examples.filter((_, itemIndex) => itemIndex !== index),
							)
						}
						onUpdate={(index, field, value) =>
							setTrainingExamples((examples) =>
								examples.map((example, itemIndex) =>
									itemIndex === index
										? { ...example, [field]: value }
										: example,
								),
							)
						}
					/>
					<OptimizationExampleList
						idPrefix="validation"
						title="Held-out validation examples"
						examples={validationExamples}
						disabled={pending}
						onAdd={() =>
							setValidationExamples((examples) => [
								...examples,
								{ input: "", answer: "" },
							])
						}
						onRemove={(index) =>
							setValidationExamples((examples) =>
								examples.filter((_, itemIndex) => itemIndex !== index),
							)
						}
						onUpdate={(index, field, value) =>
							setValidationExamples((examples) =>
								examples.map((example, itemIndex) =>
									itemIndex === index
										? { ...example, [field]: value }
										: example,
								),
							)
						}
					/>
					{overlaps && (
						<p className="text-sm text-destructive" role="alert">
							Training and held-out validation inputs must be unique and not
							materially overlap.
						</p>
					)}
					{validationExamples.length < 2 && (
						<p className="text-sm text-muted-foreground">
							One held-out sample requires manual review. Add at least two for
							automatic-promotion eligibility.
						</p>
					)}
					<label className="block text-sm font-medium">
						Task model
						<Input
							placeholder="e.g. openai/gpt-4o-mini"
							value={taskModel}
							onChange={(event) => setTaskModel(event.target.value)}
						/>
					</label>
					<label className="block text-sm font-medium">
						Reflection model
						<Input
							placeholder="e.g. openai/gpt-4o-mini"
							value={reflectionModel}
							onChange={(event) => setReflectionModel(event.target.value)}
						/>
					</label>
					<label className="block text-sm font-medium">
						Metric-call budget
						<Input
							type="number"
							min={MIN_OPTIMIZATION_METRIC_CALLS}
							max={MAX_OPTIMIZATION_METRIC_CALLS}
							placeholder="e.g. 5"
							value={maxMetricCalls}
							onChange={(event) => setMaxMetricCalls(event.target.value)}
						/>
					</label>
				</div>
				{error && (
					<p className="mt-3 text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button
						onClick={() =>
							onConfirm({
								dataset: {
									version: 1,
									rubric: rubric.trim(),
									training_examples: trainingExamples.map((example) => ({
										input: example.input.trim(),
										answer: example.answer.trim(),
									})),
									validation_examples: validationExamples.map((example) => ({
										input: example.input.trim(),
										answer: example.answer.trim(),
									})),
								},
								taskModel: taskModel.trim(),
								reflectionModel: reflectionModel.trim(),
								maxMetricCalls: Number(maxMetricCalls),
							})
						}
						disabled={pending || !valid}
					>
						{pending ? "Starting…" : "Start optimization"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function normalizeOptimizationInput(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
		.trim()
		.replace(/\s+/gu, " ");
}

function hasOverlappingOptimizationInputs(
	trainingExamples: Array<{ input: string }>,
	validationExamples: Array<{ input: string }>,
): boolean {
	const trainingInputs = trainingExamples.map((example) =>
		normalizeOptimizationInput(example.input),
	);
	const validationInputs = validationExamples.map((example) =>
		normalizeOptimizationInput(example.input),
	);
	const inputs = [...trainingInputs, ...validationInputs];
	return inputs.some((input, index) =>
		inputs
			.slice(0, index)
			.some((prior) => inputsMateriallyOverlap(input, prior)),
	);
}

function inputsMateriallyOverlap(left: string, right: string): boolean {
	if (left === right) return true;
	const leftTokens = left.match(/[\p{L}\p{N}]+/gu) ?? [];
	const rightTokens = right.match(/[\p{L}\p{N}]+/gu) ?? [];
	const [shorter, longer] =
		leftTokens.length <= rightTokens.length
			? [leftTokens, rightTokens]
			: [rightTokens, leftTokens];
	if (shorter.length === 0) return false;
	if (` ${longer.join(" ")} `.includes(` ${shorter.join(" ")} `)) return true;
	const longerCounts = new Map<string, number>();
	for (const token of longer)
		longerCounts.set(token, (longerCounts.get(token) ?? 0) + 1);
	let shared = 0;
	for (const token of shorter) {
		const remaining = longerCounts.get(token) ?? 0;
		if (remaining === 0) continue;
		shared += 1;
		longerCounts.set(token, remaining - 1);
	}
	return shared / shorter.length >= 0.7;
}

function OptimizationExampleList({
	idPrefix,
	title,
	examples,
	disabled,
	onAdd,
	onRemove,
	onUpdate,
}: {
	idPrefix: string;
	title: string;
	examples: Array<{ input: string; answer: string }>;
	disabled: boolean;
	onAdd: () => void;
	onRemove: (index: number) => void;
	onUpdate: (index: number, field: "input" | "answer", value: string) => void;
}) {
	return (
		<fieldset className="space-y-2 rounded-md border p-3">
			<div className="flex items-center justify-between gap-3">
				<legend className="text-sm font-medium">
					{title} ({examples.length})
				</legend>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={onAdd}
					disabled={disabled}
				>
					Add example
				</Button>
			</div>
			{examples.map((example, index) => (
				<div
					key={`${idPrefix}-${index}`}
					className="space-y-2 rounded-md bg-muted/50 p-2"
				>
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs font-medium">
							{title.replace(" examples", "")} {index + 1}
						</p>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => onRemove(index)}
							disabled={disabled || examples.length === 1}
						>
							Remove
						</Button>
					</div>
					<label className="block text-sm">
						{title.replace(" examples", "")} {index + 1} input
						<textarea
							className="mt-1 min-h-20 w-full rounded-md border bg-background p-2"
							value={example.input}
							onChange={(event) => onUpdate(index, "input", event.target.value)}
							disabled={disabled}
						/>
					</label>
					<label className="block text-sm">
						{title.replace(" examples", "")} {index + 1} expected answer
						<textarea
							className="mt-1 min-h-20 w-full rounded-md border bg-background p-2"
							value={example.answer}
							onChange={(event) =>
								onUpdate(index, "answer", event.target.value)
							}
							disabled={disabled}
						/>
					</label>
				</div>
			))}
		</fieldset>
	);
}

function OptimizationStatus({
	job,
	latestEvent,
	versions,
	promptName,
	streamStatus,
	streamError,
	stopPending,
	stopError,
	onClose,
	onRetry,
	onStop,
	onPromote,
	promotionPending,
	promotionError,
}: {
	job: OptimizationJob;
	latestEvent: OptimizationEvent | null;
	versions: PromptVersion[] | undefined;
	promptName: string;
	streamStatus: "connecting" | "open" | "closed";
	streamError: string | null;
	stopPending: boolean;
	stopError: string | null;
	onClose: () => void;
	onRetry: () => void;
	onStop: () => void;
	onPromote: () => void;
	promotionPending: boolean;
	promotionError: string | null;
}) {
	const active = isOptimizationActive(job.status);
	const elapsed = useElapsedTime(
		job.created_at,
		job.completed_at ?? job.updated_at,
		active,
	);
	const score = progressScore(latestEvent);
	const diff = optimizationDiff(job, versions);
	const evidence = job.evidence ?? null;
	const rubric = evidence?.rubric ?? job.dataset?.rubric;
	return (
		<div
			className="fixed bottom-4 right-4 z-40 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-4 shadow-lg"
			role="status"
			data-testid="optimization-status"
		>
			<div className="flex items-start justify-between gap-3">
				<p className="font-medium">
					{promptName} {optimizationStatusLabel(job.status)}
				</p>
				<Button size="sm" variant="ghost" onClick={onClose}>
					Close status
				</Button>
			</div>
			<p className="mt-1 text-sm text-muted-foreground">
				{promotionSummary(job)}
			</p>
			<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
				<ProgressField label="Phase" value={job.status} />
				<ProgressField
					label="Dataset"
					value={job.dataset ? `v${job.dataset.version}` : "Not reported"}
				/>
				<ProgressField
					label="Prompt role"
					value={job.target ?? "Not reported"}
				/>
				<ProgressField
					label="Source version"
					value={job.source_version ? `v${job.source_version}` : "Not reported"}
				/>
				<ProgressField label="Elapsed" value={elapsed} />
				<ProgressField label="Metric calls" value={metricCallsLabel(job)} />
				<ProgressField
					label="Latest progress score"
					value={score === null ? "Not reported" : String(score)}
				/>
				<ProgressField
					label="Promotion"
					value={promotionStatusLabel(job.promotion_status)}
				/>
				{evidence && (
					<>
						<ProgressField
							label="Training score (diagnostic)"
							value={formatScore(evidence.training.score)}
						/>
						<ProgressField
							label="Training examples"
							value={String(evidence.training.sample_count)}
						/>
						<ProgressField
							label="Held-out validation score"
							value={formatScore(evidence.validation.score)}
						/>
						<ProgressField
							label="Held-out baseline"
							value={formatScore(evidence.validation.baseline_score)}
						/>
						<ProgressField
							label="Held-out examples"
							value={String(evidence.validation.sample_count)}
						/>
						<ProgressField
							label="Leakage check"
							value={leakageLabel(evidence.leakage.status)}
						/>
					</>
				)}
			</dl>
			{active && streamStatus !== "open" && (
				<div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm">
					<span aria-live="polite">
						{streamError ??
							(streamStatus === "connecting"
								? "Connecting to live updates. Status is also checked every 5 seconds."
								: "Live updates disconnected. Automatic reconnect and status checks continue.")}
					</span>
					<Button size="sm" variant="outline" onClick={onRetry}>
						Retry now
					</Button>
				</div>
			)}
			{rubric && (
				<div className="mt-3 border-t pt-3 text-sm">
					<p className="font-medium">Scoring rubric / objective</p>
					<p className="mt-1 whitespace-pre-wrap text-muted-foreground">
						{rubric}
					</p>
				</div>
			)}
			{diff && (
				<div className="mt-4 space-y-2 border-t pt-3 text-sm">
					<p className="font-medium">Candidate review</p>
					<p className="text-muted-foreground">{diff.summary}</p>
					<p className="font-medium">Before / after</p>
					<div className="grid gap-2 sm:grid-cols-2">
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
							{diff.before}
						</pre>
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
							{diff.after}
						</pre>
					</div>
				</div>
			)}
			{active && (
				<Button
					className="mt-3"
					size="sm"
					variant="outline"
					onClick={onStop}
					disabled={stopPending}
				>
					<LuLoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
					{stopPending ? "Stopping…" : "Stop"}
				</Button>
			)}
			{active && stopError && (
				<p className="mt-3 text-sm text-destructive" role="alert">
					{stopError}
				</p>
			)}
			{job.status === "completed" &&
				job.promotion_status === "review_required" &&
				job.candidate_content && (
					<Button
						className="mt-3"
						size="sm"
						onClick={onPromote}
						disabled={promotionPending}
					>
						{promotionPending ? "Promoting…" : "Promote reviewed draft"}
					</Button>
				)}
			{promotionError && (
				<p className="mt-2 text-sm text-destructive" role="alert">
					{promotionError}
				</p>
			)}
		</div>
	);
}

function metricCallsLabel(job: OptimizationJob): string {
	const budget = job.budget?.max_metric_calls;
	if (typeof job.metric_calls_used === "number")
		return budget
			? `${job.metric_calls_used} / ${budget}`
			: String(job.metric_calls_used);
	return budget ? `Telemetry unavailable / ${budget}` : "Telemetry unavailable";
}

function formatScore(score: number | null): string {
	return score === null ? "Not reported" : String(score);
}

function leakageLabel(status: "not_run" | "passed" | "failed"): string {
	return status === "passed"
		? "Passed"
		: status === "failed"
			? "Blocked"
			: "Not run";
}

function promotionStatusLabel(
	status: OptimizationJob["promotion_status"],
): string {
	return status === "auto_promoted"
		? "Automatically promoted"
		: status === "reviewed_promoted"
			? "Promoted after review"
			: status === "review_required"
				? "Review required"
				: status === "blocked"
					? "Blocked"
					: status === "legacy"
						? "Legacy result"
						: "Pending";
}

function promotionSummary(job: OptimizationJob): string {
	if (job.result_version && job.promotion_status === undefined)
		return `Published as v${job.result_version}.`;
	if (job.promotion_status === "auto_promoted" && job.result_version)
		return `Automatically promoted as v${job.result_version} using held-out validation evidence.`;
	if (job.promotion_status === "reviewed_promoted" && job.result_version)
		return `Promoted as v${job.result_version} after authenticated review.`;
	if (job.promotion_status === "review_required")
		return `Draft only: ${promotionReason(job.promotion_reason)}.`;
	if (job.promotion_status === "blocked")
		return `Publication blocked: ${promotionReason(job.promotion_reason)}.`;
	if (job.promotion_status === "legacy")
		return "Legacy result: held-out validation evidence was not recorded.";
	return (
		job.error_message ?? "The source version and configuration are pinned."
	);
}

function promotionReason(reason: string | null | undefined): string {
	if (reason === "insufficient_held_out_validation")
		return "fewer than two independent held-out examples";
	if (reason === "held_out_score_unavailable")
		return "held-out validation evidence is unavailable";
	if (reason === "held_out_score_did_not_improve")
		return "the held-out score did not improve on the source prompt";
	if (reason === "source_version_is_stale")
		return "the source prompt changed before publication";
	if (reason === "expected_answer_full_match")
		return "the candidate copied a full expected answer";
	if (reason === "expected_answer_material_span")
		return "the candidate copied material expected-answer text";
	if (reason === "candidate_validation_failed")
		return "the candidate failed prompt validation";
	return "review is required";
}

function ProgressField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

function useElapsedTime(
	createdAt: string | undefined,
	completedAt: string | undefined | null,
	active: boolean,
): string {
	const [now, setNow] = React.useState(() => Date.now());
	React.useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const interval = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(interval);
	}, [active]);
	if (!createdAt) return "Not reported";
	const startedAt = new Date(createdAt).valueOf();
	if (Number.isNaN(startedAt)) return "Not reported";
	const finishedAt = active
		? now
		: new Date(completedAt ?? createdAt).valueOf();
	const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1_000));
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function optimizationStatusLabel(status: OptimizationJob["status"]): string {
	return status === "optimizing" ? "optimizing…" : status;
}

function PromptVersionDetails({ prompt }: { prompt: Prompt }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Version v{prompt.version}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-5">
				<dl className="grid gap-3 text-sm sm:grid-cols-2">
					<div>
						<dt className="text-muted-foreground">Content hash</dt>
						<dd className="break-all font-mono text-xs">
							{prompt.content_hash}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Created by</dt>
						<dd>{prompt.created_by}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Created</dt>
						<dd>
							<time dateTime={prompt.created_at}>
								{formatDate(prompt.created_at)}
							</time>
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Model</dt>
						<dd>{prompt.model ?? "—"}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Change summary</dt>
						<dd>{prompt.change_summary}</dd>
					</div>
				</dl>
				<div className="space-y-2">
					<h2 className="text-sm font-medium">Settings</h2>
					<pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
						{JSON.stringify(prompt.settings, null, 2)}
					</pre>
				</div>
				<div className="space-y-3">
					<h2 className="text-sm font-medium">Messages</h2>
					{prompt.messages.map((message) => (
						<div key={message.role} className="space-y-1">
							<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								{message.role}
							</p>
							<pre
								className="overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm"
								data-testid={`prompt-message-${message.role}`}
							>
								{message.content}
							</pre>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function DeletePromptDialog({
	slug,
	isDeleting,
	error,
	onClose,
	onDelete,
}: {
	slug: string;
	isDeleting: boolean;
	error: string | null;
	onClose: () => void;
	onDelete: (confirmation: string) => void;
}) {
	const [confirmation, setConfirmation] = React.useState("");
	const dialogRef = React.useRef<HTMLDivElement>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		inputRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !isDeleting) {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== "Tab") return;
			const dialog = dialogRef.current;
			if (!dialog) return;
			const focusable = Array.from(
				dialog.querySelectorAll<HTMLElement>(
					"button:not([disabled]), input:not([disabled])",
				),
			);
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (!first || !last) return;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [isDeleting, onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4"
			onMouseDown={onClose}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="delete-prompt-title"
				className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<h2 id="delete-prompt-title" className="text-lg font-semibold">
					Delete prompt
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					This permanently deletes the prompt and its version history. Existing
					trace references remain, but their prompt provenance will report
					deletion.
				</p>
				<div className="mt-4 space-y-2">
					<label htmlFor="delete-confirmation" className="text-sm font-medium">
						Type <span className="font-mono">{slug}</span> to confirm
					</label>
					<Input
						ref={inputRef}
						id="delete-confirmation"
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
						disabled={isDeleting}
						autoComplete="off"
						data-testid="delete-confirmation"
					/>
				</div>
				{error && (
					<p
						className="mt-3 text-sm text-destructive"
						role="alert"
						aria-live="assertive"
					>
						{error}
					</p>
				)}
				<div className="mt-6 flex justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => onDelete(confirmation)}
						disabled={confirmation !== slug || isDeleting}
						data-testid="confirm-delete"
					>
						{isDeleting ? "Deleting…" : "Delete prompt"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function queryVersion(search: string, key: string): number | undefined {
	const value = new URLSearchParams(search).get(key);
	if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
	const version = Number(value);
	return Number.isSafeInteger(version) ? version : undefined;
}
