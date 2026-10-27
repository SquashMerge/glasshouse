import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../src/components/ui/tabs";

describe("Tabs", () => {
	it("supports roving focus, arrow selection, and tab-panel relationships", () => {
		const onValueChange = vi.fn();
		const { container } = render(
			<Tabs value="traces" onValueChange={onValueChange}>
				<TabsList aria-label="Observability views">
					<TabsTrigger value="traces">Traces</TabsTrigger>
					<TabsTrigger value="spans">Spans</TabsTrigger>
				</TabsList>
				<TabsContent value="traces">Trace rows</TabsContent>
				<TabsContent value="spans">Span rows</TabsContent>
			</Tabs>,
		);
		const tabs = screen.getAllByRole("tab");
		const traces = tabs[0]!;
		const spans = tabs[1]!;
		const panel = screen.getByRole("tabpanel");

		expect(traces).toHaveAttribute("tabindex", "0");
		expect(spans).toHaveAttribute("tabindex", "-1");
		expect(traces).toHaveAttribute("aria-controls", panel.id);
		expect(panel).toHaveAttribute("aria-labelledby", traces.id);
		const spansPanel = document.getElementById(
			spans.getAttribute("aria-controls")!,
		);
		expect(spansPanel).toHaveAttribute("aria-labelledby", spans.id);
		expect(spansPanel).toHaveAttribute("hidden");

		traces.focus();
		fireEvent.keyDown(traces, { key: "ArrowRight" });
		expect(spans).toHaveFocus();
		expect(onValueChange).toHaveBeenCalledWith("spans");
		expect(container.querySelector('[role="tablist"]')).toHaveAccessibleName(
			"Observability views",
		);
	});
});
