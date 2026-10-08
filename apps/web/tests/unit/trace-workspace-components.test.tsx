import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ObservationDetailPanel } from "../../src/components/ObservationDetailPanel";
import { TraceHeader } from "../../src/components/TraceHeader";
import { TraceWorkspace } from "../../src/components/TraceWorkspace";
import type { CanonicalObservation } from "../../src/lib/trace-model";

vi.mock("../../src/components/PromptProvenanceCard", () => ({
	PromptProvenanceCard: () => null,
}));

const TRACE_ID = "a".repeat(32);

function observation(
	overrides: Record<string, unknown> = {},
): CanonicalObservation {
	return {
		observation_id: "root",
		parent_observation_id: null,
		name: "root operation",
		start_time: "2026-07-13 12:00:00.000",
		duration_ms: 100,
		status: "ok",
		type: "span",
		input_text: "input text",
		output_text: "output text",
		metadata: "{}",
		...overrides,
	};
}

describe("TraceHeader", () => {
	it("summarizes the trace and exposes raw JSON without exposing the full id visually", () => {
		render(
			<TraceHeader
				traceId={TRACE_ID}
				observations={[
					observation(),
					observation({
						observation_id: "failed",
						name: "failed child",
						parent_observation_id: "root",
						status: "error",
						start_time: "2026-07-13 12:00:00.050",
						duration_ms: 50,
					}),
				]}
				trace={{ source: "test" }}
				onRefresh={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("trace-name")).toHaveTextContent(
			"root operation",
		);
		expect(screen.getByTestId("trace-summary-status")).toHaveTextContent(
			"1 error",
		);
		expect(screen.getByTestId("refresh-trace")).toBeInTheDocument();
		expect(screen.queryByTestId("trace-raw-json")).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId("open-trace-json"));
		expect(screen.getByTestId("trace-raw-json")).toHaveTextContent(
			'"source": "test"',
		);
	});
});

describe("TraceWorkspace", () => {
	const observations = [
		observation(),
		observation({
			observation_id: "child",
			parent_observation_id: "root",
			name: "matching child",
			start_time: "2026-07-13 12:00:00.025",
			duration_ms: 25,
			type: "tool",
		}),
		observation({
			observation_id: "no-time",
			parent_observation_id: "root",
			name: "untimed child",
			start_time: "invalid",
			duration_ms: null,
		}),
	];

	it("renders hierarchy, selects waterfall bars, and reveals search matches", () => {
		const onSelectObservation = vi.fn();
		render(
			<TraceWorkspace
				observations={observations}
				selectedObservationId="root"
				onSelectObservation={onSelectObservation}
			/>,
		);

		expect(screen.getAllByTestId("span-row")).toHaveLength(3);
		expect(screen.getAllByTestId("waterfall-bar")).toHaveLength(2);
		expect(screen.getByTestId("timing-warning")).toHaveTextContent(
			"Timing unavailable",
		);

		fireEvent.click(screen.getAllByTestId("waterfall-bar")[1]!);
		expect(onSelectObservation).toHaveBeenCalledWith("child");

		fireEvent.change(screen.getByTestId("trace-search"), {
			target: { value: "matching" },
		});
		expect(screen.getByTestId("trace-search-count")).toHaveTextContent(
			"1 match",
		);

		fireEvent.click(screen.getByRole("button", { name: "Tree" }));
		expect(screen.queryByTestId("timeline-ruler")).not.toBeInTheDocument();
		expect(screen.getAllByTestId("span-row")).toHaveLength(3);
	});

	it("collapses descendants while leaving the selected observation controlled by its parent", () => {
		const onSelectObservation = vi.fn();
		render(
			<TraceWorkspace
				observations={observations}
				selectedObservationId="child"
				onSelectObservation={onSelectObservation}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Collapse root operation" }),
		);
		expect(screen.getAllByTestId("span-row")).toHaveLength(1);
	});
});

describe("ObservationDetailPanel", () => {
	it("renders persisted kind, service/scope/events/links, input/output, structured attributes, and malformed metadata safely", () => {
		const { rerender } = render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					type: "generation",
					metadata: JSON.stringify({
						resource: { "service.name": "agent" },
						"service.name": "agent",
						scope: { name: "otel.sdk", version: "1.2.3" },
						events: [{ name: "exception", time_unix_nano: "1" }],
						links: [{ trace_id: "linked-trace", span_id: "linked-span" }],
					}),
				})}
			/>,
		);

		expect(screen.getByTestId("detail-overview")).toHaveTextContent(
			"Generation",
		);
		expect(screen.getByTestId("detail-overview")).toHaveTextContent("agent");
		expect(screen.getByTestId("detail-overview")).toHaveTextContent(
			"otel.sdk @ 1.2.3",
		);
		fireEvent.click(screen.getByRole("tab", { name: "Input" }));
		expect(screen.getByTestId("detail-input")).toHaveTextContent("input text");
		fireEvent.click(screen.getByRole("tab", { name: "Resource" }));
		expect(
			screen.getByText("service.name", { selector: "dt" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Events" }));
		expect(screen.getByTestId("detail-events")).toHaveTextContent("exception");
		expect(
			screen.getByRole("button", { name: "Copy Event 1 value" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Links" }));
		expect(screen.getByTestId("detail-links")).toHaveTextContent(
			"linked-trace",
		);
		expect(
			screen.getByRole("button", { name: "Copy Link 1 value" }),
		).toBeInTheDocument();

		rerender(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({ metadata: "not json" })}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		expect(screen.getByTestId("detail-metadata")).toHaveTextContent(
			"Metadata could not be parsed.",
		);
	});
});
