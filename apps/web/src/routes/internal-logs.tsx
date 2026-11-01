import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
	FilterableTable,
	type ColumnDef,
	type FilterFieldDef,
} from "../components/FilterableTable";
import type { TimeRange } from "../components/TimeRangePicker";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DialogContent, DialogOverlay } from "../components/ui/dialog";
import { PageHeader } from "../components/ui/page-header";
import {
	ApiError,
	getCurrentActor,
	listInternalLogs,
	type InternalLogEntry,
} from "../lib/api";

const PAGE_SIZE = 50;
const FILTER_FIELDS: FilterFieldDef[] = [
	{
		key: "level",
		placeholder: "debug, info, warn, or error",
		validate: (value) =>
			value.trim() && !level(value.trim())
				? "Enter debug, info, warn, or error."
				: undefined,
	},
	{
		key: "source",
		placeholder: "api",
		validate: (value) =>
			value.trim().length > 80 ? "Use at most 80 characters." : undefined,
	},
	{
		key: "search",
		placeholder: "Search safe message and context",
		validate: (value) =>
			value.trim().length > 256 ? "Use at most 256 characters." : undefined,
	},
];

const COLUMNS: ColumnDef<InternalLogEntry>[] = [
	{
		header: "Time (local)",
		width: "w-[190px]",
		cell: (entry) => {
			const timestamp = new Date(entry.recorded_at);
			const localTime = timestamp.toLocaleString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				second: "2-digit",
				timeZoneName: "short",
			});
			return (
				<time
					dateTime={entry.recorded_at}
					title={entry.recorded_at}
					aria-label={`Recorded ${localTime} (local time)`}
					className="font-mono text-xs"
				>
					{localTime}
				</time>
			);
		},
	},
	{
		header: "Severity",
		width: "w-[105px]",
		cell: (entry) => (
			<Badge
				variant={
					entry.severity === "error"
						? "destructive"
						: entry.severity === "warn"
							? "outline"
							: "secondary"
				}
			>
				{entry.severity}
			</Badge>
		),
	},
	{
		header: "Source",
		width: "w-[100px]",
		cell: (entry) => <span className="font-mono text-xs">{entry.source}</span>,
	},
	{
		header: "Message",
		cell: (entry) => <span className="text-sm">{entry.message}</span>,
	},
];

function timeParams(range: TimeRange): {
	time_from?: string;
	time_to?: string;
} {
	if (range.kind === "all") return {};
	if (range.kind === "last") {
		const now = new Date();
		return {
			time_from: new Date(now.getTime() - range.minutes * 60_000).toISOString(),
			time_to: now.toISOString(),
		};
	}
	const from = new Date(range.from);
	const to = new Date(range.to);
	return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
		? {}
		: { time_from: from.toISOString(), time_to: to.toISOString() };
}

function level(value: string): InternalLogEntry["severity"] | undefined {
	return ["debug", "info", "warn", "error"].includes(value)
		? (value as InternalLogEntry["severity"])
		: undefined;
}

export function InternalLogsPage() {
	const actorQuery = useQuery({ queryKey: ["me"], queryFn: getCurrentActor });
	const [filters, setFilters] = React.useState<Record<string, string>>({});
	const [timeRange, setTimeRange] = React.useState<TimeRange>({ kind: "all" });
	const [selected, setSelected] = React.useState<InternalLogEntry | null>(null);
	const params = React.useMemo(
		() => ({
			limit: PAGE_SIZE,
			level: level(filters.level?.trim() ?? ""),
			source: filters.source?.trim() || undefined,
			q: filters.search?.trim() || undefined,
			...timeParams(timeRange),
		}),
		[filters, timeRange],
	);
	const query = useInfiniteQuery({
		queryKey: ["admin", "internal-logs", params],
		queryFn: ({ pageParam }) =>
			listInternalLogs({ ...params, cursor: pageParam as string | undefined }),
		initialPageParam: undefined as string | undefined,
		enabled: actorQuery.data?.organization_role === "admin",
		getNextPageParam: (page) => page.next_cursor,
	});
	const entries = React.useMemo(() => {
		const seen = new Set<string>();
		return (query.data?.pages ?? []).flatMap((page) =>
			page.items.filter((entry) => {
				if (seen.has(entry.id)) return false;
				seen.add(entry.id);
				return true;
			}),
		);
	}, [query.data]);
	const total = query.data?.pages[0]?.total ?? 0;
	const sourceUnavailableError =
		query.error instanceof ApiError && query.error.status === 503
			? query.error
			: null;

	if (actorQuery.isLoading) return <div aria-busy="true" className="h-40" />;
	if (actorQuery.isError || !actorQuery.data)
		return (
			<div className="space-y-6">
				<PageHeader title="Logs" description="Internal operational records." />
				<div className="space-y-3" role="alert">
					<p className="text-sm text-destructive">
						Access status could not be loaded.
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => void actorQuery.refetch()}
					>
						Retry
					</Button>
				</div>
			</div>
		);
	if (actorQuery.data.organization_role !== "admin")
		return (
			<div className="space-y-6">
				<PageHeader title="Logs" description="Internal operational records." />
				<p className="text-sm text-muted-foreground">
					Logs are restricted to Organization Admins.
				</p>
			</div>
		);

	return (
		<div className="space-y-4">
			<PageHeader
				title="Logs"
				description="Retained API operational records for this Organization. Sensitive values are removed before collection."
			/>
			{sourceUnavailableError ? (
				<section
					className="rounded-lg border border-border bg-muted/30 p-6"
					role="status"
				>
					<h2 className="font-medium">Log source unavailable</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{sourceUnavailableError.message} Try again; contact the deployment
						operator if the problem persists.
					</p>
					<Button
						className="mt-4"
						variant="outline"
						onClick={() => void query.refetch()}
					>
						Retry
					</Button>
				</section>
			) : (
				<>
					<FilterableTable<InternalLogEntry>
						title="Operational logs"
						noun={{ singular: "log entry", plural: "log entries" }}
						emptyHint="No retained API operational logs are available for this Organization."
						noMatchMessage="No logs match the current filters."
						columns={COLUMNS}
						filterFields={FILTER_FIELDS}
						items={entries}
						total={total}
						isLoading={query.isLoading || query.isFetchingNextPage}
						isError={(query.error as Error | null) ?? null}
						hasNextPage={Boolean(query.hasNextPage)}
						onLoadMore={() => {
							if (query.hasNextPage && !query.isFetchingNextPage)
								void query.fetchNextPage();
						}}
						onRetry={() => void query.refetch()}
						rowKey={(entry) => entry.id}
						onRowClick={setSelected}
						onFiltersChange={(next, range) => {
							setFilters(next);
							setTimeRange(range);
						}}
					/>
					{!query.error && (
						<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
							<span>
								{entries.length > 0 &&
								!query.hasNextPage &&
								!query.isFetchingNextPage
									? "End of retained results."
									: "Scroll to load more, or use the button."}
							</span>
							{query.hasNextPage ? (
								<Button
									variant="outline"
									disabled={query.isFetchingNextPage}
									onClick={() => void query.fetchNextPage()}
								>
									Load more logs
								</Button>
							) : null}
						</div>
					)}
				</>
			)}
			{selected ? (
				<ContextDialog entry={selected} onClose={() => setSelected(null)} />
			) : null}
		</div>
	);
}

function ContextDialog({
	entry,
	onClose,
}: {
	entry: InternalLogEntry;
	onClose: () => void;
}) {
	return (
		<DialogOverlay onClick={onClose} onEscape={onClose}>
			<DialogContent
				role="dialog"
				aria-modal="true"
				aria-labelledby="log-context-title"
				className="max-w-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 id="log-context-title" className="font-semibold">
							Safe log context
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							{entry.message}
						</p>
					</div>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
				</div>
				<pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
					{JSON.stringify(entry.context, null, 2)}
				</pre>
			</DialogContent>
		</DialogOverlay>
	);
}
