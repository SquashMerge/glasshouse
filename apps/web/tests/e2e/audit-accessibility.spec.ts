import { test, expect, type Page } from "@playwright/test";
import { assertSignedOutAppFlow } from "../smoke-flow";
import type {
	OrganizationUsageDashboard,
	OrganizationUsageRange,
	Project,
} from "../../src/lib/api";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const project: Project = {
	id: PROJECT_ID,
	name: "Audit project",
	slug: "audit-project",
	status: "active",
	created_at: "2026-10-01T00:00:00.000Z",
	archived_at: null,
	project_role: "admin",
	can_manage: true,
	can_govern: true,
	is_default: false,
};
const defaultProject: Project = {
	...project,
	id: DEFAULT_PROJECT_ID,
	name: "Default Project",
	slug: "default",
	is_default: true,
};

async function mockWorkspace(page: Page, recovery = false) {
	await page.route("**/v1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/v1/auth/session")
			return route.fulfill({
				json: {
					actor_id: ACTOR_ID,
					organization_id: ORGANIZATION_ID,
					authentication: recovery ? "basic" : "local_session",
					expires_at: recovery
						? null
						: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
					csrf_token: recovery ? null : "audit-csrf-fixture",
					username: "audit-admin",
				},
			});
		if (path === "/v1/me")
			return route.fulfill({
				json: {
					actor_id: ACTOR_ID,
					actor_subject: "audit-admin",
					organization_id: ORGANIZATION_ID,
					organization_role: "admin",
					effective_organization_role_id: "organization:admin",
					can_recover_admin: recovery,
					default_project_id: DEFAULT_PROJECT_ID,
					projects: [defaultProject, project],
				},
			});
		if (path === "/v1/projects")
			return route.fulfill({
				json: { items: [defaultProject, project], total: 2 },
			});
		if (path === "/v1/admin/actors" || path === "/v1/admin/local-accounts")
			return route.fulfill({ json: { items: [] } });
		if (path === "/v1/traces" || path === "/v1/observations")
			return route.fulfill({ json: { items: [], total: 0 } });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": ready\n\n",
			});
		return route.fallback();
	});
}

test("the current signed-out smoke flow also runs in CI's E2E suite", async ({
	page,
}) => {
	await assertSignedOutAppFlow(page);
});

test.describe("Observability tabs in the real browser", () => {
	test.beforeEach(async ({ page }) => {
		await mockWorkspace(page);
		await page.goto("/observability?tab=traces");
	});

	test("names the tab group and each active panel", async ({ page }) => {
		await expect(page.getByRole("tablist")).toHaveAccessibleName(/\S/);
		await expect(page.getByRole("tabpanel", { name: "Traces" })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Traces" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("moves focus and selection with arrows, Home, End and Tab", async ({
		page,
	}) => {
		const traces = page.getByRole("tab", { name: "Traces", exact: true });
		const spans = page.getByRole("tab", { name: "Spans", exact: true });
		await traces.focus();
		for (const [key, selected, label] of [
			["ArrowRight", spans, "Spans"],
			["ArrowRight", traces, "Traces"],
			["ArrowLeft", spans, "Spans"],
			["Home", traces, "Traces"],
			["End", spans, "Spans"],
		] as const) {
			await page.keyboard.press(key);
			await expect(selected).toBeFocused();
			await expect(selected).toHaveAttribute("aria-selected", "true");
			await expect(page.getByRole("tabpanel", { name: label })).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tab=${label.toLowerCase()}`));
		}
		await page.keyboard.press("Tab");
		await expect(page.getByRole("tabpanel", { name: "Spans" })).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(spans).toBeFocused();
	});
});

for (const action of [
	{
		name: "Project deletion",
		path: "/projects",
		endpoint: `/v1/projects/${PROJECT_ID}`,
		method: "DELETE",
		opener: "Delete Audit project",
		title: "Delete Audit project?",
		input: "Project deletion confirmation",
		confirmation: "Audit project",
		submit: "Delete project",
	},
	{
		name: "Admin recovery",
		path: "/access",
		endpoint: "/v1/admin/recovery",
		method: "POST",
		opener: "Recover Admin access",
		title: "Restore Admin access?",
		input: "Recovery confirmation",
		confirmation: "RESTORE ADMIN",
		submit: "Restore Admin",
	},
]) {
	for (const dismiss of ["Escape", "Cancel"]) {
		test(`${action.name} stays keyboard-cancellable with ${dismiss} while pending`, async ({
			page,
		}) => {
			await mockWorkspace(page, action.name === "Admin recovery");
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			let mutations = 0;
			await page.route(`**${action.endpoint}`, async (route) => {
				if (route.request().method() !== action.method) return route.fallback();
				mutations += 1;
				await pending;
				await route.fulfill({
					status: 409,
					json: { code: "CONFLICT", message: "Operation could not complete" },
				});
			});
			await page.goto(action.path);
			const opener = page.getByRole("button", { name: action.opener });
			await opener.focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: action.title });
			const confirmation = dialog.getByRole("textbox", { name: action.input });
			const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
			const submit = dialog.getByRole("button", {
				name: action.submit,
				exact: true,
			});
			await expect(dialog).toHaveAttribute("aria-modal", "true");
			await expect(confirmation).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(cancel).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(confirmation).toBeFocused();
			await confirmation.fill(action.confirmation);
			await page.keyboard.press("Tab");
			await expect(cancel).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(submit).toBeFocused();
			const response = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === action.endpoint &&
					response.request().method() === action.method,
			);
			await page.keyboard.press("Enter");
			try {
				await expect.poll(() => mutations).toBe(1);
				await expect(submit).toBeDisabled();
				await expect(cancel).toBeEnabled();
				if (dismiss === "Escape") {
					await page.keyboard.press("Escape");
				} else {
					await cancel.focus();
					await page.keyboard.press("Enter");
				}
				await expect(dialog).toHaveCount(0);
				await expect(opener).toBeFocused();
			} finally {
				release();
				await response;
			}
			await expect(dialog).toHaveCount(0);
			await expect(opener).toBeFocused();
			expect(mutations).toBe(1);
		});
	}
}

test.describe("usage dashboard freshness and keyboard access", () => {
	test.beforeEach(async ({ page }) => {
		await mockWorkspace(page);
		await page.route("**/health", (route) =>
			route.fulfill({
				json: {
					status: "ok",
					checks: { postgres: "up", clickhouse: "up", valkey: "up" },
				},
			}),
		);
	});

	function usageSnapshot(
		range: OrganizationUsageRange,
		count: number,
	): OrganizationUsageDashboard {
		const to = Date.parse("2026-10-29T12:00:00.000Z");
		const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[range];
		const from = to - days * 24 * 60 * 60 * 1000;
		const bucketMs = range === "24h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
		const firstBucket = Math.floor(from / bucketMs) * bucketMs;
		const lastBucket = Math.floor((to - 1) / bucketMs) * bucketMs;
		return {
			range,
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			projects: [
				{
					id: defaultProject.id,
					name: defaultProject.name,
					slug: defaultProject.slug,
					status: "active",
					traces: 0,
					observations: 0,
					observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
				},
				{
					id: project.id,
					name: project.name,
					slug: project.slug,
					status: "active",
					traces: count,
					observations: count,
					observations_by_type: { span: count, event: 0, generation: 0, tool: 0 },
				},
			],
			totals: {
				traces: count,
				observations: count,
				observations_by_type: { span: count, event: 0, generation: 0, tool: 0 },
			},
			series: Array.from(
				{ length: (lastBucket - firstBucket) / bucketMs + 1 },
				(_, index) => {
					const timestamp = firstBucket + index * bucketMs;
					const value = timestamp === lastBucket ? count : 0;
					return {
						bucket_start: new Date(timestamp).toISOString(),
						traces: value,
						observations: value,
						observations_by_type: { span: value, event: 0, generation: 0, tool: 0 },
					};
				},
			),
		};
	}

	test("changes the range using the keyboard and exposes the bucket values to assistive technology", async ({
		page,
	}) => {
		await page.route("**/v1/organization/usage?*", (route) => {
			const range = new URL(route.request().url()).searchParams.get(
				"range",
			) as OrganizationUsageRange;
			return route.fulfill({
				json: usageSnapshot(range, range === "7d" ? 7 : 30),
			});
		});
		await page.goto("/");
		const range = page.getByRole("combobox", { name: "Usage time range" });
		await expect(range).toHaveValue("30d");
		await range.focus();
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Enter");
		await expect(range).toHaveValue("7d");
		await expect(range).toBeFocused();
		const summary = page.getByRole("region", { name: "Usage summary" });
		await expect(summary.getByText("7", { exact: true })).toHaveCount(2);
		const activity = page.getByRole("table", {
			name: "Telemetry activity by UTC time bucket",
		});
		const populatedBucket = activity.getByRole("row", {
			name: "2026-10-29T00:00:00.000Z 7 7",
			exact: true,
		});
		await expect(populatedBucket.getByRole("rowheader")).toHaveText(
			"2026-10-29T00:00:00.000Z",
		);
		await expect(populatedBucket.getByRole("cell")).toHaveText(["7", "7"]);
	});

	test("communicates snapshot freshness", async ({ page }) => {
		await page.route("**/v1/organization/usage?*", (route) =>
			route.fulfill({ json: usageSnapshot("30d", 4) }),
		);
		await page.goto("/");
		await expect(
			page.getByRole("region", { name: "Usage summary" }).getByText("4", {
				exact: true,
			}),
		).toHaveCount(2);
		const freshness = page.getByText(/last updated|as of|data through/i);
		await expect(freshness).toBeVisible();
		await expect(freshness).toContainText(/\d/);
	});

	test("provides keyboard refresh without navigating away", async ({ page }) => {
		let count = 4;
		await page.route("**/v1/organization/usage?*", (route) =>
			route.fulfill({ json: usageSnapshot("30d", count) }),
		);
		await page.goto("/");
		const summary = page.getByRole("region", { name: "Usage summary" });
		await expect(summary.getByText("4", { exact: true })).toHaveCount(2);
		const refresh = page.getByRole("button", { name: /refresh/i });
		await expect(refresh).toBeEnabled();
		for (let step = 0; step < 60; step += 1) {
			if (await refresh.evaluate((element) => element === document.activeElement))
				break;
			await page.keyboard.press("Tab");
		}
		await expect(refresh).toBeFocused();
		count = 9;
		await page.keyboard.press("Enter");
		await expect(summary.getByText("9", { exact: true })).toHaveCount(2);
		await expect(refresh).toBeFocused();
		await expect(page).toHaveURL("/");
	});
});
