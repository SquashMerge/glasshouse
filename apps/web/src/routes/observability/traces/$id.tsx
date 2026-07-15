import * as React from "react";
import { useParams, useLocation } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs";
import { StreamToggle } from "../../../components/StreamToggle";
import { SseDebugOverlay } from "../../../components/SseDebugOverlay";
import { useTraceStream, type ObservationRowLike } from "../../../hooks/useTraceStream";
import { cn } from "../../../lib/utils";
import { PromptProvenanceCard } from "../../../components/PromptProvenanceCard";

/**
 * TraceDetailPage — live-updating detail view served at
 * `/observability/traces/:id`. The page is the canonical consumer of
 * `useTraceStream`: it does NOT issue an initial `GET /v1/traces/{id}` fetch.
 * The SSE snapshot event is the sole source of truth for observations.
 *
 * State machines:
 *  - `paused: true`        → Live indicator label "Paused" (user-pause).
 *  - `status: "open"` and
 *    `recording: true`     → Pill "Recording".
 *  - `recording: false`    → Pill "Recorded" (after server 30s grace).
 *  - `status: "closed"` and
 *    `!paused`             → Live indicator label "Reconnecting".
 *
 * The page also accepts an optional `?span=<observation_id>` deep-link from
 * the spans-tab row click; the matching observation becomes the initial
 * selection for the right-hand detail panel.
 */

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const HIGHLIGHT_MS = 1500;

interface DetailObservationLike {
  observation_id: string;
  parent_observation_id: string | null;
  name: string;
  start_time: string;
  duration_ms: number | null;
  status: "ok" | "error";
  model: string | null;
  input_text: string;
  output_text: string;
  metadata?: string;
  project_id?: string;
  type?: "span" | "event" | "generation" | "tool";
}

export function TraceDetailPage() {
  const { id } = useParams({ from: "/protected/observability/traces/$id" });
  const location = useLocation();
  const spanDeepLink = React.useMemo(() => {
    const sp = new URLSearchParams(location.searchStr);
    return sp.get("span") ?? null;
  }, [location.searchStr]);

  const validId = TRACE_ID_REGEX.test(id);
  const [observations, setObservations] = React.useState<DetailObservationLike[]>([]);
  const [notFound, setNotFound] = React.useState(false);
  const [newObservationIds, setNewObservationIds] = React.useState<Set<string>>(new Set());
  const [selectedObservationId, setSelectedObservationId] = React.useState<string | null>(null);

  // Stable handler refs so useTraceStream can read latest callbacks without
  // re-running its connection effect. We accept the hook's narrow
  // `ObservationRowLike` shape and cast internally to our local
  // `DetailObservationLike` (which extends it with display-only fields).
  const handlers = React.useMemo(
    () => ({
      onSnapshot: (msg: { observations: ObservationRowLike[] }) => {
        // Initial seed from the server snapshot. We render the snapshot
        // directly; subsequent `event: observation` frames merge by id.
        setObservations(msg.observations as unknown as DetailObservationLike[]);
        setNewObservationIds(new Set());
      },
      onObservation: (msg: { observation: ObservationRowLike }) => {
        const observation = msg.observation as unknown as DetailObservationLike;
        setObservations((prev) => {
          const next = prev.filter((o) => o.observation_id !== observation.observation_id);
          next.push(observation);
          return next;
        });
        setNewObservationIds((prev) => {
          if (prev.has(observation.observation_id)) return prev;
          const nextSet = new Set(prev);
          nextSet.add(observation.observation_id);
          return nextSet;
        });
        window.setTimeout(() => {
          setNewObservationIds((prev) => {
            if (!prev.has(observation.observation_id)) return prev;
            const nextSet = new Set(prev);
            nextSet.delete(observation.observation_id);
            return nextSet;
          });
        }, HIGHLIGHT_MS);
      },
      onStatus: (status: "complete" | "not_found") => {
        // The server's `event: status\ndata: {"status":"complete"}` frame is
        // server-driven and orthogonal to the user-toggleable "Stream" state
        // — the SSE pipe stays open until the user pauses it. We just flip
        // the 404 placeholder if the trace isn't found.
        if (status === "not_found") {
          setNotFound(true);
        }
      },
    }),
    [],
  );

  const stream = useTraceStream(id, handlers);

  // Derive a stable trace name from the snapshot. We never issue an initial
  // GET /v1/traces/{id} — the SSE snapshot is the source of truth.
  const traceName = React.useMemo(() => {
    if (observations.length === 0) return "—";
    const root = observations.find((o) => !o.parent_observation_id) ?? observations[0]!;
    return root.name || "—";
  }, [observations]);

  // Resolve the `?span=` deep-link (preferred) or fall back to the root
  // observation once the snapshot arrives. Kept as a single effect so the
  // two `setSelectedObservationId` calls do not race within the same commit
  // — if they did, whichever ran second would clobber the first and the
  // deep-link would lose to the default selection whenever the snapshot
  // also contained a root observation.
  React.useEffect(() => {
    if (observations.length === 0) return;

    if (selectedObservationId !== null) {
      // A previous render already selected something. Re-selection is
      // only needed if the deep-link points to a different observation —
      // the spans-tab row click (re-entry with the same id) is a no-op.
      if (
        spanDeepLink &&
        observations.some((o) => o.observation_id === spanDeepLink) &&
        selectedObservationId !== spanDeepLink
      ) {
        setSelectedObservationId(spanDeepLink);
      }
      return;
    }

    if (spanDeepLink && observations.some((o) => o.observation_id === spanDeepLink)) {
      setSelectedObservationId(spanDeepLink);
      return;
    }

    const root = observations.find((o) => !o.parent_observation_id) ?? observations[0];
    if (root) setSelectedObservationId(root.observation_id);
  }, [spanDeepLink, observations, selectedObservationId]);

  const selectedObservation = React.useMemo(
    () => observations.find((o) => o.observation_id === selectedObservationId) ?? null,
    [observations, selectedObservationId],
  );

  // ---- Conditional render branches (after all hooks) -----------------------

  // Invalid id gate — render the static placeholder, do not open the SSE.
  if (!validId) {
    return (
      <Card data-testid="trace-not-found">
        <CardHeader>
          <CardTitle>Trace not found</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            The id <span className="font-mono">{id}</span> is not a valid 32-character
            lowercase hex trace id.
          </div>
        </CardContent>
      </Card>
    );
  }

  // Server told us the trace does not exist (404 short-circuit on
  // /v1/traces/{id}/events). Same placeholder as the regex gate.
  if (notFound) {
    return (
      <Card data-testid="trace-not-found">
        <CardHeader>
          <CardTitle>Trace not found</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            No trace exists for <span className="font-mono">{id}</span>.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header band */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold" data-testid="trace-name">
                {traceName}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {id}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StreamToggle sse={stream} />
          </div>
        </CardContent>
      </Card>

      <ResizableSplit
        left={
          <Card>
            <CardHeader>
              <CardTitle>Spans ({observations.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {observations.length === 0 ? (
                <div className="text-sm text-muted-foreground" data-testid="spans-empty">
                  Waiting for snapshot…
                </div>
              ) : (
                <ClickableSpanTree
                  observations={observations}
                  newObservationIds={newObservationIds}
                  selectedObservationId={selectedObservationId}
                  onSelect={(observationId) => setSelectedObservationId(observationId)}
                />
              )}
            </CardContent>
          </Card>
        }
        right={
          <Card>
            <CardHeader>
              <CardTitle>Span detail</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedObservation ? (
                <ObservationDetail observation={selectedObservation} />
              ) : (
                <div className="text-sm text-muted-foreground">
                  Select a span to see its detail.
                </div>
              )}
            </CardContent>
          </Card>
        }
      />
      <SseDebugOverlay sse={stream} label={`trace/${id.slice(0, 8)}…`} />
    </div>
  );
}

interface ClickableSpanTreeProps {
  observations: DetailObservationLike[];
  newObservationIds: Set<string>;
  selectedObservationId: string | null;
  onSelect: (observationId: string) => void;
}

/**
 * Top-level spans list with click-to-select. New observations get the
 * `bg-accent/40` highlight applied via a wrapper div.
 */
function ClickableSpanTree(props: ClickableSpanTreeProps) {
  const { observations, newObservationIds, selectedObservationId, onSelect } = props;
  return (
    <div className="space-y-2" data-testid="span-tree">
      {observations.map((o) => (
        <button
          type="button"
          key={o.observation_id}
          onClick={() => onSelect(o.observation_id)}
          className={cn(
            "block w-full rounded-md border border-transparent px-2 py-1 text-left text-sm hover:border-border",
            newObservationIds.has(o.observation_id) && "bg-accent/40",
            selectedObservationId === o.observation_id && "border-primary",
          )}
          data-testid="span-row"
          data-observation-id={o.observation_id}
          data-selected={selectedObservationId === o.observation_id ? "true" : "false"}
          aria-current={selectedObservationId === o.observation_id ? "true" : undefined}
        >
          <div className="flex items-center gap-2">
            <Badge variant={o.status === "error" ? "destructive" : "secondary"}>
              {o.name || "(unnamed)"}
            </Badge>
            {o.model && <Badge variant="outline">{o.model}</Badge>}
            <span className="text-xs text-muted-foreground">
              {o.duration_ms !== null ? `${o.duration_ms}ms` : "—"}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ObservationDetail({ observation }: { observation: DetailObservationLike }) {
  const [tab, setTab] = React.useState<string>("input");

  // Reset to the "input" tab whenever the selection changes.
  React.useEffect(() => {
    setTab("input");
  }, [observation.observation_id]);

  const metadataPretty = React.useMemo(() => {
    if (!observation.metadata) return null;
    try {
      return JSON.stringify(JSON.parse(observation.metadata), null, 2);
    } catch {
      return observation.metadata;
    }
  }, [observation.metadata]);

  return (
    <div className="space-y-3" data-testid="observation-detail" data-observation-id={observation.observation_id}>
      <div className="flex items-center gap-2">
        <Badge variant={observation.status === "error" ? "destructive" : "secondary"}>
          {observation.name}
        </Badge>
        {observation.model && <Badge variant="outline">{observation.model}</Badge>}
        <span className="text-xs text-muted-foreground">
          {observation.duration_ms !== null ? `${observation.duration_ms}ms` : "—"}
        </span>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="tags">Tags</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>
        <TabsContent value="input">
          <pre className="whitespace-pre-wrap text-xs" data-testid="detail-input">
            {observation.input_text || "—"}
          </pre>
        </TabsContent>
        <TabsContent value="output">
          <pre className="whitespace-pre-wrap text-xs" data-testid="detail-output">
            {observation.output_text || "—"}
          </pre>
        </TabsContent>
        <TabsContent value="tags">
          <div className="text-xs text-muted-foreground" data-testid="detail-tags">
            No tags.
          </div>
        </TabsContent>
        <TabsContent value="metadata">
          <pre className="whitespace-pre-wrap text-xs" data-testid="detail-metadata">
            {metadataPretty ?? "—"}
          </pre>
        </TabsContent>
      </Tabs>
      {observation.type === "generation" && <PromptProvenanceCard metadata={observation.metadata} />}
    </div>
  );
}

/**
 * Simple resizable horizontal split using a draggable gutter. Persists the
 * split ratio in `localStorage` so a refresh keeps the user's preferred
 * column width.
 */
const SPLIT_KEY = "astraea.trace-detail.split";

function ResizableSplit({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  const [ratio, setRatio] = React.useState<number>(0.55);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(SPLIT_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0.2 && n <= 0.8) {
      setRatio(n);
    }
    setHydrated(true);
  }, []);

  const containerRef = React.useRef<HTMLDivElement>(null);

  function onGutterDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const node = containerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - rect.left;
      const next = Math.min(0.8, Math.max(0.2, x / rect.width));
      setRatio(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SPLIT_KEY, String(ratio));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  React.useEffect(() => {
    if (!hydrated) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SPLIT_KEY, String(ratio));
    }
  }, [ratio, hydrated]);

  return (
    <div ref={containerRef} className="flex gap-3" data-testid="resizable-split">
      <div className="min-w-0" style={{ flex: `0 0 calc(${ratio * 100}% - 0.375rem)` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onGutterDown}
        className="w-1.5 cursor-col-resize rounded bg-border hover:bg-muted-foreground/30"
        data-testid="split-gutter"
      />
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}
