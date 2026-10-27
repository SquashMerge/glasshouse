import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

	it("contains keyboard focus and closes on Escape, restoring focus to the opener", async () => {
		function Example() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Open dialog
					</button>
					{open ? (
						<DialogOverlay onEscape={() => setOpen(false)}>
							<DialogContent role="dialog" aria-label="Example dialog">
								<button type="button">First</button>
								<button type="button">Last</button>
							</DialogContent>
						</DialogOverlay>
					) : null}
				</>
			);
		}

		render(<Example />);
		const opener = screen.getByRole("button", { name: "Open dialog" });
		opener.focus();
		fireEvent.click(opener);
		const first = screen.getByRole("button", { name: "First" });
		const last = screen.getByRole("button", { name: "Last" });
		expect(first).toHaveFocus();
		fireEvent.keyDown(last, { key: "Tab" });
		expect(first).toHaveFocus();
		fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
		expect(last).toHaveFocus();
		fireEvent.keyDown(last, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "Example dialog" })).toBeNull();
		await waitFor(() => expect(opener).toHaveFocus());
	});
});
