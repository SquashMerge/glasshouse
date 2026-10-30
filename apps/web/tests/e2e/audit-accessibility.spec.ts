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
		if (
			[
				"/v1/datasets",
				"/v1/experiments",
				"/v1/evaluations",
				"/v1/evaluation-runs",
				"/v1/evaluation-gates/approvals",
				"/v1/evaluation-gates/runs",
			].includes(path)
		)
			return route.fulfill({ json: { items: [], total: 0 } });
		if (path === "/v1/evaluations/compatibility")
			return route.fulfill({ json: { items: [] } });
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

	test("does not replay tab autofocus when returning to a history entry", async ({
		page,
	}) => {
		const spans = page.getByRole("tab", { name: "Spans", exact: true });
		await page.getByRole("tab", { name: "Traces", exact: true }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(spans).toBeFocused();
		await expect(page).toHaveURL(/tab=spans/);
		const spansUrl = page.url();

		await page.getByRole("link", { name: "Projects", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Projects", exact: true }),
		).toBeVisible();
		await page
			.getByRole("textbox", { name: "Project name", exact: true })
			.focus();
		await page.goBack();

		await expect(page).toHaveURL(spansUrl);
		await expect(page.getByRole("tabpanel", { name: "Spans" })).toBeVisible();
		await expect(spans).toHaveAttribute("aria-selected", "true");
		await expect(spans).not.toBeFocused();
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
			const cancel = dialog.getByRole("button", {
				name: "Cancel",
				exact: true,
			});
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

for (const moveFocus of [false, true]) {
	test(`Project deletion completion ${moveFocus ? "preserves user-moved focus" : "focuses the Project name fallback"} when the opener disappears after Escape`, async ({
		page,
	}) => {
		await mockWorkspace(page);
		let releaseDeletion!: () => void;
		const pendingDeletion = new Promise<void>((resolve) => {
			releaseDeletion = resolve;
		});
		let releaseList!: () => void;
		const pendingList = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		let deleted = false;
		let mutations = 0;
		await page.route("**/v1/projects?*", async (route) => {
			if (deleted) await pendingList;
			await route.fulfill({
				json: {
					items: deleted ? [defaultProject] : [defaultProject, project],
					total: deleted ? 1 : 2,
				},
			});
		});
		await page.route(`**/v1/projects/${PROJECT_ID}`, async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			mutations += 1;
			await pendingDeletion;
			deleted = true;
			await route.fulfill({ status: 204 });
		});

		try {
			await page.goto("/projects");
			const opener = page.getByRole("button", { name: "Delete Audit project" });
			const fallback = page.getByRole("textbox", {
				name: "Project name",
				exact: true,
			});
			const userTarget = page.getByRole("textbox", { name: "Project slug" });
			await opener.focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", {
				name: "Delete Audit project?",
			});
			await dialog
				.getByRole("textbox", { name: "Project deletion confirmation" })
				.fill(project.name);
			const submit = dialog.getByRole("button", {
				name: "Delete project",
				exact: true,
			});
			await submit.click();
			await expect.poll(() => mutations).toBe(1);
			await expect(submit).toBeDisabled();
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(opener).toBeFocused();
			if (moveFocus) await userTarget.focus();

			const response = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `/v1/projects/${PROJECT_ID}` &&
					response.request().method() === "DELETE",
			);
			releaseDeletion();
			expect((await response).status()).toBe(204);
			await expect(moveFocus ? userTarget : opener).toBeFocused();
			releaseList();

			await expect(opener).toHaveCount(0);
			await expect(moveFocus ? userTarget : fallback).toBeFocused();
			expect(mutations).toBe(1);
		} finally {
			releaseDeletion();
			releaseList();
		}
	});
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
					observations_by_type: {
						span: count,
						event: 0,
						generation: 0,
						tool: 0,
					},
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
						observations_by_type: {
							span: value,
							event: 0,
							generation: 0,
							tool: 0,
						},
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

	test("keeps dashboard content scrolling independent and matches the evaluations heading", async ({
		page,
	}, testInfo) => {
		const navigationEvents: Array<{
			type: "navigation" | "response";
			url: string;
			method?: string;
			status?: number;
		}> = [];
		page.on("response", (response) => {
			const url = new URL(response.url());
			if (url.pathname.startsWith("/v1/")) {
				navigationEvents.push({
					type: "response",
					url: `${url.origin}${url.pathname}`,
					method: response.request().method(),
					status: response.status(),
				});
			}
		});
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) {
				const url = new URL(frame.url());
				navigationEvents.push({
					type: "navigation",
					url: `${url.origin}${url.pathname}`,
				});
			}
		});
		async function captureLayout(
			headingName: "Organization overview" | "Evaluations",
			phase: string,
		) {
			return {
				phase,
				...(await page.evaluate((headingName) => {
					function describe(target: Element | null) {
						if (!target) return null;
						const rect = target.getBoundingClientRect();
						const style = getComputedStyle(target);
						return {
							tag: target.tagName,
							rect: {
								top: rect.top,
								left: rect.left,
								width: rect.width,
								height: rect.height,
							},
							scrollTop: target.scrollTop,
							scrollLeft: target.scrollLeft,
							scrollHeight: target.scrollHeight,
							scrollWidth: target.scrollWidth,
							clientHeight: target.clientHeight,
							clientWidth: target.clientWidth,
							display: style.display,
							visibility: style.visibility,
							overflowY: style.overflowY,
							overflowAnchor: style.overflowAnchor,
							paddingTop: style.paddingTop,
							hidden: target.hasAttribute("hidden"),
							ariaHidden: target.getAttribute("aria-hidden"),
							inert: target.hasAttribute("inert"),
						};
					}
					const element = Array.from(
						document.querySelectorAll(
							'h1, h2, h3, h4, h5, h6, [role="heading"]',
						),
					).find((target) => target.textContent?.trim() === headingName);
					const main =
						element?.closest("main") ?? document.querySelector("main");
					const ancestors = [];
					for (
						let parent: Element | null =
							element?.parentElement ?? main ?? document.body;
						parent;
						parent = parent.parentElement
					) {
						ancestors.push(describe(parent));
					}
					const revalidationDialog = document.querySelector<HTMLDialogElement>(
						'dialog[aria-label="Checking session"]',
					);
					return {
						time: performance.now(),
						// Query strings and fragments can contain auth material.
						url: `${location.origin}${location.pathname}`,
						targetHeading: headingName,
						headingTop: element?.getBoundingClientRect().top ?? null,
						heading: describe(element ?? null),
						main: describe(main),
						wrapper: describe(main?.firstElementChild ?? null),
						ancestors,
						window: {
							scrollX: window.scrollX,
							scrollY: window.scrollY,
							innerHeight: window.innerHeight,
							innerWidth: window.innerWidth,
						},
						scrollingElement: describe(document.scrollingElement),
						documentElement: describe(document.documentElement),
						body: describe(document.body),
						activeElementTag: document.activeElement?.tagName,
						activeElementInMain: main?.contains(document.activeElement),
						revalidationDialog: {
							element: describe(revalidationDialog),
							open: revalidationDialog?.open ?? false,
							modal: revalidationDialog?.matches(":modal") ?? false,
						},
					};
				}, headingName)),
			};
		}
		await page.setViewportSize({ width: 1280, height: 720 });
		await page.route("**/v1/organization/usage?*", (route) =>
			route.fulfill({ json: usageSnapshot("30d", 4) }),
		);
		await page.goto("/");
		const dashboardHeading = page.getByRole("heading", {
			name: "Organization overview",
		});
		await expect(dashboardHeading).toBeVisible();
		const dashboardLayout = await captureLayout(
			"Organization overview",
			"dashboard-initial",
		);
		const dashboardTop = dashboardLayout.headingTop;
		expect(dashboardTop).not.toBeNull();
		const layouts = [dashboardLayout];
		const content = page.getByRole("main").first();
		await expect(content).toHaveCSS("overflow-y", "auto");
		const scrollMetrics = await content.evaluate((element) => ({
			clientHeight: element.clientHeight,
			scrollHeight: element.scrollHeight,
		}));
		expect(scrollMetrics.scrollHeight).toBeGreaterThan(
			scrollMetrics.clientHeight,
		);
		const sidebar = page.getByLabel("Primary");
		const sidebarTop = await sidebar.evaluate(
			(element) => element.getBoundingClientRect().top,
		);
		await content.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		expect(
			await content.evaluate((element) => element.scrollTop),
		).toBeGreaterThan(0);
		expect(
			await sidebar.evaluate((element) => element.getBoundingClientRect().top),
		).toBe(sidebarTop);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		expect(
			await page.evaluate(() => document.body.scrollHeight),
		).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));

		await content.evaluate((element) => {
			element.scrollTop = 0;
		});
		layouts.push(
			await captureLayout(
				"Organization overview",
				"dashboard-before-navigation",
			),
		);
		const evaluationsHeading = page.getByRole("heading", {
			name: "Evaluations",
			exact: true,
		});
		let navigationChecksPassed = false;
		try {
			await sidebar.getByRole("link", { name: "Evaluations" }).click();
			await expect(evaluationsHeading).toBeVisible();
			await expect
				.poll(async () => {
					const layout = await captureLayout("Evaluations", "evaluations-poll");
					layouts.push(layout);
					return layout.headingTop;
				})
				.toBe(dashboardTop);
			navigationChecksPassed = true;
		} finally {
			if (!navigationChecksPassed) {
				try {
					layouts.push(await captureLayout("Evaluations", "evaluations-final"));
				} catch {
					console.log(
						"[heading-scroll-layout]",
						JSON.stringify({
							retry: testInfo.retry,
							phase: "evaluations-final",
							snapshotUnavailable: true,
						}),
					);
				}
				for (const layout of layouts) {
					console.log(
						"[heading-scroll-layout]",
						JSON.stringify({
							retry: testInfo.retry,
							expectedHeadingTop: dashboardTop,
							...layout,
						}),
					);
				}
				console.log(
					"[evaluations-navigation-events]",
					JSON.stringify({ retry: testInfo.retry, events: navigationEvents }),
				);
			}
		}
	});

	test("keeps the telemetry caption accessible without overlapping the visual chart", async ({
		page,
	}) => {
		await page.route("**/v1/organization/usage?*", (route) =>
			route.fulfill({ json: usageSnapshot("30d", 4) }),
		);
		await page.goto("/");
		const activity = page.getByRole("table", {
			name: "Telemetry activity by UTC time bucket",
		});
		await expect(activity).toBeAttached();
		const hiddenWrapper = activity.locator("xpath=..");
		const bounds = await hiddenWrapper.boundingBox();
		expect(bounds?.width).toBeLessThanOrEqual(1);
		expect(bounds?.height).toBeLessThanOrEqual(1);
		await expect(hiddenWrapper).toHaveCSS("overflow", "hidden");
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

	test("provides keyboard refresh without navigating away", async ({
		page,
	}) => {
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
			if (
				await refresh.evaluate((element) => element === document.activeElement)
			)
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
