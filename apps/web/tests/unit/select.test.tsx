import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Select } from "../../src/components/ui/select";

describe("Select", () => {
	it("reserves consistent space for an inset, non-interactive chevron", () => {
		render(
			<label>
				Environment
				<Select aria-label="Environment" defaultValue="dev">
					<option value="dev">Development</option>
				</Select>
			</label>,
		);

		const select = screen.getByRole("combobox", { name: "Environment" });
		expect(select).toHaveClass("appearance-none", "pr-9");
		const chevron = screen.getByTestId("select-chevron");
		expect(chevron).toHaveClass(
			"pointer-events-none",
			"absolute",
			"right-3",
			"top-1/2",
			"-translate-y-1/2",
		);
		expect(chevron).toHaveAttribute("aria-hidden", "true");
	});

	it("dims the chevron with a disabled select", () => {
		render(
			<Select aria-label="Environment" disabled>
				<option value="dev">Development</option>
			</Select>,
		);

		expect(screen.getByTestId("select-chevron")).toHaveClass("opacity-50");
	});
});
