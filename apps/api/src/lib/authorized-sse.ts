import type { SSEStreamingApi } from "hono/streaming";
import type { Pool } from "pg";
import type { TrustedTenantContext } from "../middleware/auth.js";
import { withActiveAuthorizedProjectLock } from "../tenancy.js";

type AuthorizedSseStream = Pick<
	SSEStreamingApi,
	"abort" | "aborted" | "onAbort" | "write" | "writeSSE"
>;

const DEFAULT_FRAME_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_FRAMES = 32;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024;

export function sseFrameWriteTimeoutMs(): number {
	const configured = Number(
		process.env.SSE_FRAME_WRITE_TIMEOUT_MS ?? DEFAULT_FRAME_WRITE_TIMEOUT_MS,
	);
	return Number.isSafeInteger(configured) &&
		configured >= 100 &&
		configured <= 60_000
		? configured
		: DEFAULT_FRAME_WRITE_TIMEOUT_MS;
}

export function sseMaxPendingFrames(): number {
	const configured = Number(
		process.env.SSE_MAX_PENDING_FRAMES ?? DEFAULT_MAX_PENDING_FRAMES,
	);
	return Number.isSafeInteger(configured) &&
		configured >= 1 &&
		configured <= 256
		? configured
		: DEFAULT_MAX_PENDING_FRAMES;
}

export function sseMaxPendingBytes(): number {
	const configured = Number(
		process.env.SSE_MAX_PENDING_BYTES ?? DEFAULT_MAX_PENDING_BYTES,
	);
	return Number.isSafeInteger(configured) &&
		configured >= 1_024 &&
		configured <= 1_048_576
		? configured
		: DEFAULT_MAX_PENDING_BYTES;
}

export type AuthorizedSseFrame = {
	bytes: number;
	write: () => Promise<unknown>;
};

export function authorizedSseFrame(
	payload: string,
	write: () => Promise<unknown>,
): AuthorizedSseFrame {
	return { bytes: new TextEncoder().encode(payload).byteLength, write };
}

export type AuthorizedSseDelivery = {
	deliver: (frame: AuthorizedSseFrame) => Promise<boolean>;
	close: () => void;
	readonly closed: boolean;
};

/**
 * Serializes every frame through a short project/membership authorization fence.
 * A write that outlives the configured bound is abandoned after stream abort; the
 * late promise is observed so it cannot retain the transaction or reject unseen.
 */
export function createAuthorizedSseDelivery(input: {
	stream: AuthorizedSseStream;
	pool: () => Pick<Pool, "connect">;
	tenant: TrustedTenantContext;
	projectId: string;
	onClose: () => void;
	timeoutMs?: number;
	maxPendingFrames?: number;
	maxPendingBytes?: number;
}): AuthorizedSseDelivery {
	const timeoutMs = input.timeoutMs ?? sseFrameWriteTimeoutMs();
	const maxPendingFrames = input.maxPendingFrames ?? sseMaxPendingFrames();
	const maxPendingBytes = input.maxPendingBytes ?? sseMaxPendingBytes();
	let closed = false;
	let writing = false;
	let pendingBytes = 0;
	const pending: Array<{
		frame: AuthorizedSseFrame;
		resolve: (delivered: boolean) => void;
	}> = [];
	let resolveClosed: () => void = () => undefined;
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const close = () => {
		if (closed) return;
		closed = true;
		resolveClosed();
		for (const item of pending.splice(0)) {
			pendingBytes -= item.frame.bytes;
			item.resolve(false);
		}
		input.stream.abort();
		input.onClose();
	};
	input.stream.onAbort(close);
	const pump = () => {
		if (writing || closed) return;
		const item = pending.shift();
		if (!item) return;
		writing = true;
		void (async () => {
			let delivered = false;
			try {
				await withActiveAuthorizedProjectLock(
					input.pool(),
					{ ...input.tenant, projectId: input.projectId },
					async () => {
						if (closed || input.stream.aborted) return;
						const writePromise = Promise.resolve().then(item.frame.write);
						void writePromise.catch(() => {});
						let clearWriteTimeout: (() => void) | undefined;
						const settled = await Promise.race([
							writePromise.then(
								() => true,
								() => false,
							),
							closedPromise.then(() => false),
							new Promise<false>((resolve) => {
								const timeout = setTimeout(() => resolve(false), timeoutMs);
								clearWriteTimeout = () => clearTimeout(timeout);
							}),
						]);
						clearWriteTimeout?.();
						delivered = settled && !closed && !input.stream.aborted;
						if (!delivered) close();
					},
					"product_read",
					timeoutMs,
				);
			} catch {
				close();
			}
			pendingBytes -= item.frame.bytes;
			item.resolve(delivered);
			writing = false;
			if (delivered) pump();
		})();
	};
	const deliver = (frame: AuthorizedSseFrame): Promise<boolean> => {
		if (
			closed ||
			input.stream.aborted ||
			!Number.isSafeInteger(frame.bytes) ||
			frame.bytes < 0 ||
			(writing ? 1 : 0) + pending.length >= maxPendingFrames ||
			pendingBytes + frame.bytes > maxPendingBytes
		) {
			close();
			return Promise.resolve(false);
		}
		pendingBytes += frame.bytes;
		const delivered = new Promise<boolean>((resolve) => {
			pending.push({ frame, resolve });
		});
		pump();
		return delivered;
	};
	return {
		deliver,
		close,
		get closed() {
			return closed;
		},
	};
}
