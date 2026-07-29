import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	addDatasetItem,
	createDataset,
	deleteDatasetItem,
	getDataset,
	listDatasetItems,
	listDatasets,
} from "../lib/api";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PageMessage } from "./prompts";

export function DatasetsPage() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [error, setError] = React.useState("");
	const query = useQuery({
		queryKey: ["datasets", selectedProjectId],
		queryFn: () => listDatasets(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	if (!selectedProject)
		return (
			<PageMessage title="Datasets">
				Select a project to manage its datasets.
			</PageMessage>
		);
	async function submit() {
		try {
			await createDataset({
				project_id: selectedProjectId!,
				name,
				description,
			});
			setName("");
			setDescription("");
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setError((cause as Error).message);
		}
	}
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Datasets</h1>
				<p className="text-sm text-muted-foreground">{selectedProject.name}</p>
			</div>
			<div className="flex flex-wrap gap-2">
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Dataset name"
					maxLength={120}
				/>
				<Input
					value={description}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="Description"
					maxLength={1000}
				/>
				<Button disabled={!name.trim()} onClick={() => void submit()}>
					New dataset
				</Button>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			{query.isLoading && (
				<PageMessage title="Datasets">Loading datasets...</PageMessage>
			)}
			{query.isError && (
				<PageMessage title="Datasets">
					{(query.error as Error).message}
				</PageMessage>
			)}
			{query.data?.items.length === 0 && (
				<PageMessage title="Datasets">
					No datasets yet. Create one to add JSON cases.
				</PageMessage>
			)}
			<ul className="divide-y rounded border">
				{query.data?.items.map((dataset) => (
					<li key={dataset.id}>
						<Link
							className="block p-4 hover:bg-muted/50"
							to="/datasets/$id"
							params={{ id: dataset.id }}
						>
							<strong>{dataset.name}</strong>
							<span className="ml-3 text-sm text-muted-foreground">
								{dataset.item_count} cases
							</span>
							<p className="text-sm text-muted-foreground">
								{dataset.description}
							</p>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
function parseObject(value: string) {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("JSON must be an object");
	return parsed as Record<string, unknown>;
}
export function DatasetDetailPage() {
	const { id } = useParams({ from: "/protected/datasets/$id" });
	const { selectedProjectId } = useProjectSelection();
	const client = useQueryClient();
	const dataset = useQuery({
		queryKey: ["dataset", selectedProjectId, id],
		queryFn: () => getDataset({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const items = useQuery({
		queryKey: ["dataset-items", selectedProjectId, id],
		queryFn: () => listDatasetItems({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const [input, setInput] = React.useState("{}");
	const [expected, setExpected] = React.useState("");
	const [metadata, setMetadata] = React.useState("{}");
	const [error, setError] = React.useState("");
	async function add() {
		try {
			await addDatasetItem({
				project_id: selectedProjectId!,
				dataset_id: id,
				input: parseObject(input),
				expected_output: expected.trim() ? parseObject(expected) : null,
				metadata: parseObject(metadata),
			});
			setInput("{}");
			setExpected("");
			setMetadata("{}");
			await client.invalidateQueries({
				queryKey: ["dataset-items", selectedProjectId, id],
			});
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setError((cause as Error).message);
		}
	}
	if (!selectedProjectId)
		return <PageMessage title="Dataset">Select a project.</PageMessage>;
	return (
		<div className="space-y-5">
			<div>
				<Link className="text-sm underline" to="/datasets">
					Datasets
				</Link>
				<h1 className="text-2xl font-semibold">
					{dataset.data?.name ?? "Dataset"}
				</h1>
				<p className="text-sm text-muted-foreground">
					{dataset.data?.description}
				</p>
			</div>
			<section className="space-y-2 rounded border p-4">
				<h2 className="font-semibold">Add JSON case</h2>
				<label className="block text-sm">
					Input
					<textarea
						className="mt-1 min-h-24 w-full rounded border p-2 font-mono text-xs"
						value={input}
						onChange={(event) => setInput(event.target.value)}
					/>
				</label>
				<label className="block text-sm">
					Expected output (optional)
					<textarea
						className="mt-1 min-h-20 w-full rounded border p-2 font-mono text-xs"
						value={expected}
						onChange={(event) => setExpected(event.target.value)}
					/>
				</label>
				<label className="block text-sm">
					Metadata
					<textarea
						className="mt-1 min-h-16 w-full rounded border p-2 font-mono text-xs"
						value={metadata}
						onChange={(event) => setMetadata(event.target.value)}
					/>
				</label>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Button onClick={() => void add()}>Add case</Button>
			</section>
			<ul className="space-y-3">
				{items.data?.items.map((item) => (
					<li key={item.id} className="rounded border p-3">
						<pre className="overflow-auto text-xs">
							{JSON.stringify(item.input, null, 2)}
						</pre>
						{item.expected_output && (
							<pre className="mt-2 overflow-auto text-xs">
								Expected: {JSON.stringify(item.expected_output, null, 2)}
							</pre>
						)}
						<div className="mt-2 flex justify-between text-xs text-muted-foreground">
							{item.source_trace_id && (
								<Link
									className="underline"
									to="/observability/traces/$id"
									params={{ id: item.source_trace_id }}
								>
									Source trace
								</Link>
							)}
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									void deleteDatasetItem({
										project_id: selectedProjectId,
										dataset_id: id,
										item_id: item.id,
									}).then(() =>
										client.invalidateQueries({
											queryKey: ["dataset-items", selectedProjectId, id],
										}),
									)
								}
							>
								Delete
							</Button>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
