import { LuCalendar, LuChevronDown } from "react-icons/lu";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

export type TimeRange =
	| { kind: "all" }
	| { kind: "last"; minutes: number }
	| { kind: "custom"; from: string; to: string };

const PRESETS: { label: string; value: TimeRange }[] = [
	{ label: "All", value: { kind: "all" } },
	{ label: "Last 5 minutes", value: { kind: "last", minutes: 5 } },
	{ label: "Last 15 minutes", value: { kind: "last", minutes: 15 } },
	{ label: "Last 1 hour", value: { kind: "last", minutes: 60 } },
	{ label: "Last 24 hours", value: { kind: "last", minutes: 60 * 24 } },
	{ label: "Last 7 days", value: { kind: "last", minutes: 60 * 24 * 7 } },
	{ label: "Last 30 days", value: { kind: "last", minutes: 60 * 24 * 30 } },
	{ label: "Custom…", value: { kind: "custom", from: "", to: "" } },
];

export function presetFor(range: TimeRange): TimeRange {
	return range;
}

export function defaultRange(): TimeRange {
	return { kind: "all" };
}

export function labelFor(range: TimeRange): string {
	if (range.kind === "all") return "All";
	if (range.kind === "last") {
		const m = range.minutes;
		if (m < 60) return `Last ${m} minutes`;
		if (m < 60 * 24) return `Last ${m / 60} hour${m === 60 ? "" : "s"}`;
		return `Last ${m / (60 * 24)} day${m === 60 * 24 ? "" : "s"}`;
	}
	return "Custom";
}

export function toApiParams(range: TimeRange): {
	time_from?: string;
	time_to?: string;
} {
	if (range.kind === "all") return {};
	if (range.kind === "last") {
		const now = new Date();
		const from = new Date(now.getTime() - range.minutes * 60_000);
		return {
			time_from: toClickhouseDatetime(from),
			time_to: toClickhouseDatetime(now),
		};
	}
	if (!isTimeRangeValid(range)) return {};
	return {
		time_from: fromDatetimeLocal(range.from),
		time_to: fromDatetimeLocal(range.to),
	};
}

export function timeRangeError(range: TimeRange): string | null {
	if (range.kind !== "custom") return null;
	if (!range.from || !range.to) return "Enter both a start and end time.";
	const from = new Date(range.from);
	const to = new Date(range.to);
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
		return "Enter valid local date and time values.";
	if (from > to) return "The start time must be before the end time.";
	return null;
}

export function isTimeRangeValid(range: TimeRange): boolean {
	return timeRangeError(range) === null;
}

function fromDatetimeLocal(v: string): string {
	if (!v) return "";
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return "";
	return toClickhouseDatetime(d);
}

function toClickhouseDatetime(d: Date): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	);
}

function isRangeEqual(a: TimeRange, b: TimeRange): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "last" && b.kind === "last") return a.minutes === b.minutes;
	if (a.kind === "custom" && b.kind === "custom")
		return a.from === b.from && a.to === b.to;
	return true;
}

function matchPreset(range: TimeRange): string {
	const preset = PRESETS.find((p) => isRangeEqual(p.value, range));
	return preset?.label ?? "Custom…";
}

export function TimeRangePicker({
	value,
	onChange,
}: {
	value: TimeRange;
	onChange: (next: TimeRange) => void;
}) {
	const selectedLabel = matchPreset(value);
	const isCustom = value.kind === "custom";
	const error = timeRangeError(value);

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
			<span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<LuCalendar className="h-3.5 w-3.5" />
				Time range
			</span>

			<label className="relative">
				<select
					value={selectedLabel}
					onChange={(e) => {
						const preset = PRESETS.find((p) => p.label === e.target.value);
						if (!preset) return;
						onChange(preset.value);
					}}
					className={cn(
						"h-8 appearance-none rounded-md border border-input bg-background pl-3 pr-8 text-xs",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
					)}
				>
					{PRESETS.map((p) => (
						<option key={p.label} value={p.label}>
							{p.label}
						</option>
					))}
				</select>
				<LuChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			</label>

			{isCustom && (
				<>
					<span className="text-xs text-muted-foreground">From</span>
					<Input
						type="datetime-local"
						value={value.from}
						onChange={(e) =>
							onChange({ kind: "custom", from: e.target.value, to: value.to })
						}
						className="h-8 w-[200px] text-xs"
						aria-label="From"
					/>
					<span className="text-xs text-muted-foreground">To</span>
					<Input
						type="datetime-local"
						value={value.to}
						onChange={(e) =>
							onChange({ kind: "custom", from: value.from, to: e.target.value })
						}
						className="h-8 w-[200px] text-xs"
						aria-label="To"
					/>
				</>
			)}

			{value.kind === "last" && (
				<span className="text-xs text-muted-foreground">
					from {labelFor(value).toLowerCase().replace("last ", "")} ago to now
				</span>
			)}
			{error && (
				<span className="w-full text-xs text-destructive" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
