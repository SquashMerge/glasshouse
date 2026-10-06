import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DialogContent, DialogOverlay } from "../../src/components/ui/dialog";

describe("Dialog shell", () => {
	it("uses shared overlay and content tokens while allowing content sizing", () => {
		render(
			<DialogOverlay data-testid="overlay">
				<DialogContent className="max-w-xl" role="dialog" aria-label="Example">
					Content
				</DialogContent>
			</DialogOverlay>,
		);

		expect(screen.getByTestId("overlay")).toHaveClass(
			"fixed",
			"inset-0",
			"z-50",
			"bg-black/50",
		);
		const content = screen.getByRole("dialog", { name: "Example" });
		expect(content).toHaveClass(
			"max-h-[calc(100vh-2rem)]",
			"max-w-xl",
			"overflow-y-auto",
			"rounded-lg",
			"border-border",
			"bg-background",
			"shadow-lg",
		);
	});
});
