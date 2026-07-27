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
import { useProjectSelection } from "../components/ProjectProvider";
import {
	deletePrompt,
	getActivePromptOptimization,
	getPrompt,
	getPromptOptimization,
	listPromptVersions,
	startPromptOptimization,
	stopPromptOptimization,
	type OptimizationJob,
	type Prompt,
} from "../lib/api";
import { formatDate, PageMessage } from "./prompts";

export function PromptDetailPage() {
	const { slug } = useParams({ from: "/protected/prompts/$slug" });
	const location = useLocation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const [deleteOpen, setDeleteOpen] = React.useState(false);
	const [optimizeTarget, setOptimizeTarget] = React.useState<
		"system" | "user" | null
	>(null);
	const [optimization, setOptimization] =
		React.useState<OptimizationJob | null>(null);
	const [stopToEdit, setStopToEdit] = React.useState(false);
	const stopToEditInFlight = React.useRef(false);
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
	const activeOptimizationQuery = useQuery({
		queryKey: ["prompt-optimization", selectedProjectId, slug],
		queryFn: () =>
			getActivePromptOptimization({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
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
	const optimizeMutation = useMutation({
		mutationFn: (input: {
			target: "system" | "user";
			exampleInput: string;
			exampleAnswer: string;
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
				examples: [{ input: input.exampleInput, answer: input.exampleAnswer }],
				model_config: {
					task_lm: input.taskModel,
					reflection_lm: input.reflectionModel,
				},
				budget: { max_metric_calls: input.maxMetricCalls },
			}),
		onSuccess: (job) => setOptimization(job),
	});
	const stopToEditMutation = useMutation({
		mutationFn: async ({ job }: { job: OptimizationJob; prompt: Prompt }) => {
			if (!selectedProjectId)
				throw new Error("Select a project before stopping optimization.");
			const stopped = await stopPromptOptimization({
				project_id: selectedProjectId,
				id: job.id,
			});
			if (stopped.status !== "stopped")
				throw new Error("Optimization could not be stopped.");
			return stopped;
		},
		onSuccess: (job, { prompt }: { job: OptimizationJob; prompt: Prompt }) => {
			setOptimization(job);
			setStopToEdit(false);
			void navigate({
				to: "/prompts/$slug/edit",
				params: { slug: prompt.id },
				search: { from: prompt.version },
			});
		},
		onSettled: () => {
			stopToEditInFlight.current = false;
		},
	});
	const activeOptimization =
		optimization ?? activeOptimizationQuery.data ?? null;
	const optimizationActive =
		activeOptimization !== null &&
		!["completed", "stopped", "failed"].includes(activeOptimization.status);
	React.useEffect(() => {
		if (
			!activeOptimization ||
			["completed", "stopped", "failed"].includes(activeOptimization.status) ||
			!selectedProjectId
		)
			return;
		const timer = window.setInterval(() => {
			void getPromptOptimization({
				project_id: selectedProjectId,
				id: activeOptimization.id,
			}).then((job) => {
				setOptimization(job);
				if (job.status === "completed")
					void queryClient.invalidateQueries({
						queryKey: ["prompt", selectedProjectId, slug],
					});
			});
		}, 750);
		return () => window.clearInterval(timer);
	}, [
		activeOptimization?.id,
		activeOptimization?.status,
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
						onClick={() => {
							if (optimizationActive) {
								stopToEditMutation.reset();
								setStopToEdit(true);
							} else
								void navigate({
									to: "/prompts/$slug/edit",
									params: { slug: prompt.id },
									search: { from: prompt.version },
								});
						}}
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
						ref={deleteTriggerRef}
						variant="destructive"
						onClick={() => {
							deleteMutation.reset();
							setDeleteOpen(true);
						}}
					>
						Delete
					</Button>
				</div>
			</div>

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
			{optimizeTarget && (
				<OptimizationConfirmDialog
					target={optimizeTarget}
					hasSystem={prompt.messages.some((message) => message.role === "system")}
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
			{activeOptimization && (
				<OptimizationStatus
					job={activeOptimization}
					promptName={prompt.name}
					onStop={() =>
						selectedProjectId &&
						stopPromptOptimization({
							project_id: selectedProjectId,
							id: activeOptimization.id,
						}).then(setOptimization)
					}
				/>
			)}
			{stopToEdit && activeOptimization && (
				<StopToEditDialog
					pending={stopToEditMutation.isPending}
					error={
						stopToEditMutation.error instanceof Error
							? stopToEditMutation.error.message
							: null
					}
					onClose={() => setStopToEdit(false)}
					onConfirm={() => {
						if (stopToEditInFlight.current) return;
						stopToEditInFlight.current = true;
						stopToEditMutation.mutate({ job: activeOptimization, prompt });
					}}
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
		exampleInput: string;
		exampleAnswer: string;
		taskModel: string;
		reflectionModel: string;
		maxMetricCalls: number;
	}) => void;
}) {
	const [exampleInput, setExampleInput] = React.useState("");
	const [exampleAnswer, setExampleAnswer] = React.useState("");
	const [taskModel, setTaskModel] = React.useState("");
	const [reflectionModel, setReflectionModel] = React.useState("");
	const [maxMetricCalls, setMaxMetricCalls] = React.useState("20");
	const valid = Boolean(
		exampleInput.trim() &&
			exampleAnswer.trim() &&
			taskModel.trim() &&
			reflectionModel.trim() &&
			Number.isSafeInteger(Number(maxMetricCalls)) &&
			Number(maxMetricCalls) > 0,
	);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="optimization-title"
				className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
			>
				<h2 id="optimization-title" className="text-lg font-semibold">
					Start optimization
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					GEPA optimizes one prompt role per run. Choose the role to optimize,
					then provide a representative input and expected answer.
				</p>
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
						Representative input
						<textarea
							className="mt-1 min-h-20 w-full rounded-md border p-2"
							placeholder="e.g. A customer asks how to reset their password"
							value={exampleInput}
							onChange={(event) => setExampleInput(event.target.value)}
						/>
					</label>
					<label className="block text-sm font-medium">
						Expected answer
						<textarea
							className="mt-1 min-h-20 w-full rounded-md border p-2"
							placeholder="e.g. Explain the steps clearly and include the support link"
							value={exampleAnswer}
							onChange={(event) => setExampleAnswer(event.target.value)}
						/>
					</label>
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
							min="1"
							placeholder="e.g. 20"
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
								exampleInput: exampleInput.trim(),
								exampleAnswer: exampleAnswer.trim(),
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

function StopToEditDialog({
	pending,
	error,
	onClose,
	onConfirm,
}: {
	pending: boolean;
	error: string | null;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="stop-edit-title"
				className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
			>
				<h2 id="stop-edit-title" className="text-lg font-semibold">
					Stop optimization before editing?
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					Stopping is final. The current optimization will not publish a
					version, then you can create a new one.
				</p>
				{error && (
					<p className="mt-3 text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} disabled={pending}>
						{pending ? "Stopping…" : "Stop and continue"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function OptimizationStatus({
	job,
	promptName,
	onStop,
}: {
	job: OptimizationJob;
	promptName: string;
	onStop: () => void;
}) {
	const active = !["completed", "stopped", "failed"].includes(job.status);
	return (
		<div
			className="fixed bottom-4 right-4 z-40 w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
			role="status"
		>
			<p className="font-medium">
				{promptName} {optimizationStatusLabel(job.status)}
			</p>
			<p className="mt-1 text-sm text-muted-foreground">
				{job.result_version
					? `Published as v${job.result_version}.`
					: (job.error_message ??
						"The source version and configuration are pinned.")}
			</p>
			{active && (
				<Button className="mt-3" size="sm" variant="outline" onClick={onStop}>
					<LuLoaderCircle
						className="h-4 w-4 animate-spin"
						aria-hidden="true"
					/>
					Stop
				</Button>
			)}
		</div>
	);
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
