export type LlmResponse = {
	output: Record<string, unknown>;
	model: string;
	prompt_tokens?: number;
	completion_tokens?: number;
};

export async function invokeConfiguredLlm(
	input: Record<string, unknown>,
	config: Record<string, unknown>,
): Promise<LlmResponse> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
	const baseUrl = (
		process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
	).replace(/\/$/, "");
	const model =
		typeof config.model === "string" && config.model
			? config.model
			: (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
	const system =
		typeof config.system_prompt === "string"
			? config.system_prompt
			: "Return a concise answer to the user's input.";
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			temperature:
				typeof config.temperature === "number" ? config.temperature : 0,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: JSON.stringify(input) },
			],
		}),
	});
	if (!response.ok)
		throw new Error(`LLM request failed with status ${response.status}`);
	const payload = (await response.json()) as {
		choices?: Array<{ message?: { content?: unknown } }>;
		model?: string;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const content = payload.choices?.[0]?.message?.content;
	return {
		output: {
			value:
				typeof content === "string" ? content : JSON.stringify(content ?? null),
		},
		model: payload.model ?? model,
		prompt_tokens: payload.usage?.prompt_tokens,
		completion_tokens: payload.usage?.completion_tokens,
	};
}
