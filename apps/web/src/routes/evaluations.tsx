import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	archiveEvaluation,
	cancelExperiment,
	createEvaluation,
	experimentEventsUrl,
	experimentResults,
	experimentSummary,
	getExperiment,
	getEvaluation,
	getEvaluationDraft,
	listDatasets,
	listExperiments,
	listEvaluations,
	listEvaluationLegacyLinks,
	listEvaluationVersions,
	getEvaluationVersion,
	startEvaluationRun,
	listDatasetVersions,
	publishEvaluationDraft,
	restoreEvaluation,
	tombstoneEvaluation,
	updateEvaluationDraft,
} from "../lib/api";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import {
	DetailLoadingSkeleton,
	ListLoadingSkeleton,
} from "../components/LoadingSkeletons";
import { PageMessage } from "./prompts";
import { useEventSource } from "../hooks/useEventSource";
export function EvaluationsPage() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const canCurate =
		selectedProject?.project_role === "admin" ||
		selectedProject?.project_role === "user";
	const canAdmin = selectedProject?.project_role === "admin";
	const datasets = useQuery({
		queryKey: ["datasets", selectedProjectId],
		queryFn: () => listDatasets(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const experiments = useQuery({
		queryKey: ["experiments", selectedProjectId],
		queryFn: () => listExperiments(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const evaluations = useQuery({
		queryKey: ["evaluation-definitions", selectedProjectId, canAdmin],
		queryFn: () => listEvaluations(selectedProjectId!, canAdmin),
		enabled: Boolean(selectedProjectId),
	});
	const legacyLinks = useQuery({
		queryKey: ["evaluation-compatibility", selectedProjectId],
		queryFn: () => listEvaluationLegacyLinks(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const [definitionDatasetId, setDefinitionDatasetId] = React.useState("");
	const [definitionDatasetVersionId, setDefinitionDatasetVersionId] =
		React.useState("");
	const [runEvaluationSlug, setRunEvaluationSlug] = React.useState("");
	const [runDefinitionVersion, setRunDefinitionVersion] = React.useState("");
	const [runIdempotencyKey, setRunIdempotencyKey] = React.useState<
		string | null
	>(null);
	React.useEffect(() => {
		setDefinitionDatasetId("");
		setDefinitionDatasetVersionId("");
		setRunEvaluationSlug("");
		setRunDefinitionVersion("");
		setRunIdempotencyKey(null);
	}, [selectedProjectId]);
	const selectedDefinitionDataset = datasets.data?.items.find(
		(dataset) => dataset.id === definitionDatasetId,
	);
	const selectedRunEvaluation = evaluations.data?.items.find(
		(evaluation) => evaluation.slug === runEvaluationSlug,
	);
	const runVersions = useQuery({
		queryKey: ["run-evaluation-versions", selectedProjectId, runEvaluationSlug],
		queryFn: () =>
			listEvaluationVersions({
				project_id: selectedProjectId!,
				slug: runEvaluationSlug,
			}),
		enabled: Boolean(selectedProjectId && selectedRunEvaluation),
	});
	const runVersionNumber = Number(runDefinitionVersion);
	const runDefinition = useQuery({
		queryKey: [
			"run-evaluation-version",
			selectedProjectId,
			runEvaluationSlug,
			runVersionNumber,
		],
		queryFn: () =>
			getEvaluationVersion({
				project_id: selectedProjectId!,
				slug: runEvaluationSlug,
				version: runVersionNumber,
			}),
		enabled: Boolean(
			selectedProjectId &&
				selectedRunEvaluation &&
				Number.isInteger(runVersionNumber) &&
				runVersionNumber > 0,
		),
	});
	const selectedDefinitionVersions = useQuery({
		queryKey: [
			"dataset-versions",
			selectedProjectId,
			selectedDefinitionDataset?.slug,
		],
		queryFn: () =>
			listDatasetVersions({
				project_id: selectedProjectId!,
				slug: selectedDefinitionDataset!.slug,
			}),
		enabled: Boolean(selectedProjectId && selectedDefinitionDataset),
	});
	const [evaluationName, setEvaluationName] = React.useState("");
	const [evaluationSlug, setEvaluationSlug] = React.useState("");
	const [definitionPending, setDefinitionPending] = React.useState(false);
	const [definitionError, setDefinitionError] = React.useState("");
	const [definitionModel, setDefinitionModel] = React.useState("");
	const [definitionSystemPrompt, setDefinitionSystemPrompt] =
		React.useState("");
	const [definitionEvaluator, setDefinitionEvaluator] =
		React.useState("exact_match");
	const [definitionTemperature, setDefinitionTemperature] = React.useState("0");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [lifecycleError, setLifecycleError] = React.useState("");
	const [pendingLifecycleSlug, setPendingLifecycleSlug] = React.useState<
		string | null
	>(null);
	const [tombstoneEvaluationSlug, setTombstoneEvaluationSlug] = React.useState<
		string | null
	>(null);
	const [tombstoneConfirmation, setTombstoneConfirmation] = React.useState("");
	const selectedRunValid = Boolean(
		selectedRunEvaluation &&
			runDefinition.data?.definition_contract === "v1" &&
			!runDefinition.isError,
	);
	const selectedDefinitionDatasetVersion = Boolean(
		selectedDefinitionVersions.data?.items.some(
			(item) => item.id === definitionDatasetVersionId,
		),
	);
	if (!selectedProject)
		return (
			<PageMessage title="Evaluations">
				Select a project to run evaluations.
			</PageMessage>
		);
	function selectDefinitionDataset(value: string) {
		setDefinitionDatasetId(value);
		setDefinitionDatasetVersionId("");
	}
	async function run() {
		if (
			!canCurate ||
			!selectedRunValid ||
			!runEvaluationSlug ||
			!Number.isInteger(runVersionNumber) ||
			pending
		)
			return;
		try {
			setError("");
			setPending(true);
			await startEvaluationRun({
				project_id: selectedProjectId!,
				slug: runEvaluationSlug,
				definition_version: runVersionNumber,
				idempotency_key:
					runIdempotencyKey ??
					(() => {
						const key = crypto.randomUUID();
						setRunIdempotencyKey(key);
						return key;
					})(),
			});
			setRunIdempotencyKey(null);
			await client.invalidateQueries({
				queryKey: ["experiments", selectedProjectId],
			});
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	async function define() {
		if (
			!canCurate ||
			!definitionDatasetVersionId ||
			!selectedDefinitionDatasetVersion ||
			!evaluationName ||
			!evaluationSlug ||
			definitionPending
		)
			return;
		try {
			setDefinitionError("");
			setDefinitionPending(true);
			await createEvaluation({
				project_id: selectedProjectId!,
				slug: evaluationSlug,
				name: evaluationName,
				definition: {
					dataset_version_id: definitionDatasetVersionId,
					sampling: { strategy: "first_n", sample_size: 100, seed: 0 },
					evaluator: {
						kind: definitionEvaluator as "exact_match" | "contains",
						version: "v1",
						expected_output_path: "$.expected_output",
						output_path: "$.output",
					},
					target: {
						kind: "configured_llm",
						model: definitionModel || null,
						system_prompt: definitionSystemPrompt || null,
					},
					execution_defaults: {
						temperature: Number(definitionTemperature),
						max_tokens: null,
					},
					limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
					thresholds: { minimum_pass_rate: null },
				},
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-definitions", selectedProjectId],
			});
			setEvaluationName("");
			setEvaluationSlug("");
			setDefinitionDatasetVersionId("");
		} catch (cause) {
			setDefinitionError((cause as Error).message);
		} finally {
			setDefinitionPending(false);
		}
	}
	async function archive(evaluation: {
		slug: string;
		lifecycle_revision: number;
	}) {
		if (!canAdmin || pendingLifecycleSlug) return;
		try {
			setLifecycleError("");
			setPendingLifecycleSlug(evaluation.slug);
			await archiveEvaluation({
				project_id: selectedProjectId!,
				slug: evaluation.slug,
				revision: evaluation.lifecycle_revision,
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-definitions", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingLifecycleSlug(null);
		}
	}
	async function restore(evaluation: {
		slug: string;
		lifecycle_revision: number;
	}) {
		if (!canAdmin || pendingLifecycleSlug) return;
		try {
			setLifecycleError("");
			setPendingLifecycleSlug(evaluation.slug);
			await restoreEvaluation({
				project_id: selectedProjectId!,
				slug: evaluation.slug,
				revision: evaluation.lifecycle_revision,
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-definitions", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingLifecycleSlug(null);
		}
	}
	async function tombstone(evaluation: {
		slug: string;
		lifecycle_revision: number;
	}) {
		if (!canAdmin || pendingLifecycleSlug) return;
		try {
			setLifecycleError("");
			setPendingLifecycleSlug(evaluation.slug);
			await tombstoneEvaluation({
				project_id: selectedProjectId!,
				slug: evaluation.slug,
				revision: evaluation.lifecycle_revision,
				confirmation_slug: tombstoneConfirmation,
			});
			setTombstoneEvaluationSlug(null);
			setTombstoneConfirmation("");
			await client.invalidateQueries({
				queryKey: ["evaluation-definitions", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingLifecycleSlug(null);
		}
	}
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Evaluations</h1>
				<p className="text-sm text-muted-foreground">
					Configured LLM runs against a dataset.
				</p>
			</div>
			<section className="grid gap-2 rounded border p-4">
				<h2 className="text-lg font-medium">Reusable definition</h2>
				{canCurate ? (
					<>
						<p className="text-sm text-muted-foreground">
							Create a revisioned draft against an immutable Dataset Version,
							then publish it separately. It does not start a run.
						</p>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-dataset"
						>
							Definition dataset
							<Select
								id="evaluation-definition-dataset"
								value={definitionDatasetId}
								onChange={(event) =>
									selectDefinitionDataset(event.target.value)
								}
							>
								<option value="">Choose dataset</option>
								{datasets.data?.items.map((dataset) => (
									<option key={dataset.id} value={dataset.id}>
										{dataset.name}
									</option>
								))}
							</Select>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-name"
						>
							Definition name
							<Input
								id="evaluation-definition-name"
								value={evaluationName}
								onChange={(event) => setEvaluationName(event.target.value)}
							/>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-dataset-version"
						>
							Dataset Version
							<Select
								id="evaluation-definition-dataset-version"
								value={definitionDatasetVersionId}
								onChange={(event) =>
									setDefinitionDatasetVersionId(event.target.value)
								}
							>
								<option value="">Choose immutable Dataset Version</option>
								{selectedDefinitionVersions.data?.items.map((item) => (
									<option key={item.id} value={item.id}>
										Version {item.version}
									</option>
								))}
							</Select>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-slug"
						>
							Stable ID
							<Input
								id="evaluation-definition-slug"
								value={evaluationSlug}
								onChange={(event) => setEvaluationSlug(event.target.value)}
								pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
							/>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-model"
						>
							Definition model (optional)
							<Input
								id="evaluation-definition-model"
								value={definitionModel}
								onChange={(event) => setDefinitionModel(event.target.value)}
							/>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-system-prompt"
						>
							Definition system prompt (optional)
							<Input
								id="evaluation-definition-system-prompt"
								value={definitionSystemPrompt}
								onChange={(event) =>
									setDefinitionSystemPrompt(event.target.value)
								}
							/>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-evaluator"
						>
							Definition evaluator
							<Select
								id="evaluation-definition-evaluator"
								value={definitionEvaluator}
								onChange={(event) => setDefinitionEvaluator(event.target.value)}
							>
								<option value="exact_match">Exact match</option>
								<option value="contains">Contains</option>
							</Select>
						</label>
						<label
							className="block space-y-2 text-sm"
							htmlFor="evaluation-definition-temperature"
						>
							Definition temperature
							<Input
								id="evaluation-definition-temperature"
								type="number"
								min="0"
								max="2"
								step="0.1"
								value={definitionTemperature}
								onChange={(event) =>
									setDefinitionTemperature(event.target.value)
								}
							/>
						</label>
						{selectedDefinitionVersions.isError && (
							<p className="text-sm text-destructive" role="alert">
								Unable to load Dataset Versions.{" "}
								<Button
									variant="outline"
									size="sm"
									onClick={() => void selectedDefinitionVersions.refetch()}
								>
									Retry
								</Button>
							</p>
						)}
						{selectedDefinitionDataset &&
							!selectedDefinitionVersions.isError &&
							!selectedDefinitionVersions.data?.items.length && (
								<p className="text-sm text-destructive">
									Publish a Dataset Version before creating a reusable
									definition.
								</p>
							)}
						{definitionError && (
							<p className="text-sm text-destructive" role="alert">
								{definitionError}
							</p>
						)}
						<Button
							disabled={
								selectedDefinitionVersions.isLoading ||
								(!selectedDefinitionVersions.isError &&
									!selectedDefinitionVersions.data?.items.length) ||
								!selectedDefinitionDatasetVersion ||
								!evaluationName ||
								!evaluationSlug ||
								definitionPending
							}
							onClick={() => void define()}
						>
							{definitionPending ? "Creating..." : "Create definition draft"}
						</Button>
					</>
				) : (
					<p className="text-sm text-muted-foreground">
						Read-only project access can inspect published definitions and
						version history.
					</p>
				)}
				{evaluations.data?.items.length ? (
					<ul
						className="space-y-1 text-sm"
						aria-label="Published evaluation definitions"
					>
						{evaluations.data.items.map((item) => (
							<li key={item.id} className="space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									{item.tombstoned_at ? (
										<>
											<strong>{item.name}</strong>
											<span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
												Tombstoned
											</span>
											<span className="text-muted-foreground">
												({item.slug})
											</span>
										</>
									) : item.archived_at ? (
										<>
											<strong>{item.name}</strong>
											<span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
												Archived
											</span>
											<span className="text-muted-foreground">
												({item.slug})
											</span>
										</>
									) : (
										<>
											<Link
												className="font-medium underline"
												to="/evaluation-definitions/$slug"
												params={{ slug: item.slug }}
											>
												{item.name}
											</Link>
											<span className="text-muted-foreground">
												({item.slug})
											</span>
										</>
									)}
									{canAdmin && !item.tombstoned_at && (
										<div className="flex flex-wrap items-center gap-2">
											{item.archived_at ? (
												<>
													<Button
														size="sm"
														variant="outline"
														disabled={pendingLifecycleSlug !== null}
														onClick={() => void restore(item)}
													>
														{pendingLifecycleSlug === item.slug
															? "Restoring..."
															: "Restore"}
													</Button>
													<Button
														size="sm"
														variant="destructive"
														disabled={pendingLifecycleSlug !== null}
														onClick={() => {
															setTombstoneEvaluationSlug(item.slug);
															setTombstoneConfirmation("");
														}}
													>
														Tombstone
													</Button>
												</>
											) : (
												<Button
													size="sm"
													variant="outline"
													disabled={pendingLifecycleSlug !== null}
													onClick={() => void archive(item)}
												>
													{pendingLifecycleSlug === item.slug
														? "Archiving..."
														: "Archive"}
												</Button>
											)}
										</div>
									)}
								</div>
								{item.tombstoned_at && (
									<p className="text-sm text-muted-foreground">
										Terminal state. Definition Versions and audit evidence are
										retained but are not enumerable or directly readable.
									</p>
								)}
								{canAdmin && tombstoneEvaluationSlug === item.slug && (
									<div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
										<label className="sr-only" htmlFor={`tombstone-${item.id}`}>
											Confirm Evaluation stable ID
										</label>
										<Input
											id={`tombstone-${item.id}`}
											value={tombstoneConfirmation}
											onChange={(event) =>
												setTombstoneConfirmation(event.target.value)
											}
											placeholder={`Type ${item.slug} to permanently tombstone`}
										/>
										<Button
											size="sm"
											variant="destructive"
											disabled={
												pendingLifecycleSlug !== null ||
												tombstoneConfirmation !== item.slug
											}
											onClick={() => void tombstone(item)}
										>
											Permanently tombstone
										</Button>
									</div>
								)}
								{!item.archived_at && !item.tombstoned_at && (
									<>
										<EvaluationVersionInspection
											projectId={selectedProjectId!}
											slug={item.slug}
										/>
										<EvaluationDraftAuthoring
											canCurate={canCurate}
											projectId={selectedProjectId!}
											slug={item.slug}
										/>
									</>
								)}
							</li>
						))}
					</ul>
				) : null}
				{lifecycleError && (
					<p className="text-sm text-destructive" role="alert">
						{lifecycleError}
					</p>
				)}
				{legacyLinks.data?.items.length ? (
					<div
						className="space-y-1 text-sm"
						aria-label="Legacy evaluation compatibility"
					>
						<p className="font-medium">Legacy compatibility</p>
						{legacyLinks.data.items.map((link) => (
							<p key={`${link.legacy_kind}-${link.legacy_id}`}>
								{link.legacy_kind === "experiment"
									? "Experiment"
									: "Benchmark suite"}
								: {link.compatibility}
							</p>
						))}
					</div>
				) : null}
			</section>
			{canCurate && (
				<section className="grid gap-3 rounded border p-4">
					<h2 className="text-lg font-medium">Start pinned evaluation run</h2>
					<label className="block space-y-2 text-sm" htmlFor="run-evaluation">
						Evaluation
						<Select
							id="run-evaluation"
							value={runEvaluationSlug}
							onChange={(event) => {
								setRunEvaluationSlug(event.target.value);
								setRunDefinitionVersion("");
							}}
						>
							<option value="">Choose Evaluation</option>
							{evaluations.data?.items
								.filter((item) => !item.archived_at && !item.tombstoned_at)
								.map((item) => (
									<option key={item.id} value={item.slug}>
										{item.name} ({item.slug})
									</option>
								))}
						</Select>
					</label>
					<label
						className="block space-y-2 text-sm"
						htmlFor="run-definition-version"
					>
						Immutable Definition Version
						<Select
							id="run-definition-version"
							value={runDefinitionVersion}
							disabled={!selectedRunEvaluation || runVersions.isLoading}
							onChange={(event) => setRunDefinitionVersion(event.target.value)}
						>
							<option value="">Choose version</option>
							{runVersions.data?.items.map((item) => (
								<option key={item.id} value={item.version}>
									Version {item.version} ({item.definition_contract})
								</option>
							))}
						</Select>
					</label>
					{runDefinition.data && (
						<div
							className="rounded bg-muted/40 p-3 text-sm"
							aria-label="Pinned run inputs"
						>
							<p className="font-medium">
								Pinned Definition Version {runDefinition.data.version}
							</p>
							<p>Dataset Version: {runDefinition.data.dataset_version_id}</p>
							<p>
								Sampling:{" "}
								{runDefinition.data.sampling?.strategy ?? "unavailable"} /{" "}
								{runDefinition.data.sampling?.sample_size ?? "unavailable"}{" "}
								items
							</p>
						</div>
					)}
					{runDefinition.isError && (
						<p className="text-sm text-destructive" role="alert">
							Unable to load the selected immutable Definition Version.{" "}
							<Button
								variant="outline"
								size="sm"
								onClick={() => void runDefinition.refetch()}
							>
								Retry
							</Button>
						</p>
					)}
					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					<Button
						disabled={!selectedRunValid || pending}
						onClick={() => void run()}
					>
						{pending ? "Starting..." : "Run evaluation"}
					</Button>
				</section>
			)}
			{(datasets.isError ||
				experiments.isError ||
				evaluations.isError ||
				legacyLinks.isError) && (
				<PageMessage title="Evaluations">
					Unable to load evaluations.{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							void Promise.all([
								datasets.refetch(),
								experiments.refetch(),
								evaluations.refetch(),
								legacyLinks.refetch(),
							])
						}
					>
						Retry
					</Button>
				</PageMessage>
			)}
			{experiments.isLoading && !experiments.data ? (
				<ListLoadingSkeleton testId="evaluations-list-skeleton" />
			) : (
				<ul className="divide-y rounded border">
					{experiments.data?.items.map((experiment) => (
						<li key={experiment.id}>
							<Link
								className="block p-4 hover:bg-muted/50"
								to="/evaluations/$id"
								params={{ id: experiment.id }}
							>
								<strong>{experiment.name || "Untitled evaluation"}</strong>
								<span className="ml-3 text-sm text-muted-foreground">
									{experiment.status}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
function EvaluationVersionInspection({
	projectId,
	slug,
}: {
	projectId: string;
	slug: string;
}) {
	const [selectedVersion, setSelectedVersion] = React.useState<number>();
	const versions = useQuery({
		queryKey: ["evaluation-versions", projectId, slug],
		queryFn: () => listEvaluationVersions({ project_id: projectId, slug }),
	});
	const latest = versions.data?.items[0];
	React.useEffect(() => {
		if (selectedVersion === undefined && latest)
			setSelectedVersion(latest.version);
	}, [latest, selectedVersion]);
	const version = selectedVersion;
	const detail = useQuery({
		queryKey: ["evaluation-version", projectId, slug, version],
		queryFn: () =>
			getEvaluationVersion({
				project_id: projectId,
				slug,
				version: version!,
			}),
		enabled: Boolean(version),
	});
	if (versions.isError || detail.isError)
		return (
			<p className="text-destructive" role="alert">
				Unable to load immutable version.{" "}
				<Button
					variant="outline"
					size="sm"
					onClick={() =>
						void Promise.all([versions.refetch(), detail.refetch()])
					}
				>
					Retry
				</Button>
			</p>
		);
	if (!latest) return null;
	return (
		<div className="space-y-2 text-muted-foreground">
			<div
				className="flex flex-wrap gap-1"
				aria-label="Evaluation definition versions"
			>
				{versions.data?.items.map((item) => (
					<div key={item.id} className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setSelectedVersion(item.version)}
						>
							Version {item.version}
						</Button>
						<span className="text-xs">Published by {item.published_by}</span>
					</div>
				))}
			</div>
			{detail.data && (
				<pre className="overflow-auto rounded border p-2 text-xs">
					{JSON.stringify(detail.data, null, 2)}
				</pre>
			)}
		</div>
	);
}
function EvaluationDraftAuthoring({
	canCurate,
	projectId,
	slug,
}: {
	canCurate: boolean;
	projectId: string;
	slug: string;
}) {
	const client = useQueryClient();
	const draft = useQuery({
		queryKey: ["evaluation-draft", projectId, slug],
		queryFn: () => getEvaluationDraft({ project_id: projectId, slug }),
	});
	const [model, setModel] = React.useState("");
	const [systemPrompt, setSystemPrompt] = React.useState("");
	const [datasetVersion, setDatasetVersion] = React.useState("");
	const [sampleSize, setSampleSize] = React.useState("100");
	const [seed, setSeed] = React.useState("0");
	const [evaluator, setEvaluator] = React.useState<"exact_match" | "contains">(
		"exact_match",
	);
	const [expectedOutputPath, setExpectedOutputPath] =
		React.useState("$.expected_output");
	const [outputPath, setOutputPath] = React.useState("$.output");
	const [temperature, setTemperature] = React.useState("0");
	const [maxTokens, setMaxTokens] = React.useState("");
	const [maxCost, setMaxCost] = React.useState("10");
	const [maxDuration, setMaxDuration] = React.useState("3600");
	const [minimumPassRate, setMinimumPassRate] = React.useState("");
	const [publishing, setPublishing] = React.useState(false);
	const [error, setError] = React.useState("");
	const [saving, setSaving] = React.useState(false);
	React.useEffect(() => {
		if (!draft.data) return;
		if (draft.data.definition_contract === "legacy_incomplete") {
			const value = (field: Record<string, unknown>, key: string) => field[key];
			setModel(
				typeof value(draft.data.target, "model") === "string"
					? (value(draft.data.target, "model") as string)
					: "",
			);
			setSystemPrompt(
				typeof value(draft.data.target, "system_prompt") === "string"
					? (value(draft.data.target, "system_prompt") as string)
					: "",
			);
			setDatasetVersion(draft.data.dataset_version_id);
			setSampleSize(
				typeof value(draft.data.sampling, "sample_size") === "number"
					? String(value(draft.data.sampling, "sample_size"))
					: "",
			);
			setSeed(
				typeof value(draft.data.sampling, "seed") === "number"
					? String(value(draft.data.sampling, "seed"))
					: "",
			);
			setEvaluator(
				value(draft.data.evaluator, "kind") === "contains"
					? "contains"
					: "exact_match",
			);
			setExpectedOutputPath(
				typeof value(draft.data.evaluator, "expected_output_path") === "string"
					? (value(draft.data.evaluator, "expected_output_path") as string)
					: "",
			);
			setOutputPath(
				typeof value(draft.data.evaluator, "output_path") === "string"
					? (value(draft.data.evaluator, "output_path") as string)
					: "",
			);
			setTemperature(
				typeof value(draft.data.execution_defaults, "temperature") === "number"
					? String(value(draft.data.execution_defaults, "temperature"))
					: "",
			);
			setMaxTokens(
				typeof value(draft.data.execution_defaults, "max_tokens") === "number"
					? String(value(draft.data.execution_defaults, "max_tokens"))
					: "",
			);
			setMaxCost(
				typeof value(draft.data.limits, "max_cost_usd") === "number"
					? String(value(draft.data.limits, "max_cost_usd"))
					: "",
			);
			setMaxDuration(
				typeof value(draft.data.limits, "max_duration_seconds") === "number"
					? String(value(draft.data.limits, "max_duration_seconds"))
					: "",
			);
			setMinimumPassRate(
				typeof value(draft.data.thresholds, "minimum_pass_rate") === "number"
					? String(value(draft.data.thresholds, "minimum_pass_rate"))
					: "",
			);
			return;
		}
		setModel(draft.data.target.model ?? "");
		setSystemPrompt(draft.data.target.system_prompt ?? "");
		setDatasetVersion(draft.data.dataset_version_id);
		setSampleSize(String(draft.data.sampling.sample_size));
		setSeed(String(draft.data.sampling.seed));
		setEvaluator(draft.data.evaluator.kind);
		setExpectedOutputPath(draft.data.evaluator.expected_output_path);
		setOutputPath(draft.data.evaluator.output_path);
		setTemperature(String(draft.data.execution_defaults.temperature));
		setMaxTokens(draft.data.execution_defaults.max_tokens?.toString() ?? "");
		setMaxCost(String(draft.data.limits.max_cost_usd));
		setMaxDuration(String(draft.data.limits.max_duration_seconds));
		setMinimumPassRate(
			draft.data.thresholds.minimum_pass_rate?.toString() ?? "",
		);
	}, [draft.data]);
	if (draft.isError)
		return (
			<p className="text-destructive" role="alert">
				Unable to load draft.{" "}
				<Button
					variant="outline"
					size="sm"
					onClick={() => void draft.refetch()}
				>
					Retry
				</Button>
			</p>
		);
	if (!draft.data) return null;
	if (!canCurate)
		return (
			<div className="grid gap-2 rounded border p-3">
				<p className="text-sm font-medium">
					Definition draft (revision {draft.data.revision})
				</p>
				<p className="text-sm text-muted-foreground">
					Read-only project access cannot edit or publish definition drafts.
				</p>
			</div>
		);
	async function save() {
		if (!canCurate || saving) return;
		try {
			setError("");
			setSaving(true);
			const definition = {
				dataset_version_id: datasetVersion,
				sampling: {
					strategy: "first_n" as const,
					sample_size: Number(sampleSize),
					seed: Number(seed),
				},
				evaluator: {
					kind: evaluator,
					version: "v1" as const,
					expected_output_path: expectedOutputPath,
					output_path: outputPath,
				},
				target: {
					kind: "configured_llm" as const,
					model: model || null,
					system_prompt: systemPrompt || null,
				},
				execution_defaults: {
					temperature: Number(temperature),
					max_tokens: maxTokens ? Number(maxTokens) : null,
				},
				limits: {
					max_cost_usd: Number(maxCost),
					max_duration_seconds: Number(maxDuration),
				},
				thresholds: {
					minimum_pass_rate: minimumPassRate ? Number(minimumPassRate) : null,
				},
			};
			await updateEvaluationDraft({
				project_id: projectId,
				slug,
				revision: draft.data!.revision,
				definition,
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-draft", projectId, slug],
			});
		} catch (cause) {
			setError(
				(cause as Error).message.includes("revision")
					? "This draft changed elsewhere. Reload it before saving."
					: (cause as Error).message,
			);
		} finally {
			setSaving(false);
		}
	}
	async function publish() {
		if (!canCurate || saving || publishing) return;
		try {
			setError("");
			setPublishing(true);
			await publishEvaluationDraft({
				project_id: projectId,
				slug,
				revision: draft.data!.revision,
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-versions", projectId, slug],
			});
		} catch (cause) {
			setError(
				(cause as Error).message.includes("revision")
					? "This draft changed elsewhere. Reload it before publishing."
					: (cause as Error).message,
			);
		} finally {
			setPublishing(false);
		}
	}
	return (
		<div className="grid gap-3 rounded border p-3">
			<p className="text-sm font-medium">
				Definition draft (revision {draft.data.revision})
			</p>
			{draft.data.definition_contract === "legacy_incomplete" && (
				<p className="text-sm text-muted-foreground">
					This upgraded draft is incomplete. Review and save a complete
					definition before publishing.
				</p>
			)}
			<label
				className="block space-y-2 text-sm"
				htmlFor={`evaluation-draft-dataset-${slug}`}
			>
				Dataset Version ID
				<Input
					id={`evaluation-draft-dataset-${slug}`}
					value={datasetVersion}
					onChange={(event) => setDatasetVersion(event.target.value)}
				/>
			</label>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="block space-y-2 text-sm">
					Sample size
					<Input
						type="number"
						min="1"
						value={sampleSize}
						onChange={(event) => setSampleSize(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Deterministic seed
					<Input
						type="number"
						min="0"
						value={seed}
						onChange={(event) => setSeed(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Evaluator
					<Select
						value={evaluator}
						onChange={(event) =>
							setEvaluator(event.target.value as "exact_match" | "contains")
						}
					>
						<option value="exact_match">Exact match v1</option>
						<option value="contains">Contains v1</option>
					</Select>
				</label>
				<label className="block space-y-2 text-sm">
					Expected output path
					<Input
						value={expectedOutputPath}
						onChange={(event) => setExpectedOutputPath(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Output path
					<Input
						value={outputPath}
						onChange={(event) => setOutputPath(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Temperature
					<Input
						type="number"
						min="0"
						max="2"
						step="0.1"
						value={temperature}
						onChange={(event) => setTemperature(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Max tokens (optional)
					<Input
						type="number"
						min="1"
						value={maxTokens}
						onChange={(event) => setMaxTokens(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Cost limit (USD)
					<Input
						type="number"
						min="0.01"
						step="0.01"
						value={maxCost}
						onChange={(event) => setMaxCost(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Duration limit (seconds)
					<Input
						type="number"
						min="1"
						value={maxDuration}
						onChange={(event) => setMaxDuration(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Minimum pass rate (optional)
					<Input
						type="number"
						min="0"
						max="1"
						step="0.01"
						value={minimumPassRate}
						onChange={(event) => setMinimumPassRate(event.target.value)}
					/>
				</label>
			</div>
			<label
				className="block space-y-2 text-sm"
				htmlFor={`evaluation-draft-model-${slug}`}
			>
				Draft model
				<Input
					id={`evaluation-draft-model-${slug}`}
					value={model}
					onChange={(event) => setModel(event.target.value)}
				/>
			</label>
			<label
				className="block space-y-2 text-sm"
				htmlFor={`evaluation-draft-system-${slug}`}
			>
				System prompt (optional)
				<Input
					id={`evaluation-draft-system-${slug}`}
					value={systemPrompt}
					onChange={(event) => setSystemPrompt(event.target.value)}
				/>
			</label>
			{error && (
				<p className="text-destructive" role="alert">
					{error}{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() => void draft.refetch()}
					>
						Reload
					</Button>
				</p>
			)}
			<Button
				variant="outline"
				size="sm"
				disabled={saving}
				onClick={() => void save()}
			>
				{saving ? "Saving..." : "Save draft"}
			</Button>
			<Button
				size="sm"
				disabled={saving || publishing}
				onClick={() => void publish()}
			>
				{publishing ? "Publishing..." : "Publish immutable version"}
			</Button>
		</div>
	);
}
export function EvaluationDetailPage() {
	const { id } = useParams({ from: "/protected/evaluations/$id" });
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const canCurate =
		selectedProject?.project_role === "admin" ||
		selectedProject?.project_role === "user";
	const experiment = useQuery({
		queryKey: ["experiment", selectedProjectId, id],
		queryFn: () => getExperiment({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const results = useQuery({
		queryKey: ["experiment-results", selectedProjectId, id],
		queryFn: () => experimentResults({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const summary = useQuery({
		queryKey: ["experiment-summary", selectedProjectId, id],
		queryFn: () => experimentSummary({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const active = ["pending", "running"].includes(experiment.data?.status ?? "");
	useEventSource(
		selectedProjectId
			? experimentEventsUrl({ project_id: selectedProjectId, id })
			: "about:blank",
		{
			enabled: Boolean(selectedProjectId) && (!experiment.data || active),
			onMessage: (event) => {
				if (event.event !== "experiment") return;
				const update = event.data as import("../lib/api").Experiment;
				client.setQueryData(["experiment", selectedProjectId, id], update);
				void client.invalidateQueries({
					queryKey: ["experiment-results", selectedProjectId, id],
				});
				void client.invalidateQueries({
					queryKey: ["experiment-summary", selectedProjectId, id],
				});
			},
		},
	);
	const [cancelError, setCancelError] = React.useState("");
	const [cancelling, setCancelling] = React.useState(false);
	if (experiment.isLoading && !experiment.data)
		return <DetailLoadingSkeleton testId="evaluation-detail-skeleton" />;
	if (experiment.isError)
		return (
			<PageMessage title="Evaluation">
				Unable to load evaluation.{" "}
				<Button
					variant="outline"
					size="sm"
					onClick={() => void experiment.refetch()}
				>
					Retry
				</Button>
			</PageMessage>
		);
	if (!experiment.data) return null;
	async function cancel() {
		if (!canCurate || cancelling) return;
		try {
			setCancelError("");
			setCancelling(true);
			await cancelExperiment({ project_id: selectedProjectId!, id });
			await client.invalidateQueries({
				queryKey: ["experiment", selectedProjectId, id],
			});
		} catch (cause) {
			setCancelError((cause as Error).message);
		} finally {
			setCancelling(false);
		}
	}
	return (
		<div className="space-y-5">
			<Link className="text-sm underline" to="/evaluations">
				Evaluations
			</Link>
			<h1 className="text-2xl font-semibold">
				{experiment.data.name || "Evaluation"}
			</h1>
			<p>Status: {experiment.data.status}</p>
			<Link
				className="underline"
				to="/datasets/$id"
				params={{ id: experiment.data.dataset_id }}
			>
				Source dataset
			</Link>
			{active && canCurate && (
				<Button
					className="ml-3"
					variant="outline"
					disabled={cancelling}
					onClick={() => void cancel()}
				>
					{cancelling ? "Cancelling..." : "Cancel"}
				</Button>
			)}
			{cancelError && (
				<p className="text-sm text-destructive" role="alert">
					{cancelError}
				</p>
			)}
			{summary.data && (
				<p>
					{summary.data.passed} / {summary.data.total} passed (
					{Math.round(summary.data.pass_rate * 100)}%)
				</p>
			)}
			{results.isError && (
				<p className="text-sm text-destructive">
					Unable to load results.{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() => void results.refetch()}
					>
						Retry
					</Button>
				</p>
			)}
			{summary.isError && (
				<p className="text-sm text-destructive">
					Unable to load summary.{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() => void summary.refetch()}
					>
						Retry
					</Button>
				</p>
			)}
			<ul className="space-y-2">
				{results.data?.items.map((result) => (
					<li key={result.id} className="rounded border p-3">
						<span>{result.status}</span>
						<pre className="mt-2 overflow-auto text-xs">
							{JSON.stringify(result.output, null, 2)}
						</pre>
					</li>
				))}
			</ul>
		</div>
	);
}
export function EvaluationDefinitionDetailPage() {
	const { slug } = useParams({
		from: "/protected/evaluation-definitions/$slug",
	});
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const canCurate =
		selectedProject?.project_role === "admin" ||
		selectedProject?.project_role === "user";
	const detail = useQuery({
		queryKey: ["evaluation", selectedProjectId, slug],
		queryFn: () => getEvaluation({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	const versions = useQuery({
		queryKey: ["evaluation-versions", selectedProjectId, slug],
		queryFn: () =>
			listEvaluationVersions({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	const draft = useQuery({
		queryKey: ["evaluation-draft", selectedProjectId, slug],
		queryFn: () => getEvaluationDraft({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	if (detail.isLoading && !detail.data)
		return (
			<DetailLoadingSkeleton testId="evaluation-definition-detail-skeleton" />
		);
	if (detail.isError)
		return (
			<PageMessage title="Evaluation">
				Unable to load evaluation definition.{" "}
				<Button
					variant="outline"
					size="sm"
					onClick={() => void detail.refetch()}
				>
					Retry
				</Button>
			</PageMessage>
		);
	if (!detail.data) return null;
	return (
		<div className="space-y-5">
			<Link className="text-sm underline" to="/evaluations">
				Evaluations
			</Link>
			<div>
				<h1 className="text-2xl font-semibold">{detail.data.name}</h1>
				<p className="text-sm text-muted-foreground">
					Stable ID: {detail.data.slug}
				</p>
			</div>
			{detail.data.description && <p>{detail.data.description}</p>}
			<section
				className="space-y-3 rounded border p-4"
				aria-label="Definition draft"
			>
				<h2 className="text-lg font-medium">Draft</h2>
				{draft.isError ? (
					<p className="text-destructive" role="alert">
						Unable to load draft.{" "}
						<Button
							variant="outline"
							size="sm"
							onClick={() => void draft.refetch()}
						>
							Retry
						</Button>
					</p>
				) : draft.data ? (
					<EvaluationDraftAuthoring
						canCurate={canCurate}
						projectId={selectedProjectId!}
						slug={slug}
					/>
				) : (
					<p className="text-sm text-muted-foreground">Loading draft...</p>
				)}
			</section>
			<section
				className="space-y-3 rounded border p-4"
				aria-label="Immutable definition history"
			>
				<h2 className="text-lg font-medium">Immutable version history</h2>
				{versions.isError ? (
					<p className="text-destructive" role="alert">
						Unable to load immutable version history.{" "}
						<Button
							variant="outline"
							size="sm"
							onClick={() => void versions.refetch()}
						>
							Retry
						</Button>
					</p>
				) : (
					<EvaluationVersionInspection
						projectId={selectedProjectId!}
						slug={slug}
					/>
				)}
			</section>
			<p className="text-sm text-muted-foreground">
				Created {new Date(detail.data.created_at).toLocaleString()}
			</p>
		</div>
	);
}
