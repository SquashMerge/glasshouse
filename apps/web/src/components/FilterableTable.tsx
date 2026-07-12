import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LuLoader, LuSearchX, LuX } from "react-icons/lu";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";
import { TimeRangePicker, defaultRange, toApiParams, type TimeRange } from "./TimeRangePicker";

const PAGE_SIZE = 100;

export interface ColumnDef<TRow> {
  header: string;
  width?: string;
  className?: string;
  cell: (row: TRow) => React.ReactNode;
}

export interface FilterFieldDef {
  key: string;
  placeholder: string;
  className?: string;
}

export interface FilterableTableProps<TRow> {
  title: string;
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
  queryKey: string;
  buildApiParams: (filters: Record<string, string>, timeRange: TimeRange) => Record<string, unknown>;
  queryFn: (params: Record<string, unknown>) => Promise<{ items: TRow[]; total: number }>;
  rowKey: (row: TRow) => string;
  onRowClick: (row: TRow) => void;
}

export function FilterableTable<TRow>(props: FilterableTableProps<TRow>) {
  const { columns, filterFields, queryKey, buildApiParams, queryFn, rowKey, onRowClick, title, noun, emptyHint, noMatchMessage } = props;
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

  const apiParams = React.useMemo(
    () => ({ ...buildApiParams(debouncedFilters, debouncedTimeRange), limit: PAGE_SIZE }),
    [buildApiParams, debouncedFilters, debouncedTimeRange],
  );

  const query = useInfiniteQuery({
    queryKey: [queryKey, apiParams],
    queryFn: ({ pageParam = 0 }) => queryFn({ ...apiParams, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 10_000,
  });

  const items: TRow[] = React.useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;
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
        if (first?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
          query.fetchNextPage();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

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
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 px-2 text-xs">
              <LuX className="h-3 w-3" />
              Clear filters
            </Button>
          )}
          <div className="text-xs text-muted-foreground">
            {query.isLoading ? "loading…" : `${items.length} of ${total} ${total === 1 ? noun.singular : noun.plural}`}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isError && (
          <div className="text-sm text-destructive">
            Failed to load: {(query.error as Error).message}
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
            {query.isLoading && items.length === 0 ? (
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
              items.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  className="cursor-pointer"
                  onClick={() => onRowClick(row)}
                >
                  {columns.map((c) => (
                    <TableCell key={c.header} className={cn(c.className)}>
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
            {query.hasNextPage && (
              <TableRow ref={sentinelRef} className="hover:bg-transparent">
                <TableCell colSpan={totalColCount} className="py-3 text-center text-xs text-muted-foreground">
                  {query.isFetchingNextPage ? (
                    <span className="inline-flex items-center gap-2">
                      <LuLoader className="h-3.5 w-3.5 animate-spin" />
                      Loading more…
                    </span>
                  ) : (
                    "Scroll to load more"
                  )}
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