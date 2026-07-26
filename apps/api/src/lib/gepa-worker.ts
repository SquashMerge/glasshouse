export type GepaWorkerInput = {
	target: "system" | "user";
	source: string;
	evaluator: Record<string, unknown>;
	examples: unknown[];
	model_config: Record<string, unknown>;
	budget: Record<string, unknown>;
};

export type GepaWorkerResult = { candidate: string; score?: number };
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
		new Response(child.stdout).text(),
		child.exited,
	]);
	// Worker stderr can contain provider diagnostics; never surface it through jobs or SSE.
	if (exitCode !== 0) throw new Error("GEPA worker failed");
	try {
		const result = JSON.parse(stdout) as GepaWorkerResult;
		if (!result || typeof result.candidate !== "string")
			throw new Error("invalid result");
		return result;
	} catch {
		throw new Error("GEPA worker returned an invalid result");
	}
};
