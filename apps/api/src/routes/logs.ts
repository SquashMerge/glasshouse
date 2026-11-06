import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ExportLogsRequest, LogList, LogListQuery } from "../schemas/logs.js";
import { OtlpError } from "../schemas/otlp.js";
import { ErrorEnvelope } from "../schemas/common.js";
import {
	decodeLogExport,
	normalizeLogFields,
	redactLogAttributes,
	redactLogValue,
} from "../lib/otlp-logs.js";
import {
	otlpErrorResponse,
	otlpSuccessResponse,
} from "../lib/otlp-response.js";
import { parseBodySizeLimit } from "../middleware/body-size.js";
import { approvedRedaction } from "../db/governance.js";
import { resourceProjectId } from "../db/gen-ai-attrs.js";
import { policyRedactionOptions, REDACTED } from "../db/redact.js";
import { ch } from "../db/clickhouse.js";
import {
	insertLogs,
	InvalidLogCursor,
	listLogs,
	MAX_LOG_RECORD_BYTES,
	type ScopedLog,
} from "../db/logs.js";
import { pgPool } from "../db/postgres.js";
import {
	resolveTenantProject,
	TenantScopeError,
	trustedTenant,
	withActiveAuthorizedProjectLock,
} from "../tenancy.js";
import { logger } from "../lib/logger.js";
import { isTransientStorageFailure } from "../lib/transient-storage-error.js";
import { AuthenticationError } from "../db/local-sessions.js";

const binary = z.string().openapi({ type: "string", format: "binary" });
const exportResponse = z.object({}).openapi("ExportLogsServiceResponse");
const errorContent = {
	"application/json": { schema: OtlpError },
	"application/x-protobuf": { schema: binary },
};
export const ingestLogsRoute = createRoute({
	method: "post",
	path: "/v1/logs",
	tags: ["otlp"],
	summary: "OTLP HTTP log ingest",
	description:
		"Accepts JSON/protobuf, optionally gzip. Exports are atomic on validation, limited to 2,000 records, 512 per scope, 128 attributes per record, 32 known-message nesting levels and 64 KiB per retained record. Decimal nanosecond timestamps and AnyValue types are preserved. Requires an explicit Project header; payload provenance cannot override it.",
	security: [
		{ sessionCookie: [], csrfHeader: [] },
		{ basicAuth: [] },
		{ bearerAuth: [] },
	],
	request: {
		headers: z.object({ "x-glasshouse-project-id": z.string().uuid() }),
		body: {
			required: true,
			content: {
				"application/json": { schema: ExportLogsRequest },
				"application/x-protobuf": { schema: binary },
				"application/protobuf": { schema: binary },
			},
		},
	},
	responses: {
		200: {
			description: "Logs accepted",
			content: {
				"application/json": { schema: exportResponse },
				"application/x-protobuf": { schema: binary },
			},
		},
		400: { description: "Invalid log export", content: errorContent },
		401: { description: "Authentication required", content: errorContent },
		403: { description: "Origin or CSRF rejected", content: errorContent },
		404: { description: "Project unavailable", content: errorContent },
		413: { description: "Export exceeds byte limit", content: errorContent },
		415: {
			description: "Unsupported media or encoding",
			content: errorContent,
		},
		500: { description: "Log export failed", content: errorContent },
		503: {
			description: "Log export temporarily unavailable",
			content: errorContent,
		},
	},
});

export async function handleIngestLogs(c: Context): Promise<Response> {
	const req = c.req.raw;
	try {
		const tenant = trustedTenant(c);
		const header = c.req.header("x-glasshouse-project-id");
		if (!header || !z.string().uuid().safeParse(header).success)
			throw new TenantScopeError("Project unavailable");
		const projectId = header.toLowerCase();
		const url = new URL(req.url);
		if (
			[
				...url.searchParams.getAll("project_id"),
				...url.searchParams.getAll("filter[project_id]"),
			].some((value) => value.toLowerCase() !== projectId) ||
			(tenant.ingestCredential &&
				tenant.ingestCredential.projectId !== projectId)
		)
			throw new TenantScopeError("Project unavailable");
		const scope = await resolveTenantProject(
			pgPool(),
			tenant,
			projectId,
			"ingest",
		);
		const type =
			req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
			"application/json";
		if (
			![
				"application/json",
				"application/x-protobuf",
				"application/protobuf",
			].includes(type)
		)
			return otlpErrorResponse(req, 415);
		const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
		if (encoding && encoding !== "gzip" && encoding !== "identity")
			return otlpErrorResponse(req, 415);
		const limit = parseBodySizeLimit(process.env.API_MAX_BODY_BYTES);
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await req.arrayBuffer());
			if (bytes.byteLength > limit) return otlpErrorResponse(req, 413);
			if (encoding === "gzip")
				bytes = gunzipSync(bytes, { maxOutputLength: limit });
		} catch (error) {
			return otlpErrorResponse(
				req,
				(error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE"
					? 413
					: 400,
			);
		}
		if (bytes.byteLength > limit) return otlpErrorResponse(req, 413);
		let request: z.infer<typeof ExportLogsRequest>;
		try {
			request = ExportLogsRequest.parse(
				normalizeLogFields(
					type === "application/json"
						? JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(bytes),
							)
						: decodeLogExport(bytes),
					"request",
					0,
					type !== "application/json",
				),
			);
			for (const resource of request.resourceLogs)
				resourceProjectId(resource.resource?.attributes ?? []);
		} catch {
			return otlpErrorResponse(req, 400);
		}
		for (const resource of request.resourceLogs) {
			const selected = resourceProjectId(resource.resource?.attributes ?? []);
			if (selected && selected !== projectId)
				throw new TenantScopeError("Project unavailable");
		}
		const digest = createHash("sha256")
			.update(
				`otlp-logs-wire-v1\0${tenant.organizationId}\0${projectId}\0${type === "application/json" ? "json" : "protobuf"}\0`,
			)
			.update(bytes)
			.digest("hex");
		await withActiveAuthorizedProjectLock(
			pgPool(),
			scope,
			async (client) => {
				const policy = await approvedRedaction(
					client,
					tenant.organizationId,
					projectId,
				);
				const redaction = policyRedactionOptions(
					policy ?? { mode: "none", keys: [] },
				);
				const keys = new Set(redaction.redactKeys);
				const rows: ScopedLog[] = [];
				const ingested = (BigInt(Date.now()) * 1_000_000n).toString();
				for (const resource of request.resourceLogs)
					for (const group of resource.scopeLogs)
						for (const record of group.logRecords) {
							const row: ScopedLog = {
								log_id: createHash("sha256")
									.update(`${digest}:${rows.length}`)
									.digest("hex"),
								organization_id: tenant.organizationId,
								project_id: projectId,
								time_unix_nano: record.timeUnixNano,
								observed_time_unix_nano: record.observedTimeUnixNano,
								ingested_time_unix_nano: ingested,
								severity_number: record.severityNumber,
								severity_text: record.severityText,
								trace_id: record.traceId ?? null,
								span_id: record.spanId ?? null,
								flags: record.flags,
								dropped_attributes_count: record.droppedAttributesCount,
								event_name: record.eventName,
								body:
									redaction.redactInput && record.body
										? { stringValue: REDACTED }
										: record.body
											? (redactLogValue(record.body, keys) ?? {})
											: {},
								attributes: redactLogAttributes(record.attributes, keys),
								resource: {
									attributes: redactLogAttributes(
										resource.resource?.attributes ?? [],
										keys,
									),
									droppedAttributesCount:
										resource.resource?.droppedAttributesCount ?? 0,
								},
								scope: {
									name: group.scope?.name ?? "",
									version: group.scope?.version ?? "",
									attributes: redactLogAttributes(
										group.scope?.attributes ?? [],
										keys,
									),
									droppedAttributesCount:
										group.scope?.droppedAttributesCount ?? 0,
								},
								resource_schema_url: resource.schemaUrl,
								scope_schema_url: group.schemaUrl,
							};
							if (Buffer.byteLength(JSON.stringify(row)) > MAX_LOG_RECORD_BYTES)
								throw new LogRecordTooLarge();
							rows.push(row);
						}
				await insertLogs(ch(), rows, `glasshouse:otlp:logs:${digest}`);
			},
			"ingest",
		);
		return otlpSuccessResponse(req);
	} catch (error) {
		if (
			error instanceof AuthenticationError ||
			(error instanceof TenantScopeError &&
				error.message === "Credential is not available")
		)
			return otlpErrorResponse(req, 401);
		if (error instanceof TenantScopeError) return otlpErrorResponse(req, 404);
		if (error instanceof LogRecordTooLarge) return otlpErrorResponse(req, 413);
		logger.error("otlp.logs_persist_failed", error);
		return otlpErrorResponse(req, isTransientStorageFailure(error) ? 503 : 500);
	}
}
class LogRecordTooLarge extends Error {}

export const listLogsRoute = createRoute({
	method: "get",
	path: "/v1/logs",
	tags: ["logs"],
	summary: "List Project logs",
	description:
		"Typed AnyValue physical log rows, ordered by effective nanosecond time DESC, log_id DESC, then merge-stable insert coordinates DESC. Duplicate IDs and independent payloads remain separate rows. Effective time uses event time, then observed time, then receipt time; original times remain unchanged. Pages are capped at 256 KiB and carry a scope/filter-bound keyset continuation. Bearer ingestion credentials cannot read logs.",
	request: { query: LogListQuery },
	responses: {
		200: {
			description: "Project logs",
			content: { "application/json": { schema: LogList } },
		},
		400: {
			description: "Invalid filters or cursor",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		404: {
			description: "Project unavailable",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		500: {
			description: "Query failed",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
	},
});
export async function handleListLogs(c: Context): Promise<Response> {
	try {
		const query = LogListQuery.parse(c.req.query());
		const selectors = new URL(c.req.url).searchParams;
		if (
			[
				...selectors.getAll("project_id"),
				...selectors.getAll("filter[project_id]"),
			].some((value) => value.toLowerCase() !== query.project_id.toLowerCase())
		)
			throw new TenantScopeError("Project unavailable");
		const tenant = trustedTenant(c);
		const scope = await resolveTenantProject(
			pgPool(),
			tenant,
			query.project_id,
			"product_read",
		);
		const result = await withActiveAuthorizedProjectLock(
			pgPool(),
			scope,
			async () =>
				listLogs(ch(), tenant.organizationId, {
					...query,
					project_id: scope.projectId,
				}),
			"product_read",
		);
		return c.json(result);
	} catch (error) {
		if (error instanceof TenantScopeError)
			return c.json(
				{ code: "NOT_FOUND", message: "Project is not available" },
				404,
			);
		if (error instanceof InvalidLogCursor || error instanceof z.ZodError)
			return c.json({ code: "BAD_REQUEST", message: "Invalid log query" }, 400);
		logger.error("logs.query_failed", error);
		return c.json({ code: "INTERNAL", message: "Log query failed" }, 500);
	}
}
