import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservationDetailPanel } from "../../src/components/ObservationDetailPanel";
import type { CanonicalObservation } from "../../src/lib/trace-model";

const TRACE_ID = "a".repeat(32);
let clipboardDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
	if (clipboardDescriptor) {
		Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "clipboard");
	}
	clipboardDescriptor = undefined;
});

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
		input_text: "plain input text",
		output_text: "plain output text",
		metadata: {},
		...overrides,
	};
}

describe("ObservationDetailPanel JSON tree", () => {
	it("shows metadata fully expanded with one control to collapse and expand it", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					metadata: { nested: { value: "visible" } },
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		const tree = screen.getByTestId("detail-metadata");
		const nestedToggle = within(tree).getByRole("button", {
			name: /^Collapse \$\.nested \(/,
		});
		expect(nestedToggle).toHaveAttribute("aria-expanded", "true");
		expect(tree).toHaveTextContent('"visible"');

		fireEvent.click(
			within(tree).getByRole("button", { name: "Collapse all JSON nodes" }),
		);
		expect(
			within(tree).getByRole("button", {
				name: "Expand Metadata (object, 1 item)",
			}),
		).toHaveAttribute("aria-expanded", "false");
		expect(tree).not.toHaveTextContent('"visible"');

		fireEvent.click(
			within(tree).getByRole("button", { name: "Expand all JSON nodes" }),
		);
		expect(
			within(tree).getByRole("button", {
				name: "Collapse $.nested (object, 1 item)",
			}),
		).toHaveAttribute("aria-expanded", "true");
		expect(tree).toHaveTextContent('"visible"');
	});

	it("expands nested metadata and renders scalar types as safe text", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					metadata: {
						nested: {
							items: ["<script>alert(1)</script>", 7, true, null],
						},
					},
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		const tree = screen.getByTestId("detail-metadata");
		const nestedToggle = within(tree).getByRole("button", {
			name: /^Collapse \$\.nested \(/,
		});
		expect(nestedToggle).toHaveAttribute("aria-expanded", "true");
		expect(nestedToggle.tagName).toBe("BUTTON");
		expect(nestedToggle.tabIndex).toBe(0);
		nestedToggle.focus();
		expect(nestedToggle).toHaveFocus();
		fireEvent.click(nestedToggle);
		expect(nestedToggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(nestedToggle);
		expect(nestedToggle).toHaveAttribute("aria-expanded", "true");
		expect(within(tree).getByTestId("json-tree")).toHaveClass(
			"min-w-0",
			"max-w-full",
			"overflow-x-auto",
		);

		const itemsToggle = within(tree).getByRole("button", {
			name: /^Collapse \$\.nested\.items \(/,
		});
		expect(itemsToggle).toHaveAttribute("aria-expanded", "true");
		fireEvent.click(itemsToggle);
		expect(itemsToggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(itemsToggle);

		expect(tree.querySelector('[data-json-type="string"]')).toHaveTextContent(
			'"<script>alert(1)</script>"',
		);
		expect(tree.querySelector('[data-json-type="string"]')).toHaveClass(
			"text-json-type-string",
		);
		expect(tree.querySelector('[data-json-type="number"]')).toHaveTextContent(
			"7",
		);
		expect(tree.querySelector('[data-json-type="number"]')).toHaveClass(
			"text-json-type-number",
		);
		expect(tree.querySelector('[data-json-type="boolean"]')).toHaveTextContent(
			"true",
		);
		expect(tree.querySelector('[data-json-type="boolean"]')).toHaveClass(
			"text-json-type-boolean",
		);
		expect(tree.querySelector('[data-json-type="array"]')).toHaveClass(
			"text-json-type-array",
		);
		expect(tree.querySelector('[data-json-type="object"]')).toHaveClass(
			"text-json-type-object",
		);
		expect(tree.querySelector('[data-json-type="null"]')).toHaveTextContent(
			"null",
		);
		expect(tree.querySelector("script")).toBeNull();
	});

	it("renders object-valued attributes as a nested JSON tree", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					metadata: [{ key: "payload", value: { nested: { count: 7 } } }],
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));
		const attributes = screen.getByRole("tabpanel");
		fireEvent.click(
			within(attributes).getByRole("button", { name: /Expand \$\.nested/ }),
		);
		expect(
			attributes.querySelector('[data-json-type="number"]'),
		).toHaveTextContent("7");
	});

	it("renders event, link, and resource objects as expandable JSON", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					metadata: {
						events: [{ name: "exception", detail: { code: 5 } }],
						links: [{ trace_id: "linked-trace", flags: [true] }],
						resource: {
							service: { deployment: { name: "collector" } },
						},
					},
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Events" }));
		const events = screen.getByTestId("detail-events");
		fireEvent.click(
			within(events).getByRole("button", { name: /Expand \$\.detail/ }),
		);
		expect(events.querySelector('[data-json-type="number"]')).toHaveTextContent(
			"5",
		);

		fireEvent.click(screen.getByRole("tab", { name: "Links" }));
		const links = screen.getByTestId("detail-links");
		fireEvent.click(
			within(links).getByRole("button", { name: /Expand \$\.flags/ }),
		);
		expect(links.querySelector('[data-json-type="boolean"]')).toHaveTextContent(
			"true",
		);

		fireEvent.click(screen.getByRole("tab", { name: "Resource" }));
		const resource = screen.getByRole("tabpanel");
		fireEvent.click(
			within(resource).getByRole("button", {
				name: /Expand \$\.deployment/,
			}),
		);
		expect(resource).toHaveTextContent("collector");
	});

	it("copies selected JSON values and paths without changing full-observation copy", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		clipboardDescriptor = Object.getOwnPropertyDescriptor(
			navigator,
			"clipboard",
		);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const source = observation({
			metadata: { selected: { rows: [1, false] } },
		});
		render(<ObservationDetailPanel traceId={TRACE_ID} observation={source} />);

		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: "Copy JSON value at $.selected",
			}),
		);
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? "")).toEqual(
			source.metadata && (source.metadata as { selected: unknown }).selected,
		);

		writeText.mockClear();
		fireEvent.click(
			screen.getByRole("button", { name: "Copy JSON path $.selected" }),
		);
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith("$.selected");

		writeText.mockClear();
		fireEvent.click(screen.getByTestId("copy-observation-json"));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? "")).toEqual(source);
	});

	it("bounds wide and deeply nested payloads and identifies omitted content", () => {
		let deepValue: unknown = "bottom";
		for (let depth = 0; depth < 14; depth += 1) {
			deepValue = { child: deepValue };
		}
		const wideValues = Array.from({ length: 120 }, (_, index) => index);
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					metadata: { wide: wideValues, deep: deepValue },
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		const tree = screen.getByTestId("detail-metadata");
		expect(tree.querySelectorAll('[data-json-type="number"]')).toHaveLength(
			100,
		);
		expect(tree).toHaveTextContent("20 more items not shown (100-item limit).");
		expect(
			within(tree).getByTestId("json-tree-limit-notice"),
		).toHaveTextContent("500 nodes");
		expect(tree).toHaveTextContent("Depth limit (12 levels) reached.");

		fireEvent.click(
			within(tree).getByRole("button", { name: "Collapse all JSON nodes" }),
		);
		expect(tree.querySelectorAll('[data-json-type="number"]')).toHaveLength(0);
		fireEvent.click(
			within(tree).getByRole("button", { name: "Expand all JSON nodes" }),
		);
		expect(tree.querySelectorAll('[data-json-type="number"]')).toHaveLength(
			100,
		);
	});

	it("shares the bounded render budget across all structured attribute values", () => {
		const attributes = Array.from({ length: 50 }, (_, attributeIndex) => ({
			key: `attribute-${attributeIndex}`,
			value: Object.fromEntries(
				Array.from({ length: 100 }, (_, valueIndex) => [
					`value-${valueIndex}`,
					valueIndex,
				]),
			),
		}));
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({ metadata: attributes })}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));
		const attributesPanel = screen.getByRole("tabpanel");
		expect(
			attributesPanel.querySelectorAll("[data-json-type]").length,
		).toBeLessThanOrEqual(500);
	});

	it("caps structured list entries and reports the omitted rows", () => {
		const attributes = Array.from({ length: 120 }, (_, index) => ({
			key: `attribute-${index}`,
			value: index,
		}));
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({ metadata: attributes })}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));
		const attributesPanel = screen.getByRole("tabpanel");
		expect(attributesPanel.querySelectorAll("[data-json-type]")).toHaveLength(
			100,
		);
		expect(attributesPanel).toHaveTextContent(
			"20 more structured entries not shown (100-entry limit).",
		);
	});

	it("preserves input/output as text and attribute search over nested JSON values", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({
					input_text: '{"do_not_parse":true}',
					output_text: "[1,2]",
					metadata: [
						{
							key: "trace.payload",
							value: { nested: { query: "needle" } },
						},
						{ key: "unrelated", value: "other value" },
					],
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Input" }));
		const input = screen.getByTestId("detail-input");
		expect(input).toHaveTextContent('{"do_not_parse":true}');
		expect(input.querySelector("[data-json-type]")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "Output" }));
		const output = screen.getByTestId("detail-output");
		expect(output).toHaveTextContent("[1,2]");
		expect(output.querySelector("[data-json-type]")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));
		const attributeSearch = screen.getByTestId("attribute-search");
		fireEvent.change(attributeSearch, { target: { value: "needle" } });
		expect(
			screen.getByText("trace.payload", { selector: "dt" }),
		).toBeInTheDocument();
		expect(screen.queryByText("unrelated", { selector: "dt" })).toBeNull();
		fireEvent.change(attributeSearch, { target: { value: "missing" } });
		expect(screen.getByText("No matching attributes.")).toBeInTheDocument();
	});

	it("shows a safe fallback when metadata is absent", () => {
		render(
			<ObservationDetailPanel
				traceId={TRACE_ID}
				observation={observation({ metadata: "" })}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		expect(screen.getByTestId("detail-metadata")).toHaveTextContent(
			"No metadata supplied.",
		);
		expect(screen.queryByTestId("json-tree")).toBeNull();
	});
});
