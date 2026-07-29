import * as React from "react";
import { LuClipboard, LuCode, LuRefreshCw } from "react-icons/lu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { copyText } from "../lib/clipboard";
import { createTraceTimeline } from "../lib/trace-timeline";
import type { CanonicalObservation } from "../lib/trace-model";

export interface TraceHeaderProps {
	traceId: string;
	observations: readonly CanonicalObservation[];
	trace?: unknown;
	recordingStatus?: "recording" | "complete";
	streamControl?: React.ReactNode;
	onRefresh?: () => void;
	actions?: React.ReactNode;
}

function formatDuration(milliseconds: number | null): string {
	if (milliseconds === null) return "Timing unavailable";
	if (milliseconds < 1_000) return `${milliseconds} ms`;
	return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} s`;
}

function formatStart(milliseconds: number | null): {
	local: string;
	utc: string;
} {
	if (milliseconds === null)
		return { local: "Start time unavailable", utc: "" };
	const date = new Date(milliseconds);
	return {
		local: date.toLocaleString(),
		utc: date.toISOString(),
	};
}

function objectValue(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return (value as Record<string, unknown>)[key];
}

function telemetryValue(value: unknown): string | null {
	if (typeof value === "string" && value) return value;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	for (const key of ["stringValue", "value", "name"]) {
		const candidate = objectValue(value, key);
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return null;
}

function metadataAttribute(
	observation: CanonicalObservation | undefined,
	key: string,
): string | null {
	if (!observation || typeof observation.metadata !== "string") return null;
	try {
		const metadata: unknown = JSON.parse(observation.metadata);
		const attributes = Array.isArray(metadata)
			? metadata
			: (objectValue(metadata, "attributes") ??
				objectValue(objectValue(metadata, "resource"), "attributes"));
		if (!Array.isArray(attributes)) return null;
		const attribute = attributes.find(
			(item) => objectValue(item, "key") === key,
		);
		return telemetryValue(objectValue(attribute, "value"));
	} catch {
		return null;
	}
}

function traceField(trace: unknown, key: string): string | null {
	const value = objectValue(trace, key);
	return typeof value === "string" && value ? value : null;
}

function observationField(
	observation: CanonicalObservation | undefined,
	key: string,
): string | null {
	const value = objectValue(observation, key);
	return typeof value === "string" && value ? value : null;
}

export function TraceHeader({
	traceId,
	observations,
	trace,
	recordingStatus = "recording",
	streamControl,
	onRefresh,
	actions,
}: TraceHeaderProps) {
	const [rawOpen, setRawOpen] = React.useState(false);
	const [copyState, setCopyState] = React.useState<
		"idle" | "copied" | "failed" | "copied raw JSON" | "failed to copy raw JSON"
	>("idle");
	const timeline = React.useMemo(
		() => createTraceTimeline(observations),
		[observations],
	);
	const root =
		observations.find((observation) => !observation.parent_observation_id) ??
		observations[0];
	const errorCount = observations.filter(
		(observation) => observation.status === "error",
	).length;
	const status = errorCount > 0 ? "error" : "ok";
	const start = formatStart(timeline.startMs);
	const duration =
		timeline.startMs !== null && timeline.endMs !== null
			? timeline.endMs - timeline.startMs
			: null;
	const rawPayload = React.useMemo(
		() => ({ trace, observations }),
		[trace, observations],
	);
	const traceName =
		traceField(trace, "name") ??
		(typeof root?.name === "string" && root.name ? root.name : "Unnamed trace");
	const rootService =
		traceField(trace, "root_service") ??
		traceField(trace, "service_name") ??
		observationField(root, "service_name") ??
		observationField(root, "service") ??
		metadataAttribute(root, "service.name") ??
		"—";

	async function copyTraceId() {
		const result = await copyText(traceId);
		setCopyState(result.ok ? "copied" : "failed");
	}

	async function copyRawJson() {
		const result = await copyText(JSON.stringify(rawPayload, null, 2));
		setCopyState(result.ok ? "copied raw JSON" : "failed to copy raw JSON");
	}

	return (
		<section
			className="space-y-3 rounded-lg border bg-card p-4"
			data-testid="trace-header"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="text-xs font-medium text-muted-foreground">Trace</div>
					<h1
						className="truncate text-lg font-semibold"
						data-testid="trace-name"
					>
						{traceName}
					</h1>
					<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<code
							className="truncate font-mono"
							title={traceId}
							data-testid="trace-id"
						>
							{traceId}
						</code>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-7 w-7"
							aria-label="Copy trace ID"
							title="Copy trace ID"
							onClick={copyTraceId}
							data-testid="copy-trace-id"
						>
							<LuClipboard className="h-3.5 w-3.5" aria-hidden="true" />
						</Button>
						<span className="sr-only" aria-live="polite">
							{copyState === "copied"
								? "Trace ID copied"
								: copyState === "copied raw JSON"
									? "Raw JSON copied"
									: copyState === "failed"
										? "Unable to copy trace ID"
										: copyState === "failed to copy raw JSON"
											? "Unable to copy raw JSON"
											: ""}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{actions}
					{streamControl}
					{onRefresh && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onRefresh}
							data-testid="refresh-trace"
						>
							<LuRefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
							Refresh
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-expanded={rawOpen}
						onClick={() => setRawOpen((open) => !open)}
						data-testid="open-trace-json"
					>
						<LuCode className="h-3.5 w-3.5" aria-hidden="true" />
						Raw JSON
					</Button>
				</div>
			</div>

			<dl
				className="grid gap-3 border-t pt-3 text-sm sm:grid-cols-2 lg:grid-cols-6"
				data-testid="trace-summary"
			>
				<div>
					<dt className="text-xs text-muted-foreground">Status</dt>
					<dd
						className="mt-1 flex items-center gap-1.5"
						data-testid="trace-summary-status"
					>
						<Badge variant={status === "error" ? "destructive" : "secondary"}>
							{status === "error" ? "Error" : "OK"}
						</Badge>
						<Badge variant="outline" data-testid="trace-recording-status">
							{recordingStatus === "complete" ? "Recorded" : "Recording"}
						</Badge>
						{errorCount > 0 && (
							<span className="text-xs">
								{errorCount} error{errorCount === 1 ? "" : "s"}
							</span>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Duration</dt>
					<dd className="mt-1 font-medium tabular-nums">
						{formatDuration(duration)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Started</dt>
					<dd className="mt-1 truncate tabular-nums" title={start.utc}>
						{start.local}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Observations</dt>
					<dd className="mt-1 font-medium tabular-nums">
						{observations.length}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Root observation</dt>
					<dd
						className="mt-1 truncate"
						title={typeof root?.name === "string" ? root.name : undefined}
					>
						{typeof root?.name === "string" && root.name ? root.name : "—"}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Root service</dt>
					<dd
						className="mt-1 truncate"
						title={rootService}
						data-testid="trace-root-service"
					>
						{rootService}
					</dd>
				</div>
			</dl>

			{rawOpen && (
				<div className="space-y-2" data-testid="trace-raw-json">
					<div className="flex justify-end">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={copyRawJson}
							data-testid="copy-trace-json"
						>
							<LuClipboard className="h-3.5 w-3.5" aria-hidden="true" />
							Copy raw JSON
						</Button>
					</div>
					<pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
						{JSON.stringify(rawPayload, null, 2)}
					</pre>
				</div>
			)}
		</section>
	);
}
