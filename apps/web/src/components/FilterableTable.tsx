import * as React from "react";
import { LuLoader, LuSearchX, LuX } from "react-icons/lu";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";
import { TimeRangePicker, defaultRange, type TimeRange } from "./TimeRangePicker";

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

  rowKey: (row: TRow) => string;
  onRowClick: (row: TRow) => void;

  /**
   * Called with the current debounced filter values + time range whenever
   * either changes. The host uses this to drive its data fetch.
   */
  onFiltersChange?: (filters: Record<string, string>, timeRange: TimeRange) => void;

  /**
   * Set of row keys currently in the "briefly highlighted" state (e.g. just
   * arrived via SSE). Rows whose key is in this set get `bg-accent/40` applied.
   * FilterableTable will clear entries from this set after 1.5s on its own.
   */
  highlightedKeys?: Set<string>;
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
    rowKey,
    onRowClick,
    onFiltersChange,
    highlightedKeys,
    headerActions,
    disableHighlightTimeout = false,
  } = props;
  const totalColCount = columns.length;
  const leadingSpacerCount = Math.max(0, columns.length - filterFields.length);

  const [filters, setFilters] = React.useState<Record<string, string>>(() => emptyFilters(filterFields));
  const [debouncedFilters, setDebouncedFilters] = React.useState<Record<string, string>>(filters);
  const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
  const [debouncedTimeRange, setDebouncedTimeRange] = React.useState<TimeRange>(timeRange);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedFilters(filters);
      setDebouncedTimeRange(timeRange);
    }, 250);
    return () => window.clearTimeout(t);
  }, [filters, timeRange]);

  React.useEffect(() => {
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
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 px-2 text-xs">
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
          <div className="text-sm text-destructive">
            Failed to load: {isError.message}
          </div>
        )}

        <TimeRangePicker value={timeRange} onChange={setTimeRange} />

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
            <FilterRow filterFields={filterFields} filters={filters} setFilter={setFilter} leadingSpacerCount={leadingSpacerCount} />
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
                <TableCell colSpan={totalColCount} className="text-center text-muted-foreground">
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
                return (
                  <HighlightedRow
                    key={key}
                    highlighted={highlightedKeys?.has(key) ?? false}
                    disableTimeout={disableHighlightTimeout}
                    onClick={() => onRowClick(row)}
                  >
                    {columns.map((c) => (
                      <TableCell key={c.header} className={cn(c.className)}>
                        {c.cell(row, { isNew: highlightedKeys?.has(key) ?? false })}
                      </TableCell>
                    ))}
                  </HighlightedRow>
                );
              })
            )}
            {hasNextPage && (
              <TableRow ref={sentinelRef} className="hover:bg-transparent">
                <TableCell colSpan={totalColCount} className="py-3 text-center text-xs text-muted-foreground">
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

function FilterRow({
  filterFields,
  filters,
  setFilter,
  leadingSpacerCount,
}: {
  filterFields: FilterFieldDef[];
  filters: Record<string, string>;
  setFilter: (key: string, value: string) => void;
  leadingSpacerCount: number;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      {Array.from({ length: leadingSpacerCount }).map((_, i) => (
        <TableCell key={`spacer-${i}`} className="p-1" aria-hidden="true" />
      ))}
      {filterFields.map((f) => (
        <TableCell key={f.key} className="p-1">
          <Input
            value={filters[f.key] ?? ""}
            onChange={(e) => setFilter(f.key, e.target.value)}
            placeholder={f.placeholder}
            className={cn("h-7 text-xs", f.className)}
            aria-label={f.placeholder}
          />
        </TableCell>
      ))}
    </TableRow>
  );
}

/**
 * Row wrapper that applies the `bg-accent/40` highlight class while the row is
 * flagged as new, then clears the flag locally after 1.5 s so the parent does
 * not need to manage a timer per row.
 */
function HighlightedRow({
  highlighted,
  disableTimeout,
  onClick,
  children,
}: {
  highlighted: boolean;
  disableTimeout: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [active, setActive] = React.useState(highlighted);
  React.useEffect(() => {
    if (highlighted) {
      setActive(true);
      if (disableTimeout) return;
      const t = window.setTimeout(() => setActive(false), HIGHLIGHT_MS);
      return () => window.clearTimeout(t);
    }
    setActive(false);
    return;
  }, [highlighted, disableTimeout]);

  return (
    <TableRow
      className={cn("cursor-pointer", active && "bg-accent/40")}
      data-highlighted={active ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </TableRow>
  );
}