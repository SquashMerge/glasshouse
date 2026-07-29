import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	cancelExperiment,
	createExperiment,
	experimentResults,
	getExperiment,
	listDatasetItems,
	listDatasets,
	listExperiments,
} from "../lib/api";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PageMessage } from "./prompts";
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
	const [datasetId, setDatasetId] = React.useState("");
	const selectedItems = useQuery({
		queryKey: ["dataset-items", selectedProjectId, datasetId],
		queryFn: () =>
			listDatasetItems({ project_id: selectedProjectId!, id: datasetId }),
		enabled: Boolean(selectedProjectId && datasetId),
	});
	const [name, setName] = React.useState("");
	const [model, setModel] = React.useState("");
	const [systemPrompt, setSystemPrompt] = React.useState("");
	const [evaluator, setEvaluator] = React.useState("exact_match");
	const [temperature, setTemperature] = React.useState("0");
	const missing =
		selectedItems.data?.items.filter((item) => !item.expected_output).length ??
		0;
	if (!selectedProject)
		return (
			<PageMessage title="Evaluations">
				Select a project to run evaluations.
			</PageMessage>
		);
	async function run() {
		if (!datasetId || missing) return;
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
				<select
					className="h-9 rounded border px-2"
					value={datasetId}
					onChange={(event) => setDatasetId(event.target.value)}
				>
					<option value="">Choose dataset</option>
					{datasets.data?.items.map((dataset) => (
						<option key={dataset.id} value={dataset.id}>
							{dataset.name}
						</option>
					))}
				</select>
				<Input
					placeholder="Evaluation name"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<Input
					placeholder="Model (optional)"
					value={model}
					onChange={(event) => setModel(event.target.value)}
				/>
				<Input
					placeholder="System prompt (optional)"
					value={systemPrompt}
					onChange={(event) => setSystemPrompt(event.target.value)}
				/>
				<select
					className="h-9 rounded border px-2"
					value={evaluator}
					onChange={(event) => setEvaluator(event.target.value)}
				>
					<option value="exact_match">Exact match</option>
					<option value="contains">Contains</option>
				</select>
				<Input
					type="number"
					min="0"
					max="2"
					step="0.1"
					value={temperature}
					onChange={(event) => setTemperature(event.target.value)}
				/>
				{missing > 0 && (
					<p className="text-sm text-destructive">
						{missing} dataset case{missing === 1 ? "" : "s"} need expected
						output before this evaluation can run.
					</p>
				)}
				<Button disabled={!datasetId || missing > 0} onClick={() => void run()}>
					Run evaluation
				</Button>
			</section>
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
		refetchInterval: (query) =>
			["pending", "running"].includes(query.state.data?.status ?? "")
				? 1000
				: false,
	});
	const results = useQuery({
		queryKey: ["experiment-results", selectedProjectId, id],
		queryFn: () => experimentResults({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
		refetchInterval: 1000,
	});
	if (!experiment.data)
		return <PageMessage title="Evaluation">Loading evaluation...</PageMessage>;
	const active = ["pending", "running"].includes(experiment.data.status);
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
					onClick={() =>
						void cancelExperiment({ project_id: selectedProjectId!, id }).then(
							() =>
								client.invalidateQueries({
									queryKey: ["experiment", selectedProjectId, id],
								}),
						)
					}
				>
					Cancel
				</Button>
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
