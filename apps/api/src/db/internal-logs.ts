import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TrustedTenantContext } from "../middleware/auth.js";
import { lockSessionPrincipal } from "./local-sessions.js";
import {
	lockAuthorizedOrganization,
	withLockPhaseTransaction,
} from "./project-authorization.js";

export type InternalLogLevel = "debug" | "info" | "warn" | "error";

export type InternalLogFilters = {
	level?: InternalLogLevel;
	source?: string;
	search?: string;
	timeFrom?: string;
	timeTo?: string;
};

export type InternalLogCursor = { recorded_at: string; id: string };

const INTERNAL_LOG_ROUTES = [
	"agents",
	"admin",
	"auth",
	"benchmarks",
	"datasets",
	"evaluation-gates",
	"evaluation-runs",
	"evaluations",
	"experiments",
	"feedback",
	"governance",
	"me",
	"observations",
	"organization",
	"organizations",
	"otel",
	"prompt-optimizations",
	"prompt-provenance",
	"prompts",
	"projects",
	"scores",
	"traces",
] as const;
const INTERNAL_LOG_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;

export type InternalLogRoute = (typeof INTERNAL_LOG_ROUTES)[number];
type InternalLogMethod = (typeof INTERNAL_LOG_METHODS)[number];
export type InternalLogContext = {
	route: InternalLogRoute;
	method: InternalLogMethod;
	status: number;
	duration_ms: number;
};

export type InternalLogEntry = InternalLogCursor & {
	severity: InternalLogLevel;
	source: string;
	message: string;
	context: Record<string, unknown>;
};

export const INTERNAL_LOG_RETENTION_DAYS = 14;
export const INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION = 50_000;
export const INTERNAL_LOG_MAX_PENDING = 100;
export const INTERNAL_LOG_CLEANUP_BATCH_SIZE = 1_000;
export const INTERNAL_LOG_ORGANIZATION_LOCK_SEED = 58;
const INTERNAL_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const TIMESTAMP_TEXT_SQL = `to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const INTERNAL_LOG_CURSOR_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/u;
const INTERNAL_LOG_CURSOR_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class InvalidInternalLogCursorError extends Error {
	constructor() {
		super("Invalid or mismatched internal log cursor");
	}
}

export class InternalLogAccessDeniedError extends Error {
	constructor() {
		super("Organization is not available");
	}
}

function filterFingerprint(filters: InternalLogFilters): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				level: filters.level ?? null,
				source: filters.source ?? null,
				search: filters.search ?? null,
				timeFrom: filters.timeFrom ?? null,
				timeTo: filters.timeTo ?? null,
			}),
		)
		.digest("base64url");
}

export function encodeInternalLogCursor(
	organizationId: string,
	filters: InternalLogFilters,
	cursor: InternalLogCursor,
): string {
	return Buffer.from(
		JSON.stringify({
			v: 1,
			organization_id: organizationId,
			filter: filterFingerprint(filters),
			...cursor,
		}),
	).toString("base64url");
}

function validInternalLogTimestamp(value: string): boolean {
	if (!INTERNAL_LOG_CURSOR_TIMESTAMP.test(value) || value.startsWith("0000"))
		return false;
	const wholeSecond = `${value.slice(0, 19)}.000Z`;
	const parsed = new Date(wholeSecond);
	return (
		Number.isFinite(parsed.getTime()) && parsed.toISOString() === wholeSecond
	);
}

export function decodeInternalLogCursor(
	encoded: string | undefined,
	organizationId: string,
	filters: InternalLogFilters,
): InternalLogCursor | undefined {
	if (!encoded) return undefined;
	try {
		const value = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		if (
			value.v !== 1 ||
			value.organization_id !== organizationId ||
			value.filter !== filterFingerprint(filters) ||
			typeof value.recorded_at !== "string" ||
			!validInternalLogTimestamp(value.recorded_at) ||
			typeof value.id !== "string" ||
			!INTERNAL_LOG_CURSOR_ID.test(value.id)
		)
			throw new InvalidInternalLogCursorError();
		return { recorded_at: value.recorded_at, id: value.id };
	} catch {
		throw new InvalidInternalLogCursorError();
	}
}

export function internalLogRoute(path: string): InternalLogRoute | undefined {
	for (const route of INTERNAL_LOG_ROUTES)
		if (path === `/v1/${route}` || path.startsWith(`/v1/${route}/`))
			return route;
	return undefined;
}

export function internalLogRequestContext(
	path: string,
	method: string,
	status: number,
	durationMs: number,
): InternalLogContext | undefined {
	const route = internalLogRoute(path);
	if (!route || !INTERNAL_LOG_METHODS.includes(method as InternalLogMethod))
		return undefined;
	return sanitizeInternalLogContext({
		route,
		method: method as InternalLogMethod,
		status,
		duration_ms: durationMs,
	});
}

function sanitizeInternalLogContext(
	context: InternalLogContext,
): InternalLogContext | undefined {
	if (
		!INTERNAL_LOG_ROUTES.includes(context.route) ||
		!INTERNAL_LOG_METHODS.includes(context.method) ||
		!Number.isInteger(context.status) ||
		context.status < 100 ||
		context.status > 599 ||
		!Number.isFinite(context.duration_ms) ||
		context.duration_ms < 0 ||
		context.duration_ms > 86_400_000
	)
		return undefined;
	return {
		route: context.route,
		method: context.method,
		status: context.status,
		duration_ms: Math.round(context.duration_ms),
	};
}

export async function persistInternalLog(
	pool: Pick<Pool, "connect">,
	entry: {
		organizationId: string;
		severity: InternalLogLevel;
		context: InternalLogContext;
	},
): Promise<void> {
	const context = sanitizeInternalLogContext(entry.context);
	if (!context) return;
	const client = await pool.connect();
	let transactionOpen = false;
	try {
		await client.query("BEGIN");
		transactionOpen = true;
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
			[entry.organizationId, INTERNAL_LOG_ORGANIZATION_LOCK_SEED],
		);
		await client.query(
			"INSERT INTO internal_log_entries (organization_id, severity, source, message, context) VALUES ($1, $2, $3, $4, $5::jsonb)",
			[
				entry.organizationId,
				entry.severity,
				"api",
				"API request outcome",
				JSON.stringify(context),
			],
		);
		await client.query(
			"WITH overflow AS (SELECT id FROM internal_log_entries WHERE organization_id = $1 ORDER BY recorded_at DESC, id DESC OFFSET $2 LIMIT $3) DELETE FROM internal_log_entries entry USING overflow WHERE entry.id = overflow.id",
			[
				entry.organizationId,
				INTERNAL_LOG_MAX_ROWS_PER_ORGANIZATION,
				INTERNAL_LOG_CLEANUP_BATCH_SIZE,
			],
		);
		await client.query("COMMIT");
		transactionOpen = false;
	} catch (cause) {
		if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}

type InternalLogRow = {
	id: string;
	recorded_at: string;
	severity: InternalLogLevel;
	source: string;
	message: string;
	context: Record<string, unknown> | string;
	total: string | number;
};

export async function listInternalLogs(
	pool: Pick<Pool | PoolClient, "query">,
	organizationId: string,
	filters: InternalLogFilters & { limit: number; cursor?: InternalLogCursor },
): Promise<{
	items: InternalLogEntry[];
	total: number;
	nextCursor?: InternalLogCursor;
}> {
	const values: unknown[] = [organizationId];
	const where = [
		"organization_id = $1",
		"recorded_at >= now() - INTERVAL '14 days'",
	];
	if (filters.level) {
		values.push(filters.level);
		where.push(`severity = $${values.length}`);
	}
	if (filters.source) {
		values.push(filters.source);
		where.push(`source = $${values.length}`);
	}
	if (filters.search) {
		values.push(`%${filters.search}%`);
		where.push(
			`(message ILIKE $${values.length} OR context::text ILIKE $${values.length})`,
		);
	}
	if (filters.timeFrom) {
		values.push(filters.timeFrom);
		where.push(`recorded_at >= $${values.length}::timestamptz`);
	}
	if (filters.timeTo) {
		values.push(filters.timeTo);
		where.push(`recorded_at <= $${values.length}::timestamptz`);
	}
	const pageWhere = ["TRUE"];
	if (filters.cursor) {
		values.push(filters.cursor.recorded_at, filters.cursor.id);
		pageWhere.push(
			`(cursor_recorded_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
		);
	}
	values.push(filters.limit + 1);
	const result = await pool.query<InternalLogRow>(
		`WITH filtered AS MATERIALIZED (SELECT id, recorded_at AS cursor_recorded_at, ${TIMESTAMP_TEXT_SQL} AS recorded_at, severity, source, message, context FROM internal_log_entries WHERE ${where.join(" AND ")}), page AS (SELECT * FROM filtered WHERE ${pageWhere.join(" AND ")} ORDER BY cursor_recorded_at DESC, id DESC LIMIT $${values.length}) SELECT page.*, (SELECT count(*) FROM filtered) AS total FROM page ORDER BY cursor_recorded_at DESC, id DESC`,
		values,
	);
	const rows = result.rows;
	const hasNext = rows.length > filters.limit;
	const page = hasNext ? rows.slice(0, filters.limit) : rows;
	const items = page.map((row) => ({
		id: row.id,
		recorded_at: row.recorded_at,
		severity: row.severity,
		source: row.source,
		message: row.message,
		context:
			typeof row.context === "string"
				? (JSON.parse(row.context) as Record<string, unknown>)
				: row.context,
	}));
	const last = items.at(-1);
	return {
		items,
		total: Number(rows[0]?.total ?? 0),
		...(hasNext && last
			? { nextCursor: { recorded_at: last.recorded_at, id: last.id } }
			: {}),
	};
}

async function withAuthorizedInternalLogRead<T>(
	db: Pick<Pool, "connect">,
	tenant: Pick<
		TrustedTenantContext,
		"actorId" | "organizationId" | "sessionId"
	>,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	return withLockPhaseTransaction(
		db,
		async (client) => {
			if (tenant.sessionId)
				await lockSessionPrincipal(client, {
					...tenant,
					sessionId: tenant.sessionId,
				});
			if (
				!(await lockAuthorizedOrganization(
					client,
					tenant.organizationId,
					tenant.actorId,
					"organization_manage",
				))
			)
				throw new InternalLogAccessDeniedError();
		},
		callback,
	);
}

export async function assertInternalLogAccess(
	db: Pick<Pool, "connect">,
	tenant: Pick<
		TrustedTenantContext,
		"actorId" | "organizationId" | "sessionId"
	>,
): Promise<void> {
	await withAuthorizedInternalLogRead(db, tenant, async () => undefined);
}

export function listAuthorizedInternalLogs(
	db: Pick<Pool, "connect">,
	tenant: Pick<
		TrustedTenantContext,
		"actorId" | "organizationId" | "sessionId"
	>,
	filters: InternalLogFilters & { limit: number; cursor?: InternalLogCursor },
) {
	return withAuthorizedInternalLogRead(db, tenant, async (client) =>
		listInternalLogs(client, tenant.organizationId, filters),
	);
}

export async function cleanupExpiredInternalLogs(
	pool: Pick<Pool, "connect">,
): Promise<number> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const lock = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_xact_lock(hashtext('glasshouse.internal_log_cleanup')) AS acquired",
		);
		if (!lock.rows[0]?.acquired) {
			await client.query("COMMIT");
			return 0;
		}
		const deleted = await client.query<{ deleted: string }>(
			"WITH expired AS (SELECT ctid FROM internal_log_entries WHERE recorded_at < now() - INTERVAL '14 days' ORDER BY recorded_at ASC, id ASC LIMIT $1) DELETE FROM internal_log_entries entry USING expired WHERE entry.ctid = expired.ctid RETURNING 1",
			[INTERNAL_LOG_CLEANUP_BATCH_SIZE],
		);
		await client.query("COMMIT");
		return deleted.rowCount ?? deleted.rows.length;
	} catch (cause) {
		try {
			await client.query("ROLLBACK");
		} catch {
			// The original cleanup failure is the useful one.
		}
		throw cause;
	} finally {
		client.release();
	}
}

export function createInternalLogCollector(
	pool: Pick<Pool, "connect">,
	onFailure: () => void = () => {},
) {
	const queue: Array<{
		organizationId: string;
		severity: InternalLogLevel;
		context: InternalLogContext;
	}> = [];
	let draining = false;
	let closed = false;
	let healthy = true;
	const fail = () => {
		if (healthy) onFailure();
		healthy = false;
	};

	const drain = async () => {
		if (draining) return;
		draining = true;
		try {
			while (!closed && queue.length > 0) {
				const entry = queue.shift();
				if (!entry) continue;
				try {
					await persistInternalLog(pool, entry);
					healthy = true;
				} catch {
					fail();
				}
			}
		} finally {
			draining = false;
		}
	};

	return {
		record(entry: {
			organizationId: string;
			severity: InternalLogLevel;
			context: InternalLogContext;
		}): boolean {
			if (closed) return false;
			if (queue.length >= INTERNAL_LOG_MAX_PENDING) {
				fail();
				return false;
			}
			queue.push(entry);
			void drain();
			return true;
		},
		healthy() {
			return healthy && !closed;
		},
		close() {
			closed = true;
			queue.length = 0;
		},
		pending() {
			return queue.length + Number(draining);
		},
	};
}

export function startInternalLogCleanup(
	pool: Pick<Pool, "connect">,
	log: (event: string, fields: Record<string, unknown>) => void,
) {
	let stopped = false;
	let running = false;
	const tick = async () => {
		if (stopped || running) return;
		running = true;
		try {
			const deleted = await cleanupExpiredInternalLogs(pool);
			if (deleted > 0) log("internal_logs.cleanup_completed", { deleted });
		} catch {
			log("internal_logs.cleanup_failed", {});
		} finally {
			running = false;
		}
	};
	void tick();
	const timer = setInterval(
		() => void tick(),
		INTERNAL_LOG_CLEANUP_INTERVAL_MS,
	);
	timer.unref();
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}

export function internalLogCollectionEnabled(): boolean {
	return (
		process.env.GLASSHOUSE_INTERNAL_LOGS_ENABLED?.toLowerCase() !== "false"
	);
}
