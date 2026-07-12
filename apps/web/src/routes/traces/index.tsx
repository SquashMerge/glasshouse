import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { listTraces, searchTraces, type TraceRow } from "../../lib/api";

export function TraceListPage() {
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [submittedQ, setSubmittedQ] = React.useState("");

  const query = useQuery({
    queryKey: ["traces", submittedQ],
    queryFn: () =>
      submittedQ
        ? searchTraces({ q: submittedQ, sort: "start_time:desc", limit: 50 })
        : listTraces({ limit: 50 }),
    refetchInterval: 10_000,
  });

  function onSubmitSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmittedQ(q);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Traces</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={onSubmitSearch} className="flex gap-2">
            <Input
              placeholder="Search input_text / output_text…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Button type="submit">Search</Button>
          </form>

          {query.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {query.isError && (
            <div className="text-sm text-destructive">
              Failed to load traces: {(query.error as Error).message}
            </div>
          )}

          {query.data && (
            <>
              <div className="text-xs text-muted-foreground">
                {query.data.total} trace{query.data.total === 1 ? "" : "s"}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Input excerpt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No traces yet. Send one to <code>/v1/otel/v1/traces</code> to get started.
                      </TableCell>
                    </TableRow>
                  ) : (
                    query.data.items.map((t) => (
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
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}