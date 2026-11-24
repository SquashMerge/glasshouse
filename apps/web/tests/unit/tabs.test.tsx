import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../src/components/ui/tabs";

describe("Tabs", () => {
	it("navigates all three Observability views with automatic selection", () => {
		function Views() {
			const [value, setValue] = useState("traces");
			return (
				<Tabs value={value} onValueChange={setValue}>
					<TabsList aria-label="Observability views">
						<TabsTrigger value="traces">Traces</TabsTrigger>
						<TabsTrigger value="spans">Spans</TabsTrigger>
						<TabsTrigger value="logs">Logs</TabsTrigger>
					</TabsList>
					<TabsContent value="traces">Trace rows</TabsContent>
					<TabsContent value="spans">Span rows</TabsContent>
					<TabsContent value="logs">Log rows</TabsContent>
				</Tabs>
			);
		}
		render(<Views />);
		const traces = screen.getByRole("tab", { name: "Traces" });
		traces.focus();
		for (const [key, label] of [
			["ArrowRight", "Spans"],
			["ArrowRight", "Logs"],
			["ArrowRight", "Traces"],
			["ArrowLeft", "Logs"],
			["ArrowLeft", "Spans"],
			["Home", "Traces"],
			["End", "Logs"],
		]) {
			fireEvent.keyDown(document.activeElement!, { key });
			const selected = screen.getByRole("tab", { name: label });
			expect(selected).toHaveFocus();
			for (const tab of screen.getAllByRole("tab")) {
				expect(tab).toHaveAttribute("aria-selected", String(tab === selected));
				expect(tab).toHaveAttribute("tabindex", tab === selected ? "0" : "-1");
			}
			const panel = screen.getByRole("tabpanel", { name: label });
			expect(panel).toBeVisible();
			expect(panel.id).toBe(selected.getAttribute("aria-controls"));
			expect(panel).toHaveAttribute("aria-labelledby", selected.id);
		}
	});

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
