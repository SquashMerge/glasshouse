import { strict as assert } from "node:assert";

const base = process.env.CANDIDATE_URL;
assert(
	base && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base),
	"loopback candidate URL required",
);
const authorization = `Basic ${Buffer.from("synthetic-owner:synthetic-ui-9b412e8cfa").toString("base64")}`;

async function api(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		revision?: number;
		key?: string;
	} = {},
) {
	const headers: Record<string, string> = { authorization };
	if (options.body !== undefined) headers["content-type"] = "application/json";
	if (options.revision !== undefined)
		headers["if-match"] = `"${options.revision}"`;
	if (options.key) headers["idempotency-key"] = options.key;
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok)
		throw new Error(
			`${options.method ?? "GET"} ${path.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 1024)}`,
		);
	return (await response.json()) as any;
}

if (process.env.CANDIDATE_READBACK_FILE) {
	const saved = await Bun.file(process.env.CANDIDATE_READBACK_FILE).json();
	const scope = `?project_id=${saved.project}`;
	const status = await api(`/v1/evaluation-runs/${saved.run}${scope}`);
	const evidence = await api(
		`/v1/evaluation-runs/${saved.run}/evidence${scope}`,
	);
	assert.equal(status.status, "completed");
	assert.equal(status.metrics.passed, 1);
	assert.equal(status.metrics.provider_calls_used, 1);
	assert.equal(evidence.total, 1);
	assert.deepEqual(evidence.items[0].output, {
		value: "e2e-deterministic-answer",
	});
	console.log(`Evaluation run ${saved.run}: persisted after API restart`);
	process.exit(0);
}

const projects = await api("/v1/projects");
const project = projects.items.find((item: any) => item.slug === "default");
assert(project?.id);
const scope = `?project_id=${project.id}`;
const suffix = crypto.randomUUID().slice(0, 8);
const dataset = await api("/v1/datasets", {
	method: "POST",
	body: { project_id: project.id, name: `Candidate lifecycle ${suffix}` },
});
const root = `/v1/datasets/by-slug/${dataset.slug}`;
let draft = await api(`${root}/drafts${scope}`, { method: "POST" });
const item = await api(`${root}/draft/items/candidate-case${scope}`, {
	method: "PUT",
	revision: draft.revision,
	body: {
		input: { question: "candidate-lifecycle-question" },
		expected_output: { value: "e2e-deterministic-answer" },
		metadata: {},
	},
});
draft = await api(`${root}/draft${scope}`);
await api(`${root}/draft/items/${item.id}/review${scope}`, {
	method: "POST",
	revision: draft.revision,
});
draft = await api(`${root}/draft${scope}`);
const validation = await api(`${root}/draft/validate${scope}`, {
	method: "POST",
});
assert.equal(validation.valid, true);
await api(`${root}/draft/publish${scope}`, {
	method: "POST",
	revision: draft.revision,
});
const versions = await api(`${root}/versions${scope}`);
assert.equal(versions.items.length, 1);
const slug = `candidate-lifecycle-${suffix}`;
const created = await api(`/v1/evaluations${scope}`, {
	method: "POST",
	body: {
		slug,
		name: `Candidate lifecycle ${suffix}`,
		definition: {
			dataset_version_id: versions.items[0].id,
			sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
			evaluator: {
				kind: "exact_match",
				version: "v1",
				expected_output_path: "$.expected_output",
				output_path: "$.output",
			},
			target: {
				kind: "configured_llm",
				model: "deterministic",
				system_prompt: null,
			},
			execution_defaults: { temperature: 0, max_tokens: null },
			limits: { max_cost_usd: 10, max_duration_seconds: 60 },
			thresholds: { minimum_pass_rate: null },
		},
	},
});
const definition = await api(`/v1/evaluations/${slug}/draft/publish${scope}`, {
	method: "POST",
	revision: created.draft.revision,
});
if (process.env.CANDIDATE_EXPECT_FAKE_DENIAL === "true") {
	const response = await fetch(`${base}/v1/evaluations/${slug}/runs${scope}`, {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"idempotency-key": `candidate-${suffix}`,
		},
		body: JSON.stringify({
			definition_version: definition.version,
			trigger_metadata: { source: "ci" },
		}),
		signal: AbortSignal.timeout(10000),
	});
	assert.equal(response.status, 400);
	assert.match(
		await response.text(),
		/fake Evaluation provider is disabled in production/,
	);
	console.log("Production admission rejected the fake provider");
	process.exit(0);
}
const started = await api(`/v1/evaluations/${slug}/runs${scope}`, {
	method: "POST",
	key: `candidate-${suffix}`,
	body: {
		definition_version: definition.version,
		trigger_metadata: { source: "ci" },
	},
});
assert.equal(started.project_id, project.id);
assert.equal(started.dataset_version_id, versions.items[0].id);
assert.equal(started.definition_version_id, definition.id);
const path = `/v1/evaluation-runs/${started.id}`;
let status: any;
const deadline = Date.now() + 60000;
do {
	status = await api(`${path}${scope}`);
	if (["completed", "failed", "cancelled"].includes(status.status)) break;
	await Bun.sleep(250);
} while (Date.now() < deadline);
assert.equal(
	status.status,
	"completed",
	`run ended as ${status.status}: ${status.terminal_reason}`,
);
assert.equal(status.project_id, project.id);
assert.equal(status.counts.total, 1);
assert.equal(status.counts.completed, 1);
assert.equal(status.counts.failed, 0);
assert.equal(status.metrics.provider_calls_used, 1);
assert.equal(status.metrics.evaluated, 1);
assert.equal(status.metrics.passed, 1);
assert.equal(status.metrics.pass_rate, 1);
const evidence = await api(`${path}/evidence${scope}`);
assert.equal(evidence.run_id, started.id);
assert.equal(evidence.project_id, project.id);
assert.equal(evidence.total, 1);
assert.equal(evidence.items[0].status, "completed");
assert.equal(evidence.items[0].attempt_count, 1);
assert.deepEqual(evidence.items[0].output, {
	value: "e2e-deterministic-answer",
});
assert.deepEqual(evidence.items[0].expected_output, {
	value: "e2e-deterministic-answer",
});
if (process.env.CANDIDATE_STATE_FILE)
	await Bun.write(
		process.env.CANDIDATE_STATE_FILE,
		JSON.stringify({ project: project.id, run: started.id }),
	);
console.log(
	`Evaluation run ${started.id}: completed, 1 provider call, 1 passing persisted result`,
);
