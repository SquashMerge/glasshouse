import * as React from "react";
import { LuClipboard, LuX } from "react-icons/lu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { copyJson, copyText } from "../lib/clipboard";
import {
	metadataAttributes,
	metadataFallback,
	parseMetadata,
	type MetadataAttribute,
} from "../lib/trace-metadata";
import type { CanonicalObservation } from "../lib/trace-model";
import { observationKind } from "../lib/observation-kind";
import { observationTiming } from "../lib/trace-timeline";
import {
	normalizeObservationMetadata,
	type ObservationMetadataInput,
} from "../lib/api";
import { PromptProvenanceCard } from "./PromptProvenanceCard";
import { JsonTree, MAX_JSON_TREE_NODES } from "./JsonTree";

const MAX_JSON_TREE_LIST_ENTRIES = 100;

export interface ObservationDetailPanelProps {
	observation: CanonicalObservation | null;
	traceId: string;
	onClose?: () => void;
	actions?: React.ReactNode;
}

function printable(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function objectEntries(value: unknown): MetadataAttribute[] {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return [];
	return Object.entries(value)
		.map(([key, entry]) => ({ key, value: entry }))
		.sort((left, right) => left.key.localeCompare(right.key));
}

function objectValue(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return (value as Record<string, unknown>)[key];
}

function telemetryValue(value: unknown): string | null {
	if (typeof value === "string" && value) return value;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	for (const key of ["stringValue", "value", "name", "version"]) {
		const candidate = objectValue(value, key);
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return null;
}

function metadataValue(metadata: unknown, key: string): unknown {
	const attributes = Array.isArray(metadata)
		? metadata
		: objectValue(metadata, "attributes");
	if (Array.isArray(attributes)) {
		const attribute = attributes.find(
			(item) => objectValue(item, "key") === key,
		);
		if (attribute) return objectValue(attribute, "value");
	}
	const direct = objectValue(metadata, key);
	if (direct !== undefined) return direct;
	return key
		.split(".")
		.reduce<unknown>((value, segment) => objectValue(value, segment), metadata);
}

function detailValue(
	observation: CanonicalObservation,
	metadata: unknown,
	keys: string[],
): string | null {
	for (const key of keys) {
		const direct = telemetryValue(objectValue(observation, key));
		if (direct) return direct;
		const fromMetadata = telemetryValue(metadataValue(metadata, key));
		if (fromMetadata) return fromMetadata;
	}
	return null;
}

function detailEntries(value: unknown, label: string): MetadataAttribute[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry, index) => ({
		key: `${label} ${index + 1}`,
		value: entry,
	}));
}

function MetadataList({
	values,
	emptyLabel,
	onCopyValue,
	onCopyJsonValue,
	onCopyPath,
	structuredValues = false,
}: {
	values: MetadataAttribute[];
	emptyLabel: string;
	onCopyValue?: (value: unknown, key: string) => void;
	onCopyJsonValue?: (value: unknown, path: string) => void;
	onCopyPath?: (path: string) => void;
	structuredValues?: boolean;
}) {
	if (values.length === 0)
		return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
	const visibleValues = structuredValues
		? values.slice(0, MAX_JSON_TREE_LIST_ENTRIES)
		: values;
	const omittedEntryCount = values.length - visibleValues.length;
	const nodeLimitPerValue = structuredValues
		? Math.max(1, Math.floor(MAX_JSON_TREE_NODES / visibleValues.length))
		: MAX_JSON_TREE_NODES;
	return (
		<>
			<dl className="space-y-2 text-xs">
				{visibleValues.map(({ key, value }) => (
					<div
						key={key}
						className="grid gap-1 border-b pb-2 sm:grid-cols-[minmax(8rem,12rem)_1fr]"
					>
						<dt className="font-mono text-muted-foreground">{key}</dt>
						<dd className="flex min-w-0 items-start gap-2">
							{structuredValues ? (
								<JsonTree
									value={value}
									rootLabel={key}
									onCopyValue={onCopyJsonValue}
									onCopyPath={onCopyPath}
									maxNodes={nodeLimitPerValue}
								/>
							) : (
								<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
									{printable(value)}
								</span>
							)}
							{onCopyValue && (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="h-6 shrink-0 px-2 text-[10px]"
									onClick={() => onCopyValue(value, key)}
									aria-label={`Copy ${key} value`}
								>
									Copy
								</Button>
							)}
						</dd>
					</div>
				))}
			</dl>
			{omittedEntryCount > 0 && (
				<p role="status" className="mt-2 text-xs text-muted-foreground">
					{omittedEntryCount} more structured entries not shown (
					{MAX_JSON_TREE_LIST_ENTRIES}-entry limit).
				</p>
			)}
		</>
	);
}

export function ObservationDetailPanel({
	observation,
	traceId,
	onClose,
	actions,
}: ObservationDetailPanelProps) {
	const [tab, setTab] = React.useState("overview");
	const [copyMessage, setCopyMessage] = React.useState("");
	const [attributeQuery, setAttributeQuery] = React.useState("");

	React.useEffect(() => {
		setTab("overview");
		setAttributeQuery("");
	}, [observation?.observation_id]);

	const metadata = React.useMemo(
		() => parseMetadata(observation?.metadata),
		[observation?.metadata],
	);
	const promptProvenance = React.useMemo(
		() =>
			normalizeObservationMetadata(
				observation?.metadata as ObservationMetadataInput,
				observation?.type === "generation",
			).prompt_provenance,
		[observation?.metadata, observation?.type],
	);
	const attributes = React.useMemo(() => {
		const arrayAttributes = metadataAttributes(metadata);
		return arrayAttributes.length > 0
			? arrayAttributes
			: objectEntries(metadata.value);
	}, [metadata]);
	const visibleAttributes = React.useMemo(() => {
		const query = attributeQuery.trim().toLocaleLowerCase();
		if (!query) return attributes;
		return attributes.filter(
			({ key, value }) =>
				key.toLocaleLowerCase().includes(query) ||
				printable(value).toLocaleLowerCase().includes(query),
		);
	}, [attributeQuery, attributes]);
	const eventEntries = React.useMemo(
		() =>
			metadata.value &&
			typeof metadata.value === "object" &&
			!Array.isArray(metadata.value)
				? (metadata.value as { events?: unknown }).events
				: null,
		[metadata],
	);
	const linkEntries = React.useMemo(
		() =>
			metadata.value &&
			typeof metadata.value === "object" &&
			!Array.isArray(metadata.value)
				? (metadata.value as { links?: unknown }).links
				: null,
		[metadata],
	);
	const resource = React.useMemo(
		() =>
			metadata.value &&
			typeof metadata.value === "object" &&
			!Array.isArray(metadata.value)
				? (metadata.value as { resource?: unknown }).resource
				: null,
		[metadata],
	);

	if (!observation) {
		return (
			<aside
				className="rounded-lg border p-6 text-sm text-muted-foreground"
				data-testid="observation-detail-empty"
			>
				Select an observation to see its detail.
			</aside>
		);
	}

	const kind = observationKind(observation.type);
	const timing = observationTiming(observation);
	const statusError = observation.status === "error";
	const retainedFieldNotices = [
		observation.input_retained_truncated === true
			? "Input retained at 8 KiB"
			: null,
		observation.output_retained_truncated === true
			? "Output retained at 8 KiB"
			: null,
		normalizeObservationMetadata(
			observation.metadata as ObservationMetadataInput,
			observation.type === "generation",
		).truncated === true || observation.metadata_truncated === true
			? "Metadata retained at 16 KiB"
			: null,
	].filter((notice): notice is string => notice !== null);
	const service = detailValue(observation, metadata.value, [
		"service_name",
		"service.name",
	]);
	const scopeName = detailValue(observation, metadata.value, [
		"scope_name",
		"scope.name",
		"instrumentation_scope_name",
	]);
	const scopeVersion = detailValue(observation, metadata.value, [
		"scope_version",
		"scope.version",
		"instrumentation_scope_version",
	]);
	const events = Array.isArray(eventEntries)
		? eventEntries
		: Array.isArray(objectValue(observation, "events"))
			? objectValue(observation, "events")
			: [];
	const links = Array.isArray(linkEntries)
		? linkEntries
		: Array.isArray(objectValue(observation, "links"))
			? objectValue(observation, "links")
			: [];

	async function copy(value: string, label: string) {
		const result = await copyText(value);
		setCopyMessage(
			result.ok
				? `${label} copied`
				: `Unable to copy ${label.toLocaleLowerCase()}`,
		);
	}

	async function copyRawJson() {
		const result = await copyJson(observation);
		setCopyMessage(
			result.ok ? "Observation JSON copied" : "Unable to copy observation JSON",
		);
	}

	async function copyStructuredValue(value: unknown, path: string) {
		const result = await copyJson(value);
		setCopyMessage(
			result.ok
				? `JSON value at ${path} copied`
				: `Unable to copy JSON value at ${path}`,
		);
	}

	function copyStructuredPath(path: string) {
		void copy(path, `JSON path ${path}`);
	}

	function copyAttributeValue(value: unknown, key: string) {
		void copy(printable(value), `${key} value`);
	}

	return (
		<aside
			className="rounded-lg border bg-card"
			data-testid="observation-detail"
			data-observation-id={observation.observation_id}
			onKeyDown={(event) => {
				if (event.key === "Escape" && onClose) {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="truncate font-semibold">
							{typeof observation.name === "string" && observation.name
								? observation.name
								: "(unnamed)"}
						</h2>
						<Badge variant={statusError ? "destructive" : "secondary"}>
							{statusError ? "Error" : "OK"}
						</Badge>
						<Badge variant="outline">{kind.label}</Badge>
					</div>
					<p className="mt-1 font-mono text-xs text-muted-foreground">
						{observation.observation_id}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{actions}
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={copyRawJson}
						data-testid="copy-observation-json"
					>
						<LuClipboard className="h-3.5 w-3.5" aria-hidden="true" />
						Copy JSON
					</Button>
					{onClose && (
						<Button
							type="button"
							size="icon"
							variant="ghost"
							aria-label="Close inspector"
							onClick={onClose}
						>
							<LuX className="h-4 w-4" aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>
			<span className="sr-only" aria-live="polite">
				{copyMessage}
			</span>
			{retainedFieldNotices.length > 0 && (
				<div
					className="mx-4 mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
					role="status"
				>
					{retainedFieldNotices.join(" · ")}
				</div>
			)}

			<Tabs value={tab} onValueChange={setTab} className="p-4">
				<TabsList className="h-auto flex-wrap justify-start">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="input">Input</TabsTrigger>
					<TabsTrigger value="output">Output</TabsTrigger>
					<TabsTrigger value="attributes">Attributes</TabsTrigger>
					<TabsTrigger value="events">Events</TabsTrigger>
					<TabsTrigger value="links">Links</TabsTrigger>
					<TabsTrigger value="resource">Resource</TabsTrigger>
					<TabsTrigger value="metadata">Metadata</TabsTrigger>
				</TabsList>
				<TabsContent
					value="overview"
					className="space-y-3"
					data-testid="detail-overview"
				>
					<MetadataList
						values={[
							{ key: "Trace ID", value: traceId },
							{ key: "Observation ID", value: observation.observation_id },
							{
								key: "Parent observation ID",
								value: observation.parent_observation_id ?? "—",
							},
							{ key: "Type", value: kind.label },
							{ key: "Start", value: observation.start_time ?? "—" },
							{ key: "End", value: observation.end_time ?? "—" },
							{
								key: "Duration",
								value:
									timing.durationMs === null ? "—" : `${timing.durationMs}ms`,
							},
							{ key: "Model", value: observation.model ?? "—" },
							{ key: "Service", value: service ?? "—" },
							{
								key: "Instrumentation scope",
								value:
									[scopeName, scopeVersion].filter(Boolean).join(" @ ") || "—",
							},
						]}
						emptyLabel="No overview data."
					/>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => copy(observation.observation_id, "Observation ID")}
						>
							Copy observation ID
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => copy(traceId, "Trace ID")}
						>
							Copy trace ID
						</Button>
					</div>
				</TabsContent>
				<TabsContent value="input">
					<pre
						className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"
						data-testid="detail-input"
					>
						{typeof observation.input_text === "string" &&
						observation.input_text
							? observation.input_text
							: "—"}
					</pre>
				</TabsContent>
				<TabsContent value="output">
					<pre
						className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"
						data-testid="detail-output"
					>
						{typeof observation.output_text === "string" &&
						observation.output_text
							? observation.output_text
							: "—"}
					</pre>
				</TabsContent>
				<TabsContent value="attributes" className="space-y-3">
					<label className="block">
						<span className="sr-only">Search attributes</span>
						<Input
							type="search"
							value={attributeQuery}
							onChange={(event) => setAttributeQuery(event.target.value)}
							placeholder="Search attributes…"
							aria-label="Search attributes"
							className="h-8 text-xs"
							data-testid="attribute-search"
						/>
					</label>
					<MetadataList
						values={visibleAttributes}
						emptyLabel={
							attributeQuery.trim()
								? "No matching attributes."
								: "No attributes supplied."
						}
						onCopyValue={copyAttributeValue}
						onCopyJsonValue={copyStructuredValue}
						onCopyPath={copyStructuredPath}
						structuredValues
					/>
				</TabsContent>
				<TabsContent value="events" data-testid="detail-events">
					<MetadataList
						values={detailEntries(events, "Event")}
						emptyLabel="No events supplied."
						onCopyValue={copyAttributeValue}
						onCopyJsonValue={copyStructuredValue}
						onCopyPath={copyStructuredPath}
						structuredValues
					/>
				</TabsContent>
				<TabsContent value="links" data-testid="detail-links">
					<MetadataList
						values={detailEntries(links, "Link")}
						emptyLabel="No links supplied."
						onCopyValue={copyAttributeValue}
						onCopyJsonValue={copyStructuredValue}
						onCopyPath={copyStructuredPath}
						structuredValues
					/>
				</TabsContent>
				<TabsContent value="resource">
					<MetadataList
						values={objectEntries(resource)}
						emptyLabel="No resource attributes supplied."
						onCopyValue={copyAttributeValue}
						onCopyJsonValue={copyStructuredValue}
						onCopyPath={copyStructuredPath}
						structuredValues
					/>
				</TabsContent>
				<TabsContent value="metadata">
					<div data-testid="detail-metadata" className="max-h-80 overflow-auto">
						{metadata.state === "valid" ? (
							<JsonTree
								value={metadata.value}
								rootLabel="Metadata"
								onCopyValue={copyStructuredValue}
								onCopyPath={copyStructuredPath}
								expandAllByDefault
							/>
						) : (
							<p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
								{metadataFallback(metadata)}
							</p>
						)}
					</div>
				</TabsContent>
			</Tabs>
			{observation.type === "generation" && (
				<div className="px-4 pb-4">
					<PromptProvenanceCard provenance={promptProvenance} />
				</div>
			)}
		</aside>
	);
}
