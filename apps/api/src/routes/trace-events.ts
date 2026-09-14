import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { TraceIdParam } from "../schemas/common.js";
import { ErrorEnvelope } from "../schemas/common.js";
import { TraceDetailQuery, TraceEventsQuery } from "../schemas/traces.js";
import { subscribe } from "../lib/event-bus.js";
import {
	defaultClient,
	getTrace as queryGetTrace,
} from "../db/traces-query.js";
import { trustedTenant } from "../tenancy.js";
import { pgPool } from "../db/postgres.js";
import type { TrustedTenantContext } from "../middleware/auth.js";
import {
	createAuthorizedSseDelivery,
	authorizedSseFrame,
	sseFrameWriteTimeoutMs,
	sseMaxPendingBytes,
	sseMaxPendingFrames,
	type AuthorizedSseDelivery,
} from "../lib/authorized-sse.js";
import { presentObservationMetadata } from "../db/observation-metadata.js";
import { logger } from "../lib/logger.js";
import {
	fitResponseItems,
	MAX_TRACE_RESPONSE_BYTES,
	utf8ByteLength,
} from "../db/trace-payload-bounds.js";
import { encodeTraceCursor } from "../db/trace-cursor.js";
import {
	presentListObservation,
	presentListTrace,
	presentObservation,
} from "../db/trace-presentation.js";

// Read tunables once at module load so per-event work is allocation-free.
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15_000);
const GRACE_MS = Number(process.env.TRACE_COMPLETE_GRACE_MS ?? 30_000);
const sseEncoder = new TextEncoder();

function sseEventFrame(event: string, data: string): string {
	return `event: ${event}\ndata: ${data}\n\n`;
}

const tag = "traces";

const NotFoundResponse = {
	description: "Trace not found",
	content: { "application/json": { schema: ErrorEnvelope } },
};

const StreamResponse = {
	description: "SSE stream of events",
	content: { "text/event-stream": { schema: z.string() } },
};

const BadRequestResponse = {
	description: "Bad request",
	content: { "application/json": { schema: ErrorEnvelope } },
};

const InternalResponse = {
	description:
		"Trace snapshot query failed before the SSE upgrade; retry safely.",
	content: { "application/json": { schema: ErrorEnvelope } },
};

const SnapshotUnavailableResponse = {
	description:
		"Trace snapshot buffering reached its bounded limit before the SSE upgrade; retry safely.",
	content: { "application/json": { schema: ErrorEnvelope } },
};

const SnapshotTimeoutResponse = {
	description:
		"Trace snapshot did not complete before its bounded delivery deadline; retry safely.",
	content: { "application/json": { schema: ErrorEnvelope } },
};

export const streamTraceEvents = createRoute({
	method: "get",
	path: "/v1/traces/events",
	tags: [tag],
	summary: "SSE stream of newly created traces",
	description:
		"Subscribes to the `trace.created` bus event and emits one `event: trace` " +
		"SSE frame per published trace. Its trace payload uses the Trace list projection: no organization_id, input/output excerpts limited to 200 Unicode code points, and retained/excerpt truncation flags. Sends an `:ok` comment immediately on " +
		"connect, a `:heartbeat` comment every `SSE_HEARTBEAT_MS` (default 15s), " +
		"and cleans up the bus subscription on client disconnect.",
	security: [{ basicAuth: [] }],
	request: { query: TraceEventsQuery },
	responses: {
		200: StreamResponse,
		400: BadRequestResponse,
	},
});

export const streamObservationEvents = createRoute({
	method: "get",
	path: "/v1/observations/events",
	tags: [tag],
	summary: "SSE stream of newly created observations",
	description:
		"Subscribes to the `observation.created` bus event and emits one " +
		"`event: observation` SSE frame per published observation, with " +
		"the Observation list projection: no organization_id, 200-Unicode-code-point input/output excerpts with retained/excerpt truncation flags, and a 2 KiB metadata envelope with metadata_truncated when omitted. It includes a typed versioned metadata envelope and nullable prompt provenance. " +
		"Sends an `:ok` comment immediately on connect and a `:heartbeat` " +
		"comment every `SSE_HEARTBEAT_MS` (default 15s).",
	security: [{ basicAuth: [] }],
	request: { query: TraceEventsQuery },
	responses: {
		200: StreamResponse,
		400: BadRequestResponse,
	},
});

export const streamTraceDetailEvents = createRoute({
	method: "get",
	path: "/v1/traces/{id}/events",
	tags: [tag],
	summary:
		"SSE stream for a single trace: snapshot + live observations + complete",
	description:
		"Validates the trace exists (404 short-circuits BEFORE the SSE upgrade), " +
		"subscribes to `observation.created` BEFORE writing the snapshot (so any " +
		"observation created in the gap is delivered as a live event), writes an " +
		"`event: snapshot` frame with existing observations capped by the raw UTF-8 event/data SSE frame budget (the smaller of 256 KiB and `SSE_MAX_PENDING_BYTES`); " +
		"a partial snapshot has `snapshot_truncated: true` and a project- and trace-scoped `next_cursor`, then forwards " +
		"matching observations (`observation.trace_id === id` and matching project provenance) as `event: observation` " +
		"frames. Each matching observation resets a `TRACE_COMPLETE_GRACE_MS` " +
		"default-30s timer; on the timer's fire the server writes " +
		'`event: status\ndata: {"status":"complete"}` and closes the stream.',
	security: [{ basicAuth: [] }],
	request: {
		params: TraceIdParam,
		query: TraceDetailQuery.pick({ project_id: true }),
	},
	responses: {
		200: StreamResponse,
		400: BadRequestResponse,
		404: NotFoundResponse,
		500: InternalResponse,
		503: SnapshotUnavailableResponse,
		504: SnapshotTimeoutResponse,
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundResponse(traceId: string): Response {
	return new Response(
		JSON.stringify({
			code: "NOT_FOUND",
			message: `Trace ${traceId} not found`,
		}),
		{ status: 404, headers: { "content-type": "application/json" } },
	);
}

function snapshotOverflowResponse(): Response {
	return new Response(
		JSON.stringify({
			code: "SERVICE_UNAVAILABLE",
			message: "Trace snapshot is unavailable",
		}),
		{ status: 503, headers: { "content-type": "application/json" } },
	);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `GET /v1/traces/events` — one `event: trace\ndata: {trace: <TraceRow>}\n\n`
 * frame per `trace.created` bus event. Stays open until the client aborts.
 */
export type TraceEventRouteDependencies = {
	assertProjectAccess?: (
		tenant: TrustedTenantContext,
		projectId: string,
	) => Promise<void>;
	createFrameDelivery?: (
		stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
		tenant: TrustedTenantContext,
		projectId: string,
		cleanup: () => void,
	) => AuthorizedSseDelivery;
	defaultClient: typeof defaultClient;
	getTrace: typeof queryGetTrace;
	graceMs: number;
	heartbeatMs: number;
	maxPendingBytes: number;
	maxPendingFrames: number;
	snapshotTimeoutMs: number;
	subscribe: typeof subscribe;
};

const productionTraceEventRouteDependencies: TraceEventRouteDependencies = {
	createFrameDelivery: (stream, tenant, projectId, cleanup) =>
		createAuthorizedSseDelivery({
			stream,
			pool: pgPool,
			tenant,
			projectId,
			onClose: cleanup,
		}),
	defaultClient,
	getTrace: queryGetTrace,
	graceMs: GRACE_MS,
	heartbeatMs: HEARTBEAT_MS,
	maxPendingBytes: sseMaxPendingBytes(),
	maxPendingFrames: sseMaxPendingFrames(),
	snapshotTimeoutMs: sseFrameWriteTimeoutMs(),
	subscribe,
};

export function createTraceEventHandlers(
	dependencies: Partial<TraceEventRouteDependencies> = {},
) {
	const d = { ...productionTraceEventRouteDependencies, ...dependencies };
	const createFrameDelivery =
		dependencies.createFrameDelivery ??
		(dependencies.assertProjectAccess
			? (stream, tenant, projectId, cleanup) => {
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						stream.abort();
						cleanup();
					};
					return {
						deliver: async (frame) => {
							if (closed || stream.aborted) return false;
							try {
								await dependencies.assertProjectAccess!(tenant, projectId);
								await frame.write();
								return !closed && !stream.aborted;
							} catch {
								close();
								return false;
							}
						},
						close,
						get closed() {
							return closed;
						},
					};
				}
			: productionTraceEventRouteDependencies.createFrameDelivery!);
	const streamTraceEventsHandler = async (c: Context): Promise<Response> => {
		const tenant = trustedTenant(c);
		const { project_id: expectedProjectId } = (
			c.req as { valid: (target: "query") => { project_id: string } }
		).valid("query");
		return streamSSE(c, async (stream) => {
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			let unsubscribe: (() => void) | null = null;
			let resolveWait: () => void = () => undefined;
			const waitForAbort = new Promise<void>((resolve) => {
				resolveWait = resolve;
			});
			const cleanup = () => {
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				unsubscribe?.();
				unsubscribe = null;
				resolveWait();
			};
			stream.onAbort(cleanup);
			if (stream.aborted) {
				cleanup();
				return;
			}

			const frameDelivery = createFrameDelivery(
				stream,
				tenant,
				expectedProjectId,
				cleanup,
			);
			unsubscribe = d.subscribe("trace.created", (msg) => {
				const trace = msg.payload.trace;
				if (
					!trace ||
					trace.organization_id !== tenant.organizationId ||
					trace.project_id !== expectedProjectId
				)
					return;
				const data = JSON.stringify({
					trace: presentListTrace(trace),
				});
				const frame = sseEventFrame("trace", data);
				void frameDelivery.deliver(
					authorizedSseFrame(frame, () => stream.write(frame)),
				);
			});
			heartbeat = setInterval(() => {
				void frameDelivery.deliver(
					authorizedSseFrame(":heartbeat\n\n", () =>
						stream.write(":heartbeat\n\n"),
					),
				);
			}, d.heartbeatMs);

			await frameDelivery.deliver(
				authorizedSseFrame(":ok\n\n", () => stream.write(":ok\n\n")),
			);
			if (stream.aborted) cleanup();
			await waitForAbort;
		});
	};

	const streamObservationEventsHandler = async (
		c: Context,
	): Promise<Response> => {
		const tenant = trustedTenant(c);
		const { project_id: expectedProjectId } = (
			c.req as { valid: (target: "query") => { project_id: string } }
		).valid("query");
		return streamSSE(c, async (stream) => {
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			let unsubscribe: (() => void) | null = null;
			let resolveWait: () => void = () => undefined;
			const waitForAbort = new Promise<void>((resolve) => {
				resolveWait = resolve;
			});
			const cleanup = () => {
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				unsubscribe?.();
				unsubscribe = null;
				resolveWait();
			};
			stream.onAbort(cleanup);
			if (stream.aborted) {
				cleanup();
				return;
			}

			const frameDelivery = createFrameDelivery(
				stream,
				tenant,
				expectedProjectId,
				cleanup,
			);
			unsubscribe = d.subscribe("observation.created", (msg) => {
				const observation = msg.payload.observation;
				if (
					!observation ||
					observation.organization_id !== tenant.organizationId ||
					observation.project_id !== expectedProjectId
				)
					return;
				const presented = presentListObservation(
					observation,
					presentObservationMetadata,
				);
				const data = JSON.stringify({
					observation: presented,
					metadataParsed: presented.metadata,
				});
				const frame = sseEventFrame("observation", data);
				void frameDelivery.deliver(
					authorizedSseFrame(frame, () => stream.write(frame)),
				);
			});
			heartbeat = setInterval(() => {
				void frameDelivery.deliver(
					authorizedSseFrame(":heartbeat\n\n", () =>
						stream.write(":heartbeat\n\n"),
					),
				);
			}, d.heartbeatMs);

			await frameDelivery.deliver(
				authorizedSseFrame(":ok\n\n", () => stream.write(":ok\n\n")),
			);
			if (stream.aborted) cleanup();
			await waitForAbort;
		});
	};

	const streamTraceDetailEventsHandler = async (
		c: Context,
	): Promise<Response> => {
		const tenant = trustedTenant(c);
		const traceId = c.req.param("id")!;
		const { project_id: projectId } = (
			c.req as { valid: (target: "query") => { project_id?: string } }
		).valid("query");
		const expectedProjectId = projectId ?? "";
		const bufferedObservations: Array<{ frame: string; bytes: number }> = [];
		let bufferedObservationBytes = 0;
		let forwardObservation: ((frame: string) => void) | null = null;
		let unsubscribe: (() => void) | null = null;
		let preSnapshotClosed: "aborted" | "overflow" | "timeout" | null = null;
		const snapshotController = new AbortController();
		let resolvePreSnapshotClose: () => void = () => undefined;
		const preSnapshotClose = new Promise<void>((resolve) => {
			resolvePreSnapshotClose = resolve;
		});
		const cleanupPreSnapshot = (reason: "aborted" | "overflow" | "timeout") => {
			if (preSnapshotClosed) return;
			preSnapshotClosed = reason;
			snapshotController.abort();
			forwardObservation = null;
			bufferedObservationBytes = 0;
			bufferedObservations.length = 0;
			unsubscribe?.();
			unsubscribe = null;
			resolvePreSnapshotClose();
		};
		const requestSignal = c.req.raw.signal;
		const onRequestAbort = () => cleanupPreSnapshot("aborted");
		requestSignal.addEventListener("abort", onRequestAbort, { once: true });
		if (requestSignal.aborted) cleanupPreSnapshot("aborted");
		unsubscribe = d.subscribe("observation.created", (msg) => {
			if (preSnapshotClosed) return;
			const observation = msg.payload.observation;
			if (
				!observation ||
				observation.organization_id !== tenant.organizationId ||
				observation.trace_id !== traceId ||
				observation.project_id !== expectedProjectId
			)
				return;
			const data = JSON.stringify({
				observation: presentObservation(
					observation,
					presentObservationMetadata,
				),
			});
			const frame = sseEventFrame("observation", data);
			if (forwardObservation) {
				forwardObservation(frame);
				return;
			}
			const bytes = sseEncoder.encode(frame).byteLength;
			if (
				bufferedObservations.length >= d.maxPendingFrames ||
				bufferedObservationBytes + bytes > d.maxPendingBytes
			) {
				cleanupPreSnapshot("overflow");
				return;
			}
			bufferedObservationBytes += bytes;
			bufferedObservations.push({ frame, bytes });
		});

		if (preSnapshotClosed) {
			unsubscribe?.();
			return preSnapshotClosed === "overflow"
				? snapshotOverflowResponse()
				: new Response(null, { status: 499 });
		}

		const snapshot = Promise.resolve().then(() =>
			d.getTrace(
				d.defaultClient(),
				tenant.organizationId,
				traceId,
				projectId,
				snapshotController.signal,
			),
		);
		let clearSnapshotTimeout: (() => void) | undefined;
		const traceExists = await Promise.race([
			snapshot.then(
				(value) => ({ kind: "snapshot" as const, value }),
				(error) => ({ kind: "error" as const, error }),
			),
			new Promise<{ kind: "timeout" }>((resolve) => {
				const timeout = setTimeout(
					() => resolve({ kind: "timeout" }),
					d.snapshotTimeoutMs,
				);
				clearSnapshotTimeout = () => clearTimeout(timeout);
			}),
			preSnapshotClose.then(() => ({ kind: "closed" as const })),
		]);
		clearSnapshotTimeout?.();
		if (traceExists.kind === "closed") {
			requestSignal.removeEventListener("abort", onRequestAbort);
			return preSnapshotClosed === "overflow"
				? snapshotOverflowResponse()
				: new Response(null, { status: 499 });
		}
		if (traceExists.kind === "timeout") {
			cleanupPreSnapshot("timeout");
			requestSignal.removeEventListener("abort", onRequestAbort);
			return new Response(
				JSON.stringify({
					code: "GATEWAY_TIMEOUT",
					message: "Trace snapshot timed out",
				}),
				{ status: 504, headers: { "content-type": "application/json" } },
			);
		}
		if (traceExists.kind === "error") {
			cleanupPreSnapshot("aborted");
			requestSignal.removeEventListener("abort", onRequestAbort);
			logger.error("trace_events.snapshot_query_failed", traceExists.error, {
				trace_id: traceId,
				project_id: expectedProjectId,
			});
			return new Response(
				JSON.stringify({
					code: "INTERNAL",
					message: "Query failed; check server logs",
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}
		requestSignal.removeEventListener("abort", onRequestAbort);
		const snapshotResult = traceExists.value;
		if (!snapshotResult.trace) {
			unsubscribe?.();
			bufferedObservationBytes = 0;
			bufferedObservations.length = 0;
			return notFoundResponse(traceId);
		}
		const snapshotTrace = snapshotResult.trace;

		const snapshotObservations = snapshotResult.observations.map(
			(observation) =>
				presentObservation(observation, presentObservationMetadata),
		);
		const snapshotDataFor = (
			observations: ReadonlyArray<(typeof snapshotObservations)[number]>,
		) => {
			const snapshotTruncated =
				observations.length < snapshotObservations.length ||
				snapshotResult.next_cursor !== undefined;
			const last = observations.at(-1);
			return JSON.stringify({
				trace: snapshotTrace,
				observations,
				...(snapshotTruncated ? { snapshot_truncated: true } : {}),
				...(last && snapshotTruncated
					? {
							next_cursor: encodeTraceCursor(
								"trace-observations",
								expectedProjectId,
								{
									start_time: last.start_time,
									id: last.observation_id,
								},
								traceId,
							),
						}
					: {}),
			});
		};
		const maxSnapshotBytes = Math.min(
			MAX_TRACE_RESPONSE_BYTES,
			d.maxPendingBytes,
		);
		const boundedSnapshot = fitResponseItems(
			snapshotObservations,
			(observations) =>
				sseEventFrame("snapshot", snapshotDataFor(observations)),
			maxSnapshotBytes,
		);
		const snapshotData = snapshotDataFor(boundedSnapshot.items);
		const snapshotFrame = sseEventFrame("snapshot", snapshotData);
		if (
			utf8ByteLength(snapshotFrame) > maxSnapshotBytes ||
			(snapshotObservations.length > 0 && boundedSnapshot.items.length === 0)
		) {
			unsubscribe?.();
			return snapshotOverflowResponse();
		}
		return streamSSE(c, async (stream) => {
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			let graceTimer: ReturnType<typeof setTimeout> | null = null;
			let closed = false;
			let cleaned = false;
			let resolveWait: () => void = () => undefined;
			const waitForClose = new Promise<void>((resolve) => {
				resolveWait = resolve;
			});
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				closed = true;
				if (graceTimer !== null) clearTimeout(graceTimer);
				graceTimer = null;
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				forwardObservation = null;
				bufferedObservationBytes = 0;
				bufferedObservations.length = 0;
				unsubscribe?.();
				unsubscribe = null;
				resolveWait();
			};
			stream.onAbort(cleanup);
			if (stream.aborted) {
				cleanup();
				return;
			}

			const frameDelivery = createFrameDelivery(
				stream,
				tenant,
				expectedProjectId,
				cleanup,
			);
			heartbeat = setInterval(() => {
				void frameDelivery.deliver(
					authorizedSseFrame(":heartbeat\n\n", () =>
						stream.write(":heartbeat\n\n"),
					),
				);
			}, d.heartbeatMs);
			await frameDelivery.deliver(
				authorizedSseFrame(":ok\n\n", () => stream.write(":ok\n\n")),
			);
			if (stream.aborted) {
				cleanup();
				return;
			}

			const armGraceTimer = () => {
				if (graceTimer !== null) clearTimeout(graceTimer);
				graceTimer = setTimeout(() => {
					if (closed) return;
					closed = true;
					const data = JSON.stringify({ status: "complete" });
					const frame = sseEventFrame("status", data);
					void frameDelivery
						.deliver(authorizedSseFrame(frame, () => stream.write(frame)))
						.finally(cleanup);
				}, d.graceMs);
			};
			const sendObservation = (frame: string) => {
				if (closed) return;
				armGraceTimer();
				void frameDelivery.deliver(
					authorizedSseFrame(frame, () => stream.write(frame)),
				);
			};

			await frameDelivery.deliver(
				authorizedSseFrame(snapshotFrame, () => stream.write(snapshotFrame)),
			);
			if (frameDelivery.closed || stream.aborted) {
				cleanup();
				return;
			}
			forwardObservation = sendObservation;
			for (const observation of bufferedObservations.splice(0)) {
				bufferedObservationBytes -= observation.bytes;
				sendObservation(observation.frame);
			}
			armGraceTimer();
			await waitForClose;
		});
	};

	return {
		handleStreamObservationEvents: streamObservationEventsHandler,
		handleStreamTraceDetailEvents: streamTraceDetailEventsHandler,
		handleStreamTraceEvents: streamTraceEventsHandler,
	};
}

export const {
	handleStreamObservationEvents,
	handleStreamTraceDetailEvents,
	handleStreamTraceEvents,
} = createTraceEventHandlers();
