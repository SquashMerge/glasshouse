import { afterEach, expect, test } from "bun:test";
import { invokeConfiguredLlm } from "../../src/lib/llm";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_API_BASE;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalApiKey;
	if (originalBase === undefined) delete process.env.OPENAI_API_BASE;
	else process.env.OPENAI_API_BASE = originalBase;
});

test("passes the stable admission effect key to OpenAI idempotency support", async () => {
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
		{ model: "test-model" },
		undefined,
		"admission-id:provider",
	);

	expect(new Headers(request?.headers).get("idempotency-key")).toBe(
		"admission-id:provider",
	);
});
