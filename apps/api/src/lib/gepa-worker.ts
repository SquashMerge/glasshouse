import type { OptimizationDataset } from "./optimization-dataset.js";
import { logger } from "./logger.js";

export type GepaWorkerInput = {
	target: "system" | "user";
	source: string;
	evaluator: Record<string, unknown>;
	dataset: OptimizationDataset;
	model_config: Record<string, unknown>;
	budget: Record<string, unknown>;
};

export type GepaWorkerResult = {
	candidate: string;
	training_score: number;
	validation_score: number;
	baseline_validation_score: number;
	metric_calls_used: number | null;
};
export const MAX_OPTIMIZATION_CANDIDATE_BYTES = 64 * 1024;
const MAX_WORKER_OUTPUT_BYTES = MAX_OPTIMIZATION_CANDIDATE_BYTES + 1024;
const MAX_WORKER_DIAGNOSTIC_BYTES = 16 * 1024;
export type GepaWorker = (
	input: GepaWorkerInput,
	signal: AbortSignal,
) => Promise<GepaWorkerResult>;

function workerPath(): string {
	return new URL("../../../../worker/gepa_worker.py", import.meta.url).pathname;
}

export const runGepaWorker: GepaWorker = async (input, signal) => {
	const payload = JSON.stringify(input);
	const child = Bun.spawn(
		[process.env.GEPA_PYTHON ?? "python3", workerPath()],
		{
			stdin: new Response(`${payload}\n`).body,
			stdout: "pipe",
			stderr: "pipe",
			signal,
			env: {
				...process.env,
				GEPA_WORKER_MODE: process.env.GEPA_WORKER_MODE ?? "gepa",
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		readWorkerOutput(child.stdout),
		readWorkerOutput(child.stderr, MAX_WORKER_DIAGNOSTIC_BYTES),
		child.exited,
	]);
	if (exitCode !== 0) {
		logger.error(
			"optimization.worker_failed",
			new Error("GEPA worker failed"),
			{
				exit_code: exitCode,
				diagnostic_bytes: new TextEncoder().encode(stderr).byteLength,
			},
		);
		throw new Error("GEPA worker failed");
	}
	try {
		const parsed = JSON.parse(stdout) as Partial<GepaWorkerResult> & {
			metric_calls_used?: unknown;
		};
		const maxMetricCalls = input.budget.max_metric_calls;
		const metricCallsUsed: number | null =
			parsed.metric_calls_used === undefined ||
			parsed.metric_calls_used === null
				? null
				: typeof parsed.metric_calls_used === "number"
					? parsed.metric_calls_used
					: Number.NaN;
		if (
			!parsed ||
			typeof parsed.candidate !== "string" ||
			typeof parsed.training_score !== "number" ||
			!Number.isFinite(parsed.training_score) ||
			typeof parsed.validation_score !== "number" ||
			!Number.isFinite(parsed.validation_score) ||
			typeof parsed.baseline_validation_score !== "number" ||
			!Number.isFinite(parsed.baseline_validation_score) ||
			(metricCallsUsed !== null &&
				(!Number.isSafeInteger(metricCallsUsed) ||
					metricCallsUsed < 0 ||
					typeof maxMetricCalls !== "number" ||
					metricCallsUsed > maxMetricCalls)) ||
			new TextEncoder().encode(parsed.candidate).byteLength >
				MAX_OPTIMIZATION_CANDIDATE_BYTES
		)
			throw new Error("invalid result");
		return {
			candidate: parsed.candidate,
			training_score: parsed.training_score,
			validation_score: parsed.validation_score,
			baseline_validation_score: parsed.baseline_validation_score,
			metric_calls_used: metricCallsUsed,
		};
	} catch {
		throw new Error("GEPA worker returned an invalid result");
	}
};

export async function readWorkerOutput(
	stream: ReadableStream<Uint8Array>,
	maxBytes = MAX_WORKER_OUTPUT_BYTES,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error("GEPA worker output exceeded size limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(output);
}
