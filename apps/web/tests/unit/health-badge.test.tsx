import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthBadge } from "../../src/components/HealthBadge";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("dependency health", () => {
	it.each([
		{ status: 200, health: "ok", clickhouse: "up" },
		{ status: 503, health: "degraded", clickhouse: "down" },
	])(
		"reports dependency states from an HTTP $status health response",
		async ({ status, health, clickhouse }) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json(
						{
						status: health,
						checks: { postgres: "up", clickhouse, valkey: "up" },
						},
						{ status },
					),
				),
			);
			render(
				<QueryClientProvider
					client={
						new QueryClient({
							defaultOptions: { queries: { retry: false } },
						})
					}
				>
					<HealthBadge />
				</QueryClientProvider>,
			);

			expect(await screen.findByText(`ClickHouse: ${clickhouse}`)).toBeVisible();
			expect(screen.getByText("Postgres: up")).toBeVisible();
			expect(screen.getByText("Valkey: up")).toBeVisible();
			expect(
				screen.queryByText(`ClickHouse: ${clickhouse === "up" ? "down" : "up"}`),
			).not.toBeInTheDocument();
		},
	);
});
