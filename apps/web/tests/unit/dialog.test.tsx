import { StrictMode, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DialogContent, DialogOverlay } from "../../src/components/ui/dialog";
import { RollbackLatestVersionDialog } from "../../src/routes/rollback-latest-version-dialog";

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

	it("does not dismiss a pending rollback from the backdrop", () => {
		const onClose = vi.fn();
		render(
			<RollbackLatestVersionDialog
				pending
				error={null}
				onClose={onClose}
				onConfirm={vi.fn()}
			/>,
		);

		fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("keeps focus inside the rollback dialog after submission disables its actions", () => {
		function Example() {
			const [pending, setPending] = useState(false);
			const [error, setError] = useState<string | null>(null);
			return (
				<>
					<RollbackLatestVersionDialog
						pending={pending}
						error={error}
						onClose={() => {}}
						onConfirm={() => setPending(true)}
					/>
					<button
						type="button"
						onClick={() => {
							setPending(false);
							setError("Rollback failed");
						}}
					>
						Fail request
					</button>
				</>
			);
		}

		render(<Example />);
		const confirm = screen.getByRole("button", { name: "Rollback version" });
		confirm.focus();
		fireEvent.click(confirm);

		const dialog = screen.getByRole("dialog", {
			name: "Rollback latest version",
		});
		expect(dialog).toHaveFocus();
		fireEvent.keyDown(dialog, { key: "Tab" });
		expect(dialog).toHaveFocus();
		fireEvent.click(screen.getByRole("button", { name: "Fail request" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Rollback failed");
		expect(dialog).toHaveFocus();
	});

	it("keeps initial dialog focus under React StrictMode effect replay", async () => {
		function Example() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Open strict dialog
					</button>
					{open ? (
						<DialogOverlay>
							<DialogContent role="dialog" aria-label="Strict dialog">
								<button type="button">Dialog action</button>
							</DialogContent>
						</DialogOverlay>
					) : null}
				</>
			);
		}

		render(
			<StrictMode>
				<Example />
			</StrictMode>,
		);
		const opener = screen.getByRole("button", { name: "Open strict dialog" });
		opener.focus();
		fireEvent.click(opener);
		const dialogAction = screen.getByRole("button", { name: "Dialog action" });
		await new Promise((resolve) => window.setTimeout(resolve, 10));
		expect(dialogAction).toHaveFocus();
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
