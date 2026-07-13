export type PersistedObservationType = "span" | "event" | "generation" | "tool";

export interface ObservationKind {
  type: PersistedObservationType | null;
  label: string;
  icon: string;
  color: "slate" | "blue" | "violet" | "amber";
}

const KINDS: Record<PersistedObservationType, ObservationKind> = {
  span: { type: "span", label: "Span", icon: "○", color: "slate" },
  event: { type: "event", label: "Event", icon: "◇", color: "blue" },
  generation: { type: "generation", label: "Generation", icon: "✦", color: "violet" },
  tool: { type: "tool", label: "Tool", icon: "⌘", color: "amber" },
};

const UNKNOWN_KIND: ObservationKind = { type: null, label: "Unknown", icon: "?", color: "slate" };

export function observationKind(value: unknown): ObservationKind {
  if (typeof value !== "string" || !(value in KINDS)) return UNKNOWN_KIND;
  return KINDS[value as PersistedObservationType];
}
