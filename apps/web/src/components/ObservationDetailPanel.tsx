import * as React from "react";
import { LuClipboard } from "react-icons/lu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { copyJson, copyText } from "../lib/clipboard";
import { formatMetadata, metadataAttributes, metadataFallback, parseMetadata, type MetadataAttribute } from "../lib/trace-metadata";
import type { CanonicalObservation } from "../lib/trace-model";
import { observationKind } from "../lib/observation-kind";
import { observationTiming } from "../lib/trace-timeline";

export interface ObservationDetailPanelProps {
  observation: CanonicalObservation | null;
  traceId: string;
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entry]) => ({ key, value: entry })).sort((left, right) => left.key.localeCompare(right.key));
}

function MetadataList({ values, emptyLabel }: { values: MetadataAttribute[]; emptyLabel: string }) {
  if (values.length === 0) return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  return (
    <dl className="space-y-2 text-xs">
      {values.map(({ key, value }) => <div key={key} className="grid gap-1 border-b pb-2 sm:grid-cols-[minmax(8rem,12rem)_1fr]"><dt className="font-mono text-muted-foreground">{key}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{printable(value)}</dd></div>)}
    </dl>
  );
}

export function ObservationDetailPanel({ observation, traceId }: ObservationDetailPanelProps) {
  const [tab, setTab] = React.useState("overview");
  const [copyMessage, setCopyMessage] = React.useState("");

  React.useEffect(() => {
    setTab("overview");
  }, [observation?.observation_id]);

  const metadata = React.useMemo(() => parseMetadata(observation?.metadata), [observation?.metadata]);
  const formattedMetadata = React.useMemo(() => formatMetadata(metadata), [metadata]);
  const attributes = React.useMemo(() => {
    const arrayAttributes = metadataAttributes(metadata);
    return arrayAttributes.length > 0 ? arrayAttributes : objectEntries(metadata.value);
  }, [metadata]);
  const eventEntries = React.useMemo(() => metadata.value && typeof metadata.value === "object" && !Array.isArray(metadata.value) ? (metadata.value as { events?: unknown }).events : null, [metadata]);
  const linkEntries = React.useMemo(() => metadata.value && typeof metadata.value === "object" && !Array.isArray(metadata.value) ? (metadata.value as { links?: unknown }).links : null, [metadata]);
  const resource = React.useMemo(() => metadata.value && typeof metadata.value === "object" && !Array.isArray(metadata.value) ? (metadata.value as { resource?: unknown }).resource : null, [metadata]);

  if (!observation) {
    return <aside className="rounded-lg border p-6 text-sm text-muted-foreground" data-testid="observation-detail-empty">Select an observation to see its detail.</aside>;
  }

  const kind = observationKind(observation.type);
  const timing = observationTiming(observation);
  const statusError = observation.status === "error";

  async function copy(value: string, label: string) {
    const result = await copyText(value);
    setCopyMessage(result.ok ? `${label} copied` : `Unable to copy ${label.toLocaleLowerCase()}`);
  }

  async function copyRawJson() {
    const result = await copyJson(observation);
    setCopyMessage(result.ok ? "Observation JSON copied" : "Unable to copy observation JSON");
  }

  return (
    <aside className="rounded-lg border bg-card" data-testid="observation-detail" data-observation-id={observation.observation_id}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold">{typeof observation.name === "string" && observation.name ? observation.name : "(unnamed)"}</h2>
            <Badge variant={statusError ? "destructive" : "secondary"}>{statusError ? "Error" : "OK"}</Badge>
            <Badge variant="outline">{kind.label}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{observation.observation_id}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={copyRawJson} data-testid="copy-observation-json"><LuClipboard className="h-3.5 w-3.5" aria-hidden="true" />Copy JSON</Button>
      </div>
      <span className="sr-only" aria-live="polite">{copyMessage}</span>

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
        <TabsContent value="overview" className="space-y-3" data-testid="detail-overview">
          <MetadataList values={[
            { key: "Trace ID", value: traceId },
            { key: "Observation ID", value: observation.observation_id },
            { key: "Parent observation ID", value: observation.parent_observation_id ?? "—" },
            { key: "Type", value: kind.label },
            { key: "Start", value: observation.start_time ?? "—" },
            { key: "End", value: observation.end_time ?? "—" },
            { key: "Duration", value: timing.durationMs === null ? "—" : `${timing.durationMs}ms` },
            { key: "Model", value: observation.model ?? "—" },
          ]} emptyLabel="No overview data." />
          <div className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => copy(observation.observation_id, "Observation ID")}>Copy observation ID</Button><Button type="button" size="sm" variant="ghost" onClick={() => copy(traceId, "Trace ID")}>Copy trace ID</Button></div>
        </TabsContent>
        <TabsContent value="input"><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs" data-testid="detail-input">{typeof observation.input_text === "string" && observation.input_text ? observation.input_text : "—"}</pre></TabsContent>
        <TabsContent value="output"><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs" data-testid="detail-output">{typeof observation.output_text === "string" && observation.output_text ? observation.output_text : "—"}</pre></TabsContent>
        <TabsContent value="attributes"><MetadataList values={attributes} emptyLabel="No attributes supplied." /></TabsContent>
        <TabsContent value="events"><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{Array.isArray(eventEntries) ? printable(eventEntries) : "No events supplied."}</pre></TabsContent>
        <TabsContent value="links"><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{Array.isArray(linkEntries) ? printable(linkEntries) : "No links supplied."}</pre></TabsContent>
        <TabsContent value="resource"><MetadataList values={objectEntries(resource)} emptyLabel="No resource attributes supplied." /></TabsContent>
        <TabsContent value="metadata"><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs" data-testid="detail-metadata">{formattedMetadata ?? metadataFallback(metadata)}</pre></TabsContent>
      </Tabs>
    </aside>
  );
}
