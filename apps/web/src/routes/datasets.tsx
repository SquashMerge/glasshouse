import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import * as React from "react";
import {
	DetailLoadingSkeleton,
	ListLoadingSkeleton,
} from "../components/LoadingSkeletons";
import { useProjectSelection } from "../components/ProjectProvider";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Textarea } from "../components/ui/textarea";
import {
	ApiError,
	archiveDataset,
	type ApiValidationIssue,
	createDataset,
	createDatasetDraft,
	type DatasetItem,
	deleteDatasetDraftItem,
	exportDataset,
	getDataset,
	getDatasetDraft,
	getDatasetVersion,
	importDatasetDraftItems,
	listDatasetDraftItemRevisions,
	listDatasetItems,
	listDatasetVersions,
	listDatasets,
	publishDatasetDraft,
	reorderDatasetDraftItems,
	restoreDataset,
	reviewDatasetDraftItem,
	upsertDatasetDraftItem,
	tombstoneDataset,
	validateDatasetDraft,
} from "../lib/api";
import { PageMessage } from "./prompts";

export function DatasetsPage() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [lifecycleError, setLifecycleError] = React.useState("");
	const [pendingDatasetId, setPendingDatasetId] = React.useState<string | null>(
		null,
	);
	const [tombstoneDatasetId, setTombstoneDatasetId] = React.useState<
		string | null
	>(null);
	const [tombstoneConfirmation, setTombstoneConfirmation] = React.useState("");
	const canAdmin = selectedProject?.project_role === "admin";
	const query = useQuery({
		queryKey: ["datasets", selectedProjectId, canAdmin],
		queryFn: () => listDatasets(selectedProjectId!, canAdmin),
		enabled: Boolean(selectedProjectId),
	});
	if (!selectedProject)
		return (
			<PageMessage title="Datasets">
				Select a project to manage its datasets.
			</PageMessage>
		);
	const canCurate = selectedProject.project_role !== "read_only";
	async function archive(dataset: {
		id: string;
		slug: string;
		revision: number;
	}) {
		if (pendingDatasetId) return;
		try {
			setLifecycleError("");
			setPendingDatasetId(dataset.id);
			await archiveDataset({
				project_id: selectedProjectId!,
				slug: dataset.slug,
				revision: dataset.revision,
			});
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingDatasetId(null);
		}
	}
	async function restore(dataset: {
		id: string;
		slug: string;
		revision: number;
	}) {
		if (pendingDatasetId) return;
		try {
			setLifecycleError("");
			setPendingDatasetId(dataset.id);
			await restoreDataset({
				project_id: selectedProjectId!,
				slug: dataset.slug,
				revision: dataset.revision,
			});
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingDatasetId(null);
		}
	}
	async function tombstone(dataset: {
		id: string;
		slug: string;
		revision: number;
	}) {
		if (pendingDatasetId) return;
		try {
			setLifecycleError("");
			setPendingDatasetId(dataset.id);
			await tombstoneDataset({
				project_id: selectedProjectId!,
				slug: dataset.slug,
				revision: dataset.revision,
				confirmation_slug: tombstoneConfirmation,
			});
			setTombstoneDatasetId(null);
			setTombstoneConfirmation("");
			await client.invalidateQueries({
				queryKey: ["datasets", selectedProjectId],
			});
		} catch (cause) {
			setLifecycleError((cause as Error).message);
		} finally {
			setPendingDatasetId(null);
		}
	}
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
			<PageHeader title="Datasets" description={selectedProject.name} />
			{canCurate && (
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
			)}
			{error && (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			)}
			{lifecycleError && (
				<p className="text-sm text-destructive" role="alert">
					{lifecycleError}
				</p>
			)}
			{query.isLoading && !query.data && (
				<ListLoadingSkeleton testId="dataset-list-skeleton" />
			)}
			{query.isError && (
				<Alert variant="destructive" aria-live="assertive">
					<AlertTitle>Datasets could not be loaded</AlertTitle>
					<AlertDescription className="flex flex-wrap items-center gap-3">
						<span>
							{query.error instanceof Error
								? query.error.message
								: "Unable to load datasets."}
						</span>
						<Button
							size="sm"
							variant="outline"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							{query.isFetching ? "Retrying..." : "Retry loading datasets"}
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{query.data?.items.length === 0 && (
				<PageMessage title="Datasets">
					{canCurate
						? "No datasets yet. Create one to add JSON cases."
						: "No datasets are available in this project."}
				</PageMessage>
			)}
			<ul className="divide-y rounded border">
				{query.data?.items.map((dataset) => (
					<li key={dataset.id} className="p-4">
						<div className="flex flex-wrap items-start justify-between gap-3">
							{dataset.archived_at ? (
								<div>
									<strong>{dataset.name}</strong>
									<Badge className="ml-3" variant="secondary">
										Archived
									</Badge>
									<p className="mt-1 text-sm text-muted-foreground">
										{dataset.description}
									</p>
								</div>
							) : (
								<Link
									className="block hover:text-primary"
									to="/datasets/$id"
									params={{ id: dataset.id }}
								>
									<strong>{dataset.name}</strong>
									<span className="ml-3 text-sm text-muted-foreground">
										{dataset.item_count} cases
									</span>
									<p className="mt-1 text-sm text-muted-foreground">
										{dataset.description}
									</p>
								</Link>
							)}
							{canAdmin && (
								<div className="flex flex-wrap items-center gap-2">
									{dataset.archived_at ? (
										<>
											<Button
												size="sm"
												variant="outline"
												disabled={pendingDatasetId !== null}
												onClick={() => void restore(dataset)}
											>
												{pendingDatasetId === dataset.id
													? "Restoring..."
													: "Restore"}
											</Button>
											<Button
												size="sm"
												variant="destructive"
												disabled={pendingDatasetId !== null}
												onClick={() => {
													setTombstoneDatasetId(dataset.id);
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
											disabled={pendingDatasetId !== null}
											onClick={() => void archive(dataset)}
										>
											{pendingDatasetId === dataset.id
												? "Archiving..."
												: "Archive"}
										</Button>
									)}
								</div>
							)}
						</div>
						{canAdmin && tombstoneDatasetId === dataset.id && (
							<div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
								<label className="sr-only" htmlFor={`tombstone-${dataset.id}`}>
									Confirm Dataset slug
								</label>
								<Input
									id={`tombstone-${dataset.id}`}
									value={tombstoneConfirmation}
									onChange={(event) =>
										setTombstoneConfirmation(event.target.value)
									}
									placeholder={`Type ${dataset.slug} to permanently tombstone`}
								/>
								<Button
									size="sm"
									variant="destructive"
									disabled={
										pendingDatasetId !== null ||
										tombstoneConfirmation !== dataset.slug
									}
									onClick={() => void tombstone(dataset)}
								>
									Permanently tombstone
								</Button>
							</div>
						)}
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

function parseImport(value: string) {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.length === 0)
		throw new Error("Import must be a non-empty JSON array");
	return parsed.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`Import row ${index + 1} must be an object`);
		const row = candidate as Record<string, unknown>;
		if (typeof row.item_key !== "string" || !row.item_key.trim())
			throw new Error(`Import row ${index + 1} needs an item_key`);
		if (!row.input || typeof row.input !== "object" || Array.isArray(row.input))
			throw new Error(`Import row ${index + 1} needs an input object`);
		if (
			row.expected_output !== undefined &&
			row.expected_output !== null &&
			(typeof row.expected_output !== "object" ||
				Array.isArray(row.expected_output))
		)
			throw new Error(
				`Import row ${index + 1} expected_output must be an object or null`,
			);
		if (
			row.metadata !== undefined &&
			(!row.metadata ||
				typeof row.metadata !== "object" ||
				Array.isArray(row.metadata))
		)
			throw new Error(`Import row ${index + 1} metadata must be an object`);
		if (
			row.source_trace_id !== undefined &&
			row.source_trace_id !== null &&
			typeof row.source_trace_id !== "string"
		)
			throw new Error(
				`Import row ${index + 1} source_trace_id must be a string`,
			);
		if (
			row.source_observation_id !== undefined &&
			row.source_observation_id !== null &&
			typeof row.source_observation_id !== "string"
		)
			throw new Error(
				`Import row ${index + 1} source_observation_id must be a string`,
			);
		const sourceTraceId = row.source_trace_id as string | null | undefined;
		const sourceObservationId = row.source_observation_id as
			| string
			| null
			| undefined;
		if (sourceObservationId && !sourceTraceId)
			throw new Error(
				`Import row ${index + 1} observation provenance requires a trace`,
			);
		return {
			item_key: row.item_key,
			input: row.input as Record<string, unknown>,
			expected_output:
				row.expected_output === undefined
					? undefined
					: (row.expected_output as Record<string, unknown> | null),
			metadata: row.metadata as Record<string, unknown> | undefined,
			external_id:
				typeof row.external_id === "string" ? row.external_id : undefined,
			...(sourceTraceId === undefined
				? {}
				: { source_trace_id: sourceTraceId }),
			...(sourceObservationId === undefined
				? {}
				: { source_observation_id: sourceObservationId }),
		};
	});
}

export function DatasetDetailPage() {
	const { id } = useParams({ from: "/protected/datasets/$id" });
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const dataset = useQuery({
		queryKey: ["dataset", selectedProjectId, id],
		queryFn: () => getDataset({ project_id: selectedProjectId!, id }),
		enabled: Boolean(selectedProjectId),
	});
	const items = useQuery({
		queryKey: ["dataset-items", selectedProjectId, id],
		queryFn: ({ signal }) =>
			listDatasetItems({ project_id: selectedProjectId!, id, signal }),
		enabled: Boolean(selectedProjectId),
	});
	const versions = useQuery({
		queryKey: ["dataset-versions", selectedProjectId, id, dataset.data?.slug],
		queryFn: () =>
			listDatasetVersions({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			}),
		enabled: Boolean(selectedProjectId && dataset.data?.slug),
	});
	const publishedVersion = useQuery({
		queryKey: [
			"dataset-version",
			selectedProjectId,
			dataset.data?.slug,
			dataset.data?.latest_published_version,
		],
		queryFn: () =>
			getDatasetVersion({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				version: dataset.data!.latest_published_version!,
			}),
		enabled: Boolean(
			selectedProjectId &&
				dataset.data?.slug &&
				dataset.data.latest_published_version,
		),
	});
	const [input, setInput] = React.useState("{}");
	const [expected, setExpected] = React.useState("");
	const [metadata, setMetadata] = React.useState("{}");
	const [externalId, setExternalId] = React.useState("");
	const [importValue, setImportValue] = React.useState("");
	const [error, setError] = React.useState("");
	const [conflict, setConflict] = React.useState<{
		currentRevision: number;
		fieldDiff: Array<{ field: string; current: unknown; requested: unknown }>;
	} | null>(null);
	const [validationErrors, setValidationErrors] = React.useState<
		Array<{ item_key: string | null; field: string; message: string }>
	>([]);
	const [importValidationErrors, setImportValidationErrors] = React.useState<
		ApiValidationIssue[]
	>([]);
	const [editing, setEditing] = React.useState<DatasetItem | null>(null);
	const [history, setHistory] = React.useState<{
		itemId: string;
		items: Array<{
			item_revision: number;
			action: string;
			actor_username: string;
			created_at: string;
		}>;
	} | null>(null);
	const [pending, setPending] = React.useState(false);
	const [deletingItemId, setDeletingItemId] = React.useState<string | null>(
		null,
	);
	const canCurate = selectedProject?.project_role !== "read_only";
	const canAdmin = selectedProject?.project_role === "admin";
	const importAttempt = React.useRef<{
		idempotency_key: string;
		revision: number | undefined;
	} | null>(null);

	function recordError(cause: unknown) {
		if (cause instanceof ApiError && cause.status === 409) {
			setError("This draft changed elsewhere. Refresh the draft and retry.");
			if (
				typeof cause.details?.current_revision === "number" &&
				Array.isArray(cause.details.field_diff)
			)
				setConflict({
					currentRevision: cause.details.current_revision,
					fieldDiff: cause.details.field_diff,
				});
		} else {
			setConflict(null);
			setError((cause as Error).message);
		}
	}
	async function downloadExport(
		format: "csv" | "jsonl",
		representation: "draft" | "version",
	) {
		try {
			setError("");
			const result = await exportDataset({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				format,
				representation,
				...(representation === "version"
					? { version: dataset.data!.latest_published_version! }
					: {}),
			});
			const url = URL.createObjectURL(
				new Blob([result.body], { type: result.content_type }),
			);
			const link = document.createElement("a");
			link.href = url;
			link.download = result.filename;
			link.click();
			URL.revokeObjectURL(url);
		} catch (cause) {
			recordError(cause);
		}
	}
	function importValidation(cause: unknown): ApiValidationIssue[] {
		if (!(cause instanceof ApiError)) return [];
		return (
			cause.details?.errors?.filter(
				(issue): issue is ApiValidationIssue =>
					typeof issue.field === "string" &&
					typeof issue.message === "string" &&
					(typeof issue.item_key === "string" || issue.item_key === null),
			) ?? []
		);
	}
	async function refreshDraft() {
		await Promise.all([
			client.invalidateQueries({
				queryKey: ["dataset-items", selectedProjectId, id],
			}),
			client.invalidateQueries({
				queryKey: ["dataset", selectedProjectId, id],
			}),
			client.invalidateQueries({ queryKey: ["datasets", selectedProjectId] }),
			client.invalidateQueries({
				queryKey: ["dataset-versions", selectedProjectId, id],
			}),
		]);
	}
	async function existingDraftRevision() {
		try {
			return (
				await getDatasetDraft({
					project_id: selectedProjectId!,
					slug: dataset.data!.slug,
				})
			).revision;
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 404) return undefined;
			throw cause;
		}
	}
	async function currentDraftItems() {
		const draft = await createDatasetDraft({
			project_id: selectedProjectId!,
			slug: dataset.data!.slug,
		});
		const visible = await listDatasetItems({
			project_id: selectedProjectId!,
			id: dataset.data!.id,
		});
		return { draft, items: visible.items };
	}
	async function publish() {
		if (pending) return;
		try {
			setError("");
			setValidationErrors([]);
			setPending(true);
			const draft = await createDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			const validation = await validateDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			if (!validation.valid) {
				setValidationErrors(validation.errors);
				setError("Review the highlighted draft items before publishing.");
				return;
			}
			await publishDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				revision: draft.revision,
			});
			await refreshDraft();
		} catch (cause) {
			recordError(cause);
		} finally {
			setPending(false);
		}
	}
	async function add() {
		if (pending) return;
		try {
			setError("");
			setValidationErrors([]);
			const parsedInput = parseObject(input);
			const parsedExpected = expected.trim() ? parseObject(expected) : null;
			const parsedMetadata = parseObject(metadata);
			setPending(true);
			const draft = await createDatasetDraft({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
			});
			await upsertDatasetDraftItem({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_key: editing?.item_key ?? crypto.randomUUID(),
				revision: draft.revision,
				input: parsedInput,
				expected_output: parsedExpected,
				metadata: parsedMetadata,
				external_id: externalId.trim() || null,
			});
			setInput("{}");
			setExpected("");
			setMetadata("{}");
			setExternalId("");
			setEditing(null);
			await refreshDraft();
		} catch (cause) {
			recordError(cause);
		} finally {
			setPending(false);
		}
	}
	function edit(item: DatasetItem) {
		setEditing(item);
		setInput(JSON.stringify(item.input, null, 2));
		setExpected(
			item.expected_output ? JSON.stringify(item.expected_output, null, 2) : "",
		);
		setMetadata(JSON.stringify(item.metadata, null, 2));
		setExternalId(item.external_id ?? "");
		setError("");
	}
	async function review(item: DatasetItem) {
		if (pending) return;
		try {
			setError("");
			setPending(true);
			const { draft, items: draftItems } = await currentDraftItems();
			const target = draftItems.find(
				(candidate) => candidate.item_key === item.item_key,
			);
			if (!target) throw new Error("Dataset draft item not found");
			await reviewDatasetDraftItem({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_id: target.id,
				revision: draft.revision,
			});
			await refreshDraft();
		} catch (cause) {
			recordError(cause);
		} finally {
			setPending(false);
		}
	}
	async function move(item: DatasetItem, direction: -1 | 1) {
		if (pending || !items.data) return;
		const ordered = items.data.items;
		const index = ordered.findIndex((candidate) => candidate.id === item.id);
		const destination = index + direction;
		if (index < 0 || destination < 0 || destination >= ordered.length) return;
		try {
			setError("");
			setPending(true);
			const { draft, items: draftItems } = await currentDraftItems();
			const keys = ordered.map((candidate) => candidate.item_key);
			if (keys.some((key) => !key))
				throw new Error("Dataset draft item is missing its stable key");
			const [moved] = keys.splice(index, 1);
			if (!moved) throw new Error("Dataset draft item not found");
			keys.splice(destination, 0, moved);
			const ids = keys.map((key) => {
				const draftItem = draftItems.find(
					(candidate) => candidate.item_key === key,
				);
				if (!draftItem) throw new Error("Dataset draft item not found");
				return draftItem.id;
			});
			await reorderDatasetDraftItems({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				revision: draft.revision,
				item_ids: ids,
			});
			await refreshDraft();
		} catch (cause) {
			recordError(cause);
		} finally {
			setPending(false);
		}
	}
	async function importRows() {
		if (pending) return;
		try {
			setError("");
			setValidationErrors([]);
			setImportValidationErrors([]);
			setPending(true);
			const rows = parseImport(importValue);
			const attempt = importAttempt.current ?? {
				idempotency_key: crypto.randomUUID(),
				revision: await existingDraftRevision(),
			};
			importAttempt.current ??= attempt;
			await importDatasetDraftItems({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				revision: attempt.revision,
				idempotency_key: attempt.idempotency_key,
				items: rows,
			});
			importAttempt.current = null;
			setImportValue("");
			await refreshDraft();
		} catch (cause) {
			const issues = importValidation(cause);
			if (issues.length) {
				setImportValidationErrors(issues);
			} else recordError(cause);
		} finally {
			setPending(false);
		}
	}
	async function showHistory(item: DatasetItem) {
		try {
			const result = await listDatasetDraftItemRevisions({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_id: item.id,
			});
			setHistory({ itemId: item.id, items: result.items });
		} catch (cause) {
			recordError(cause);
		}
	}
	async function remove(item: DatasetItem) {
		if (deletingItemId) return;
		try {
			setError("");
			setDeletingItemId(item.id);
			const { draft, items: draftItems } = await currentDraftItems();
			const draftItem = draftItems.find(
				(candidate) => candidate.item_key === item.item_key,
			);
			if (!draftItem) throw new Error("Dataset draft item not found");
			await deleteDatasetDraftItem({
				project_id: selectedProjectId!,
				slug: dataset.data!.slug,
				item_id: draftItem.id,
				revision: draft.revision,
			});
			await refreshDraft();
		} catch (cause) {
			recordError(cause);
		} finally {
			setDeletingItemId(null);
		}
	}
	if (!selectedProjectId)
		return <PageMessage title="Dataset">Select a project.</PageMessage>;
	if ((dataset.isLoading && !dataset.data) || (items.isLoading && !items.data))
		return <DetailLoadingSkeleton testId="dataset-detail-skeleton" />;
	if (dataset.isError || items.isError) {
		const loadError = dataset.error ?? items.error;
		return (
			<Alert variant="destructive" aria-live="assertive">
				<AlertTitle>Dataset could not be loaded</AlertTitle>
				<AlertDescription className="flex flex-wrap items-center gap-3">
					<span>
						{loadError instanceof Error
							? loadError.message
							: "Unable to load dataset."}
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={dataset.isFetching || items.isFetching}
						onClick={() =>
							void Promise.all([dataset.refetch(), items.refetch()])
						}
					>
						{dataset.isFetching || items.isFetching
							? "Retrying..."
							: "Retry loading dataset"}
					</Button>
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<div className="space-y-6">
			<div>
				<Link className="text-sm underline" to="/datasets">
					Datasets
				</Link>
				<PageHeader
					title={dataset.data?.name ?? "Dataset"}
					description={dataset.data?.description}
				/>
				{dataset.data?.latest_published_version ? (
					<p className="mt-2 text-sm text-muted-foreground">
						Latest immutable version:{" "}
						<strong>
							{dataset.data.slug}@{dataset.data.latest_published_version}
						</strong>
						{versions.data?.items[0]
							? ` (${versions.data.items[0].content_hash.slice(0, 12)})`
							: ""}
					</p>
				) : (
					<p className="mt-2 text-sm text-muted-foreground">
						No published version yet.
					</p>
				)}
				{canAdmin && (
					<div className="mt-3 flex flex-wrap gap-2">
						{dataset.data?.latest_published_version && (
							<>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void downloadExport("csv", "version")}
								>
									Export version CSV
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void downloadExport("jsonl", "version")}
								>
									Export version JSONL
								</Button>
							</>
						)}
						<Button
							size="sm"
							variant="outline"
							onClick={() => void downloadExport("jsonl", "draft")}
						>
							Export draft JSONL
						</Button>
					</div>
				)}
			</div>
			{conflict && (
				<Alert variant="destructive" role="alert">
					<AlertTitle>Shared draft changed</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>
							The current revision is {conflict.currentRevision}. Astraea did
							not merge your changes automatically.
						</p>
						<ul className="list-disc space-y-1 pl-5 text-xs">
							{conflict.fieldDiff.map((field) => (
								<li key={field.field}>
									{field.field}: current {JSON.stringify(field.current)};
									requested {JSON.stringify(field.requested)}
								</li>
							))}
						</ul>
						<Button
							size="sm"
							variant="outline"
							disabled={pending}
							onClick={() => {
								setConflict(null);
								void refreshDraft();
							}}
						>
							Refresh current draft
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{canCurate && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">
							{editing ? "Edit draft case" : "Add JSON case"}
						</CardTitle>
						<CardDescription>
							Saved cases require an explicit review before publication.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="dataset-input"
						>
							Input
							<Textarea
								id="dataset-input"
								className="min-h-24 font-mono text-xs"
								value={input}
								onChange={(event) => setInput(event.target.value)}
							/>
						</label>
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="dataset-expected"
						>
							Expected output (optional)
							<Textarea
								id="dataset-expected"
								className="min-h-20 font-mono text-xs"
								value={expected}
								onChange={(event) => setExpected(event.target.value)}
							/>
						</label>
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="dataset-metadata"
						>
							Metadata
							<Textarea
								id="dataset-metadata"
								className="min-h-16 font-mono text-xs"
								value={metadata}
								onChange={(event) => setMetadata(event.target.value)}
							/>
						</label>
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="dataset-external-id"
						>
							External source identity (optional)
							<Input
								id="dataset-external-id"
								value={externalId}
								onChange={(event) => setExternalId(event.target.value)}
								maxLength={200}
							/>
						</label>
						{error && (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button disabled={pending} onClick={() => void add()}>
								{pending
									? "Saving..."
									: editing
										? "Save and require review"
										: "Add case to draft"}
							</Button>
							{editing && (
								<Button
									variant="outline"
									disabled={pending}
									onClick={() => setEditing(null)}
								>
									Cancel edit
								</Button>
							)}
						</div>
					</CardContent>
				</Card>
			)}
			{canCurate && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Import JSON cases</CardTitle>
						<CardDescription>
							Paste up to 500 canonical rows. Invalid rows leave the draft
							unchanged.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="dataset-import"
						>
							JSON array
							<Textarea
								id="dataset-import"
								className="min-h-24 font-mono text-xs"
								placeholder='[{"item_key":"case-1","input":{"question":"..."}}]'
								value={importValue}
								onChange={(event) => setImportValue(event.target.value)}
							/>
						</label>
						<Button
							variant="outline"
							disabled={pending || !importValue.trim()}
							onClick={() => void importRows()}
						>
							{pending ? "Importing..." : "Import into draft"}
						</Button>
						{importValidationErrors.length > 0 && (
							<div
								className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
								role="alert"
							>
								<p className="font-medium">Import validation needs attention</p>
								<ul className="mt-2 list-disc space-y-1 pl-5">
									{importValidationErrors.map((issue, index) => (
										<li
											key={`${issue.item_key ?? "row"}-${issue.field}-${index}`}
										>
											{issue.item_key
												? `${issue.item_key}, `
												: `Row ${index + 1}, `}
											{issue.field.replace(/^items\/\d+\//, "")}:{" "}
											{issue.message}
										</li>
									))}
								</ul>
							</div>
						)}
					</CardContent>
				</Card>
			)}
			{canCurate && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="outline"
						disabled={pending}
						onClick={() => void publish()}
					>
						{pending ? "Publishing..." : "Publish reviewed draft"}
					</Button>
					<p className="text-sm text-muted-foreground">
						Changes stay in the shared draft until you publish.
					</p>
				</div>
			)}
			{validationErrors.length > 0 && (
				<div
					className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
					role="alert"
				>
					<p className="font-medium">Draft validation needs attention</p>
					<ul className="mt-2 list-disc space-y-1 pl-5">
						{validationErrors.map((issue, index) => (
							<li key={`${issue.item_key ?? "draft"}-${issue.field}-${index}`}>
								{issue.item_key ? `${issue.item_key}: ` : ""}
								{issue.message}
							</li>
						))}
					</ul>
				</div>
			)}
			{publishedVersion.data && (
				<Card>
					<CardHeader>
						<CardTitle>
							Published version {publishedVersion.data.version}
						</CardTitle>
						<CardDescription>
							Immutable snapshot with {publishedVersion.data.item_count} cases
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ul className="space-y-3">
							{publishedVersion.data.items.map((item) => (
								<li
									key={item.id}
									className="rounded-md border border-border p-3"
								>
									<p className="text-sm font-medium">{item.item_key}</p>
									<pre className="mt-2 overflow-auto text-xs">
										{JSON.stringify(item.input, null, 2)}
									</pre>
									{item.expected_output && (
										<pre className="mt-2 overflow-auto text-xs">
											Expected: {JSON.stringify(item.expected_output, null, 2)}
										</pre>
									)}
									<div className="mt-2 space-y-1 text-xs text-muted-foreground">
										{item.feedback_score_id && (
											<p>Feedback score: {item.feedback_score_id}</p>
										)}
										{item.curated_by_username && (
											<p>Curated by: {item.curated_by_username}</p>
										)}
										{item.reviewed_by_username && (
											<p>Reviewed by: {item.reviewed_by_username}</p>
										)}
										{item.reviewed_at && <p>Reviewed at: {item.reviewed_at}</p>}
									</div>
									{item.source_trace_id && (
										<Link
											className="mt-2 inline-block text-xs underline"
											to="/observability/traces/$id"
											params={{ id: item.source_trace_id }}
										>
											Source trace
										</Link>
									)}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}
			{items.data?.items.length === 0 && (
				<PageMessage title={canCurate ? "Draft cases" : "Dataset cases"}>
					{canCurate
						? "No cases yet. Add a JSON case, import rows, or capture redacted evidence from a trace."
						: "No cases are available in this Dataset."}
				</PageMessage>
			)}
			<ul className="space-y-3">
				{items.data?.items.map((item) => (
					<li
						key={item.id}
						className="rounded-lg border border-border bg-background p-4"
					>
						<div className="mb-3 flex flex-wrap items-center gap-2">
							<Badge
								variant={item.state === "reviewed" ? "success" : "secondary"}
							>
								{item.state === "reviewed" ? "Reviewed" : "Needs review"}
							</Badge>
							{item.capture_context?.redaction_applied && (
								<Badge variant="outline">Redacted capture</Badge>
							)}
							{item.external_id && (
								<span className="text-xs text-muted-foreground">
									External: {item.external_id}
								</span>
							)}
						</div>
						<pre className="overflow-auto text-xs">
							{JSON.stringify(item.input, null, 2)}
						</pre>
						{item.expected_output && (
							<pre className="mt-2 overflow-auto text-xs">
								Expected: {JSON.stringify(item.expected_output, null, 2)}
							</pre>
						)}
						<div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							{item.source_trace_id && (
								<Link
									className="underline"
									to="/observability/traces/$id"
									params={{ id: item.source_trace_id }}
								>
									Source trace
								</Link>
							)}
							<div className="flex flex-wrap gap-2">
								{canCurate && (
									<>
										<Button
											size="sm"
											variant="ghost"
											disabled={pending}
											onClick={() => edit(item)}
										>
											Edit
										</Button>
										{item.state !== "reviewed" && (
											<Button
												size="sm"
												variant="outline"
												disabled={pending}
												onClick={() => void review(item)}
											>
												Mark reviewed
											</Button>
										)}
										<Button
											size="sm"
											variant="ghost"
											disabled={pending}
											onClick={() => void move(item, -1)}
										>
											Move up
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={pending}
											onClick={() => void move(item, 1)}
										>
											Move down
										</Button>
									</>
								)}
								<Button
									size="sm"
									variant="ghost"
									disabled={pending}
									onClick={() => void showHistory(item)}
								>
									Revision history
								</Button>
								{canCurate && (
									<Button
										size="sm"
										variant="ghost"
										disabled={deletingItemId !== null || pending}
										onClick={() => void remove(item)}
									>
										{deletingItemId === item.id
											? "Deleting from draft..."
											: "Delete from draft"}
									</Button>
								)}
							</div>
						</div>
						{history?.itemId === item.id && (
							<div className="mt-3 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
								<p className="font-medium text-foreground">Revision history</p>
								<ul className="mt-2 space-y-1">
									{history.items.map((revision) => (
										<li key={revision.item_revision}>
											Revision {revision.item_revision}: {revision.action} by{" "}
											{revision.actor_username}
										</li>
									))}
								</ul>
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
