import * as React from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import { ObservationDetailPanel } from "../../../components/ObservationDetailPanel";
import { SseDebugOverlay } from "../../../components/SseDebugOverlay";
import { StreamToggle } from "../../../components/StreamToggle";
import { TraceHeader } from "../../../components/TraceHeader";
import { TraceWorkspace } from "../../../components/TraceWorkspace";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import {
	useTraceStream,
	type ObservationRowLike,
} from "../../../hooks/useTraceStream";
import { normalizeObservationMetadata, type TraceRow } from "../../../lib/api";
import {
	AddToDatasetDialog,
	FeedbackControls,
} from "../../../components/DatasetFeedbackActions";
import { useOptionalProjectSelection } from "../../../components/ProjectProvider";
import {
	canonicalObservationId,
	createTraceModel,
	traceModelObservations,
	upsertLiveObservation,
	type TraceModel,
} from "../../../lib/trace-model";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const HIGHLIGHT_MS = 1_500;
const SPLIT_STORAGE_KEY = "astraea.trace-detail.workspace-width";
const MIN_WORKSPACE_WIDTH = 35;
const MAX_WORKSPACE_WIDTH = 70;
const SNAPSHOT_TIMEOUT_MS = 10_000;

function clampWorkspaceWidth(value: number): number {
	return Math.min(
		MAX_WORKSPACE_WIDTH,
		Math.max(MIN_WORKSPACE_WIDTH, Math.round(value)),
	);
}

function initialWorkspaceWidth(): number {
	try {
		const saved = window.localStorage.getItem(SPLIT_STORAGE_KEY);
		const width = saved === null ? Number.NaN : Number(saved);
		return Number.isFinite(width) ? clampWorkspaceWidth(width) : 60;
	} catch {
		return 60;
	}
}

function NotFound({
	children,
}: {
	children: React.ReactNode;
}): React.ReactElement {
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

function normalizeStreamObservation(observation: ObservationRowLike) {
	return {
		...observation,
		metadata: normalizeObservationMetadata(
			observation.metadata,
			observation.type === "generation",
		),
	};
}

export function TraceDetailPage() {
	const { id } = useParams({ from: "/protected/observability/traces/$id" });
	const location = useLocation();
	const spanDeepLink = React.useMemo(
		() => new URLSearchParams(location.searchStr).get("span"),
		[location.searchStr],
	);
	const validId = TRACE_ID_REGEX.test(id);
	const project = useOptionalProjectSelection();
	const [model, setModel] = React.useState<TraceModel<TraceRow>>(() =>
		createTraceModel<TraceRow>({ observations: [] }),
	);
	const [notFound, setNotFound] = React.useState(false);
	const [recordingStatus, setRecordingStatus] = React.useState<
		"recording" | "complete"
	>("recording");
	const [highlightVersions, setHighlightVersions] = React.useState<
		Map<string, number>
	>(new Map());
	const [selectedObservationId, setSelectedObservationId] = React.useState<
		string | null
	>(null);
	const [inspectorOpen, setInspectorOpen] = React.useState(true);
	const [workspaceWidth, setWorkspaceWidth] = React.useState(
		initialWorkspaceWidth,
	);
	const [focusWorkspaceVersion, setFocusWorkspaceVersion] = React.useState(0);
	const [receivedSnapshot, setReceivedSnapshot] = React.useState(false);
	const [snapshotTimedOut, setSnapshotTimedOut] = React.useState(false);
	const splitContainerRef = React.useRef<HTMLDivElement>(null);
	const highlightTimersRef = React.useRef(new Map<string, number>());
	const highlightVersionsRef = React.useRef(new Map<string, number>());

	const clearHighlightTimers = React.useCallback(() => {
		for (const timer of highlightTimersRef.current.values())
			window.clearTimeout(timer);
		highlightTimersRef.current.clear();
	}, []);

	React.useEffect(() => clearHighlightTimers, [clearHighlightTimers]);

	React.useEffect(() => {
		try {
			window.localStorage.setItem(SPLIT_STORAGE_KEY, String(workspaceWidth));
		} catch {}
	}, [workspaceWidth]);

	const closeInspector = React.useCallback(() => {
		setInspectorOpen(false);
		setFocusWorkspaceVersion((version) => version + 1);
	}, []);

	const selectObservation = React.useCallback((observationId: string) => {
		setSelectedObservationId(observationId);
		setInspectorOpen(true);
	}, []);

	const handlers = React.useMemo(
		() => ({
			onSnapshot: (snapshot: {
				trace?: TraceRow;
				observations: ObservationRowLike[];
			}) => {
				setReceivedSnapshot(true);
				setSnapshotTimedOut(false);
				setNotFound(false);
				setRecordingStatus("recording");
				setModel(
					createTraceModel({
						...snapshot,
						observations: snapshot.observations.map(normalizeStreamObservation),
					}),
				);
				clearHighlightTimers();
				highlightVersionsRef.current = new Map();
				setHighlightVersions(highlightVersionsRef.current);
			},
			onObservation: ({ observation }: { observation: ObservationRowLike }) => {
				setRecordingStatus("recording");
				const normalizedObservation = normalizeStreamObservation(observation);
				const observationId = canonicalObservationId(
					normalizedObservation.observation_id,
				);
				setModel((current) =>
					upsertLiveObservation(current, normalizedObservation),
				);
				if (!observationId) return;

				const next = new Map(highlightVersionsRef.current);
				const version = (next.get(observationId) ?? 0) + 1;
				const previousTimer = highlightTimersRef.current.get(observationId);
				if (previousTimer !== undefined) window.clearTimeout(previousTimer);
				next.set(observationId, version);
				highlightVersionsRef.current = next;
				setHighlightVersions(next);
				const timer = window.setTimeout(() => {
					if (highlightVersionsRef.current.get(observationId) !== version)
						return;
					const cleared = new Map(highlightVersionsRef.current);
					cleared.delete(observationId);
					highlightVersionsRef.current = cleared;
					setHighlightVersions(cleared);
					if (highlightTimersRef.current.get(observationId) === timer) {
						highlightTimersRef.current.delete(observationId);
					}
				}, HIGHLIGHT_MS);
				highlightTimersRef.current.set(observationId, timer);
			},
			onStatus: (status: "complete" | "not_found") => {
				if (status === "not_found") setNotFound(true);
				if (status === "complete") setRecordingStatus("complete");
			},
		}),
		[clearHighlightTimers],
	);
	const stream = useTraceStream(id, handlers, project?.selectedProjectId);
	React.useEffect(() => {
		if (!validId || receivedSnapshot || notFound) return;
		const timeout = window.setTimeout(
			() => setSnapshotTimedOut(true),
			SNAPSHOT_TIMEOUT_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [notFound, receivedSnapshot, validId]);
	const observations = React.useMemo(
		() => traceModelObservations(model),
		[model],
	);

	React.useEffect(() => {
		if (observations.length === 0) {
			setSelectedObservationId(null);
			return;
		}
		if (
			spanDeepLink &&
			observations.some(
				(observation) => observation.observation_id === spanDeepLink,
			)
		) {
			setSelectedObservationId(spanDeepLink);
			return;
		}
		if (
			selectedObservationId &&
			observations.some(
				(observation) => observation.observation_id === selectedObservationId,
			)
		)
			return;
		const root =
			observations.find((observation) => !observation.parent_observation_id) ??
			observations[0];
		setSelectedObservationId(root?.observation_id ?? null);
	}, [observations, selectedObservationId, spanDeepLink]);

	const selectedObservation = React.useMemo(
		() =>
			observations.find(
				(observation) => observation.observation_id === selectedObservationId,
			) ?? null,
		[observations, selectedObservationId],
	);

	function resizeWorkspace(clientX: number) {
		const bounds = splitContainerRef.current?.getBoundingClientRect();
		if (!bounds || bounds.width === 0) return;
		setWorkspaceWidth(
			clampWorkspaceWidth(((clientX - bounds.left) / bounds.width) * 100),
		);
	}

	if (!validId) {
		return (
			<NotFound>
				The id <span className="font-mono">{id}</span> is not a valid
				32-character lowercase hex trace id.
			</NotFound>
		);
	}

	if (notFound) {
		return (
			<NotFound>
				No trace exists for <span className="font-mono">{id}</span>.
			</NotFound>
		);
	}

	return (
		<div className="space-y-4" data-testid="trace-detail-page">
			<TraceHeader
				traceId={id}
				observations={observations}
				trace={model.trace}
				recordingStatus={recordingStatus}
				streamControl={<StreamToggle sse={stream} />}
				actions={
					<>
						<FeedbackControls
							projectId={project?.selectedProjectId ?? null}
							traceId={id}
							label="trace"
						/>
						<AddToDatasetDialog
							projectId={project?.selectedProjectId ?? null}
							traceId={id}
							inputText={
								typeof model.trace?.input_text === "string"
									? model.trace.input_text
									: ""
							}
							outputText={
								typeof model.trace?.output_text === "string"
									? model.trace.output_text
									: ""
							}
							label="trace"
						/>
					</>
				}
				onRefresh={() => {
					setRecordingStatus("recording");
					stream.reconnect();
				}}
			/>
			{(snapshotTimedOut || stream.debug.lastError) && !receivedSnapshot && (
				<div
					className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
					role="alert"
				>
					<span>
						{stream.debug.lastError
							? `Live trace connection failed: ${stream.debug.lastError}`
							: "The trace snapshot is taking longer than expected."}
					</span>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setSnapshotTimedOut(false);
							stream.reconnect();
						}}
					>
						Retry connection
					</Button>
				</div>
			)}
			<div
				ref={splitContainerRef}
				className="grid gap-4 xl:gap-0 xl:grid-cols-[minmax(0,var(--trace-workspace-width))_0.5rem_minmax(22rem,1fr)]"
				style={
					inspectorOpen
						? ({
								"--trace-workspace-width": `${workspaceWidth}%`,
							} as React.CSSProperties)
						: undefined
				}
			>
				<TraceWorkspace
					observations={observations}
					selectedObservationId={selectedObservationId}
					onSelectObservation={selectObservation}
					highlightVersions={highlightVersions}
					malformedObservationCount={model.malformedObservationCount}
					onCloseInspector={closeInspector}
					focusRequestVersion={focusWorkspaceVersion}
				/>
				{inspectorOpen && (
					<div
						className="relative hidden cursor-col-resize touch-none xl:block"
						role="separator"
						tabIndex={0}
						aria-label="Resize trace workspace and inspector"
						aria-orientation="vertical"
						aria-valuemin={MIN_WORKSPACE_WIDTH}
						aria-valuemax={MAX_WORKSPACE_WIDTH}
						aria-valuenow={workspaceWidth}
						onPointerDown={(event) => {
							event.currentTarget.setPointerCapture(event.pointerId);
							resizeWorkspace(event.clientX);
						}}
						onPointerMove={(event) => {
							if (event.currentTarget.hasPointerCapture(event.pointerId))
								resizeWorkspace(event.clientX);
						}}
						onPointerUp={(event) => {
							if (event.currentTarget.hasPointerCapture(event.pointerId))
								event.currentTarget.releasePointerCapture(event.pointerId);
						}}
						onKeyDown={(event) => {
							if (event.key === "ArrowLeft") {
								event.preventDefault();
								setWorkspaceWidth((width) => clampWorkspaceWidth(width - 2));
							} else if (event.key === "ArrowRight") {
								event.preventDefault();
								setWorkspaceWidth((width) => clampWorkspaceWidth(width + 2));
							} else if (event.key === "Home") {
								event.preventDefault();
								setWorkspaceWidth(MIN_WORKSPACE_WIDTH);
							} else if (event.key === "End") {
								event.preventDefault();
								setWorkspaceWidth(MAX_WORKSPACE_WIDTH);
							}
						}}
						data-testid="trace-detail-splitter"
					>
						<span
							className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
							aria-hidden="true"
						/>
					</div>
				)}
				{inspectorOpen ? (
					<ObservationDetailPanel
						traceId={id}
						observation={selectedObservation}
						actions={
							selectedObservation ? (
								<>
									<FeedbackControls
										projectId={project?.selectedProjectId ?? null}
										traceId={id}
										observationId={selectedObservation.observation_id}
										label="Observation"
									/>
									<AddToDatasetDialog
										projectId={project?.selectedProjectId ?? null}
										traceId={id}
										observationId={selectedObservation.observation_id}
										inputText={
											typeof selectedObservation.input_text === "string"
												? selectedObservation.input_text
												: ""
										}
										outputText={
											typeof selectedObservation.output_text === "string"
												? selectedObservation.output_text
												: ""
										}
										label="Observation"
									/>
								</>
							) : undefined
						}
						onClose={closeInspector}
					/>
				) : (
					<div className="mt-4 xl:col-span-2 xl:mt-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => setInspectorOpen(true)}
							data-testid="show-inspector"
						>
							Show inspector
						</Button>
					</div>
				)}
			</div>
			<SseDebugOverlay sse={stream} label={`trace/${id.slice(0, 8)}…`} />
		</div>
	);
}
