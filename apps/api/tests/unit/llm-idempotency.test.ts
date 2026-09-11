import { afterEach, expect, test } from "bun:test";
import { invokeConfiguredLlm } from "../../src/lib/llm";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_API_BASE;
const originalDevCommand = process.env.ASTRAEA_DEV_LLM_COMMAND;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalApiKey;
	if (originalBase === undefined) delete process.env.OPENAI_API_BASE;
	else process.env.OPENAI_API_BASE = originalBase;
	if (originalDevCommand === undefined)
		delete process.env.ASTRAEA_DEV_LLM_COMMAND;
	else process.env.ASTRAEA_DEV_LLM_COMMAND = originalDevCommand;
});

test("passes the immutable OpenAI execution defaults and stable dispatch headers", async () => {
	let request: RequestInit | undefined;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_API_BASE = "https://provider.example/v1";
	globalThis.fetch = (async (_url, init) => {
		request = init;
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: "ok" } }],
				model: "test-model",
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	await invokeConfiguredLlm(
		{ question: "test" },
		{
			model: "test-model",
			temperature: 0.4,
			max_tokens: 321,
			system_prompt: "Use the pinned rubric.",
		},
		undefined,
		"astraea:experiment_task:task-id:provider_dispatch:1",
	);

	expect(new Headers(request?.headers).get("idempotency-key")).toBe(
		"astraea:experiment_task:task-id:provider_dispatch:1",
	);
	expect(new Headers(request?.headers).get("x-client-request-id")).toBe(
		"astraea:experiment_task:task-id:provider_dispatch:1",
	);
	expect(JSON.parse(String(request?.body))).toEqual({
		model: "test-model",
		temperature: 0.4,
		max_tokens: 321,
		messages: [
			{ role: "system", content: "Use the pinned rubric." },
			{ role: "user", content: JSON.stringify({ question: "test" }) },
		],
	});
});

test("passes the stable logical dispatch key to the development CLI", async () => {
	process.env.ASTRAEA_DEV_LLM_COMMAND = JSON.stringify([
		process.execPath,
		"-e",
		"process.stdout.write(process.env.ASTRAEA_PROVIDER_DISPATCH_KEY ?? '')",
	]);

	const response = await invokeConfiguredLlm(
		{ question: "test" },
		{ provider: "codex_cli", model: "test-model" },
		undefined,
		"astraea:experiment_task:task-id:provider_dispatch:1",
	);

	expect(response.output).toEqual({
		value: "astraea:experiment_task:task-id:provider_dispatch:1",
	});
});

test("classifies provider throttling and server failures as uncertain", async () => {
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_API_BASE = "https://provider.example/v1";
	for (const status of [429, 500, 503]) {
		globalThis.fetch = (async () =>
			new Response("failure", { status })) as typeof fetch;
		await expect(
			invokeConfiguredLlm({ question: "test" }, { model: "test-model" }),
		).rejects.toMatchObject({ dispatchOutcome: "uncertain" });
	}
});

test("classifies a provider validation response as deterministic and safe to retry", async () => {
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_API_BASE = "https://provider.example/v1";
	globalThis.fetch = (async () =>
		new Response("invalid request", { status: 400 })) as typeof fetch;

	await expect(
		invokeConfiguredLlm({ question: "test" }, { model: "test-model" }),
	).rejects.toMatchObject({
		dispatchOutcome: "deterministic_failure",
		safeToRetry: true,
	});
});
