import * as React from "react";
import {
	LuChevronDown,
	LuChevronUp,
	LuPlus,
	LuRefreshCw,
	LuX,
} from "react-icons/lu";
import type { UseEventSourceResult } from "../hooks/useEventSource";
import { seedRandomTrace } from "../lib/api";
import { cn } from "../lib/utils";

/**
 * Floating SSE debug card. Render ONLY in `import.meta.env.DEV` (Vite's
 * dev-mode flag) so production bundles never ship the inspector UI. The
 * consumer (TracesTab / SpansTab / TraceDetailPage) gates the render with
 * `import.meta.env.DEV`; this component is a no-op otherwise.
 *
 * Shows live state from `useEventSource.debug`:
 *   - URL
 *   - connection status (open / connecting / closed)
 *   - paused flag
 *   - lastEventAt ("12s ago" or "waiting")
 *   - framesReceived (count)
 *   - bufferDepth (current RAF coalesce queue length)
 *   - reconnectAttempts
 *   - lastError (if any)
 *
 * Includes controls to seed a random trace and force a reconnect.
 */

export interface SseDebugOverlayProps {
	/** The full hook result. Use the live getters — they read through to the
	 * underlying refs each time, so the card stays current without rerendering. */
	sse: UseEventSourceResult;
	/** Identifier for the SSE pipe (e.g. "traces" or "trace/<id>"). Shown in header. */
	label: string;
	/**
	 * Override the dev-mode gate. Defaults to `import.meta.env.DEV` (Vite
	 * build-time replacement). Tests pass `devMode={true|false}` directly.
	 */
	devMode?: boolean;
}

function formatRelative(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s ago`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ago`;
}

export function SseDebugOverlay({
	sse,
	label,
	devMode,
}: SseDebugOverlayProps): React.ReactElement | null {
	// Bail in production — Vite's `import.meta.env.DEV` is statically replaced
	// at build time so this branch is dead code in `vite build` output. Tests
	// pass `devMode={true|false}` directly to override.
	const inDev =
		devMode ??
		(import.meta as ImportMeta & { env: { DEV?: boolean } }).env.DEV ??
		false;
	if (!inDev) return null;

	// Re-render every second so `lastEventAt` staleness stays fresh.
	const [, setTick] = React.useState(0);
	React.useEffect(() => {
		if (sse.paused || sse.lastEventAt === null) return;
		const t = window.setInterval(() => setTick((n) => n + 1), 1000);
		return () => window.clearInterval(t);
	}, [sse.paused, sse.lastEventAt]);

	const [collapsed, setCollapsed] = React.useState(false);
	const [seedState, setSeedState] = React.useState<
		"idle" | "pending" | "error"
	>("idle");
	// Allow the user to hide the overlay locally; a small dismiss-X in the
	// corner clears a sessionStorage flag so a refresh in the same dev session
	// doesn't bring it back.
	const [dismissed, setDismissed] = React.useState<boolean>(() => {
		if (typeof sessionStorage === "undefined") return false;
		return sessionStorage.getItem("astraea.sse-debug.dismissed") === "1";
	});
	React.useEffect(() => {
		if (typeof sessionStorage === "undefined") return;
		if (dismissed) sessionStorage.setItem("astraea.sse-debug.dismissed", "1");
		else sessionStorage.removeItem("astraea.sse-debug.dismissed");
	}, [dismissed]);

	if (dismissed) return null;

	const { status, paused, lastEventAt } = sse;
	const { framesReceived, bufferDepth, reconnectAttempts, lastError } =
		sse.debug;

	const lastEventDelta = lastEventAt === null ? null : Date.now() - lastEventAt;

	const handleSeedTrace = async (): Promise<void> => {
		setSeedState("pending");
		try {
			await seedRandomTrace();
			setSeedState("idle");
		} catch {
			setSeedState("error");
		}
	};

	return (
		<div
			data-testid="sse-debug-overlay"
			data-state={paused ? "paused" : status}
			className={cn(
				"fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur",
				"font-mono text-[11px]",
			)}
		>
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
				<div className="flex min-w-0 items-center gap-1.5">
					<span
						className={cn(
							"h-2 w-2 rounded-full",
							paused
								? "bg-muted-foreground/50"
								: status === "open"
									? "bg-green-500 animate-pulse"
									: status === "connecting"
										? "bg-amber-500"
										: "bg-amber-500",
						)}
						aria-hidden="true"
					/>
					<span
						className="font-sans text-xs font-semibold"
						data-testid="sse-debug-label"
					>
						SSE · {label}
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						aria-label="Seed random trace"
						title={
							seedState === "error"
								? "Failed to seed trace"
								: "Seed random trace"
						}
						data-testid="sse-debug-seed"
						disabled={seedState === "pending"}
						onClick={() => void handleSeedTrace()}
						className={cn(
							"rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
							seedState === "error" && "text-destructive",
						)}
					>
						<LuPlus
							className={cn(
								"h-3 w-3",
								seedState === "pending" && "animate-pulse",
							)}
						/>
					</button>
					<button
						type="button"
						aria-label="Force reconnect"
						data-testid="sse-debug-reconnect"
						onClick={() => sse.reconnect()}
						className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<LuRefreshCw className="h-3 w-3" />
					</button>
					<button
						type="button"
						aria-label="Toggle collapsed"
						onClick={() => setCollapsed((c) => !c)}
						className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						{collapsed ? (
							<LuChevronUp className="h-3 w-3" />
						) : (
							<LuChevronDown className="h-3 w-3" />
						)}
					</button>
					<button
						type="button"
						aria-label="Dismiss overlay"
						data-testid="sse-debug-dismiss"
						onClick={() => setDismissed(true)}
						className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<LuX className="h-3 w-3" />
					</button>
				</div>
			</div>

			{!collapsed && (
				<dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 px-3 py-2">
					<Stat label="status">{status}</Stat>
					<Stat label="paused">{String(paused)}</Stat>
					<Stat label="lastEvent">
						{lastEventAt === null
							? "—"
							: lastEventDelta === null
								? "—"
								: formatRelative(lastEventDelta)}
					</Stat>
					<Stat label="framesReceived">{framesReceived}</Stat>
					<Stat label="bufferDepth">{bufferDepth}</Stat>
					<Stat label="reconnectAttempts">{reconnectAttempts}</Stat>
					<Stat label="lastError">{lastError ?? "—"}</Stat>
				</dl>
			)}
		</div>
	);
}

function Stat({
	label,
	children,
}: { label: string; children: React.ReactNode }): React.ReactElement {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className="truncate text-foreground"
				data-testid={`sse-debug-${label}`}
			>
				{children}
			</dd>
		</>
	);
}
