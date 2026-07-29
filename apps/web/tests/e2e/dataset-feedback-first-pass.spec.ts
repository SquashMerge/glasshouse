import {
	expect,
	test,
	type APIRequestContext,
	type APIResponse,
	type Page,
} from "@playwright/test";

const USER = process.env.UI_USERNAME ?? "astraea";
const PASS = process.env.UI_PASSWORD ?? "testpassword";
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";

type Project = { id: string; name: string; slug: string };
type Dataset = { id: string; name: string; project_id: string };
type DatasetItem = {
	id: string;
	input: Record<string, unknown>;
	expected_output: Record<string, unknown> | null;
	source_trace_id: string | null;
	source_observation_id: string | null;
};
type Feedback = {
	id: string;
	project_id: string;
	trace_id: string;
	observation_id: string | null;
	value: 1 | -1;
	sentiment: "positive" | "negative";
	comment: string | null;
	status: "new" | "reviewed" | "dismissed" | "added_to_dataset";
	dataset_id: string | null;
	dataset_item_id: string | null;
};

function authorization() {
	return `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
}

function unique(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hex(bytes: number) {
	const characters = "0123456789abcdef";
	let value = "";
	for (let index = 0; index < bytes * 2; index += 1)
		value += characters[Math.floor(Math.random() * characters.length)];
	return value;
}

async function apiJson<T>(response: APIResponse, status = 200): Promise<T> {
	expect(response.status(), "API response status").toBe(status);
	return (await response.json()) as T;
}

async function loginAndSelectE2eProject(page: Page): Promise<Project> {
	await page.goto("/login");
	await page.getByLabel(/Username/i).fill(USER);
	await page.getByLabel(/Password/i).fill(PASS);
	await page.getByRole("button", { name: /Sign in/i }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 5_000 });

	const selector = page.getByTestId("project-selector");
	await expect(selector).toBeEnabled();
	await expect(
		selector.locator("option", { hasText: "E2E Project" }),
	).toHaveCount(1);
	await selector.selectOption({ label: "E2E Project" });
	const id = await selector.inputValue();
	expect(id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	return { id, name: "E2E Project", slug: "e2e-project" };
}

async function selectProject(
	page: Page,
	name: string,
	slug: string,
): Promise<Project> {
	const selector = page.getByTestId("project-selector");
	await expect(selector.locator("option", { hasText: name })).toHaveCount(1);
	await selector.selectOption({ label: name });
	const id = await selector.inputValue();
	expect(id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	return { id, name, slug };
}

async function createDatasetInBrowser(
	page: Page,
	name: string,
): Promise<Dataset> {
	await page.goto("/datasets");
	await page.getByLabel("Dataset name").fill(name);
	await page
		.getByLabel("Description")
		.fill("Created by first-pass E2E coverage");
	await page.getByRole("button", { name: "New dataset" }).click();
	const link = page.getByRole("link", { name: new RegExp(name) });
	await expect(link).toBeVisible();
	const href = await link.getAttribute("href");
	expect(href).toMatch(/^\/datasets\/[0-9a-f-]{36}$/);
	return {
		id: href!.split("/").at(-1)!,
		name,
		project_id: "",
	};
}

async function addCaseInBrowser(
	page: Page,
	dataset: Dataset,
	input: Record<string, unknown>,
	expected: Record<string, unknown> | null,
) {
	await page.goto(`/datasets/${dataset.id}`);
	await page.getByLabel("Input").fill(JSON.stringify(input));
	if (expected)
		await page
			.getByLabel("Expected output (optional)")
			.fill(JSON.stringify(expected));
	await page.getByLabel("Metadata").fill("{}");
	await page.getByRole("button", { name: "Add case" }).click();
	await expect(
		page.locator("pre").filter({ hasText: JSON.stringify(input, null, 2) }),
	).toBeVisible();
}

async function ingestProjectTrace(
	request: APIRequestContext,
	projectId: string,
	input: Record<string, unknown>,
	output: Record<string, unknown>,
) {
	const traceId = hex(16);
	const observationId = hex(8);
	const timestamp = Date.now() * 1_000_000;
	const response = await request.post(`${API_BASE}/v1/otel/v1/traces`, {
		headers: {
			authorization: authorization(),
			"content-type": "application/json",
		},
		data: {
			resource_spans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "first-pass-e2e" } },
							{
								key: "astraea.project.id",
								value: { stringValue: projectId },
							},
						],
					},
					scope_spans: [
						{
							spans: [
								{
									trace_id: traceId,
									span_id: observationId,
									name: unique("first-pass-trace"),
									kind: 1,
									start_time_unix_nano: timestamp,
									end_time_unix_nano: timestamp + 1_000_000,
									status: { code: 1 },
									attributes: [
										{
											key: "gen_ai.request.model",
											value: { stringValue: "e2e-model" },
										},
										{
											key: "gen_ai.prompt.0.content",
											value: { stringValue: JSON.stringify(input) },
										},
										{
											key: "gen_ai.completion.0.content",
											value: { stringValue: JSON.stringify(output) },
										},
									],
								},
							],
						},
					],
				},
			],
		},
	});
	expect(response.status(), "OTLP ingest status").toBe(200);

	await expect
		.poll(
			async () => {
				const trace = await request.get(
					`${API_BASE}/v1/traces/${traceId}?project_id=${projectId}`,
					{
						headers: { authorization: authorization() },
					},
				);
				return trace.status();
			},
			{ timeout: 10_000 },
		)
		.toBe(200);
	const persisted = await apiJson<{
		trace: { project_id: string };
	}>(
		await request.get(
			`${API_BASE}/v1/traces/${traceId}?project_id=${projectId}`,
			{
				headers: { authorization: authorization() },
			},
		),
	);
	expect(persisted.trace.project_id).toBe(projectId);
	return { traceId, observationId };
}

test("creates a project dataset and JSON case through the dashboard", async ({
	page,
	request,
}) => {
	const project = await loginAndSelectE2eProject(page);
	const input = { question: unique("manual-input") };
	const expected = { answer: "manual-answer" };
	const dataset = await createDatasetInBrowser(page, unique("manual-dataset"));
	await addCaseInBrowser(page, dataset, input, expected);

	const datasets = await apiJson<{ items: Dataset[] }>(
		await request.get(`${API_BASE}/v1/datasets?project_id=${project.id}`, {
			headers: { authorization: authorization() },
		}),
	);
	const persistedDataset = datasets.items.find(
		(item) => item.id === dataset.id,
	);
	expect(persistedDataset).toMatchObject({
		id: dataset.id,
		name: dataset.name,
		project_id: project.id,
	});

	const items = await apiJson<{ items: DatasetItem[] }>(
		await request.get(
			`${API_BASE}/v1/datasets/${dataset.id}/items?project_id=${project.id}`,
			{
				headers: { authorization: authorization() },
			},
		),
	);
	expect(items.items).toContainEqual(
		expect.objectContaining({ input, expected_output: expected }),
	);
	await expect(page.getByText(input.question)).toBeVisible();
});

test("records trace feedback and preserves observation provenance when adding its case", async ({
	page,
	request,
}) => {
	const project = await loginAndSelectE2eProject(page);
	const dataset = await createDatasetInBrowser(page, unique("trace-dataset"));
	const input = { prompt: unique("source-input") };
	const output = { completion: unique("source-output") };
	const trace = await ingestProjectTrace(request, project.id, input, output);

	await page.goto(`/observability/traces/${trace.traceId}`);
	await expect(page.getByTestId("trace-header")).toContainText(trace.traceId);
	await page.getByLabel("Comment").first().fill("Helpful first-pass trace");
	await page.getByRole("button", { name: "Thumbs up trace" }).click();
	await expect(page.getByRole("status")).toContainText("Recorded");

	const panel = page.getByTestId("observation-detail");
	await expect(panel).toHaveAttribute(
		"data-observation-id",
		trace.observationId,
	);
	await panel.getByRole("button", { name: "Add to dataset" }).click();
	const dialog = page.getByRole("dialog", {
		name: "Add Observation to dataset",
	});
	await dialog.getByLabel("Dataset").selectOption(dataset.id);
	await expect(dialog.getByLabel("Input")).toHaveValue(
		JSON.stringify(input, null, 2),
	);
	await expect(dialog.getByLabel("Expected output suggestion")).toHaveValue(
		JSON.stringify(output, null, 2),
	);
	await dialog.getByRole("button", { name: "Add case" }).click();
	await expect(dialog).toBeHidden();

	const feedback = await apiJson<{ items: Feedback[] }>(
		await request.get(
			`${API_BASE}/v1/feedback?project_id=${project.id}&trace_id=${trace.traceId}`,
			{ headers: { authorization: authorization() } },
		),
	);
	expect(feedback.items).toContainEqual(
		expect.objectContaining({
			project_id: project.id,
			trace_id: trace.traceId,
			value: 1,
			sentiment: "positive",
			comment: "Helpful first-pass trace",
			status: "reviewed",
		}),
	);

	const items = await apiJson<{ items: DatasetItem[] }>(
		await request.get(
			`${API_BASE}/v1/datasets/${dataset.id}/items?project_id=${project.id}`,
			{
				headers: { authorization: authorization() },
			},
		),
	);
	expect(items.items).toContainEqual(
		expect.objectContaining({
			input,
			expected_output: output,
			source_trace_id: trace.traceId,
			source_observation_id: trace.observationId,
		}),
	);
});

test("hides and rejects another project's trace while allowing its owner to view it", async ({
	page,
	request,
}) => {
	const project = await loginAndSelectE2eProject(page);
	const otherProject = await selectProject(
		page,
		"E2E Other Project",
		"e2e-other-project",
	);
	await selectProject(page, project.name, project.slug);
	const input = { prompt: unique("isolated-input") };
	const output = { completion: unique("isolated-output") };
	const trace = await ingestProjectTrace(
		request,
		otherProject.id,
		input,
		output,
	);

	const crossProjectDetail = await request.get(
		`${API_BASE}/v1/traces/${trace.traceId}?project_id=${project.id}`,
		{ headers: { authorization: authorization() } },
	);
	expect(crossProjectDetail.status()).toBe(404);
	const crossProjectEvents = await request.get(
		`${API_BASE}/v1/traces/${trace.traceId}/events?project_id=${project.id}`,
		{ headers: { authorization: authorization() } },
	);
	expect(crossProjectEvents.status()).toBe(404);

	const rejectedFeedback = await request.post(`${API_BASE}/v1/feedback`, {
		headers: {
			authorization: authorization(),
			"content-type": "application/json",
			"idempotency-key": unique("cross-project-feedback"),
		},
		data: {
			project_id: project.id,
			trace_id: trace.traceId,
			value: 1,
			metadata: {
				feedback: {
					schema_version: 1,
					sentiment: "positive",
					comment: "Must not cross project boundaries",
				},
			},
		},
	});
	expect(rejectedFeedback.status()).toBe(404);

	await page.goto(`/observability/traces/${trace.traceId}`);
	await expect(page.getByTestId("trace-not-found")).toBeVisible();
	await expect(page.getByLabel("Comment")).toHaveCount(0);

	await selectProject(page, otherProject.name, otherProject.slug);
	await page.goto(`/observability/traces/${trace.traceId}`);
	await expect(page.getByTestId("trace-header")).toContainText(trace.traceId);
});

test("reviews negative feedback through the inbox without promoting a dataset case", async ({
	page,
	request,
}) => {
	const project = await loginAndSelectE2eProject(page);
	const trace = await ingestProjectTrace(
		request,
		project.id,
		{ prompt: unique("negative-input") },
		{ completion: unique("negative-output") },
	);
	const created = await apiJson<Feedback>(
		await request.post(`${API_BASE}/v1/feedback`, {
			headers: {
				authorization: authorization(),
				"content-type": "application/json",
				"idempotency-key": unique("negative-feedback"),
			},
			data: {
				project_id: project.id,
				trace_id: trace.traceId,
				value: -1,
				metadata: {
					feedback: {
						schema_version: 1,
						sentiment: "negative",
						reason: "incorrect_answer",
						comment: "Needs a human review",
					},
				},
			},
		}),
		201,
	);
	expect(created.status).toBe("new");

	await page.goto("/feedback");
	await expect(page.getByText("Needs a human review")).toBeVisible();
	await page.getByRole("button", { name: "Mark reviewed" }).click();
	await expect(page.getByText(/trace · reviewed/)).toBeVisible();

	const feedback = await apiJson<{ items: Feedback[] }>(
		await request.get(`${API_BASE}/v1/feedback?project_id=${project.id}`, {
			headers: { authorization: authorization() },
		}),
	);
	expect(feedback.items.find((item) => item.id === created.id)).toMatchObject({
		status: "reviewed",
		dataset_id: null,
		dataset_item_id: null,
	});
});

test("blocks an evaluation before an LLM run when the selected dataset lacks expected output", async ({
	page,
	request,
}) => {
	const project = await loginAndSelectE2eProject(page);
	const dataset = await createDatasetInBrowser(
		page,
		unique("preflight-dataset"),
	);
	await addCaseInBrowser(
		page,
		dataset,
		{ prompt: unique("missing-expected") },
		null,
	);
	const before = await apiJson<{ total: number }>(
		await request.get(`${API_BASE}/v1/experiments?project_id=${project.id}`, {
			headers: { authorization: authorization() },
		}),
	);

	await page.goto("/evaluations");
	await page.getByLabel("Dataset").selectOption(dataset.id);
	await expect(
		page.getByText(
			"1 dataset case need expected output before this evaluation can run.",
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Run evaluation" }),
	).toBeDisabled();

	const after = await apiJson<{ total: number }>(
		await request.get(`${API_BASE}/v1/experiments?project_id=${project.id}`, {
			headers: { authorization: authorization() },
		}),
	);
	expect(after.total).toBe(before.total);
});
