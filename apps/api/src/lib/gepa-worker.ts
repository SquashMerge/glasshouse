import type { OptimizationDataset } from "./optimization-dataset.js";
import { logger } from "./logger.js";

export type GepaWorkerInput = {
	target: "system";
	source: string;
	evaluator: Record<string, unknown>;
	dataset: OptimizationDataset;
	model_config: Record<string, unknown>;
	budget: Record<string, unknown>;
	provider_dispatch_key: string;
};

export type GepaWorkerResult = {
	candidate: string;
	training_score: number | null;
	validation_score: number;
	baseline_validation_score: number;
	metric_calls_used: number | null;
};
export const MAX_OPTIMIZATION_CANDIDATE_BYTES = 64 * 1024;
const MAX_WORKER_OUTPUT_BYTES = MAX_OPTIMIZATION_CANDIDATE_BYTES + 1024;
const MAX_WORKER_DIAGNOSTIC_BYTES = 16 * 1024;
export type GepaWorkerProgress = { metric_calls_used: number };
export type GepaWorker = (
	input: GepaWorkerInput,
	signal: AbortSignal,
	onProgress?: (progress: GepaWorkerProgress) => Promise<void> | void,
) => Promise<GepaWorkerResult>;

function workerPath(): string {
	return new URL("../../../../worker/gepa_worker.py", import.meta.url).pathname;
}

const WORKER_FAILURE_PREFIX = "ASTRAEA_GEPA_FAILURE ";
const SAFE_WORKER_FAILURE_KINDS = new Set([
	"AssertionError",
	"AttributeError",
	"KeyError",
	"RuntimeError",
	"TypeError",
	"UnknownError",
	"ValueError",
]);
const SAFE_WORKER_FAILURE_SITE = /^(?:astraea_worker|gepa):[1-9][0-9]{0,5}$/u;

export function diagnosticSummary(
	diagnostic: string,
): Record<string, number | string> {
	if (!diagnostic) return {};
	const failure = diagnostic
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith(WORKER_FAILURE_PREFIX))
		?.slice(WORKER_FAILURE_PREFIX.length);
	const [failureKind, failureSite, ...extraFailureParts] =
		failure?.split(" ") ?? [];
	const hasSafeFailureSite =
		extraFailureParts.length === 0 &&
		failureSite !== undefined &&
		SAFE_WORKER_FAILURE_SITE.test(failureSite);
	const hasSafeFailureKind =
		failureKind !== undefined && SAFE_WORKER_FAILURE_KINDS.has(failureKind);
	return {
		diagnostic_bytes: new TextEncoder().encode(diagnostic).byteLength,
		diagnostic_lines: diagnostic.split("\n").filter(Boolean).length,
		...(hasSafeFailureKind ? { worker_failure_kind: failureKind } : {}),
		...(hasSafeFailureKind && hasSafeFailureSite
			? { worker_failure_site: failureSite }
			: {}),
	};
}

export const runGepaWorker: GepaWorker = async (input, signal, onProgress) => {
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
		readWorkerDiagnostics(child.stderr, onProgress),
		child.exited,
	]);
	if (exitCode !== 0) {
		const diagnostic = stderr.trim();
		logger.error(
			"optimization.worker_failed",
			new Error(`GEPA worker exited with code ${exitCode}`),
			{
				exit_code: exitCode,
				...diagnosticSummary(diagnostic),
			},
		);
		throw new Error("GEPA worker failed");
	}
	return parseWorkerResult(stdout, input.budget.max_metric_calls);
};

export function parseWorkerResult(
	stdout: string,
	maxMetricCalls: unknown,
): GepaWorkerResult {
	try {
		const parsed = JSON.parse(stdout) as Partial<GepaWorkerResult> & {
			metric_calls_used?: unknown;
		};
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
			(parsed.training_score !== null &&
				(typeof parsed.training_score !== "number" ||
					!Number.isFinite(parsed.training_score))) ||
			typeof parsed.validation_score !== "number" ||
			!Number.isFinite(parsed.validation_score) ||
			typeof parsed.baseline_validation_score !== "number" ||
			!Number.isFinite(parsed.baseline_validation_score) ||
			typeof maxMetricCalls !== "number" ||
			!Number.isSafeInteger(maxMetricCalls) ||
			maxMetricCalls < 0 ||
			(metricCallsUsed !== null &&
				(!Number.isSafeInteger(metricCallsUsed) ||
					metricCallsUsed < 0 ||
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
}

const PROGRESS_PREFIX = "ASTRAEA_GEPA_PROGRESS ";

export async function readWorkerDiagnostics(
	stream: ReadableStream<Uint8Array>,
	onProgress?: (progress: GepaWorkerProgress) => Promise<void> | void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const diagnostics: string[] = [];
	let diagnosticBytes = 0;
	let pending = "";
	const appendDiagnostic = (line: string): void => {
		const bytes = new TextEncoder().encode(line).byteLength;
		if (diagnosticBytes + bytes > MAX_WORKER_DIAGNOSTIC_BYTES)
			throw new Error("GEPA worker output exceeded size limit");
		diagnosticBytes += bytes;
		diagnostics.push(line);
	};
	const processLine = async (line: string): Promise<void> => {
		if (!line.startsWith(PROGRESS_PREFIX)) {
			appendDiagnostic(line);
			return;
		}
		let progress: unknown;
		try {
			progress = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as unknown;
		} catch {
			appendDiagnostic(line);
			return;
		}
		if (
			!progress ||
			typeof progress !== "object" ||
			!("metric_calls_used" in progress) ||
			typeof progress.metric_calls_used !== "number" ||
			!Number.isSafeInteger(progress.metric_calls_used) ||
			progress.metric_calls_used < 0
		) {
			appendDiagnostic(line);
			return;
		}
		await onProgress?.({ metric_calls_used: progress.metric_calls_used });
	};
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			pending += decoder.decode(next.value, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) await processLine(line);
		}
		pending += decoder.decode();
		if (pending) await processLine(pending);
	} finally {
		reader.releaseLock();
	}
	return diagnostics.join("\n");
}

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
