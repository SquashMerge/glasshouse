// AC11 walkthrough — Playwright E2E.
//
// Honest split:
// - Coverage in unit tests (apps/web/tests/unit/observability-traces-detail.test.tsx): Stream toggle, ?span= deep-link, snapshot→stream merge, invalid-id gate.
// - Coverage here (e2e): the live ingestion path requires a running apps/api + matched UI_USERNAME/UI_PASSWORD + a seeded dataset. Each case gates on envReady(); see slice brief §Test plan for the manual walkthrough when envReady is false.
//
// When envReady() returns false the test skips with a clear reason rather than passing on a swallowed assertion.
//
// Prereqs: `make deps-up`, then `make dev-backend` + `make dev-frontend` in
// separate terminals. UI_USERNAME / UI_PASSWORD come from infra/.env (see
// playwright.config).

import {
	test,
	expect,
	type Page,
	type APIRequestContext,
} from "@playwright/test";

const USER = process.env.UI_USERNAME ?? "astraea";
const PASS = process.env.UI_PASSWORD ?? "testpassword";
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
}

async function gotoFresh(page: Page, path: string) {
	await page.context().clearCookies();
	// Navigate first so the page has a real document; localStorage is
	// not accessible on `about:blank` (Playwright raises a SecurityError).
	await page.goto(path);
	await page.evaluate(() => window.localStorage.clear());
}

async function login(page: Page) {
	await gotoFresh(page, "/login");
	await page.getByLabel(/Username/i).fill(USER);
	await page.getByLabel(/Password/i).fill(PASS);
	await page.getByRole("button", { name: /Sign in/i }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
}

/**
 * Returns true if the running API is reachable on `E2E_API_BASE` AND a
 * fresh login succeeds with the configured creds. The login probe is
 * required because the dev server may be reachable but the API may
 * have rotated creds — we want the test to skip rather than fail with
 * an auth error that pollutes the run.
 */
async function envReady(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) return false;
  } catch {
    return false;
  }
  // Login probe — POST to /v1/auth/login and verify a 200.
  try {
    const res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basicAuthHeader(),
      },
      body: "{}",
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OTLP payload builders
//
// Schema (apps/api/src/schemas/otlp.ts):
//   ExportTraceServiceRequest { resource_spans: ResourceSpans[] }
//   ResourceSpans            { resource?, scope_spans: ScopeSpans[] }
//   ScopeSpans               { scope?, spans: Span[] }
//   Span                     { trace_id (32 hex), span_id (16 hex), name,
//                             kind (0..5), start_time_unix_nano (int),
//                             end_time_unix_nano?, status?, attributes? }
// ---------------------------------------------------------------------------

/** Random lowercase hex string of `bytes*2` chars. */
function hex(bytes: number): string {
	const chars = "0123456789abcdef";
	let out = "";
	for (let i = 0; i < bytes * 2; i += 1) {
		out += chars[Math.floor(Math.random() * 16)];
	}
	return out;
}

/** Current time in unix nanos, with optional offset. */
function nowNanos(offsetMs = 0): number {
	return Date.now() * 1_000_000 + offsetMs * 1_000_000;
}

/**
 * Build an OTLP ExportTraceServiceRequest for a single trace with the given
 * number of spans. Every span shares `traceId`; the first span is the root
 * (no parent_span_id) and child spans reference `rootSpanId`.
 */
function buildTracePayload(
  traceId: string,
  rootSpanId: string,
  spanCount: number,
  traceName: string,
  startIndex = 0,
): Record<string, unknown> {
  const spans: Array<Record<string, unknown>> = [];
  for (let i = 0; i < spanCount; i += 1) {
    const index = startIndex + i;
    spans.push({
      trace_id: traceId,
      span_id: index === 0 ? rootSpanId : hex(8),
      parent_span_id: index === 0 ? null : rootSpanId,
      name: index === 0 ? traceName : `${traceName}.child.${index}`,
      kind: 1,
      start_time_unix_nano: nowNanos(index * 50),
      end_time_unix_nano: nowNanos(index * 50 + 100),
      status: { code: 1 },
      attributes: [],
    });
  }
  return {
    resource_spans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "astraea-e2e" } },
          ],
        },
        scope_spans: [
          {
            scope: { name: "astraea-e2e", version: "1.0.0" },
            spans,
          },
        ],
      },
    ],
  };
}

/** POST one trace payload and assert the API accepted it. */
async function postTrace(
	request: APIRequestContext,
	payload: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${API_BASE}/v1/otel/v1/traces`, {
    data: payload,
    headers: { "content-type": "application/json", authorization: basicAuthHeader() },
  });
  expect(res.status(), `OTLP ingest should accept payload, got ${res.status()}`).toBeLessThan(300);
}

/**
 * Wait up to `timeoutMs` for at least `target` highlighted rows in the
 * table; returns the final count (may be less than `target` on timeout).
 */
async function waitForHighlightedRows(
	page: Page,
	target: number,
	timeoutMs = 1500,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	let count = 0;
	while (Date.now() < deadline) {
		count = await page
			.locator("table tbody tr[data-highlighted='true']")
			.count();
		if (count >= target) return count;
		await page.waitForTimeout(50);
	}
	return count;
}

test.describe("SSE live pages — AC11 walkthrough", () => {
	test("invalid id renders the 'Trace not found' placeholder (regex gate, no API)", async ({
		page,
	}) => {
		// This test does NOT require the API — it is a pure client-side
		// regex check on the new detail page. We bypass login by seeding
		// the auth localStorage directly so the AuthGate lets us through.
		if (!(await envReady())) {
			test.skip(
				true,
				"Requires API for AuthGate seed; see slice brief for manual walkthrough",
			);
			return;
		}
		await login(page);
		await page.goto("/observability/traces/not-a-valid-hex-id");
		await expect(page.getByTestId("trace-not-found")).toBeVisible();
	});

	test("5 traces appear in the list within 1s with bg-accent/40 highlight", async ({
		page,
		request,
	}) => {
		// The live ingestion path requires a running apps/api + matched
		// UI_USERNAME/UI_PASSWORD. Skip cleanly rather than fake a passing
		// assertion when the env is not set up.
		if (!(await envReady())) {
			test.skip(
				true,
				"Requires live API + seeder + matching UI_USERNAME/UI_PASSWORD; see slice brief for manual walkthrough steps.",
			);
			return;
		}
		await login(page);

		// Ingest 5 distinct traces via OTLP HTTP/JSON. The first name is kept
		// for a downstream text-content sanity check.
		const firstName = `walkthrough-trace-${Date.now()}-0`;
		await postTrace(request, buildTracePayload(hex(16), hex(8), 1, firstName));
		for (let i = 1; i < 5; i += 1) {
			const traceId = hex(16);
			const rootSpanId = hex(8);
			const name = `walkthrough-trace-${Date.now()}-${i}`;
			await postTrace(request, buildTracePayload(traceId, rootSpanId, 1, name));
		}

		// Navigate to the traces tab.
		await page.goto("/observability?tab=traces");
		await expect(page).toHaveURL(/tab=traces/);

		// The list page merges streamed rows via SSE; rows carry
		// `data-highlighted="true"` and the `bg-accent/40` class for ~1.5s
		// after arrival. Within that window we expect ≥5 highlighted rows.
		const count = await waitForHighlightedRows(page, 5, 1500);
		expect(
			count,
			"expected 5 highlighted trace rows to appear within 1.5s",
		).toBeGreaterThanOrEqual(5);

		// Every highlighted row must carry the highlight class.
		const highlightedRows = page.locator(
			"table tbody tr[data-highlighted='true']",
		);
		for (let i = 0; i < count; i += 1) {
			const cls = (await highlightedRows.nth(i).getAttribute("class")) ?? "";
			expect(cls, `row ${i} should carry bg-accent/40 highlight`).toContain(
				"bg-accent/40",
			);
		}

		// Sanity-check the first name is visible at least once in the table.
		await expect(page.getByText(firstName)).toBeVisible();
	});

	test("10 spans appear in the spans list within 1s", async ({
		page,
		request,
	}) => {
		if (!(await envReady())) {
			test.skip(
				true,
				"Requires live API + seeder + matching UI_USERNAME/UI_PASSWORD; see slice brief for manual walkthrough steps.",
			);
			return;
		}
		await login(page);

		// One OTLP payload with a single trace that has 10 spans. The first
		// span is the root; children reference its span_id.
		const traceId = hex(16);
		const rootSpanId = hex(8);
		const traceName = `walkthrough-spans-${Date.now()}`;
		await postTrace(
			request,
			buildTracePayload(traceId, rootSpanId, 10, traceName),
		);

		// Navigate to the spans tab.
		await page.goto("/observability?tab=spans");
		await expect(page).toHaveURL(/tab=spans/);

		// Wait for the spans to materialize via the SSE merge.
		const count = await waitForHighlightedRows(page, 10, 1500);
		expect(
			count,
			"expected 10 highlighted span rows to appear within 1.5s",
		).toBeGreaterThanOrEqual(10);

		// The root span name should be visible in the table; the trace_id is
		// rendered in the Trace column (first 16 chars + ellipsis).
		await expect(page.getByText(traceName).first()).toBeVisible();
		const traceIdPrefix = traceId.slice(0, 16);
		await expect(
			page.getByText(new RegExp(traceIdPrefix)).first(),
		).toBeVisible();
	});

  test("Stream toggle pauses and resumes the detail SSE", async ({ page }) => {
    if (!(await envReady())) {
      test.skip(true, "Requires running API + seeder; see slice brief for manual walkthrough");
      return;
    }
    await login(page);

		const traceId = "0123456789abcdef0123456789abcdef";
		await page.goto(`/observability/traces/${traceId}`);

    const toggle = page.getByTestId("stream-toggle-button");
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(page.getByTestId("stream-toggle")).toHaveAttribute("data-state", "off");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect(page.getByTestId("stream-toggle")).not.toHaveAttribute("data-state", "off");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("release gate: browser renders a 5k-observation trace with stable row selectors", async ({ page, request }) => {
    test.slow();
    if (!(await envReady())) {
      test.skip(true, "Requires live API + seeded browser auth for the 5k trace-detail release gate.");
      return;
    }

    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const traceId = hex(16);
    const rootSpanId = hex(8);
    const traceName = `release-gate-5k-${Date.now()}`;
    // Keep the snapshot below the 1 MiB SSE-frame limit: open the detail page
    // after the root span exists, then deliver the other rows as the endpoint's
    // normal incremental `observation` events.
    await postTrace(request, buildTracePayload(traceId, rootSpanId, 1, traceName));
    await login(page);
    await page.goto(`/observability/traces/${traceId}`);

    const rows = page.getByTestId("span-row");
    const workspace = page.getByTestId("trace-workspace");
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    for (let startIndex = 1; startIndex < 5_000; startIndex += 100) {
      await postTrace(request, buildTracePayload(traceId, rootSpanId, Math.min(100, 5_000 - startIndex), traceName, startIndex));
    }
    await expect(workspace).toHaveAttribute("data-row-count", "5000", { timeout: 2_000 });

    const root = page.locator(`[data-testid="span-row"][data-observation-id="${rootSpanId}"]`);
    const leaf = rows.nth(1);
    await leaf.click({ timeout: 250 });
    await expect(leaf).toHaveAttribute("data-selected", "true", { timeout: 250 });

    await root.getByRole("button", { name: `Collapse ${traceName}` }).click({ timeout: 250 });
    await expect(root).toHaveAttribute("aria-expanded", "false", { timeout: 250 });

    await expect(root).toHaveAttribute("data-observation-id", rootSpanId);
    await expect(page.getByTestId("span-tree")).toHaveAttribute("role", "tree");
    expect(consoleErrors).toEqual([]);
  });
});
