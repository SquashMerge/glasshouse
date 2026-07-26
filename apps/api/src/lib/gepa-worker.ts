export type GepaWorkerInput = {
	target: "system" | "user";
	source: string;
	evaluator: Record<string, unknown>;
	examples: unknown[];
	model_config: Record<string, unknown>;
	budget: Record<string, unknown>;
};

export type GepaWorkerResult = { candidate: string; score?: number };
export const MAX_OPTIMIZATION_CANDIDATE_BYTES = 64 * 1024;
const MAX_WORKER_OUTPUT_BYTES = MAX_OPTIMIZATION_CANDIDATE_BYTES + 1024;
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
	const [stdout, exitCode] = await Promise.all([
		readWorkerOutput(child.stdout),
		child.exited,
	]);
	// Worker stderr can contain provider diagnostics; never surface it through jobs or SSE.
	if (exitCode !== 0) throw new Error("GEPA worker failed");
	try {
		const result = JSON.parse(stdout) as GepaWorkerResult;
		if (
			!result ||
			typeof result.candidate !== "string" ||
			new TextEncoder().encode(result.candidate).byteLength >
				MAX_OPTIMIZATION_CANDIDATE_BYTES
		)
			throw new Error("invalid result");
		return result;
	} catch {
		throw new Error("GEPA worker returned an invalid result");
	}
};

export async function readWorkerOutput(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_WORKER_OUTPUT_BYTES) {
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
