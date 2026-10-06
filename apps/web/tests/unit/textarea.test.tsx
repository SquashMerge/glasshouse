import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Textarea } from "../../src/components/ui/textarea";

describe("Textarea", () => {
	it("provides the shared themed and accessible textarea styles", () => {
		render(<Textarea aria-label="Description" />);

		expect(screen.getByRole("textbox", { name: "Description" })).toHaveClass(
			"min-h-20",
			"w-full",
			"rounded-md",
			"border-input",
			"bg-background",
			"focus-visible:ring-2",
		);
	});
});
