import * as React from "react";
import { LuLoader, LuSearchX, LuX } from "react-icons/lu";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";
import { cn } from "../lib/utils";
import {
	TimeRangePicker,
	defaultRange,
	isTimeRangeValid,
	type TimeRange,
} from "./TimeRangePicker";

export interface ColumnDef<TRow> {
	header: string;
	width?: string;
	className?: string;
	cell: (row: TRow, info: { isNew: boolean }) => React.ReactNode;
}

export interface FilterFieldDef {
	key: string;
	placeholder: string;
	className?: string;
}

/**
 * Presentational list table. The host page owns the data source (HTTP fetch,
 * SSE merge, etc.) and passes rows + loading flags down. FilterableTable keeps
 * the filter inputs, debounce, time-range picker, clear-filters button, and
 * the infinite-scroll sentinel; it surfaces debounced filter changes via
 * `onFiltersChange` so the host can re-run its query.
 */
export interface FilterableTableProps<TRow> {
	title: React.ReactNode;
	/** Optional element rendered to the right of the title (e.g. Live / Pause UX). */
	headerActions?: React.ReactNode;
	noun: { singular: string; plural: string };
	emptyHint: React.ReactNode;
	noMatchMessage: string;
	/** Data columns (rendered as table headers and body cells). */
	columns: ColumnDef<TRow>[];
	/**
	 * Filter input fields. The filter row renders one input per entry, aligned
	 * with the columns. If shorter than columns, the first (columns.length -
	 * filterFields.length) cells are blank spacers — useful when a leading
	 * column (e.g. "Time") has no per-column filter.
	 */
	filterFields: FilterFieldDef[];

	/** Merged, deduplicated rows for the current view (paginated + streamed). */
	items: TRow[];
	/** Total count to display in the "X of Y" counter (host already adds SSE). */
	total: number;
	isLoading: boolean;
	isError: Error | null;
	hasNextPage: boolean;
	onLoadMore: () => void;
	onRetry?: () => void;

	rowKey: (row: TRow) => string;
	onRowClick: (row: TRow) => void;

	/**
	 * Called with the current debounced filter values + time range whenever
	 * either changes. The host uses this to drive its data fetch.
	 */
	onFiltersChange?: (
		filters: Record<string, string>,
		timeRange: TimeRange,
	) => void;
	/** Initial URL-backed state. The host owns persisting subsequent changes. */
	initialFilters?: Record<string, string>;
	initialTimeRange?: TimeRange;

	/**
	 * Set of row keys currently in the "briefly highlighted" state (e.g. just
	 * arrived via SSE). Rows whose key is in this set get `bg-accent/40` applied.
	 * FilterableTable will clear entries from this set after 1.5s on its own.
	 */
	highlightedKeys?: Set<string>;
	highlightedVersions?: ReadonlyMap<string, number>;
	/** Disable the highlight effect (e.g. in tests). */
	disableHighlightTimeout?: boolean;
}

const HIGHLIGHT_MS = 1500;

export function FilterableTable<TRow>(props: FilterableTableProps<TRow>) {
	const {
		columns,
		filterFields,
		title,
		noun,
		emptyHint,
		noMatchMessage,
		items,
		total,
		isLoading,
		isError,
		hasNextPage,
		onLoadMore,
		onRetry,
		rowKey,
		onRowClick,
		onFiltersChange,
		initialFilters,
		initialTimeRange,
		highlightedKeys,
		highlightedVersions,
		headerActions,
		disableHighlightTimeout = false,
	} = props;
	const totalColCount = columns.length;

	const [filters, setFilters] = React.useState<Record<string, string>>(() => ({
		...emptyFilters(filterFields),
		...initialFilters,
	}));
	const [debouncedFilters, setDebouncedFilters] =
		React.useState<Record<string, string>>(filters);
	const [timeRange, setTimeRange] = React.useState<TimeRange>(
		initialTimeRange ?? defaultRange,
	);
	const [debouncedTimeRange, setDebouncedTimeRange] =
		React.useState<TimeRange>(timeRange);

	React.useEffect(() => {
		const t = window.setTimeout(() => {
			setDebouncedFilters(filters);
			setDebouncedTimeRange(timeRange);
		}, 250);
		return () => window.clearTimeout(t);
	}, [filters, timeRange]);

	React.useEffect(() => {
		if (!isTimeRangeValid(debouncedTimeRange)) return;
		onFiltersChange?.(debouncedFilters, debouncedTimeRange);
	}, [debouncedFilters, debouncedTimeRange, onFiltersChange]);

	const hasColumnFilters = Object.values(filters).some((v) => v.length > 0);
	const hasTimeFilter = timeRange.kind !== "all";
	const hasActiveFilters = hasColumnFilters || hasTimeFilter;

	const sentinelRef = React.useRef<HTMLTableRowElement>(null);
	React.useEffect(() => {
		const node = sentinelRef.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const first = entries[0];
				if (first?.isIntersecting && hasNextPage && !isLoading) {
					onLoadMore();
				}
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [hasNextPage, isLoading, onLoadMore]);

	function setFilter(key: string, value: string) {
		setFilters((prev) => ({ ...prev, [key]: value }));
	}

	function clearFilters() {
		setFilters(emptyFilters(filterFields));
		setTimeRange(defaultRange());
	}

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>{title}</CardTitle>
				<div className="flex items-center gap-3">
					{headerActions}
					{hasActiveFilters && (
						<Button
							variant="ghost"
							size="sm"
							onClick={clearFilters}
							className="h-7 px-2 text-xs"
						>
							<LuX className="h-3 w-3" />
							Clear filters
						</Button>
					)}
					<div className="text-xs text-muted-foreground">
						{isLoading && items.length === 0
							? "loading…"
							: `${items.length} of ${total} ${total === 1 ? noun.singular : noun.plural}`}
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{isError && (
					<div
						className="flex items-center justify-between gap-3 text-sm text-destructive"
						role="alert"
					>
						<span>Failed to load: {isError.message}</span>
						{onRetry && (
							<Button variant="outline" size="sm" onClick={onRetry}>
								Retry
							</Button>
						)}
					</div>
				)}

				<TimeRangePicker value={timeRange} onChange={setTimeRange} />
				<FilterBar
					filterFields={filterFields}
					filters={filters}
					setFilter={setFilter}
				/>

				<Table>
					<TableHeader>
						<TableRow>
							{columns.map((c) => (
								<TableHead key={c.header} className={cn(c.width, c.className)}>
									{c.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading && items.length === 0 ? (
							Array.from({ length: 8 }).map((_, i) => (
								<TableRow key={`s-${i}`}>
									<TableCell colSpan={totalColCount} className="p-0">
										<Skeleton className="h-9 w-full" />
									</TableCell>
								</TableRow>
							))
						) : items.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={totalColCount}
									className="text-center text-muted-foreground"
								>
									{hasActiveFilters ? (
										<span className="inline-flex items-center gap-2">
											<LuSearchX className="h-4 w-4" />
											{noMatchMessage}
										</span>
									) : (
										emptyHint
									)}
								</TableCell>
							</TableRow>
						) : (
							items.map((row) => {
								const key = rowKey(row);
								const highlightVersion =
									highlightedVersions?.get(key) ??
									(highlightedKeys?.has(key) ? 1 : 0);
								return (
									<HighlightedRow
										key={key}
										highlightVersion={highlightVersion}
										disableTimeout={disableHighlightTimeout}
										onClick={() => onRowClick(row)}
										label={`Open ${noun.singular} ${key}`}
									>
										{columns.map((c) => (
											<TableCell key={c.header} className={cn(c.className)}>
												{c.cell(row, { isNew: highlightVersion > 0 })}
											</TableCell>
										))}
									</HighlightedRow>
								);
							})
						)}
						{hasNextPage && (
							<TableRow ref={sentinelRef} className="hover:bg-transparent">
								<TableCell
									colSpan={totalColCount}
									className="py-3 text-center text-xs text-muted-foreground"
								>
									<span className="inline-flex items-center gap-2">
										<LuLoader className="h-3.5 w-3.5 animate-spin" />
										Loading more…
									</span>
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function emptyFilters(fields: FilterFieldDef[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of fields) out[f.key] = "";
	return out;
}

function FilterBar({
	filterFields,
	filters,
	setFilter,
}: {
	filterFields: FilterFieldDef[];
	filters: Record<string, string>;
	setFilter: (key: string, value: string) => void;
}) {
	if (filterFields.length === 0) return null;
	return (
		<fieldset
			aria-label="Filters"
			className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-2 xl:grid-cols-3"
		>
			<legend className="px-1 text-xs font-medium text-muted-foreground">
				Filters
			</legend>
			{filterFields.map((field) => {
				const label = field.key
					.replaceAll("_", " ")
					.replace(/\b\w/g, (character) => character.toUpperCase());
				return (
					<label key={field.key} className="grid gap-1 text-xs font-medium">
						<span>{label}</span>
						<Input
							value={filters[field.key] ?? ""}
							onChange={(event) => setFilter(field.key, event.target.value)}
							placeholder={field.placeholder}
							className={cn("h-8 text-xs", field.className)}
							aria-label={label}
						/>
					</label>
				);
			})}
		</fieldset>
	);
}

/**
 * Row wrapper that applies the `bg-accent/40` highlight class while the row is
 * flagged as new, then clears the flag locally after 1.5 s so the parent does
 * not need to manage a timer per row.
 */
function HighlightedRow({
	highlightVersion,
	disableTimeout,
	onClick,
	label,
	children,
}: {
	highlightVersion: number;
	disableTimeout: boolean;
	onClick: () => void;
	label: string;
	children: React.ReactNode;
}) {
	const [active, setActive] = React.useState(highlightVersion > 0);
	React.useEffect(() => {
		if (highlightVersion > 0) {
			setActive(true);
			if (disableTimeout) return;
			const t = window.setTimeout(() => setActive(false), HIGHLIGHT_MS);
			return () => window.clearTimeout(t);
		}
		setActive(false);
		return;
	}, [highlightVersion, disableTimeout]);

	return (
		<TableRow
			className={cn(
				"cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				active && "bg-accent/40",
			)}
			data-highlighted={active ? "true" : "false"}
			onClick={onClick}
			tabIndex={0}
			aria-label={label}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onClick();
				}
			}}
		>
			{children}
		</TableRow>
	);
}
