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
} from "../schemas/traces.js";
import { ErrorEnvelope, PageQuery, TraceIdParam } from "../schemas/common.js";
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

function getPagination(c: Context): { limit: number; offset: number } {
	const { limit: requestedLimit = 50, offset = 0 } = (
		c.req as { valid: (target: "query") => { limit?: number; offset?: number } }
	).valid("query");
	return { limit: Math.min(requestedLimit, 200), offset };
}

export const listTraces = createRoute({
	method: "get",
	path: "/v1/traces",
	tags: ["traces"],
	summary: "List traces",
	description:
		"Returns up to 50 traces sorted by start_time DESC. Each row's input_text is truncated to 200 chars.",
	security: [{ basicAuth: [] }],
	request: { query: PageQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: TraceList } },
		},
		400: {
			description: "Invalid pagination parameters",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		...TraceStubResponses,
	},
});

export async function handleListTraces(c: Context): Promise<Response> {
	const { limit, offset } = getPagination(c);
	const q = c.req.query("filter[q]");
	const filters = {
		organization_id: trustedTenant(c).organizationId,
		project_id: c.req.query("filter[project_id]") ?? undefined,
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
		const { items, total } = await queryListTraces(
			defaultClient(),
			filters,
			limit,
			offset,
		);
		return c.json({ items: items.map(presentTrace), total });
	} catch (err) {
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
		"Fetch a project-scoped trace and its observations with versioned metadata envelopes. Omitting project_id reads only legacy unscoped rows. Legacy metadata arrays are exposed as attributes with null prompt provenance; invalid persisted metadata fails closed.",
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
	},
});

export async function handleGetTrace(c: Context): Promise<Response> {
	const traceId = c.req.param("id")!;
	const { project_id: projectId } = (
		c.req as { valid: (target: "query") => { project_id?: string } }
	).valid("query");
	try {
		const { trace, observations } = await queryGetTrace(
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
		return c.json({
			trace: presentTrace(trace),
			observations: observations.map(presentObservation),
		});
	} catch (err) {
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
		"Returns up to 50 observations per page sorted by start_time DESC. input_text is truncated to 200 chars.",
	security: [{ basicAuth: [] }],
	request: { query: PageQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: ObservationList } },
		},
		400: {
			description: "Invalid pagination parameters",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		...TraceStubResponses,
	},
});

export async function handleListObservations(c: Context): Promise<Response> {
	const { limit, offset } = getPagination(c);
	const filters = {
		organization_id: trustedTenant(c).organizationId,
		project_id: c.req.query("filter[project_id]") ?? undefined,
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
		const { items, total } = await queryListObservations(
			defaultClient(),
			filters,
			limit,
			offset,
		);
		return c.json({ items: items.map(presentObservation), total });
	} catch (err) {
		console.error("GET /v1/observations failed:", (err as Error).message);
		return c.json(
			{ code: "INTERNAL", message: "Query failed; check server logs" },
			500,
		);
	}
}
