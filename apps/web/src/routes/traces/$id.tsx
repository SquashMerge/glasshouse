// /traces/:id — detail page. Header card with trace metadata + nested span
// tree + Tabs for Input/Output/Details.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { createRoute, useParams } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import { SpanTree } from "../../components/SpanTree";
import { getTrace } from "../../lib/api";

export function TraceDetailPage() {
  const { id } = useParams({ from: "/traces/$id" });
  const query = useQuery({
    queryKey: ["trace", id],
    queryFn: () => getTrace(id as string),
    enabled: Boolean(id),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="text-sm text-destructive">
        Failed to load trace: {(query.error as Error).message}
      </div>
    );
  }
  if (!query.data) return null;

  const t = query.data.trace;
  const obs = query.data.observations;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>{t.name}</CardTitle>
              <div className="mt-1 text-xs text-muted-foreground font-mono">{t.trace_id}</div>
            </div>
            <Badge variant={t.status === "error" ? "destructive" : "success"}>{t.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Field label="Started" value={new Date(t.start_time).toLocaleString()} />
          <Field label="Duration" value={t.duration_ms !== null ? `${t.duration_ms}ms` : "—"} />
          <Field label="Agent" value={t.agent_id || "—"} />
          <Field label="Env" value={t.env || "—"} />
          <Field label="Status" value={t.status} />
          <Field label="Scores" value={t.scores_summary || "—"} />
          <Field label="User" value={t.user_id || "—"} />
          <Field label="Session" value={t.session_id || "—"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spans ({obs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <SpanTree observations={obs} />
        </CardContent>
      </Card>

      <Tabs defaultValue="input">
        <TabsList>
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="tags">Tags</TabsTrigger>
        </TabsList>
        <TabsContent value="input">
          <Card>
            <CardContent className="pt-6">
              <pre className="whitespace-pre-wrap text-xs">{t.input_text || "—"}</pre>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="output">
          <Card>
            <CardContent className="pt-6">
              <pre className="whitespace-pre-wrap text-xs">{t.output_text || "—"}</pre>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="tags">
          <Card>
            <CardContent className="pt-6">
              {t.tags.length === 0 ? (
                <div className="text-muted-foreground">No tags.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {t.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono">{value}</div>
    </div>
  );
}