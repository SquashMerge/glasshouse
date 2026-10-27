import * as React from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LuActivity, LuListTree } from "react-icons/lu";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import {
	FilterableTable,
	type ColumnDef,
	type FilterFieldDef,
} from "../components/FilterableTable";
import { StreamToggle } from "../components/StreamToggle";
import { SseDebugOverlay } from "../components/SseDebugOverlay";
import {
	ApiError,
	listTraces,
	listObservations,
	type ListTracesParams,
	type ListObservationsParams,
	type TraceRow,
	type ObservationRow,
	normalizeObservationMetadata,
	type ObservationMetadata,
	type ObservationMetadataInput,
} from "../lib/api";
import {
	defaultRange,
	toApiParams,
	type TimeRange,
} from "../components/TimeRangePicker";
import { useEventSource } from "../hooks/useEventSource";
import { useProjectSelection } from "../components/ProjectProvider";
import { copyText } from "../lib/clipboard";
import {
	parseObservabilitySearch,
	serializeObservabilitySearch,
} from "../lib/observability-search";
type Tab = "traces" | "spans";

const VALID_TABS = new Set<Tab>(["traces", "spans"]);

export function ObservabilityPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const searchParams = new URLSearchParams(location.searchStr);
	const rawTab = searchParams.get("tab");
	const tab: Tab = VALID_TABS.has(rawTab as Tab) ? (rawTab as Tab) : "traces";

	function setTab(next: Tab) {
		const nextSearch = Object.fromEntries(searchParams.entries());
		navigate({
			to: "/observability",
			search: { ...nextSearch, tab: next },
		});
	}

	return (
		<div className="space-y-4">
			<Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
				<TabsList>
					<TabsTrigger value="traces" className="gap-1.5">
						<LuListTree className="h-3.5 w-3.5" />
						Traces
					</TabsTrigger>
					<TabsTrigger value="spans" className="gap-1.5">
						<LuActivity className="h-3.5 w-3.5" />
						Spans
					</TabsTrigger>
				</TabsList>

				<TabsContent value="traces">
					{tab === "traces" ? <TracesTab /> : null}
				</TabsContent>
				<TabsContent value="spans">
					{tab === "spans" ? <SpansTab /> : null}
				</TabsContent>
			</Tabs>
		</div>
	);
}

const TRACE_COLUMNS: ColumnDef<TraceRow>[] = [
	{
		header: "Time",
		width: "w-[180px]",
		cell: (t) => (
			<span className="font-mono text-xs">
				{new Date(t.start_time).toLocaleString()}
			</span>
		),
	},
	{
		header: "Name",
		width: "w-[180px]",
		cell: (t) => <span className="font-medium">{t.name}</span>,
	},
	{
		header: "Agent",
		width: "w-[160px]",
		className: "text-xs text-muted-foreground",
		cell: (t) => t.agent_id || "—",
	},
	{
		header: "Status",
		width: "w-[100px]",
		cell: (t) => (
			<Badge variant={t.status === "error" ? "destructive" : "success"}>
				{t.status}
			</Badge>
		),
	},
	{
		header: "Duration",
		width: "w-[110px]",
		className: "text-xs",
		cell: (t) => (t.duration_ms !== null ? `${t.duration_ms}ms` : "—"),
	},
	{
		header: "Score",
		width: "w-[180px]",
		className: "text-xs text-muted-foreground",
		cell: (t) => t.scores_summary || "—",
	},
	{
		header: "Input excerpt",
		className: "max-w-md truncate text-xs text-muted-foreground",
		cell: (t) => t.input_text || "—",
	},
];

const TRACE_FILTER_FIELDS: FilterFieldDef[] = [
	{ key: "name", placeholder: "e.g. llm.call or tool.search_db" },
	{ key: "agent_id", placeholder: "e.g. code-reviewer" },
	{ key: "status", placeholder: "ok / error", className: "font-mono" },
	{
		key: "duration",
		placeholder: "e.g. <500 or >1000",
		className: "font-mono",
	},
	{ key: "scores", placeholder: "e.g. input_tokens", className: "font-mono" },
	{ key: "input_text", placeholder: "e.g. recruiter or SQL" },
];

function buildTraceApiParams(
	filters: Record<string, string>,
	timeRange: TimeRange,
): Omit<ListTracesParams, "project_id" | "cursor" | "limit" | "offset"> {
	const out: Omit<
		ListTracesParams,
		"project_id" | "cursor" | "limit" | "offset"
	> = {};
	if (filters.name) out.name = filters.name;
	if (filters.agent_id) out.agent_id = filters.agent_id;
	if (filters.status) out.status = filters.status;
	if (filters.duration) out.duration = filters.duration;
	if (filters.scores) out.scores = filters.scores;
	if (filters.input_text) out.input_text = filters.input_text;
	const tr = toApiParams(timeRange);
	if (tr.time_from) out.time_from = tr.time_from;
	if (tr.time_to) out.time_to = tr.time_to;
	return out;
}

export interface TraceEvent {
	trace_id: string;
	project_id: string;
	name: string;
	start_time: string;
	end_time?: string | null;
	duration_ms?: number | null;
	status: "ok" | "error";
	user_id?: string;
	session_id?: string;
	agent_id?: string;
	agent_version?: string;
	env?: string;
	tags?: string[];
	input_text?: string;
	output_text?: string;
	scores_summary?: string;
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	input_excerpt_truncated?: boolean;
	output_excerpt_truncated?: boolean;
}

const PAGE_SIZE = 100;

// Cap streamed rows inserted into the visible list. The pending-id set still
// tracks unique rows outside the paginated pages so the total stays accurate.
const VISIBLE_SSE_CAP = 30;

/**
 * Merge paginated + streamed rows into one list deduped by id, sorted by
 * `start_time` DESC so newer items render at the top regardless of source.
 * Matches the order returned by the REST `listTraces` / `listObservations`
 * endpoints, so live view and reload look the same.
 */
function mergeByStartDesc<TRow extends { start_time: string }>(
	keyOf: (row: TRow) => string,
	paginated: ReadonlyArray<TRow>,
	streamed: ReadonlyMap<string, TRow>,
): TRow[] {
	const map = new Map<string, TRow>();
	for (const r of paginated) map.set(keyOf(r), r);
	for (const r of streamed.values()) map.set(keyOf(r), r);
	return Array.from(map.values()).sort(
		(a, b) =>
			b.start_time.localeCompare(a.start_time) ||
			keyOf(b).localeCompare(keyOf(a)),
	);
}

interface LiveRows<TRow> {
	scope: string;
	rows: Map<string, TRow>;
	pendingIds: Set<string>;
	highlightVersions: Map<string, number>;
}

function emptyLiveRows<TRow>(scope: string): LiveRows<TRow> {
	return {
		scope,
		rows: new Map<string, TRow>(),
		pendingIds: new Set<string>(),
		highlightVersions: new Map<string, number>(),
	};
}

function countPending(
	pendingIds: ReadonlySet<string>,
	paginatedIds: ReadonlySet<string>,
): number {
	let count = pendingIds.size;
	for (const id of paginatedIds) {
		if (pendingIds.has(id)) count -= 1;
	}
	return count;
}

function matchesDuration(
	value: number | null | undefined,
	filter?: string,
): boolean {
	if (!filter) return true;
	if (value === null || value === undefined) return false;
	const match = /^(<=|<|>=|>|=)?\s*(\d+(?:\.\d+)?)$/.exec(filter.trim());
	if (!match) return true;
	const expected = Number(match[2]);
	switch (match[1] ?? "=") {
		case "<":
			return value < expected;
		case "<=":
			return value <= expected;
		case ">":
			return value > expected;
		case ">=":
			return value >= expected;
		default:
			return value === expected;
	}
}

function includesFolded(
	value: string | null | undefined,
	filter?: string,
): boolean {
	return (
		!filter ||
		(value ?? "").toLocaleLowerCase().includes(filter.toLocaleLowerCase())
	);
}

function matchesTimeRange(
	startTime: string,
	range: TimeRange,
	params?: { time_from?: string; time_to?: string },
): boolean {
	if (range.kind === "last") {
		const cutoff = new Date(Date.now() - range.minutes * 60_000);
		const cutoffText = cutoff.toISOString().replace("T", " ").replace("Z", "");
		return startTime >= cutoffText;
	}
	if (params?.time_from && startTime < params.time_from) return false;
	if (params?.time_to && startTime > params.time_to) return false;
	return true;
}

function matchesTraceEvent(
	event: TraceEvent,
	params: ListTracesParams | undefined,
	range: TimeRange,
): boolean {
	return (
		(!params?.env || event.env === params.env) &&
		(!params?.agent_id || event.agent_id === params.agent_id) &&
		(!params?.status || event.status === params.status) &&
		includesFolded(event.name, params?.name) &&
		includesFolded(event.scores_summary, params?.scores) &&
		includesFolded(event.input_text, params?.input_text) &&
		matchesDuration(event.duration_ms, params?.duration) &&
		matchesTimeRange(event.start_time, range, params)
	);
}

function matchesObservationEvent(
	event: ObservationEvent,
	params: ListObservationsParams | undefined,
	range: TimeRange,
): boolean {
	return (
		(!params?.trace_id || event.trace_id === params.trace_id) &&
		(!params?.type || event.type === params.type) &&
		(!params?.status || event.status === params.status) &&
		includesFolded(event.name, params?.name) &&
		includesFolded(event.model, params?.model) &&
		includesFolded(event.input_text, params?.input_text) &&
		includesFolded(metadataSearchText(event.metadata), params?.agent_id) &&
		matchesDuration(event.duration_ms, params?.duration) &&
		matchesTimeRange(event.start_time, range, params)
	);
}

/**
 * Hook that owns the data fetch for TracesTab and the SSE merge.
 */
function useTracesData() {
	const { selectedProjectId } = useProjectSelection();
	const [filters, setFilters] = React.useState<Record<string, string>>(() =>
		emptyFilters(TRACE_FILTER_FIELDS),
	);
	const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
	const [debouncedFilters, setDebouncedFilters] =
		React.useState<Record<string, string>>(filters);
	const [debouncedTimeRange, setDebouncedTimeRange] =
		React.useState<TimeRange>(timeRange);

	React.useEffect(() => {
		const t = window.setTimeout(() => {
			setDebouncedFilters(filters);
			setDebouncedTimeRange(timeRange);
		}, 250);
		return () => window.clearTimeout(t);
	}, [filters, timeRange]);

	const apiParams = React.useMemo(
		() =>
			selectedProjectId
				? {
						...buildTraceApiParams(debouncedFilters, debouncedTimeRange),
						project_id: selectedProjectId,
					}
				: undefined,
		[debouncedFilters, debouncedTimeRange, selectedProjectId],
	);
	const streamScope = JSON.stringify(apiParams ?? null);

	// SSE-only live updates — no `refetchInterval` polling. The hook below
	// returns `{status, paused, lastEventAt, reconnect}` for the Live/Pause UX.
	// If the SSE pipe is closed for too long the user sees a "Reconnecting" pill;
	// the only "fallback" is for the user to hit Refresh or wait for SSE to
	// reconnect (the hook handles exponential backoff).
	const query = useInfiniteQuery({
		queryKey: ["traces", apiParams],
		queryFn: ({ pageParam }) =>
			listTraces({
				...apiParams!,
				cursor: pageParam as string | undefined,
			}),
		initialPageParam: undefined as string | undefined,
		enabled: Boolean(selectedProjectId),
		getNextPageParam: (lastPage: {
			items: TraceRow[];
			total: number;
			next_cursor?: string;
		}) => lastPage.next_cursor,
	});

	// Dedup across pages defensively. Keyset traversal prevents inserts above the
	// prior boundary from shifting later pages, while trace retries can still
	// duplicate a stored id.
	const paginated = React.useMemo(() => {
		const ids = new Set<string>();
		const out: TraceRow[] = [];
		for (const p of query.data?.pages ?? []) {
			for (const t of p.items) {
				if (ids.has(t.trace_id)) continue;
				ids.add(t.trace_id);
				out.push(t);
			}
		}
		return out;
	}, [query.data]);
	const paginatedTotal = query.data?.pages[0]?.total ?? 0;

	const paginatedIds = React.useMemo(() => {
		const s = new Set<string>();
		for (const t of paginated) s.add(t.trace_id);
		return s;
	}, [paginated]);

	const [liveRows, setLiveRows] = React.useState<LiveRows<TraceRow>>(() =>
		emptyLiveRows(streamScope),
	);
	const activeLiveRows =
		liveRows.scope === streamScope
			? liveRows
			: emptyLiveRows<TraceRow>(streamScope);

	// Visibility-aware: only subscribe to the SSE feed while the tab is visible.
	// The real `useEventSource` hook reads `enabled` to skip subscribe work and
	// disconnect. The hook's return value drives the Live/Pause/Reconnecting
	// indicator in the table header.
	const [enabled, setEnabled] = React.useState<boolean>(() =>
		typeof document === "undefined"
			? true
			: document.visibilityState !== "hidden",
	);
	React.useEffect(() => {
		if (typeof document === "undefined") return;
		const onVis = () => setEnabled(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);

	const sse = useEventSource(
		selectedProjectId
			? `/v1/traces/events?project_id=${encodeURIComponent(selectedProjectId)}`
			: "",
		{
			enabled: enabled && Boolean(selectedProjectId),
			onMessage: (msg) => {
				const { trace: event } = msg.data as { trace: TraceEvent };
				if (event.project_id !== selectedProjectId) return;
				if (!matchesTraceEvent(event, apiParams, debouncedTimeRange)) return;
				const id = event.trace_id;
				const row: TraceRow = {
					trace_id: event.trace_id,
					project_id: event.project_id,
					name: event.name,
					start_time: event.start_time,
					end_time: event.end_time ?? null,
					duration_ms: event.duration_ms ?? null,
					status: event.status,
					user_id: event.user_id ?? "",
					session_id: event.session_id ?? "",
					agent_id: event.agent_id ?? "",
					agent_version: event.agent_version ?? "",
					env: event.env ?? "",
					tags: event.tags ?? [],
					input_text: event.input_text ?? "",
					output_text: event.output_text ?? "",
					scores_summary: event.scores_summary ?? "",
					input_retained_truncated: event.input_retained_truncated,
					output_retained_truncated: event.output_retained_truncated,
					input_excerpt_truncated: event.input_excerpt_truncated,
					output_excerpt_truncated: event.output_excerpt_truncated,
				};
				setLiveRows((previous) => {
					const current =
						previous.scope === streamScope
							? previous
							: emptyLiveRows<TraceRow>(streamScope);
					const rows = new Map(current.rows);
					rows.delete(id);
					rows.set(id, row);
					if (rows.size > VISIBLE_SSE_CAP)
						rows.delete(rows.keys().next().value!);

					const pendingIds = current.pendingIds;
					if (!paginatedIds.has(id)) pendingIds.add(id);

					const highlightVersions = new Map(current.highlightVersions);
					highlightVersions.delete(id);
					highlightVersions.set(
						id,
						(current.highlightVersions.get(id) ?? 0) + 1,
					);
					if (highlightVersions.size > VISIBLE_SSE_CAP) {
						highlightVersions.delete(highlightVersions.keys().next().value!);
					}
					return { scope: streamScope, rows, pendingIds, highlightVersions };
				});
			},
		},
	);

	// Merge paginated + capped streamed rows; sort by start_time DESC so the
	// live view matches the order returned by the REST endpoint on reload.
	const merged = React.useMemo(
		() => mergeByStartDesc((t) => t.trace_id, paginated, activeLiveRows.rows),
		[paginated, activeLiveRows.rows],
	);
	const pendingCount = countPending(activeLiveRows.pendingIds, paginatedIds);
	const total = paginatedTotal + pendingCount;

	// FilterableTable owns the raw filter inputs (uncontrolled) and debounces
	// them. The host receives the debounced values here and feeds them into
	// `filters` / `timeRange` state so the query key changes.
	const onFiltersChange = React.useCallback(
		(next: Record<string, string>, tr: TimeRange) => {
			setFilters(next);
			setTimeRange(tr);
		},
		[],
	);

	return {
		merged,
		total,
		isLoading: query.isLoading,
		isError: (query.error as Error | null) ?? null,
		hasNextPage: Boolean(query.hasNextPage),
		isFetchingNextPage: query.isFetchingNextPage,
		fetchNextPage: () => {
			if (query.hasNextPage && !query.isFetchingNextPage)
				void query.fetchNextPage();
		},
		refetch: query.refetch,
		highlightVersions: activeLiveRows.highlightVersions,
		filters,
		setFilters,
		timeRange,
		setTimeRange,
		onFiltersChange,
		sse,
	};
}

function useUrlBackedListState(
	prefix: "traces" | "spans",
	filterFields: readonly FilterFieldDef[],
) {
	const location = useLocation();
	const [search, setSearch] = React.useState(location.searchStr);

	React.useEffect(() => setSearch(location.searchStr), [location.searchStr]);
	React.useEffect(() => {
		const onPopState = () => setSearch(window.location.search);
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	const filterKeys = React.useMemo(
		() => filterFields.map((field) => field.key),
		[filterFields],
	);
	const state = React.useMemo(
		() => parseObservabilitySearch(search, prefix, filterKeys),
		[filterKeys, prefix, search],
	);
	const persist = React.useCallback(
		(filters: Record<string, string>, timeRange: TimeRange) => {
			const next = serializeObservabilitySearch(search, prefix, {
				filters,
				timeRange,
			});
			if (next === search) return;
			window.history.pushState({}, "", `${window.location.pathname}${next}`);
			setSearch(next);
		},
		[prefix, search],
	);

	return { search, state, persist };
}

function CopyActiveLink() {
	const [message, setMessage] = React.useState("");
	return (
		<span className="inline-flex items-center gap-1">
			<button
				type="button"
				className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => {
					void copyText(window.location.href).then((result) =>
						setMessage(result.ok ? "Link copied" : "Could not copy link"),
					);
				}}
			>
				Copy link
			</button>
			{message && (
				<span className="text-xs text-muted-foreground" role="status">
					{message}
				</span>
			)}
		</span>
	);
}

/** TracesTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function TracesTab() {
	const navigate = useNavigate();
	const data = useTracesData();
	const {
		search: urlSearch,
		state: urlState,
		persist: persistUrlState,
	} = useUrlBackedListState("traces", TRACE_FILTER_FIELDS);
	const onFiltersChange = React.useCallback(
		(filters: Record<string, string>, timeRange: TimeRange) => {
			data.onFiltersChange(filters, timeRange);
			persistUrlState(filters, timeRange);
		},
		[data.onFiltersChange, persistUrlState],
	);

	return (
		<>
			<FilterableTable<TraceRow>
				key={urlSearch}
				title="Traces"
				headerActions={
					<>
						<StreamToggle sse={data.sse} />
						<CopyActiveLink />
					</>
				}
				noun={{ singular: "trace", plural: "traces" }}
				emptyHint={
					<>
						No traces yet. Send one to <code>/v1/otel/v1/traces</code> to get
						started.
					</>
				}
				noMatchMessage="No traces match the current filters."
				columns={TRACE_COLUMNS}
				filterFields={TRACE_FILTER_FIELDS}
				initialFilters={urlState.filters}
				initialTimeRange={urlState.timeRange}
				items={data.merged}
				total={data.total}
				isLoading={data.isLoading}
				isError={data.isError}
				hasNextPage={data.hasNextPage}
				onLoadMore={data.fetchNextPage}
				onRetry={
					data.isError instanceof ApiError && data.isError.status === 500
						? () => void data.refetch()
						: undefined
				}
				highlightedVersions={data.highlightVersions}
				rowKey={(t) => t.trace_id}
				onFiltersChange={onFiltersChange}
				onRowClick={(t) => {
					navigate({
						to: traceDetailPath(t.trace_id),
						params: { id: t.trace_id },
					});
				}}
			/>
			<SseDebugOverlay sse={data.sse} label="traces" />
		</>
	);
}

const SPAN_COLUMNS: ColumnDef<ObservationRow>[] = [
	{
		header: "Time",
		width: "w-[180px]",
		cell: (o) => (
			<span className="font-mono text-xs">
				{new Date(o.start_time).toLocaleString()}
			</span>
		),
	},
	{
		header: "Type",
		width: "w-[100px]",
		cell: (o) => (
			<Badge
				variant={
					o.type === "tool"
						? "secondary"
						: o.type === "generation"
							? "default"
							: "outline"
				}
			>
				{o.type}
			</Badge>
		),
	},
	{
		header: "Name",
		width: "w-[180px]",
		cell: (o) => <span className="font-medium">{o.name}</span>,
	},
	{
		header: "Trace",
		width: "w-[160px]",
		className: "font-mono text-xs text-muted-foreground",
		cell: (o) => <span title={o.trace_id}>{o.trace_id.slice(0, 16)}…</span>,
	},
	{
		header: "Status",
		width: "w-[100px]",
		cell: (o) => (
			<Badge variant={o.status === "error" ? "destructive" : "success"}>
				{o.status}
			</Badge>
		),
	},
	{
		header: "Duration",
		width: "w-[110px]",
		className: "text-xs",
		cell: (o) => (o.duration_ms !== null ? `${o.duration_ms}ms` : "—"),
	},
	{
		header: "Model",
		width: "w-[160px]",
		className: "text-xs text-muted-foreground",
		cell: (o) => o.model || "—",
	},
	{
		header: "Input excerpt",
		className: "max-w-md truncate text-xs text-muted-foreground",
		cell: (o) => o.input_text || "—",
	},
];

const SPAN_FILTER_FIELDS: FilterFieldDef[] = [
	{
		key: "type",
		placeholder: "span / tool / generation",
		className: "font-mono",
	},
	{ key: "name", placeholder: "e.g. llm.call" },
	{ key: "trace_id", placeholder: "32-char trace id", className: "font-mono" },
	{ key: "status", placeholder: "ok / error", className: "font-mono" },
	{
		key: "duration",
		placeholder: "e.g. <500 or >1000",
		className: "font-mono",
	},
	{ key: "model", placeholder: "e.g. gpt-4o", className: "font-mono" },
	{ key: "input_text", placeholder: "e.g. recruiter or SQL" },
];

function buildSpanApiParams(
	filters: Record<string, string>,
	timeRange: TimeRange,
): Omit<ListObservationsParams, "project_id" | "cursor" | "limit" | "offset"> {
	const out: Omit<
		ListObservationsParams,
		"project_id" | "cursor" | "limit" | "offset"
	> = {};
	if (filters.type) out.type = filters.type;
	if (filters.name) out.name = filters.name;
	if (filters.trace_id) out.trace_id = filters.trace_id;
	if (filters.status) out.status = filters.status;
	if (filters.duration) out.duration = filters.duration;
	if (filters.model) out.model = filters.model;
	if (filters.input_text) out.input_text = filters.input_text;
	const tr = toApiParams(timeRange);
	if (tr.time_from) out.time_from = tr.time_from;
	if (tr.time_to) out.time_to = tr.time_to;
	return out;
}

export interface ObservationEvent {
	observation_id: string;
	trace_id: string;
	project_id: string;
	parent_observation_id?: string | null;
	type: "span" | "event" | "generation" | "tool";
	name: string;
	start_time: string;
	end_time?: string | null;
	duration_ms?: number | null;
	status: "ok" | "error";
	model?: string | null;
	input_text?: string;
	output_text?: string;
	metadataParsed?: ObservationMetadata | null;
	metadata?: ObservationMetadataInput;
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	input_excerpt_truncated?: boolean;
	output_excerpt_truncated?: boolean;
	metadata_truncated?: boolean;
}

function useSpansData() {
	const { selectedProjectId } = useProjectSelection();
	const [filters, setFilters] = React.useState<Record<string, string>>(() =>
		emptyFilters(SPAN_FILTER_FIELDS),
	);
	const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
	const [debouncedFilters, setDebouncedFilters] =
		React.useState<Record<string, string>>(filters);
	const [debouncedTimeRange, setDebouncedTimeRange] =
		React.useState<TimeRange>(timeRange);

	React.useEffect(() => {
		const t = window.setTimeout(() => {
			setDebouncedFilters(filters);
			setDebouncedTimeRange(timeRange);
		}, 250);
		return () => window.clearTimeout(t);
	}, [filters, timeRange]);

	const apiParams = React.useMemo(
		() =>
			selectedProjectId
				? {
						...buildSpanApiParams(debouncedFilters, debouncedTimeRange),
						limit: PAGE_SIZE,
						project_id: selectedProjectId,
					}
				: undefined,
		[debouncedFilters, debouncedTimeRange, selectedProjectId],
	);
	const streamScope = JSON.stringify(apiParams ?? null);

	// SSE-only live updates — no `refetchInterval` polling. The hook returns
	// `{status, paused, lastEventAt, reconnect}` for the Live/Pause UX.
	const query = useInfiniteQuery({
		queryKey: ["observations", apiParams],
		queryFn: ({ pageParam }) =>
			listObservations({
				...apiParams!,
				cursor: pageParam as string | undefined,
			}),
		initialPageParam: undefined as string | undefined,
		enabled: Boolean(selectedProjectId),
		getNextPageParam: (lastPage: {
			items: ObservationRow[];
			total: number;
			next_cursor?: string;
		}) => lastPage.next_cursor,
	});

	// Dedup across pages: see useTracesData.
	const paginated = React.useMemo(() => {
		const ids = new Set<string>();
		const out: ObservationRow[] = [];
		for (const p of query.data?.pages ?? []) {
			for (const o of p.items) {
				if (ids.has(o.observation_id)) continue;
				ids.add(o.observation_id);
				out.push(o);
			}
		}
		return out;
	}, [query.data]);
	const paginatedTotal = query.data?.pages[0]?.total ?? 0;

	const paginatedIds = React.useMemo(() => {
		const s = new Set<string>();
		for (const o of paginated) s.add(o.observation_id);
		return s;
	}, [paginated]);

	const [liveRows, setLiveRows] = React.useState<LiveRows<ObservationRow>>(() =>
		emptyLiveRows(streamScope),
	);
	const activeLiveRows =
		liveRows.scope === streamScope
			? liveRows
			: emptyLiveRows<ObservationRow>(streamScope);

	const [enabled, setEnabled] = React.useState<boolean>(() =>
		typeof document === "undefined"
			? true
			: document.visibilityState !== "hidden",
	);
	React.useEffect(() => {
		if (typeof document === "undefined") return;
		const onVis = () => setEnabled(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);

	const sse = useEventSource(
		selectedProjectId
			? `/v1/observations/events?project_id=${encodeURIComponent(selectedProjectId)}`
			: "",
		{
			enabled: enabled && Boolean(selectedProjectId),
			onMessage: (msg) => {
				const { observation: event } = msg.data as {
					observation: ObservationEvent;
				};
				if (event.project_id !== selectedProjectId) return;
				if (!matchesObservationEvent(event, apiParams, debouncedTimeRange))
					return;
				const id = event.observation_id;
				const row: ObservationRow = {
					observation_id: event.observation_id,
					trace_id: event.trace_id,
					project_id: event.project_id,
					parent_observation_id: event.parent_observation_id ?? null,
					type: event.type,
					name: event.name,
					start_time: event.start_time,
					end_time: event.end_time ?? null,
					duration_ms: event.duration_ms ?? null,
					status: event.status,
					model: event.model ?? null,
					input_text: event.input_text ?? "",
					output_text: event.output_text ?? "",
					metadata: normalizeObservationMetadata(
						event.metadata,
						event.type === "generation",
					),
					input_retained_truncated: event.input_retained_truncated,
					output_retained_truncated: event.output_retained_truncated,
					input_excerpt_truncated: event.input_excerpt_truncated,
					output_excerpt_truncated: event.output_excerpt_truncated,
					metadata_truncated: event.metadata_truncated,
				};
				setLiveRows((previous) => {
					const current =
						previous.scope === streamScope
							? previous
							: emptyLiveRows<ObservationRow>(streamScope);
					const rows = new Map(current.rows);
					rows.delete(id);
					rows.set(id, row);
					if (rows.size > VISIBLE_SSE_CAP)
						rows.delete(rows.keys().next().value!);

					const pendingIds = current.pendingIds;
					if (!paginatedIds.has(id)) pendingIds.add(id);

					const highlightVersions = new Map(current.highlightVersions);
					highlightVersions.delete(id);
					highlightVersions.set(
						id,
						(current.highlightVersions.get(id) ?? 0) + 1,
					);
					if (highlightVersions.size > VISIBLE_SSE_CAP) {
						highlightVersions.delete(highlightVersions.keys().next().value!);
					}
					return { scope: streamScope, rows, pendingIds, highlightVersions };
				});
			},
		},
	);

	const merged = React.useMemo(
		() =>
			mergeByStartDesc((o) => o.observation_id, paginated, activeLiveRows.rows),
		[paginated, activeLiveRows.rows],
	);
	const pendingCount = countPending(activeLiveRows.pendingIds, paginatedIds);
	const total = paginatedTotal + pendingCount;

	// FilterableTable owns the raw filter inputs (uncontrolled) and debounces
	// them. The host receives the debounced values here and feeds them into
	// `filters` / `timeRange` state so the query key changes.
	const onFiltersChange = React.useCallback(
		(next: Record<string, string>, tr: TimeRange) => {
			setFilters(next);
			setTimeRange(tr);
		},
		[],
	);

	return {
		merged,
		total,
		isLoading: query.isLoading,
		isError: (query.error as Error | null) ?? null,
		hasNextPage: Boolean(query.hasNextPage),
		isFetchingNextPage: query.isFetchingNextPage,
		fetchNextPage: () => {
			if (query.hasNextPage && !query.isFetchingNextPage)
				void query.fetchNextPage();
		},
		refetch: query.refetch,
		highlightVersions: activeLiveRows.highlightVersions,
		filters,
		setFilters,
		timeRange,
		setTimeRange,
		onFiltersChange,
		sse,
	};
}

function metadataSearchText(metadata: ObservationMetadataInput): string {
	if (typeof metadata === "string") return metadata;
	if (!metadata) return "";
	try {
		return JSON.stringify(metadata);
	} catch {
		return "";
	}
}

/** SpansTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function SpansTab() {
	const navigate = useNavigate();
	const data = useSpansData();
	const {
		search: urlSearch,
		state: urlState,
		persist: persistUrlState,
	} = useUrlBackedListState("spans", SPAN_FILTER_FIELDS);
	const onFiltersChange = React.useCallback(
		(filters: Record<string, string>, timeRange: TimeRange) => {
			data.onFiltersChange(filters, timeRange);
			persistUrlState(filters, timeRange);
		},
		[data.onFiltersChange, persistUrlState],
	);

	return (
		<>
			<FilterableTable<ObservationRow>
				key={urlSearch}
				title="Spans"
				headerActions={
					<>
						<StreamToggle sse={data.sse} />
						<CopyActiveLink />
					</>
				}
				noun={{ singular: "span", plural: "spans" }}
				emptyHint={
					<>
						No spans yet. Send one to <code>/v1/otel/v1/traces</code> to get
						started.
					</>
				}
				noMatchMessage="No spans match the current filters."
				columns={SPAN_COLUMNS}
				filterFields={SPAN_FILTER_FIELDS}
				initialFilters={urlState.filters}
				initialTimeRange={urlState.timeRange}
				items={data.merged}
				total={data.total}
				isLoading={data.isLoading}
				isError={data.isError}
				hasNextPage={data.hasNextPage}
				onLoadMore={data.fetchNextPage}
				onRetry={() => void data.refetch()}
				highlightedVersions={data.highlightVersions}
				rowKey={(o) => o.observation_id}
				onFiltersChange={onFiltersChange}
				onRowClick={(o) => {
					navigate({
						to: traceDetailPath(o.trace_id),
						params: { id: o.trace_id },
						search: { span: o.observation_id },
					});
				}}
			/>
			<SseDebugOverlay sse={data.sse} label="spans" />
		</>
	);
}

function emptyFilters(fields: FilterFieldDef[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of fields) out[f.key] = "";
	return out;
}

/**
 * Path helper for the trace detail route. The new route is registered
 * under `/observability/traces/$id`; this helper keeps the row-click
 * navigation target in one place so the list pages stay consistent.
 */
function traceDetailPath(traceId: string): string {
	return `/observability/traces/${encodeURIComponent(traceId)}`;
}
