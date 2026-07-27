export type LlmResponse = {
	output: Record<string, unknown>;
	model: string;
	prompt_tokens?: number;
	completion_tokens?: number;
};

const MAX_DEV_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_DEV_TIMEOUT_MS = 60_000;
const MAX_DEV_TIMEOUT_MS = 1_800_000;

function configuredDevCommand(model: string): string[] {
	const raw = process.env.ASTRAEA_DEV_LLM_COMMAND;
	if (!raw) throw new Error("ASTRAEA_DEV_LLM_COMMAND is not configured");
	let command: unknown;
	try {
		command = JSON.parse(raw);
	} catch {
		throw new Error("ASTRAEA_DEV_LLM_COMMAND must be a JSON argv array");
	}
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		!command.every((value) => typeof value === "string" && value.length > 0)
	)
		throw new Error(
			"ASTRAEA_DEV_LLM_COMMAND must be a non-empty JSON argv array",
		);
	return (command as string[]).map((argument) =>
		argument.replaceAll("{model}", model),
	);
}

async function invokeDevelopmentCli(
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<string> {
	if (
		process.env.NODE_ENV === "production" &&
		process.env.ASTRAEA_ALLOW_DEV_LLM_IN_PRODUCTION !== "true"
	)
		throw new Error("development CLI provider is disabled in production");
	const timeoutValue = Number(
		process.env.ASTRAEA_DEV_LLM_TIMEOUT_SECONDS ?? 60,
	);
	const timeoutMs =
		Number.isFinite(timeoutValue) && timeoutValue > 0
			? Math.min(timeoutValue * 1000, MAX_DEV_TIMEOUT_MS)
			: DEFAULT_DEV_TIMEOUT_MS;
	const child = Bun.spawn(configuredDevCommand(model), {
		stdin: new Response(prompt).body,
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const timeout = setTimeout(() => child.kill(), timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			child.stdout ? new Response(child.stdout).text() : "",
			child.stderr ? new Response(child.stderr).text() : "",
			child.exited,
		]);
		if (exitCode !== 0)
			throw new Error(
				`development CLI exited with status ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : ""}`,
			);
		const bytes = new TextEncoder().encode(stdout);
		if (bytes.byteLength > MAX_DEV_OUTPUT_BYTES)
			throw new Error("development CLI output exceeded size limit");
		return stdout.trim();
	} finally {
		clearTimeout(timeout);
	}
}

export async function invokeConfiguredLlm(
	input: Record<string, unknown>,
	config: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<LlmResponse> {
	const model =
		typeof config.model === "string" && config.model
			? config.model
			: (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
	const provider =
		typeof config.provider === "string"
			? config.provider
			: (process.env.ASTRAEA_EVAL_LLM_PROVIDER ?? "openai");
	const system =
		typeof config.system_prompt === "string"
			? config.system_prompt
			: "Return a concise answer to the user's input.";
	const prompt = JSON.stringify([
		{ role: "system", content: system },
		{ role: "user", content: JSON.stringify(input) },
	]);
	if (provider === "codex_cli")
		return {
			output: { value: await invokeDevelopmentCli(prompt, model, signal) },
			model,
		};
	if (provider !== "openai") throw new Error("unsupported LLM provider");
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
	const baseUrl = (
		process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
	).replace(/\/$/, "");
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
		signal,
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
