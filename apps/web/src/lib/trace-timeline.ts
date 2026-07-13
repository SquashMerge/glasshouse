import type { CanonicalObservation } from "./trace-model";

export type TimingWarning =
  | "invalid_start"
  | "invalid_end"
  | "end_before_start"
  | "duration_unset"
  | "invalid_duration";

export interface ObservationTiming {
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  warnings: TimingWarning[];
  isRenderable: boolean;
}

export interface TimelineBar {
  observationId: string;
  startMs: number;
  endMs: number;
  leftPercent: number;
  widthPercent: number;
}

export interface TraceTimeline {
  startMs: number | null;
  endMs: number | null;
  bars: readonly TimelineBar[];
  invalidObservationIds: readonly string[];
}

const CLICKHOUSE_UTC = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;

export function parseClickHouseUtc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = CLICKHOUSE_UTC.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText || !secondText) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number(`${fraction}000`.slice(0, 3));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const date = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return timestamp;
}

export function observationTiming(observation: Pick<CanonicalObservation, "start_time" | "end_time" | "duration_ms">): ObservationTiming {
  const warnings: TimingWarning[] = [];
  const startMs = parseClickHouseUtc(observation.start_time);
  if (startMs === null) warnings.push("invalid_start");

  const hasEnd = observation.end_time !== null && observation.end_time !== undefined && observation.end_time !== "";
  const endFromRow = hasEnd ? parseClickHouseUtc(observation.end_time) : null;
  if (hasEnd && endFromRow === null) warnings.push("invalid_end");
  if (startMs !== null && endFromRow !== null && endFromRow < startMs) warnings.push("end_before_start");

  const durationMs = typeof observation.duration_ms === "number" && Number.isFinite(observation.duration_ms)
    ? observation.duration_ms
    : null;
  if (durationMs === null) warnings.push("duration_unset");
  else if (durationMs < 0) warnings.push("invalid_duration");

  const isRenderable = startMs !== null && durationMs !== null && durationMs >= 0 && !warnings.includes("end_before_start");
  return {
    startMs,
    endMs: isRenderable ? startMs + durationMs : endFromRow,
    durationMs,
    warnings,
    isRenderable,
  };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function createTraceTimeline(observations: readonly CanonicalObservation[]): TraceTimeline {
  const timings = observations.map((observation) => ({ observation, timing: observationTiming(observation) }));
  const renderable = timings.filter((entry): entry is { observation: CanonicalObservation; timing: ObservationTiming & { startMs: number; endMs: number } } => (
    entry.timing.isRenderable && entry.timing.startMs !== null && entry.timing.endMs !== null
  ));
  const invalidObservationIds = timings
    .filter((entry) => !entry.timing.isRenderable)
    .map((entry) => entry.observation.observation_id);
  if (renderable.length === 0) {
    return { startMs: null, endMs: null, bars: [], invalidObservationIds };
  }

  const startMs = Math.min(...renderable.map((entry) => entry.timing.startMs));
  const maximumEnd = Math.max(...renderable.map((entry) => entry.timing.endMs));
  const endMs = maximumEnd > startMs ? maximumEnd : startMs + 1;
  const range = endMs - startMs;
  const bars = renderable.map(({ observation, timing }) => ({
    observationId: observation.observation_id,
    startMs: timing.startMs,
    endMs: timing.endMs,
    leftPercent: clampPercent(((timing.startMs - startMs) / range) * 100),
    widthPercent: clampPercent(((timing.endMs - timing.startMs) / range) * 100),
  }));
  return { startMs, endMs, bars, invalidObservationIds };
}
