import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	FilterableTable,
	type ColumnDef,
	type FilterFieldDef,
} from "../components/FilterableTable";
import { toApiParams, type TimeRange } from "../components/TimeRangePicker";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { DialogContent, DialogOverlay } from "../components/ui/dialog";
import { listLogs, type LogRecord, type ListLogsParams } from "../lib/api";
import {
	parseObservabilitySearch,
	serializeObservabilitySearch,
} from "../lib/observability-search";

export function logTimestamp(nano: string): string {
	try {
		const value = BigInt(nano);
		return `${new Date(Number(value / 1_000_000_000n) * 1000).toISOString().slice(0, 19)}.${(value % 1_000_000_000n).toString().padStart(9, "0")}Z`;
	} catch {
		return nano;
	}
}

const fields: FilterFieldDef[] = [
	{ key: "severity_text", placeholder: "e.g. WARN" },
	{
		key: "trace_id",
		placeholder: "32-character trace ID",
		validate: (value) =>
			value && !/^[a-f0-9]{32}$/i.test(value)
				? "Enter a 32-character hexadecimal trace ID"
				: undefined,
	},
	{ key: "q", label: "Body", placeholder: "Search retained log body" },
];

function logBodyPreview(body: LogRecord["body"]): string {
	const text = body.stringValue ?? JSON.stringify(body);
	const characters = Array.from(text);
	return characters.length > 200
		? `${characters.slice(0, 200).join("")}…`
		: text;
}

const columns: ColumnDef<LogRecord>[] = [
	{
		header: "Time (UTC)",
		width: "w-[280px]",
		cell: (log) => (
			<span className="font-mono text-xs">
				{logTimestamp(log.effective_time_unix_nano)}
			</span>
		),
	},
	{
		header: "Severity",
		width: "w-[140px]",
		cell: (log) => (
			<Badge variant={log.severity_number >= 17 ? "destructive" : "outline"}>
				{log.severity_text || `Level ${log.severity_number}`}
			</Badge>
		),
	},
	{
		header: "Trace",
		width: "w-[180px]",
		cell: (log) => (
			<span className="font-mono text-xs" title={log.trace_id ?? undefined}>
				{log.trace_id ? `${log.trace_id.slice(0, 16)}…` : "Uncorrelated"}
			</span>
		),
	},
	{
		header: "Body",
		className: "max-w-md truncate text-xs",
		cell: (log) => logBodyPreview(log.body),
	},
];

export function LogsTab() {
	const { selectedProjectId } = useProjectSelection();
	return (
		<ProjectLogs
			key={selectedProjectId ?? "none"}
			projectId={selectedProjectId}
		/>
	);
}

function ProjectLogs({ projectId }: { projectId: string | null | undefined }) {
	const location = useLocation();
	const [search, setSearch] = React.useState(() => window.location.search);
	const [reset, setReset] = React.useState(0);
	const routerSearch = React.useRef(location.searchStr);
	React.useEffect(() => {
		if (routerSearch.current === location.searchStr) return;
		routerSearch.current = location.searchStr;
		setSearch(location.searchStr);
		setReset((value) => value + 1);
	}, [location.searchStr]);
	React.useEffect(() => {
		const restore = () => {
			setSearch(window.location.search);
			setReset((value) => value + 1);
		};
		window.addEventListener("popstate", restore);
		return () => window.removeEventListener("popstate", restore);
	}, []);
	const initial = React.useMemo(
		() =>
			parseObservabilitySearch(
				search,
				"logs",
				fields.map((field) => field.key),
			),
		[search],
	);
	const [filters, setFilters] = React.useState(initial.filters);
	const [range, setRange] = React.useState<TimeRange>(initial.timeRange);
	const [selectedRecord, setSelectedRecord] = React.useState<LogRecord | null>(
		null,
	);
	const params: ListLogsParams = React.useMemo(() => {
		const time = toApiParams(range);
		return {
			project_id: projectId ?? "",
			limit: 50,
			severity_text: filters.severity_text || undefined,
			trace_id: filters.trace_id || undefined,
			q: filters.q || undefined,
			time_from: time.time_from
				? `${time.time_from.replace(" ", "T")}Z`
				: undefined,
			time_to: time.time_to ? `${time.time_to.replace(" ", "T")}Z` : undefined,
		};
	}, [projectId, filters, range]);
	const query = useInfiniteQuery({
		queryKey: ["logs", params],
		enabled: Boolean(projectId),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => listLogs({ ...params, cursor: pageParam }),
		getNextPageParam: (last) => last.next_cursor,
	});
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	const selected =
		!query.isError && selectedRecord && items.includes(selectedRecord)
			? selectedRecord
			: null;
	React.useEffect(() => {
		if (query.isError) setSelectedRecord(null);
	}, [query.isError]);
	const onFiltersChange = React.useCallback(
		(next: Record<string, string>, timeRange: TimeRange) => {
			setFilters(next);
			setRange(timeRange);
			setSelectedRecord(null);
			const current = window.location.search;
			const updated = serializeObservabilitySearch(current, "logs", {
				filters: next,
				timeRange,
			});
			if (updated !== current)
				window.history.pushState(
					{},
					"",
					`${window.location.pathname}${updated}`,
				);
			setSearch(updated);
		},
		[],
	);
	return (
		<>
			<FilterableTable<LogRecord>
				key={reset}
				title="Logs"
				noun={{ singular: "log", plural: "logs" }}
				headerActions={
					<Button
						type="button"
						variant="outline"
						disabled={query.isFetching || !projectId}
						onClick={() => void query.refetch()}
					>
						Refresh
					</Button>
				}
				emptyHint={
					<>
						No logs yet. Send an OTLP log export to <code>/v1/logs</code> with
						this Project’s ingestion credentials.
					</>
				}
				noMatchMessage="No logs match the current filters."
				columns={columns}
				filterFields={fields}
				initialFilters={initial.filters}
				initialTimeRange={initial.timeRange}
				items={items}
				total={query.data?.pages[0]?.total ?? 0}
				isLoading={query.isLoading}
				isError={query.error}
				hasNextPage={Boolean(query.hasNextPage)}
				onLoadMore={() => {
					if (query.hasNextPage && !query.isFetching)
						void query.fetchNextPage();
				}}
				onRetry={() => void query.refetch()}
				rowKey={(log) => `${log.log_id}:${items.indexOf(log)}`}
				onRowClick={setSelectedRecord}
				onFiltersChange={onFiltersChange}
			/>
			{selected && (
				<DialogOverlay onEscape={() => setSelectedRecord(null)}>
					<DialogContent
						role="dialog"
						aria-modal="true"
						aria-labelledby="log-detail-title"
						className="max-w-3xl space-y-6"
					>
						<div className="flex items-center justify-between gap-4">
							<h2 id="log-detail-title" className="text-xl font-semibold">
								Log record
							</h2>
							<Button
								type="button"
								variant="outline"
								onClick={() => setSelectedRecord(null)}
							>
								Close
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Nanosecond fields are exact decimal strings. A missing event time
							uses observed time, then receipt time for ordering.
						</p>
						{selected.trace_id && (
							<a
								className="text-sm text-link underline"
								href={`/observability/traces/${encodeURIComponent(selected.trace_id)}${selected.span_id ? `?span=${encodeURIComponent(selected.span_id)}` : ""}`}
							>
								Inspect correlated trace
							</a>
						)}
						<pre
							tabIndex={0}
							aria-label="Full retained log record"
							className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed"
						>
							{JSON.stringify(selected, null, 2)}
						</pre>
					</DialogContent>
				</DialogOverlay>
			)}
		</>
	);
}
