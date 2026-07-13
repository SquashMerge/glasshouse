import * as React from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import { ObservationDetailPanel } from "../../../components/ObservationDetailPanel";
import { SseDebugOverlay } from "../../../components/SseDebugOverlay";
import { StreamToggle } from "../../../components/StreamToggle";
import { TraceHeader } from "../../../components/TraceHeader";
import { TraceWorkspace } from "../../../components/TraceWorkspace";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { useTraceStream, type ObservationRowLike } from "../../../hooks/useTraceStream";
import type { TraceRow } from "../../../lib/api";
import {
  canonicalObservationId,
  createTraceModel,
  traceModelObservations,
  upsertLiveObservation,
  type TraceModel,
} from "../../../lib/trace-model";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const HIGHLIGHT_MS = 1_500;

function NotFound({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Card data-testid="trace-not-found">
      <CardHeader>
        <CardTitle>Trace not found</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-sm text-muted-foreground">{children}</div>
      </CardContent>
    </Card>
  );
}

export function TraceDetailPage() {
  const { id } = useParams({ from: "/protected/observability/traces/$id" });
  const location = useLocation();
  const spanDeepLink = React.useMemo(() => new URLSearchParams(location.searchStr).get("span"), [location.searchStr]);
  const validId = TRACE_ID_REGEX.test(id);
  const [model, setModel] = React.useState<TraceModel<TraceRow>>(() =>
    createTraceModel<TraceRow>({ observations: [] }),
  );
  const [notFound, setNotFound] = React.useState(false);
  const [newObservationIds, setNewObservationIds] = React.useState<Set<string>>(new Set());
  const [selectedObservationId, setSelectedObservationId] = React.useState<string | null>(null);

  const handlers = React.useMemo(
    () => ({
      onSnapshot: (snapshot: { trace?: TraceRow; observations: ObservationRowLike[] }) => {
        setNotFound(false);
        setModel(createTraceModel(snapshot));
        setNewObservationIds(new Set());
      },
      onObservation: ({ observation }: { observation: ObservationRowLike }) => {
        const observationId = canonicalObservationId(observation.observation_id);
        setModel((current) => upsertLiveObservation(current, observation));
        if (!observationId) return;

        setNewObservationIds((current) => new Set(current).add(observationId));
        window.setTimeout(() => {
          setNewObservationIds((current) => {
            if (!current.has(observationId)) return current;
            const next = new Set(current);
            next.delete(observationId);
            return next;
          });
        }, HIGHLIGHT_MS);
      },
      onStatus: (status: "complete" | "not_found") => {
        if (status === "not_found") setNotFound(true);
      },
    }),
    [],
  );
  const stream = useTraceStream(id, handlers);
  const observations = React.useMemo(() => traceModelObservations(model), [model]);

  React.useEffect(() => {
    if (observations.length === 0) {
      setSelectedObservationId(null);
      return;
    }
    if (spanDeepLink && observations.some((observation) => observation.observation_id === spanDeepLink)) {
      setSelectedObservationId(spanDeepLink);
      return;
    }
    if (selectedObservationId && observations.some((observation) => observation.observation_id === selectedObservationId)) return;
    const root = observations.find((observation) => !observation.parent_observation_id) ?? observations[0];
    setSelectedObservationId(root?.observation_id ?? null);
  }, [observations, selectedObservationId, spanDeepLink]);

  const selectedObservation = React.useMemo(
    () => observations.find((observation) => observation.observation_id === selectedObservationId) ?? null,
    [observations, selectedObservationId],
  );

  if (!validId) {
    return <NotFound>The id <span className="font-mono">{id}</span> is not a valid 32-character lowercase hex trace id.</NotFound>;
  }

  if (notFound) {
    return <NotFound>No trace exists for <span className="font-mono">{id}</span>.</NotFound>;
  }

  return (
    <div className="space-y-4" data-testid="trace-detail-page">
      <TraceHeader
        traceId={id}
        observations={observations}
        trace={model.trace}
        streamControl={<StreamToggle sse={stream} />}
        onRefresh={() => stream.reconnect()}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
        <TraceWorkspace
          observations={observations}
          selectedObservationId={selectedObservationId}
          onSelectObservation={setSelectedObservationId}
          newObservationIds={newObservationIds}
        />
        <ObservationDetailPanel traceId={id} observation={selectedObservation} />
      </div>
      <SseDebugOverlay sse={stream} label={`trace/${id.slice(0, 8)}…`} />
    </div>
  );
}
