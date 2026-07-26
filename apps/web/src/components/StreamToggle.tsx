import * as React from "react";
import { LuPower } from "react-icons/lu";
import { cn } from "../lib/utils";
import type { EventSourceStatus } from "../hooks/useEventSource";

/**
 * Read-only shape that `StreamToggle` consumes. Both `useEventSource` and
 * `useTraceStream` already return objects that satisfy this (the detail-page
 * wrapper's result is keyed by getters that read through to the underlying
 * `useEventSource` handle, so `reconnect` / `paused` / `status` are visible).
 */
export interface StreamController {
	paused: boolean;
	status: EventSourceStatus;
	completed?: boolean;
	reconnect: (opts?: { pause?: boolean }) => void;
}

export interface StreamToggleProps {
	sse: StreamController;
	/** Label rendered to the left of the switch. Default "Stream". */
	label?: string;
	className?: string;
}

type State =
	| "off"
	| "complete"
	| "on-connecting"
	| "on-open"
	| "on-reconnecting";

/**
 * The "Stream" toggle. Replaces the older Live/Pause/Reconnecting pill +
 * Pause/Resume button combo on the observability list tabs and the trace
 * detail page (one consistent UX across both surfaces).
 *
 * States:
 *   off              — user pause (`paused: true`). SSE is closed, no events.
 *   on-connecting    — first time connecting (race before `:ok` or first frame).
 *   on-open          — green pipeline, lastEventAt monospace below.
 *   on-reconnecting  — amber pipeline, exponential backoff in progress.
 */
export function StreamToggle({
	sse,
	label = "Stream",
	className,
}: StreamToggleProps): React.ReactElement {
	const state: State = sse.completed
		? "complete"
		: sse.paused
			? "off"
			: sse.status === "open"
				? "on-open"
				: sse.status === "connecting"
					? "on-connecting"
					: "on-reconnecting";

	const on = state !== "off" && state !== "complete";
	const statusWord =
		state === "complete"
			? "Complete"
			: state === "off"
				? "Paused"
				: state === "on-connecting"
					? "Connecting…"
					: state === "on-reconnecting"
						? "Reconnecting…"
						: "Streaming";

	const trackClass = (() => {
		if (state === "off" || state === "complete")
			return "bg-muted-foreground/40";
		if (state === "on-reconnecting" || state === "on-connecting")
			return "bg-amber-500";
		return "bg-green-500";
	})();

	function toggle() {
		sse.reconnect({ pause: on });
	}

	return (
		<div
			className={cn("inline-flex items-center gap-3", className)}
			data-testid="stream-toggle"
			data-state={state}
		>
			<button
				type="button"
				role="switch"
				aria-checked={on}
				aria-label={`${label} ${on ? "on" : "off"}`}
				onClick={toggle}
				data-testid="stream-toggle-button"
				className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium hover:bg-muted/60"
			>
				<LuPower className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
				<span className="text-foreground">{label}</span>
				<span
					className={cn(
						"relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
						trackClass,
					)}
					aria-hidden="true"
				>
					<span
						className={cn(
							"inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform",
							on ? "translate-x-3" : "translate-x-0.5",
						)}
					/>
				</span>
				<span className="min-w-[5.5rem] text-left text-muted-foreground">
					{statusWord}
				</span>
			</button>
		</div>
	);
}
