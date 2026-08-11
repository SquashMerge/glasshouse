const DEFAULT_EXECUTION_ADMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTION_ADMISSION_POLL_MS = 250;

export function executionAdmissionTimeoutMs(): number {
	const configured = Number(
		process.env.EXECUTION_ADMISSION_TIMEOUT_MS ??
			DEFAULT_EXECUTION_ADMISSION_TIMEOUT_MS,
	);
	return Number.isSafeInteger(configured) &&
		configured >= 1_000 &&
		configured <= 300_000
		? configured
		: DEFAULT_EXECUTION_ADMISSION_TIMEOUT_MS;
}

export function executionAdmissionPollMs(): number {
	const configured = Number(
		process.env.EXECUTION_ADMISSION_POLL_MS ??
			DEFAULT_EXECUTION_ADMISSION_POLL_MS,
	);
	return Number.isSafeInteger(configured) &&
		configured >= 50 &&
		configured <= 5_000
		? configured
		: DEFAULT_EXECUTION_ADMISSION_POLL_MS;
}

export async function invokeWithExecutionAdmission<T>(input: {
	parentSignal?: AbortSignal;
	isActive: () => Promise<boolean>;
	claimDispatch: () => Promise<boolean>;
	cancel: () => Promise<void>;
	invoke: (signal: AbortSignal) => Promise<T>;
	timeoutMs?: number;
	pollMs?: number;
}): Promise<{ admitted: true; value: T } | { admitted: false }> {
	if (input.parentSignal?.aborted || !(await input.isActive())) {
		await input.cancel();
		return { admitted: false };
	}
	// This commit is the remote-dispatch linearization point. It is deliberately
	// separate from validation so a concurrent revocation can win before invoke.
	if (input.parentSignal?.aborted || !(await input.claimDispatch())) {
		await input.cancel();
		return { admitted: false };
	}
	const controller = new AbortController();
	let abort: () => void = () => {};
	const aborted = new Promise<void>((resolve) => {
		abort = () => {
			if (!controller.signal.aborted) controller.abort();
			resolve();
		};
	});
	const onParentAbort = () => abort();
	input.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	const deadline = setTimeout(
		abort,
		input.timeoutMs ?? executionAdmissionTimeoutMs(),
	);
	const poll = setInterval(() => {
		void input.isActive().then((active) => {
			if (!active) abort();
		}, abort);
	}, input.pollMs ?? executionAdmissionPollMs());
	let invocation: Promise<T>;
	try {
		invocation = input.invoke(controller.signal);
	} catch (cause) {
		invocation = Promise.reject(cause);
	}
	void invocation.catch(() => {});
	try {
		const result = await Promise.race([
			invocation.then(
				(value) => ({ kind: "result" as const, value }),
				(cause) => ({ kind: "error" as const, cause }),
			),
			aborted.then(() => ({ kind: "aborted" as const })),
		]);
		if (result.kind === "aborted" || !(await input.isActive())) {
			await input.cancel();
			return { admitted: false };
		}
		if (result.kind === "error") throw result.cause;
		return { admitted: true, value: result.value };
	} finally {
		clearTimeout(deadline);
		clearInterval(poll);
		input.parentSignal?.removeEventListener("abort", onParentAbort);
	}
}
