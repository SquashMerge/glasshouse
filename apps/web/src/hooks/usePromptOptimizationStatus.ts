import * as React from "react";
import {
	getLatestPromptOptimization,
	getPromptOptimization,
	type OptimizationJob,
} from "../lib/api";

export const ACTIVE_OPTIMIZATION_STATUSES = new Set<OptimizationJob["status"]>([
	"queued",
	"preparing",
	"optimizing",
	"evaluating",
]);

export const OPTIMIZATION_SNAPSHOT_INTERVAL_MS = 5_000;
export const OPTIMIZATION_SNAPSHOT_TIMEOUT_MS = 4_000;

export function isOptimizationActive(
	status: OptimizationJob["status"] | undefined,
): boolean {
	return status !== undefined && ACTIVE_OPTIMIZATION_STATUSES.has(status);
}

type SnapshotRequest = {
	generation: number;
	jobId: string | null;
	sequence: number;
	controller: AbortController;
	dirty: boolean;
	promise: Promise<void>;
};

function message(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Optimization status could not be refreshed.";
}

export function usePromptOptimizationStatus({
	projectId,
	slug,
}: {
	projectId: string | null;
	slug: string;
}) {
	const [job, setJob] = React.useState<OptimizationJob | null>(null);
	const [loading, setLoading] = React.useState(Boolean(projectId));
	const [snapshotError, setSnapshotError] = React.useState<string | null>(null);
	const [streamError, setStreamError] = React.useState<string | null>(null);
	const jobRef = React.useRef<OptimizationJob | null>(null);
	const generationRef = React.useRef(0);
	const sequenceRef = React.useRef(0);
	const requestRef = React.useRef<SnapshotRequest | null>(null);

	const adopt = React.useCallback(
		(
			next: OptimizationJob | null,
			generation = generationRef.current,
		): void => {
			if (generation !== generationRef.current) return;
			const current = jobRef.current;
			if (
				current &&
				current.id === next?.id &&
				isOptimizationActive(current.status) === false &&
				isOptimizationActive(next?.status)
			)
				return;
			jobRef.current = next;
			setJob(next);
		},
		[],
	);

	const reconcile = React.useCallback((): Promise<void> => {
		if (!projectId) return Promise.resolve();
		const generation = generationRef.current;
		const jobId = jobRef.current?.id ?? null;
		const current = requestRef.current;
		if (current?.generation === generation && current.jobId === jobId) {
			current.dirty = true;
			return current.promise;
		}
		current?.controller.abort();
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, OPTIMIZATION_SNAPSHOT_TIMEOUT_MS);
		const sequence = sequenceRef.current + 1;
		sequenceRef.current = sequence;
		const request: SnapshotRequest = {
			generation,
			jobId,
			sequence,
			controller,
			dirty: false,
			promise: Promise.resolve(),
		};
		const promise = (async () => {
			try {
				const next = jobId
					? await getPromptOptimization({
							project_id: projectId,
							id: jobId,
							signal: controller.signal,
						})
					: await getLatestPromptOptimization({
							project_id: projectId,
							slug,
							signal: controller.signal,
						});
				if (
					generation !== generationRef.current ||
					sequence !== sequenceRef.current
				)
					return;
				if (controller.signal.aborted) {
					if (timedOut)
						setSnapshotError("Optimization status request timed out.");
					return;
				}
				setSnapshotError(null);
				adopt(next, generation);
			} catch (cause) {
				if (
					generation !== generationRef.current ||
					sequence !== sequenceRef.current
				)
					return;
				if (controller.signal.aborted && !timedOut) return;
				setSnapshotError(
					timedOut ? "Optimization status request timed out." : message(cause),
				);
			} finally {
				clearTimeout(timeout);
				if (requestRef.current !== request) return;
				requestRef.current = null;
				if (generation === generationRef.current) setLoading(false);
				if (
					request.dirty &&
					generation === generationRef.current &&
					jobRef.current?.id === jobId &&
					isOptimizationActive(jobRef.current.status)
				)
					void reconcile();
			}
		})();
		request.promise = promise;
		requestRef.current = request;
		return promise;
	}, [adopt, projectId, slug]);

	React.useEffect(() => {
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		sequenceRef.current += 1;
		requestRef.current?.controller.abort();
		requestRef.current = null;
		jobRef.current = null;
		setJob(null);
		setSnapshotError(null);
		setStreamError(null);
		setLoading(Boolean(projectId));
		if (projectId) void reconcile();
		return () => {
			if (generation !== generationRef.current) return;
			generationRef.current += 1;
			requestRef.current?.controller.abort();
			requestRef.current = null;
		};
	}, [projectId, reconcile]);

	React.useEffect(() => {
		if (!isOptimizationActive(job?.status)) return;
		const timer = setInterval(
			() => void reconcile(),
			OPTIMIZATION_SNAPSHOT_INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, [job?.id, job?.status, reconcile]);

	const adoptStartedJob = React.useCallback(
		(next: OptimizationJob): void => {
			sequenceRef.current += 1;
			requestRef.current?.controller.abort();
			requestRef.current = null;
			setSnapshotError(null);
			setStreamError(null);
			setLoading(false);
			adopt(next);
		},
		[adopt],
	);

	const reportStreamOpen = React.useCallback((): void => {
		setStreamError(null);
		void reconcile();
	}, [reconcile]);
	const reportStreamError = React.useCallback(
		(cause: unknown): void => {
			setStreamError(message(cause));
			void reconcile();
		},
		[reconcile],
	);
	const retry = React.useCallback((): void => {
		setSnapshotError(null);
		setStreamError(null);
		void reconcile();
	}, [reconcile]);

	return {
		job,
		loading,
		snapshotError,
		streamError,
		adopt,
		adoptStartedJob,
		reconcile,
		reportStreamOpen,
		reportStreamError,
		retry,
	};
}
