import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { TraceIdParam } from "../schemas/common.js";
import { ErrorEnvelope } from "../schemas/common.js";
import { TraceDetailQuery } from "../schemas/traces.js";
import { subscribe } from "../lib/event-bus.js";
import {
	defaultClient,
	getTrace as queryGetTrace,
} from "../db/traces-query.js";
import type { TenantScopedObservation } from "../db/traces-writer.js";
import { trustedTenant } from "../tenancy.js";
import {
	presentObservationMetadata,
	type ObservationMetadata,
} from "../db/observation-metadata.js";

// Read tunables once at module load so per-event work is allocation-free.
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15_000);
const GRACE_MS = Number(process.env.TRACE_COMPLETE_GRACE_MS ?? 30_000);

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

export const streamTraceEvents = createRoute({
	method: "get",
	path: "/v1/traces/events",
	tags: [tag],
	summary: "SSE stream of newly created traces",
	description:
		"Subscribes to the `trace.created` bus event and emits one `event: trace` " +
		"SSE frame per published trace. Sends an `:ok` comment immediately on " +
		"connect, a `:heartbeat` comment every `SSE_HEARTBEAT_MS` (default 15s), " +
		"and cleans up the bus subscription on client disconnect.",
	security: [{ basicAuth: [] }],
	responses: {
		200: StreamResponse,
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
		"a typed versioned metadata envelope and nullable prompt provenance. " +
		"Sends an `:ok` comment immediately on connect and a `:heartbeat` " +
		"comment every `SSE_HEARTBEAT_MS` (default 15s).",
	security: [{ basicAuth: [] }],
	responses: {
		200: StreamResponse,
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
		"`event: snapshot` frame with the existing observations, then forwards " +
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
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize storage and live observations to the same external metadata
 * envelope. Invalid persisted metadata intentionally fails closed.
 */
function presentObservation<
	T extends { type: string; metadata: string | ObservationMetadata },
>(observation: T) {
	return {
		...observation,
		metadata: presentObservationMetadata(
			observation.metadata,
			observation.type === "generation",
		),
	};
}

function notFoundResponse(traceId: string): Response {
	return new Response(
		JSON.stringify({
			code: "NOT_FOUND",
			message: `Trace ${traceId} not found`,
		}),
		{ status: 404, headers: { "content-type": "application/json" } },
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
	defaultClient: typeof defaultClient;
	getTrace: typeof queryGetTrace;
	graceMs: number;
	heartbeatMs: number;
	subscribe: typeof subscribe;
};

const productionTraceEventRouteDependencies: TraceEventRouteDependencies = {
	defaultClient,
	getTrace: queryGetTrace,
	graceMs: GRACE_MS,
	heartbeatMs: HEARTBEAT_MS,
	subscribe,
};

export function createTraceEventHandlers(
	dependencies: TraceEventRouteDependencies = productionTraceEventRouteDependencies,
) {
	const streamTraceEventsHandler = async (c: Context): Promise<Response> => {
		const tenant = trustedTenant(c);
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

			unsubscribe = dependencies.subscribe("trace.created", (msg) => {
				const trace = msg.payload.trace;
				if (!trace || trace.organization_id !== tenant.organizationId) return;
				void stream.writeSSE({
					event: "trace",
					data: JSON.stringify({ trace }),
				});
			});
			heartbeat = setInterval(() => {
				void stream.write(":heartbeat\n\n");
			}, dependencies.heartbeatMs);

			await stream.write(":ok\n\n");
			if (stream.aborted) cleanup();
			await waitForAbort;
		});
	};

	const streamObservationEventsHandler = async (
		c: Context,
	): Promise<Response> => {
		const tenant = trustedTenant(c);
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

			unsubscribe = dependencies.subscribe("observation.created", (msg) => {
				const observation = msg.payload.observation;
				if (
					!observation ||
					observation.organization_id !== tenant.organizationId
				)
					return;
				const presented = presentObservation(observation);
				void stream.writeSSE({
					event: "observation",
					data: JSON.stringify({
						observation: presented,
						metadataParsed: presented.metadata,
					}),
				});
			});
			heartbeat = setInterval(() => {
				void stream.write(":heartbeat\n\n");
			}, dependencies.heartbeatMs);

			await stream.write(":ok\n\n");
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
		const bufferedObservations: TenantScopedObservation[] = [];
		let forwardObservation:
			| ((observation: TenantScopedObservation) => void)
			| null = null;
		const unsubscribe = dependencies.subscribe("observation.created", (msg) => {
			const observation = msg.payload.observation;
			if (
				!observation ||
				observation.organization_id !== tenant.organizationId ||
				observation.trace_id !== traceId ||
				observation.project_id !== expectedProjectId
			)
				return;
			if (forwardObservation) forwardObservation(observation);
			else bufferedObservations.push(observation);
		});

		let traceExists: Awaited<ReturnType<typeof queryGetTrace>>;
		try {
			traceExists = await dependencies.getTrace(
				dependencies.defaultClient(),
				tenant.organizationId,
				traceId,
				projectId,
			);
		} catch (err) {
			unsubscribe();
			console.error(
				`GET /v1/traces/{id}/events snapshot query failed:`,
				(err as Error).message,
			);
			return new Response(
				JSON.stringify({
					code: "INTERNAL",
					message: "Query failed; check server logs",
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}
		if (!traceExists.trace) {
			unsubscribe();
			return notFoundResponse(traceId);
		}
		const snapshotTrace = traceExists.trace;

		const snapshotObservations =
			traceExists.observations.map(presentObservation);
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
				unsubscribe();
				resolveWait();
			};
			stream.onAbort(cleanup);
			if (stream.aborted) {
				cleanup();
				return;
			}

			heartbeat = setInterval(() => {
				void stream.write(":heartbeat\n\n");
			}, dependencies.heartbeatMs);
			await stream.write(":ok\n\n");
			if (stream.aborted) {
				cleanup();
				return;
			}

			const armGraceTimer = () => {
				if (graceTimer !== null) clearTimeout(graceTimer);
				graceTimer = setTimeout(() => {
					if (closed) return;
					closed = true;
					void stream
						.writeSSE({
							event: "status",
							data: JSON.stringify({ status: "complete" }),
						})
						.finally(cleanup);
				}, dependencies.graceMs);
			};
			const sendObservation = (observation: TenantScopedObservation) => {
				if (closed) return;
				armGraceTimer();
				void stream.writeSSE({
					event: "observation",
					data: JSON.stringify({
						observation: presentObservation(observation),
					}),
				});
			};

			await stream.writeSSE({
				event: "snapshot",
				data: JSON.stringify({
					trace: snapshotTrace,
					observations: snapshotObservations,
				}),
			});
			forwardObservation = sendObservation;
			for (const observation of bufferedObservations.splice(0))
				sendObservation(observation);
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
