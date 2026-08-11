import type { SSEStreamingApi } from "hono/streaming";
import type { Pool } from "pg";
import type { TrustedTenantContext } from "../middleware/auth.js";
import { withActiveAuthorizedProjectLock } from "../tenancy.js";

type AuthorizedSseStream = Pick<
	SSEStreamingApi,
	"abort" | "aborted" | "write" | "writeSSE"
>;

const DEFAULT_FRAME_WRITE_TIMEOUT_MS = 5_000;

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

export type AuthorizedSseDelivery = {
	deliver: (write: () => Promise<unknown>) => Promise<boolean>;
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
}): AuthorizedSseDelivery {
	const timeoutMs = input.timeoutMs ?? sseFrameWriteTimeoutMs();
	let closed = false;
	let pending = Promise.resolve();
	const close = () => {
		if (closed) return;
		closed = true;
		input.stream.abort();
		input.onClose();
	};
	const deliver = (write: () => Promise<unknown>): Promise<boolean> => {
		const current = pending.then(async () => {
			if (closed || input.stream.aborted) return false;
			let delivered = false;
			try {
				await withActiveAuthorizedProjectLock(
					input.pool(),
					{ ...input.tenant, projectId: input.projectId },
					async () => {
						if (closed || input.stream.aborted) return;
						const writePromise = Promise.resolve().then(write);
						void writePromise.catch(() => {});
						let clearWriteTimeout: (() => void) | undefined;
						const settled = await Promise.race([
							writePromise.then(
								() => true,
								() => false,
							),
							new Promise<false>((resolve) => {
								const timeout = setTimeout(resolve, timeoutMs);
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
			return delivered;
		});
		pending = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	};
	return {
		deliver,
		close,
		get closed() {
			return closed;
		},
	};
}
