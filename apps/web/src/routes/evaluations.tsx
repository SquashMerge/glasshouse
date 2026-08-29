import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	cancelExperiment,
	createEvaluation,
	createExperiment,
	experimentEventsUrl,
	experimentResults,
	experimentSummary,
	getExperiment,
	listDatasets,
	listExperiments,
	listEvaluations,
	listDatasetVersions,
	listPublishedDatasetItems,
	publishEvaluationDraft,
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
		queryKey: ["evaluation-definitions", selectedProjectId],
		queryFn: () => listEvaluations(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const [datasetId, setDatasetId] = React.useState("");
	React.useEffect(() => {
		setDatasetId("");
	}, [selectedProjectId]);
	const selectedDataset = datasets.data?.items.find(
		(dataset) => dataset.id === datasetId,
	);
	const selectedItems = useQuery({
		queryKey: ["published-dataset-items", selectedProjectId, datasetId],
		queryFn: () =>
			listPublishedDatasetItems({
				project_id: selectedProjectId!,
				id: datasetId,
			}),
		enabled: Boolean(selectedProjectId && selectedDataset),
	});
	const selectedVersions = useQuery({
		queryKey: ["dataset-versions", selectedProjectId, selectedDataset?.slug],
		queryFn: () =>
			listDatasetVersions({
				project_id: selectedProjectId!,
				slug: selectedDataset!.slug,
			}),
		enabled: Boolean(selectedProjectId && selectedDataset),
	});
	const [evaluationName, setEvaluationName] = React.useState("");
	const [evaluationSlug, setEvaluationSlug] = React.useState("");
	const [definitionPending, setDefinitionPending] = React.useState(false);
	const [definitionError, setDefinitionError] = React.useState("");
	const [name, setName] = React.useState("");
	const [model, setModel] = React.useState("");
	const [systemPrompt, setSystemPrompt] = React.useState("");
	const [evaluator, setEvaluator] = React.useState("exact_match");
	const [temperature, setTemperature] = React.useState("0");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const missing =
		selectedItems.data?.items.filter((item) => !item.expected_output).length ??
		0;
	const selectedItemsValid = Boolean(
		selectedDataset &&
			selectedItems.data &&
			selectedItems.data.items.length > 0 &&
			missing === 0,
	);
	if (!selectedProject)
		return (
			<PageMessage title="Evaluations">
				Select a project to run evaluations.
			</PageMessage>
		);
	async function run() {
		if (!selectedItemsValid || pending) return;
		try {
			setError("");
			setPending(true);
			await createExperiment({
				project_id: selectedProjectId!,
				dataset_id: datasetId,
				name,
				config: {
					...(model ? { model } : {}),
					...(systemPrompt ? { system_prompt: systemPrompt } : {}),
					evaluator,
					temperature: Number(temperature),
				},
			});
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
		const datasetVersion = selectedVersions.data?.items[0];
		if (
			!datasetVersion ||
			!evaluationName ||
			!evaluationSlug ||
			definitionPending
		)
			return;
		try {
			setDefinitionError("");
			setDefinitionPending(true);
			const created = await createEvaluation({
				project_id: selectedProjectId!,
				slug: evaluationSlug,
				name: evaluationName,
				definition: {
					dataset_version_id: datasetVersion.id,
					evaluator: {
						kind: evaluator as "exact_match" | "contains",
						expected_output_path: "$.expected_output",
						output_path: "$.output",
					},
					target: {
						kind: "configured_llm",
						model: model || null,
						system_prompt: systemPrompt || null,
					},
					execution_defaults: {
						temperature: Number(temperature),
						max_tokens: null,
					},
					thresholds: { minimum_pass_rate: null },
				},
			});
			await publishEvaluationDraft({
				project_id: selectedProjectId!,
				id: created.evaluation.id,
				revision: created.draft.revision,
			});
			await client.invalidateQueries({
				queryKey: ["evaluation-definitions", selectedProjectId],
			});
			setEvaluationName("");
			setEvaluationSlug("");
		} catch (cause) {
			setDefinitionError((cause as Error).message);
		} finally {
			setDefinitionPending(false);
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
				<p className="text-sm text-muted-foreground">
					Publishes an immutable definition using the latest available Dataset
					Version. It does not start a run.
				</p>
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
				{selectedDataset && !selectedVersions.data?.items.length && (
					<p className="text-sm text-destructive">
						Publish a Dataset Version before creating a reusable definition.
					</p>
				)}
				{definitionError && (
					<p className="text-sm text-destructive" role="alert">
						{definitionError}
					</p>
				)}
				<Button
					disabled={
						!selectedVersions.data?.items.length ||
						!evaluationName ||
						!evaluationSlug ||
						definitionPending
					}
					onClick={() => void define()}
				>
					{definitionPending
						? "Publishing..."
						: "Create and publish definition"}
				</Button>
				{evaluations.data?.items.length ? (
					<ul
						className="space-y-1 text-sm"
						aria-label="Published evaluation definitions"
					>
						{evaluations.data.items.map((item) => (
							<li key={item.id}>
								{item.name}{" "}
								<span className="text-muted-foreground">({item.slug})</span>
							</li>
						))}
					</ul>
				) : null}
			</section>
			<section className="grid gap-2 rounded border p-4">
				<h2 className="text-lg font-medium">Ad-hoc run</h2>
				<label className="block space-y-2 text-sm" htmlFor="evaluation-dataset">
					Dataset
					<Select
						id="evaluation-dataset"
						value={datasetId}
						onChange={(event) => setDatasetId(event.target.value)}
					>
						<option value="">Choose dataset</option>
						{datasets.data?.items.map((dataset) => (
							<option key={dataset.id} value={dataset.id}>
								{dataset.name}
							</option>
						))}
					</Select>
				</label>
				<label className="block space-y-2 text-sm">
					Evaluation name
					<Input
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					Model (optional)
					<Input
						value={model}
						onChange={(event) => setModel(event.target.value)}
					/>
				</label>
				<label className="block space-y-2 text-sm">
					System prompt (optional)
					<Input
						value={systemPrompt}
						onChange={(event) => setSystemPrompt(event.target.value)}
					/>
				</label>
				<label
					className="block space-y-2 text-sm"
					htmlFor="evaluation-evaluator"
				>
					Evaluator
					<Select
						id="evaluation-evaluator"
						value={evaluator}
						onChange={(event) => setEvaluator(event.target.value)}
					>
						<option value="exact_match">Exact match</option>
						<option value="contains">Contains</option>
					</Select>
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
				{missing > 0 && (
					<p className="text-sm text-destructive">
						{missing} dataset case{missing === 1 ? "" : "s"} need expected
						output before this evaluation can run.
					</p>
				)}
				{selectedDataset && selectedItems.data?.items.length === 0 && (
					<p className="text-sm text-destructive">
						Publish at least one dataset case before this evaluation can run.
					</p>
				)}
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<Button
					disabled={!selectedItemsValid || pending}
					onClick={() => void run()}
				>
					{pending ? "Starting..." : "Run evaluation"}
				</Button>
			</section>
			{(datasets.isError || experiments.isError) && (
				<PageMessage title="Evaluations">
					Unable to load evaluations.{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							void Promise.all([datasets.refetch(), experiments.refetch()])
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
export function EvaluationDetailPage() {
	const { id } = useParams({ from: "/protected/evaluations/$id" });
	const { selectedProjectId } = useProjectSelection();
	const client = useQueryClient();
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
		if (cancelling) return;
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
			{active && (
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
