import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LuLoader, LuSearchX, LuX } from "react-icons/lu";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { listTraces, type ListTracesParams, type TraceRow } from "../../lib/api";
import { cn } from "../../lib/utils";
import { TimeRangePicker, defaultRange, toApiParams, type TimeRange } from "../../components/TimeRangePicker";

const PAGE_SIZE = 100;

interface FilterValues {
  name: string;
  agent_id: string;
  status: string;
  duration: string;
  scores: string;
  input_text: string;
}

const EMPTY_FILTERS: FilterValues = {
  name: "",
  agent_id: "",
  status: "",
  duration: "",
  scores: "",
  input_text: "",
};

const PLACEHOLDERS: Record<keyof FilterValues, string> = {
  name: "e.g. llm.call or tool.search_db",
  agent_id: "e.g. code-reviewer",
  status: "ok / error",
  duration: "e.g. <500 or >1000",
  scores: "e.g. input_tokens",
  input_text: "e.g. recruiter or SQL",
};

export function TraceListPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = React.useState<FilterValues>(EMPTY_FILTERS);
  const [debouncedFilters, setDebouncedFilters] = React.useState<FilterValues>(EMPTY_FILTERS);
  const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
  const [debouncedTimeRange, setDebouncedTimeRange] = React.useState<TimeRange>(timeRange);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedFilters(filters);
      setDebouncedTimeRange(timeRange);
    }, 250);
    return () => window.clearTimeout(t);
  }, [filters, timeRange]);

  const apiParams: ListTracesParams = React.useMemo(() => {
    const out: ListTracesParams = { limit: PAGE_SIZE };
    if (debouncedFilters.name) out.name = debouncedFilters.name;
    if (debouncedFilters.agent_id) out.agent_id = debouncedFilters.agent_id;
    if (debouncedFilters.status) out.status = debouncedFilters.status;
    if (debouncedFilters.duration) out.duration = debouncedFilters.duration;
    if (debouncedFilters.scores) out.scores = debouncedFilters.scores;
    if (debouncedFilters.input_text) out.input_text = debouncedFilters.input_text;
    const tr = toApiParams(debouncedTimeRange);
    if (tr.time_from) out.time_from = tr.time_from;
    if (tr.time_to) out.time_to = tr.time_to;
    return out;
  }, [debouncedFilters, debouncedTimeRange]);

  const query = useInfiniteQuery({
    queryKey: ["traces", apiParams],
    queryFn: ({ pageParam = 0 }) => listTraces({ ...apiParams, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 10_000,
  });

  const items: TraceRow[] = React.useMemo(
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
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, query]);

  function setFilter<K extends keyof FilterValues>(key: K, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setTimeRange(defaultRange());
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Traces</CardTitle>
          <div className="flex items-center gap-3">
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 px-2 text-xs">
                <LuX className="h-3 w-3" />
                Clear filters
              </Button>
            )}
            <div className="text-xs text-muted-foreground">
              {query.isLoading ? "loading…" : `${items.length} of ${total} ${total === 1 ? "trace" : "traces"}`}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {query.isError && (
            <div className="text-sm text-destructive">
              Failed to load traces: {(query.error as Error).message}
            </div>
          )}

          <TimeRangePicker value={timeRange} onChange={setTimeRange} />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Time</TableHead>
                <TableHead className="w-[180px]">Name</TableHead>
                <TableHead className="w-[160px]">Agent</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead className="w-[110px]">Duration</TableHead>
                <TableHead className="w-[180px]">Score</TableHead>
                <TableHead>Input excerpt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <FilterRow filters={filters} setFilter={setFilter} />
              {query.isLoading && items.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`s-${i}`}>
                    <TableCell colSpan={7} className="p-0">
                      <Skeleton className="h-9 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {hasActiveFilters ? (
                      <span className="inline-flex items-center gap-2">
                        <LuSearchX className="h-4 w-4" />
                        No traces match the current filters.
                      </span>
                    ) : (
                      <>No traces yet. Send one to <code>/v1/otel/v1/traces</code> to get started.</>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((t) => (
                  <TableRow
                    key={t.trace_id}
                    className="cursor-pointer"
                    onClick={() => navigate({ to: "/traces/$id", params: { id: t.trace_id } })}
                  >
                    <TableCell className="font-mono text-xs">{new Date(t.start_time).toLocaleString()}</TableCell>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t.agent_id || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === "error" ? "destructive" : "success"}>{t.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{t.duration_ms !== null ? `${t.duration_ms}ms` : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t.scores_summary || "—"}</TableCell>
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground">{t.input_text || "—"}</TableCell>
                  </TableRow>
                ))
              )}
              {query.hasNextPage && (
                <TableRow ref={sentinelRef} className="hover:bg-transparent">
                  <TableCell colSpan={7} className="py-3 text-center text-xs text-muted-foreground">
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
    </div>
  );
}

function FilterRow({
  filters,
  setFilter,
}: {
  filters: FilterValues;
  setFilter: <K extends keyof FilterValues>(key: K, value: string) => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="p-1" aria-hidden="true" />
      <FilterCell
        value={filters.name}
        placeholder={PLACEHOLDERS.name}
        onChange={(v) => setFilter("name", v)}
      />
      <FilterCell
        value={filters.agent_id}
        placeholder={PLACEHOLDERS.agent_id}
        onChange={(v) => setFilter("agent_id", v)}
      />
      <FilterCell
        value={filters.status}
        placeholder={PLACEHOLDERS.status}
        onChange={(v) => setFilter("status", v)}
        className="font-mono"
      />
      <FilterCell
        value={filters.duration}
        placeholder={PLACEHOLDERS.duration}
        onChange={(v) => setFilter("duration", v)}
        className="font-mono"
      />
      <FilterCell
        value={filters.scores}
        placeholder={PLACEHOLDERS.scores}
        onChange={(v) => setFilter("scores", v)}
        className="font-mono"
      />
      <FilterCell
        value={filters.input_text}
        placeholder={PLACEHOLDERS.input_text}
        onChange={(v) => setFilter("input_text", v)}
      />
    </TableRow>
  );
}

function FilterCell({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <TableCell className="p-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-7 text-xs", className)}
        aria-label="Filter"
      />
    </TableCell>
  );
}