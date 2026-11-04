import { strict as assert } from "node:assert";

// This probe only talks to the running API. The candidate must come from its
// asynchronous Bun.spawn -> Python worker path, not from an in-process stub.
const base = process.env.CANDIDATE_URL;
assert(
	base && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base),
	"loopback candidate URL required",
);
const authorization = `Basic ${Buffer.from("synthetic-owner:synthetic-ui-9b412e8cfa").toString("base64")}`;
const source = "Summarize tasks";
const candidate = `${source}\n\nOptimize for clear, accurate answers.`;

async function api(path: string, body?: unknown, expected = 200): Promise<any> {
	const response = await fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
	if (response.status !== expected)
		throw new Error(
			`${path.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 1024)}`,
		);
	return response.json();
}

function check(job: any, id: string, slug: string) {
	assert.equal(job.id, id);
	assert.equal(job.prompt_slug, slug);
	assert.equal(job.source_version, 1);
	assert.equal(
		job.status,
		"completed",
		`optimization ended as ${job.status}: ${job.error_message}`,
	);
	assert.equal(job.candidate_content, candidate);
	assert.equal(job.metric_calls_used, 0);
	assert.equal(job.promotion_status, "review_required");
	assert.equal(job.evidence.metric, "default_adapter.expected_answer_contains");
	assert.equal(job.evidence.training.sample_count, 1);
	assert.equal(job.evidence.training.score, 1);
	assert.equal(job.evidence.validation.sample_count, 1);
	assert.equal(job.evidence.validation.score, 1);
	assert.equal(job.evidence.validation.baseline_score, 0);
	assert.equal(job.evidence.validation.held_out, true);
}

if (process.env.CANDIDATE_READBACK_FILE) {
	const saved = await Bun.file(process.env.CANDIDATE_READBACK_FILE).json();
	check(
		await api(
			`/v1/prompt-optimizations/${saved.id}?project_id=${saved.project}`,
		),
		saved.id,
		saved.slug,
	);
	console.log(
		`Optimization ${saved.id}: candidate and evidence persisted after API restart`,
	);
	process.exit(0);
}

const projects = await api("/v1/projects");
const project = projects.items.find((item: any) => item.slug === "default");
assert(project?.id);
const prompt = await api(
	"/v1/prompts",
	{
		project_id: project.id,
		name: `Candidate GEPA ${crypto.randomUUID().slice(0, 8)}`,
		messages: [{ role: "system", content: source }],
	},
	201,
);
assert.equal(prompt.version, 1);
const started = await api(
	"/v1/prompt-optimizations",
	{
		project_id: project.id,
		slug: prompt.id,
		source_version: prompt.version,
		target: "system",
		evaluator: { type: "default_adapter" },
		dataset: {
			version: 1,
			rubric: "Be accurate",
			training_examples: [
				{ input: "alpha question", answer: "training response" },
			],
			validation_examples: [
				{ input: "zulu question", answer: "held out response" },
			],
		},
		model_config: {
			task_lm: "openai/gpt-4o-mini",
			reflection_lm: "openai/gpt-4o-mini",
		},
		budget: { max_metric_calls: 2 },
	},
	202,
);
assert(started.id);
const path = `/v1/prompt-optimizations/${started.id}?project_id=${project.id}`;
let job: any;
const deadline = Date.now() + 60000;
do {
	job = await api(path);
	if (["completed", "failed", "stopped"].includes(job.status)) break;
	await Bun.sleep(250);
} while (Date.now() < deadline);
check(job, started.id, prompt.id);
assert(process.env.CANDIDATE_STATE_FILE, "state file required");
await Bun.write(
	process.env.CANDIDATE_STATE_FILE,
	JSON.stringify({ project: project.id, id: started.id, slug: prompt.id }),
);
console.log(
	`Optimization ${started.id}: Python fake worker completed and persisted its candidate`,
);
