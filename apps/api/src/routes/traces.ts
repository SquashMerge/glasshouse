import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
	Trace,
	TraceList,
	TraceStubResponses,
	Observation,
	ObservationList,
	TraceDetailQuery,
	TraceListQuery,
} from "../schemas/traces.js";
import { ErrorEnvelope, TraceIdParam } from "../schemas/common.js";
import {
	defaultClient,
	getTrace as queryGetTrace,
	listTraces as queryListTraces,
	listObservations as queryListObservations,
} from "../db/traces-query.js";
import {
	presentObservationMetadata,
	type ObservationMetadata,
} from "../db/observation-metadata.js";
import { trustedTenant } from "../tenancy.js";
import {
	fitResponseItems,
	MAX_TRACE_RESPONSE_BYTES,
	utf8ByteLength,
} from "../db/trace-payload-bounds.js";
import {
	decodeTraceCursor,
	encodeTraceCursor,
	InvalidTraceCursorError,
} from "../db/trace-cursor.js";

function presentObservation<
	T extends {
		type: string;
		metadata: string | ObservationMetadata;
		start_time: string;
		end_time: string | null;
	},
>(observation: T) {
	return {
		...observation,
		start_time: presentTimestamp(observation.start_time),
		end_time: observation.end_time
			? presentTimestamp(observation.end_time)
			: null,
		metadata: presentObservationMetadata(
			observation.metadata,
			observation.type === "generation",
		),
	};
}

function presentTrace<
	T extends { start_time: string; end_time: string | null },
>(trace: T) {
	return {
		...trace,
		start_time: presentTimestamp(trace.start_time),
		end_time: trace.end_time ? presentTimestamp(trace.end_time) : null,
	};
}

function presentTimestamp(value: string): string {
	if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return value;
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(
		value,
	);
	return match ? `${match[1]}T${match[2]}Z` : value;
}

function getPagination(c: Context): {
	limit: number;
	cursor?: string;
	offset: number;
	projectId?: string;
} {
	const {
		limit: requestedLimit = 50,
		cursor,
		offset = 0,
		project_id: projectId,
	} = (
		c.req as {
			valid: (target: "query") => {
				limit?: number;
				cursor?: string;
				offset?: number;
				project_id?: string;
			};
		}
	).valid("query");
	return { limit: Math.min(requestedLimit, 200), cursor, offset, projectId };
}

function boundedListResponse<T extends { start_time: string }>(
	c: Context,
	items: readonly T[],
	total: number,
	nextCursor: { start_time: string; id: string } | undefined,
	cursorKind: "traces" | "observations",
	projectId: string,
	itemId: (item: T) => string,
) {
	const responseFor = (candidate: readonly T[]) => {
		const responseTruncated = candidate.length < items.length;
		const last = candidate.at(-1);
		const pageCursor = responseTruncated
			? last
				? { start_time: last.start_time, id: itemId(last) }
				: undefined
			: nextCursor;
		return {
			items: candidate,
			total,
			...(responseTruncated ? { response_truncated: true } : {}),
			...(pageCursor
				? { next_cursor: encodeTraceCursor(cursorKind, projectId, pageCursor) }
				: {}),
		};
	};
	const bounded = fitResponseItems(items, responseFor);
	const response = responseFor(bounded.items);
	if (
		(items.length > 0 && bounded.items.length === 0) ||
		utf8ByteLength(JSON.stringify(response)) > MAX_TRACE_RESPONSE_BYTES
	) {
		return c.json(
			{ code: "PAYLOAD_TOO_LARGE", message: "Response exceeds byte limit" },
			413,
		);
	}
	return c.json(response);
}

export const listTraces = createRoute({
	method: "get",
	path: "/v1/traces",
	tags: ["traces"],
	summary: "List traces",
	description:
		"Returns a project-scoped page sorted by start_time DESC, trace_id DESC. limit defaults to 50, accepts zero, and clamps values above 200; malformed, fractional, or negative limits return 400. v1 offset pagination remains supported; use the opaque next_cursor keyset continuation for new clients and do not combine it with a positive offset. The raw UTF-8 JSON body is capped at 256 KiB; a byte-truncated page carries response_truncated and next_cursor. Input and output excerpts are limited to 200 Unicode code points; the retained and excerpt truncation flags distinguish storage clipping from list presentation.",
	security: [{ basicAuth: [] }],
	request: { query: TraceListQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: TraceList } },
		},
		400: {
			description: "Invalid pagination parameters",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		413: {
			description: "A response cannot fit within the raw UTF-8 byte limit",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		...TraceStubResponses,
	},
});

export async function handleListTraces(c: Context): Promise<Response> {
	const { limit, cursor: encodedCursor, offset, projectId } = getPagination(c);
	const q = c.req.query("filter[q]");
	const filters = {
		organization_id: trustedTenant(c).organizationId,
		project_id: projectId,
		agent_id: c.req.query("filter[agent_id]") ?? undefined,
		env: c.req.query("filter[env]") ?? undefined,
		time_from: c.req.query("filter[time.from]") ?? undefined,
		time_to: c.req.query("filter[time.to]") ?? undefined,
		name: c.req.query("filter[name]") ?? undefined,
		status: c.req.query("filter[status]") ?? undefined,
		duration: c.req.query("filter[duration]") ?? undefined,
		scores: c.req.query("filter[scores]") ?? undefined,
		input_text: q ?? c.req.query("filter[input_text]") ?? undefined,
	};
	try {
		const cursor = decodeTraceCursor(encodedCursor, "traces", projectId!);
		const { items, total, next_cursor } = await queryListTraces(
			defaultClient(),
			filters,
			limit,
			cursor,
			offset,
		);
		const presented = items.map(presentTrace);
		return boundedListResponse(
			c,
			presented,
			total,
			next_cursor,
			"traces",
			projectId!,
			(trace) => trace.trace_id,
		);
	} catch (err) {
		if (err instanceof InvalidTraceCursorError)
			return c.json({ code: "BAD_REQUEST", message: err.message }, 400);
		console.error("GET /v1/traces failed:", (err as Error).message);
		return c.json(
			{ code: "INTERNAL", message: "Query failed; check server logs" },
			500,
		);
	}
}

export const getTrace = createRoute({
	method: "get",
	path: "/v1/traces/{id}",
	tags: ["traces"],
	summary: "Get a trace",
	description:
		"Fetch a project- and trace-scoped observation page in stable start_time, observation_id order. The embedded trace input/output remain 200-Unicode-code-point excerpts; each observation detail field contains the full retained value, capped at 8 KiB UTF-8, and truncation flags report source or legacy read-time clipping. The raw UTF-8 JSON body is capped at 256 KiB; response_truncated and a project- and trace-scoped next_cursor preserve byte-truncated continuation. Legacy metadata arrays are exposed as attributes with null prompt provenance, while invalid or oversized persisted metadata fails closed.",
	security: [{ basicAuth: [] }],
	request: {
		params: TraceIdParam,
		query: TraceDetailQuery,
	},
	responses: {
		200: {
			description: "OK",
			content: {
				"application/json": {
					schema: z.object({
						trace: Trace,
						observations: z.array(Observation),
						response_truncated: z.boolean().optional(),
						next_cursor: z.string().optional(),
					}),
				},
			},
		},
		404: {
			description: "Trace not found",
			content: {
				"application/json": {
					schema: {
						type: "object",
						properties: {
							code: { type: "string" },
							message: { type: "string" },
						},
					},
				},
			},
		},
		400: {
			description: "Missing or invalid project_id",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		413: {
			description: "A response cannot fit within the raw UTF-8 byte limit",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
	},
});

export async function handleGetTrace(c: Context): Promise<Response> {
	const traceId = c.req.param("id")!;
	const { project_id: projectId, cursor: encodedCursor } = (
		c.req as {
			valid: (target: "query") => { project_id: string; cursor?: string };
		}
	).valid("query");
	try {
		const cursor = decodeTraceCursor(
			encodedCursor,
			"trace-observations",
			projectId,
			traceId,
		);
		const { trace, observations, next_cursor } = cursor
			? await queryGetTrace(
					defaultClient(),
					trustedTenant(c).organizationId,
					traceId,
					projectId,
					undefined,
					cursor,
				)
			: await queryGetTrace(
					defaultClient(),
					trustedTenant(c).organizationId,
					traceId,
					projectId,
				);
		if (!trace) {
			return c.json(
				{ code: "NOT_FOUND", message: `Trace ${traceId} not found` },
				404,
			);
		}
		const presentedTrace = presentTrace(trace);
		const presentedObservations = observations.map(presentObservation);
		const responseFor = (
			candidate: ReadonlyArray<(typeof presentedObservations)[number]>,
		) => {
			const responseTruncated = candidate.length < presentedObservations.length;
			const hasMore = responseTruncated || next_cursor !== undefined;
			const last = candidate.at(-1);
			return {
				trace: presentedTrace,
				observations: candidate,
				...(responseTruncated ? { response_truncated: true } : {}),
				...(last && hasMore
					? {
							next_cursor: encodeTraceCursor(
								"trace-observations",
								projectId,
								{
									start_time: last.start_time,
									id: last.observation_id,
								},
								traceId,
							),
						}
					: {}),
			};
		};
		const bounded = fitResponseItems(
			presentedObservations,
			responseFor,
			MAX_TRACE_RESPONSE_BYTES,
		);
		const response = responseFor(bounded.items);
		if (
			(presentedObservations.length > 0 && bounded.items.length === 0) ||
			utf8ByteLength(JSON.stringify(response)) > MAX_TRACE_RESPONSE_BYTES
		) {
			return c.json(
				{ code: "PAYLOAD_TOO_LARGE", message: "Response exceeds byte limit" },
				413,
			);
		}
		return c.json(response);
	} catch (err) {
		if (err instanceof InvalidTraceCursorError)
			return c.json({ code: "BAD_REQUEST", message: err.message }, 400);
		console.error("GET /v1/traces/{id} failed:", (err as Error).message);
		return c.json(
			{ code: "INTERNAL", message: "Query failed; check server logs" },
			500,
		);
	}
}

export const listObservations = createRoute({
	method: "get",
	path: "/v1/observations",
	tags: ["traces"],
	summary: "List observations (spans)",
	description:
		"Returns a project-scoped page sorted by start_time DESC, observation_id DESC. limit defaults to 50, accepts zero, and clamps values above 200; malformed, fractional, or negative limits return 400. v1 offset pagination remains supported; use the opaque next_cursor keyset continuation for new clients and do not combine it with a positive offset. The raw UTF-8 JSON body is capped at 256 KiB; a byte-truncated page carries response_truncated and next_cursor. Input and output excerpts are limited to 200 Unicode code points; the retained and excerpt truncation flags distinguish storage clipping from list presentation.",
	security: [{ basicAuth: [] }],
	request: { query: TraceListQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: ObservationList } },
		},
		400: {
			description: "Invalid pagination parameters",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		413: {
			description: "A response cannot fit within the raw UTF-8 byte limit",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		...TraceStubResponses,
	},
});

export async function handleListObservations(c: Context): Promise<Response> {
	const { limit, cursor: encodedCursor, offset, projectId } = getPagination(c);
	const filters = {
		organization_id: trustedTenant(c).organizationId,
		project_id: projectId,
		agent_id: c.req.query("filter[agent_id]") ?? undefined,
		trace_id: c.req.query("filter[trace_id]") ?? undefined,
		type: c.req.query("filter[type]") ?? undefined,
		time_from: c.req.query("filter[time.from]") ?? undefined,
		time_to: c.req.query("filter[time.to]") ?? undefined,
		name: c.req.query("filter[name]") ?? undefined,
		status: c.req.query("filter[status]") ?? undefined,
		duration: c.req.query("filter[duration]") ?? undefined,
		model: c.req.query("filter[model]") ?? undefined,
		input_text: c.req.query("filter[input_text]") ?? undefined,
	};
	try {
		const cursor = decodeTraceCursor(encodedCursor, "observations", projectId!);
		const { items, total, next_cursor } = await queryListObservations(
			defaultClient(),
			filters,
			limit,
			cursor,
			offset,
		);
		const presented = items.map(presentObservation);
		return boundedListResponse(
			c,
			presented,
			total,
			next_cursor,
			"observations",
			projectId!,
			(observation) => observation.observation_id,
		);
	} catch (err) {
		if (err instanceof InvalidTraceCursorError)
			return c.json({ code: "BAD_REQUEST", message: err.message }, 400);
		console.error("GET /v1/observations failed:", (err as Error).message);
		return c.json(
			{ code: "INTERNAL", message: "Query failed; check server logs" },
			500,
		);
	}
}
