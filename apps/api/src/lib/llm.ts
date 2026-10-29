import { killOwnedProcessGroup } from "./owned-process.js";

export type LlmResponse = {
	output: Record<string, unknown>;
	model: string;
	prompt_tokens?: number;
	completion_tokens?: number;
	/** Provider-reported billable cost. It is never inferred from token counts. */
	cost_usd?: number | null;
};

export class LlmProviderError extends Error {
	constructor(
		message: string,
		readonly dispatchOutcome: "deterministic_failure" | "uncertain",
		cause?: unknown,
		readonly safeToRetry = dispatchOutcome === "deterministic_failure",
	) {
		super(message, { cause });
		this.name = "LlmProviderError";
	}
}

export function isUncertainLlmFailure(cause: unknown): boolean {
	return (
		cause instanceof LlmProviderError && cause.dispatchOutcome === "uncertain"
	);
}

const MAX_DEV_OUTPUT_BYTES = 64 * 1024;
const MAX_PROVIDER_OUTPUT_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_DEV_TIMEOUT_MS = 60_000;
const MAX_DEV_TIMEOUT_MS = 1_800_000;

function configuredDevCommand(model: string): string[] {
	const raw = process.env.GLASSHOUSE_DEV_LLM_COMMAND;
	if (!raw) throw new Error("GLASSHOUSE_DEV_LLM_COMMAND is not configured");
	let command: unknown;
	try {
		command = JSON.parse(raw);
	} catch {
		throw new Error("GLASSHOUSE_DEV_LLM_COMMAND must be a JSON argv array");
	}
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		!command.every((value) => typeof value === "string" && value.length > 0)
	)
		throw new Error(
			"GLASSHOUSE_DEV_LLM_COMMAND must be a non-empty JSON argv array",
		);
	return (command as string[]).map((argument) =>
		argument.replaceAll("{model}", model),
	);
}

async function readLimited(
	stream: ReadableStream<Uint8Array> | null,
	limit: number,
	signal?: AbortSignal,
	errorMessage = "development CLI stream exceeded size limit",
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			if (total + value.byteLength > limit) throw new Error(errorMessage);
			chunks.push(value);
			total += value.byteLength;
		}
	} catch (cause) {
		await reader.cancel().catch(() => {});
		throw cause;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(output);
}

async function invokeDevelopmentCli(
	prompt: string,
	model: string,
	signal?: AbortSignal,
	providerDispatchKey?: string,
): Promise<string> {
	if (
		process.env.NODE_ENV === "production" &&
		process.env.GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION !== "true"
	)
		throw new Error("development CLI provider is disabled in production");
	const timeoutValue = Number(
		process.env.GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS ?? 60,
	);
	const timeoutMs =
		Number.isFinite(timeoutValue) && timeoutValue > 0
			? Math.min(timeoutValue * 1000, MAX_DEV_TIMEOUT_MS)
			: DEFAULT_DEV_TIMEOUT_MS;
	const command = configuredDevCommand(model);
	const child = Bun.spawn(
		process.platform === "linux" ? ["setsid", ...command] : command,
		{
			stdin: new Response(prompt).body,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				...(providerDispatchKey
					? { GLASSHOUSE_PROVIDER_DISPATCH_KEY: providerDispatchKey }
					: {}),
			},
		},
	);
	let stopped = false;
	const abort = () => {
		stopped = true;
		killOwnedProcessGroup(child.pid);
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, timeoutMs);
	const completion = [
		readLimited(child.stdout, MAX_DEV_OUTPUT_BYTES),
		readLimited(child.stderr, 8 * 1024),
		child.exited,
	] as const;
	try {
		const [stdout, stderr, exitCode] = await Promise.all(completion);
		if (stopped) throw new Error("development CLI was terminated");
		if (exitCode !== 0)
			throw new Error(
				`development CLI exited with status ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : ""}`,
			);
		const bytes = new TextEncoder().encode(stdout);
		if (bytes.byteLength > MAX_DEV_OUTPUT_BYTES)
			throw new Error("development CLI output exceeded size limit");
		return stdout.trim();
	} finally {
		killOwnedProcessGroup(child.pid);
		await Promise.allSettled(completion);
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

export async function invokeConfiguredLlm(
	input: Record<string, unknown>,
	config: Record<string, unknown>,
	signal?: AbortSignal,
	idempotencyKey?: string,
): Promise<LlmResponse> {
	const model =
		typeof config.model === "string" && config.model
			? config.model
			: (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
	const provider =
		typeof config.provider === "string"
			? config.provider
			: (process.env.GLASSHOUSE_EVAL_LLM_PROVIDER ?? "openai");
	const system =
		typeof config.system_prompt === "string"
			? config.system_prompt
			: "Return a concise answer to the user's input.";
	const prompt = JSON.stringify([
		{ role: "system", content: system },
		{ role: "user", content: JSON.stringify(input) },
	]);
	if (provider === "fake")
		return {
			output: { value: "e2e-deterministic-answer" },
			model,
			cost_usd: 0,
		};
	if (provider === "codex_cli")
		// The development CLI intentionally keeps its existing stdin contract. It
		// receives the pinned model and dispatch key, but does not emulate OpenAI's
		// temperature/max_tokens request fields.
		return {
			output: {
				value: await invokeDevelopmentCli(
					prompt,
					model,
					signal,
					idempotencyKey,
				),
			},
			model,
		};
	if (provider !== "openai")
		throw new LlmProviderError(
			"unsupported LLM provider",
			"deterministic_failure",
			undefined,
			false,
		);
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey)
		throw new LlmProviderError(
			"OPENAI_API_KEY is not configured",
			"deterministic_failure",
			undefined,
			false,
		);
	const baseUrl = (
		process.env.OPENAI_API_BASE ??
		process.env.OPENAI_BASE_URL ??
		"https://api.openai.com/v1"
	).replace(/\/$/, "");
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				...(idempotencyKey
					? {
							"idempotency-key": idempotencyKey,
							"x-client-request-id": idempotencyKey,
						}
					: {}),
			},
			body: JSON.stringify({
				model,
				temperature:
					typeof config.temperature === "number" ? config.temperature : 0,
				...(typeof config.max_tokens === "number" &&
				Number.isSafeInteger(config.max_tokens) &&
				config.max_tokens >= 1
					? { max_tokens: config.max_tokens }
					: {}),
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: JSON.stringify(input) },
				],
			}),
			signal,
		});
	} catch (cause) {
		throw new LlmProviderError(
			"LLM request outcome is unknown",
			"uncertain",
			cause,
		);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new LlmProviderError(
			`LLM request failed with status ${response.status}`,
			response.status === 429 || response.status >= 500
				? "uncertain"
				: "deterministic_failure",
			undefined,
			response.status !== 429 && response.status < 500,
		);
	}
	let payload: {
		choices?: Array<{ message?: { content?: unknown } }>;
		model?: string;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
		cost_usd?: unknown;
	};
	try {
		payload = JSON.parse(
			await readLimited(
				response.body,
				MAX_PROVIDER_RESPONSE_BYTES,
				signal,
				"LLM response exceeded the response size limit",
			),
		) as typeof payload;
		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			(payload.model !== undefined &&
				(typeof payload.model !== "string" ||
					!payload.model ||
					Buffer.byteLength(payload.model) > 200)) ||
			(payload.usage !== undefined &&
				(!payload.usage ||
					typeof payload.usage !== "object" ||
					[payload.usage.prompt_tokens, payload.usage.completion_tokens].some(
						(value) =>
							value !== undefined &&
							(!Number.isSafeInteger(value) || value < 0),
					)))
		)
			throw new Error("Invalid LLM response metadata");
	} catch (cause) {
		throw new LlmProviderError(
			"LLM response could not be decoded",
			"uncertain",
			cause,
		);
	}
	const content = payload.choices?.[0]?.message?.content;
	const outputValue =
		typeof content === "string" ? content : JSON.stringify(content ?? null);
	if (
		new TextEncoder().encode(outputValue).byteLength > MAX_PROVIDER_OUTPUT_BYTES
	)
		throw new LlmProviderError(
			"LLM response exceeded the evidence size limit",
			"deterministic_failure",
			undefined,
			false,
		);
	return {
		output: {
			value: outputValue,
		},
		model: payload.model ?? model,
		prompt_tokens: payload.usage?.prompt_tokens,
		completion_tokens: payload.usage?.completion_tokens,
		cost_usd:
			typeof payload.cost_usd === "number" &&
			Number.isFinite(payload.cost_usd) &&
			payload.cost_usd >= 0
				? payload.cost_usd
				: null,
	};
}
