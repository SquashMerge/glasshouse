import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createDatasetDraft,
	createDataset,
	deleteDatasetDraftItem,
	type DatasetItem,
	getDataset,
	listDatasetItems,
	listDatasets,
	publishDatasetDraft,
	upsertDatasetDraftItem,
} from "../lib/api";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
	DetailLoadingSkeleton,
	ListLoadingSkeleton,
} from "../components/LoadingSkeletons";
import { PageMessage } from "./prompts";

export function DatasetsPage() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
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
		if (pending) return;
		try {
			setError("");
			setPending(true);
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
		} finally {
			setPending(false);
		}
	}
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Datasets</h1>
				<p className="text-sm text-muted-foreground">{selectedProject.name}</p>
			</div>
			<div className="flex flex-wrap gap-2">
				<label className="sr-only" htmlFor="dataset-name">
					Dataset name
				</label>
				<Input
					id="dataset-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Dataset name"
					maxLength={120}
				/>
				<label className="sr-only" htmlFor="dataset-description">
					Description
				</label>
				<Input
					id="dataset-description"
					value={description}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="Description"
					maxLength={1000}
				/>
				<Button
					disabled={!name.trim() || pending}
					onClick={() => void submit()}
				>
					{pending ? "Creating..." : "New dataset"}
				</Button>
			</div>
			{error && (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			)}
			{query.isLoading && !query.data && (
				<ListLoadingSkeleton testId="dataset-list-skeleton" />
			)}
			{query.isError && (
				<PageMessage title="Datasets">
					Unable to load datasets.{" "}
					<Button
						size="sm"
						variant="outline"
						onClick={() => void query.refetch()}
					>
						Retry
					</Button>
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
	const [pending, setPending] = React.useState(false);
	const [deletingItemId, setDeletingItemId] = React.useState<string | null>(
		null,
	);
	async function publish() {
		if (pending) return;
		try {
			setError("");
			setPending(true);
			const draft = await createDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			await publishDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				revision: draft.revision,
			});
			await Promise.all([
				client.invalidateQueries({
					queryKey: ["dataset-items", selectedProjectId, id],
				}),
				client.invalidateQueries({
					queryKey: ["dataset", selectedProjectId, id],
				}),
				client.invalidateQueries({ queryKey: ["datasets", selectedProjectId] }),
			]);
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	async function add() {
		if (pending) return;
		try {
			setError("");
			setPending(true);
			const draft = await createDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			await upsertDatasetDraftItem({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_key: crypto.randomUUID(),
				revision: draft.revision,
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
		} finally {
			setPending(false);
		}
	}
	async function remove(item: DatasetItem) {
		if (deletingItemId) return;
		try {
			setError("");
			setDeletingItemId(item.id);
			const draft = await createDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			const draftItems = await listDatasetItems({
				project_id: selectedProjectId!,
				id: dataset.data!.id,
			});
			const draftItem = draftItems.items.find(
				(candidate) => candidate.item_key === item.item_key,
			);
			if (!draftItem) throw new Error("Dataset draft item not found");
			await deleteDatasetDraftItem({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_id: draftItem.id,
				revision: draft.revision,
			});
			await client.invalidateQueries({
				queryKey: ["dataset-items", selectedProjectId, id],
			});
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setDeletingItemId(null);
		}
	}
	if (!selectedProjectId)
		return <PageMessage title="Dataset">Select a project.</PageMessage>;
	if ((dataset.isLoading && !dataset.data) || (items.isLoading && !items.data))
		return <DetailLoadingSkeleton testId="dataset-detail-skeleton" />;
	if (dataset.isError || items.isError)
		return (
			<PageMessage title="Dataset">
				Unable to load dataset.{" "}
				<Button
					size="sm"
					variant="outline"
					onClick={() => void Promise.all([dataset.refetch(), items.refetch()])}
				>
					Retry
				</Button>
			</PageMessage>
		);
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
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<Button disabled={pending} onClick={() => void add()}>
					{pending ? "Adding..." : "Add case"}
				</Button>
			</section>
			<Button
				variant="outline"
				disabled={pending}
				onClick={() => void publish()}
			>
				{pending ? "Publishing..." : "Publish draft"}
			</Button>
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
								disabled={deletingItemId !== null}
								onClick={() => void remove(item)}
							>
								{deletingItemId === item.id ? "Deleting..." : "Delete"}
							</Button>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
