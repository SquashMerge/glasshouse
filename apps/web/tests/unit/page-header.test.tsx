import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "../../src/components/ui/page-header";

describe("PageHeader", () => {
	it("renders a consistent page heading and optional description", () => {
		render(<PageHeader title="Projects" description="Manage projects." />);

		const heading = screen.getByRole("heading", { level: 1, name: "Projects" });
		expect(heading).toHaveClass(
			"text-[32px]",
			"leading-10",
			"font-semibold",
			"tracking-tight",
		);
		expect(heading.closest("header")).toHaveClass("space-y-1");
		expect(screen.getByText("Manage projects.")).toHaveClass(
			"text-sm",
			"text-muted-foreground",
		);
	});
});
