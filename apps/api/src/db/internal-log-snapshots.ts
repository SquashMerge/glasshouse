import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type { InternalLogEntry, InternalLogFilters } from "./internal-logs.js";

const MAX_ROWS = 50_000;
const MAX_PER_ACTOR = 8;
const MAX_PER_ORGANIZATION = 32;
const MAX_GLOBAL = 128;

export class InternalLogSnapshotInvalidError extends Error {
	constructor() {
		super("Log results expired or changed. Refresh to restart.");
	}
}
export class InternalLogSnapshotCapacityError extends Error {
	constructor() {
		super("Log snapshot capacity reached. Try again later.");
	}
}

function fingerprint(filters: InternalLogFilters): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				filters.level ?? null,
				filters.source ?? null,
				filters.search ?? null,
				filters.timeFrom ?? null,
				filters.timeTo ?? null,
			]),
		)
		.digest("base64url");
}

function signature(id: string, offset: number, key: Buffer): string {
	return createHmac("sha256", key)
		.update(`${id}.${offset}`)
		.digest("base64url");
}
function makeCursor(id: string, offset: number, key: Buffer): string {
	return `v2.${id}.${offset}.${signature(id, offset, key)}`;
}
function parseCursor(cursor: string): {
	id: string;
	offset: number;
	signature: string;
} {
	const match =
		/^v2\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]{0,4})\.([A-Za-z0-9_-]{43})$/u.exec(
			cursor,
		);
	if (!match) throw new InternalLogSnapshotInvalidError();
	const offset = Number(match[2]);
	if (offset >= MAX_ROWS) throw new InternalLogSnapshotInvalidError();
	return { id: match[1]!, offset, signature: match[3]! };
}

type Scope = { organizationId: string; actorId: string };
type Snapshot = { id: string; signing_key: Buffer };
type ResultRow = {
	valid: boolean;
	total: number;
	id: string | null;
	recorded_at: string | null;
	severity: InternalLogEntry["severity"] | null;
	source: string | null;
	message: string | null;
	context: Record<string, unknown> | null;
};

export async function listInternalLogSnapshot(
	client: PoolClient,
	scope: Scope,
	filters: InternalLogFilters & { limit: number; cursor?: string },
): Promise<{ items: InternalLogEntry[]; total: number; nextCursor?: string }> {
	const filterHash = fingerprint(filters);
	let snapshot: Snapshot;
	let offset = 0;
	if (filters.cursor) {
		const cursor = parseCursor(filters.cursor);
		const result = await client.query<Snapshot>(
			`SELECT id, signing_key FROM internal_log_snapshots
			 WHERE id = $1 AND organization_id = $2 AND actor_id = $3
			 AND filter_hash = $4 AND expires_at > clock_timestamp()`,
			[cursor.id, scope.organizationId, scope.actorId, filterHash],
		);
		if (!result.rows[0]) throw new InternalLogSnapshotInvalidError();
		snapshot = result.rows[0];
		const expected = Buffer.from(
			signature(snapshot.id, cursor.offset, snapshot.signing_key),
		);
		const received = Buffer.from(cursor.signature);
		if (
			received.length !== expected.length ||
			!timingSafeEqual(expected, received)
		)
			throw new InternalLogSnapshotInvalidError();
		offset = cursor.offset;
	} else {
		// Serialize allocation and cleanup across replicas; never lock the log writer.
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('glasshouse.internal_log_snapshots'))",
		);
		await client.query(
			"DELETE FROM internal_log_snapshots WHERE expires_at <= clock_timestamp()",
		);
		const quota = await client.query<{
			global_count: number;
			org_count: number;
			actor_count: number;
		}>(
			`SELECT count(*)::int AS global_count,
			 count(*) FILTER (WHERE organization_id = $1)::int AS org_count,
			 count(*) FILTER (WHERE actor_id = $2)::int AS actor_count
			 FROM internal_log_snapshots`,
			[scope.organizationId, scope.actorId],
		);
		const counts = quota.rows[0]!;
		if (
			counts.global_count >= MAX_GLOBAL ||
			counts.org_count >= MAX_PER_ORGANIZATION ||
			counts.actor_count >= MAX_PER_ACTOR
		)
			throw new InternalLogSnapshotCapacityError();
		const values: unknown[] = [scope.organizationId];
		const where = [
			"organization_id = $1",
			"recorded_at >= clock_timestamp() - interval '14 days'",
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
		// A single SELECT statement fixes the MVCC membership and exact sort keys.
		const id = randomUUID();
		const key = randomBytes(32);
		values.push(id, scope.actorId, filterHash, key);
		const p = values.length;
		const inserted = await client.query<{ count: number }>(
			`WITH selected AS MATERIALIZED (
			 SELECT id, recorded_at FROM internal_log_entries WHERE ${where.join(" AND ")}
			 ORDER BY recorded_at DESC, id DESC LIMIT ${MAX_ROWS + 1}
			), collected AS (
			 SELECT coalesce(array_agg(id ORDER BY recorded_at DESC, id DESC), '{}'::uuid[]) AS ids,
			 coalesce(array_agg(recorded_at ORDER BY recorded_at DESC, id DESC), '{}'::timestamptz[]) AS times,
			 count(*)::int AS count FROM selected
			), inserted AS (
			 INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at)
			 SELECT $${p - 3}, $1, $${p - 2}, $${p - 1}, $${p}, ids, times, clock_timestamp() + interval '5 minutes'
			 FROM collected WHERE count <= ${MAX_ROWS} RETURNING id
			) SELECT count FROM collected`,
			values,
		);
		if ((inserted.rows[0]?.count ?? MAX_ROWS + 1) > MAX_ROWS)
			throw new InternalLogSnapshotCapacityError();
		snapshot = { id, signing_key: key };
	}
	// Validate the entire snapshot and retrieve its page in the SAME fresh MVCC
	// statement: retention cannot race a separate check and silently omit rows.
	const result = await client.query<ResultRow>(
		`WITH snap AS MATERIALIZED (
		 SELECT * FROM internal_log_snapshots WHERE id = $1 AND organization_id = $2
		 AND actor_id = $3 AND filter_hash = $4 AND expires_at > clock_timestamp()
		), members AS MATERIALIZED (
		 SELECT x.id, x.recorded_at, x.ord FROM snap,
		 unnest(snap.entry_ids, snap.recorded_ats) WITH ORDINALITY AS x(id, recorded_at, ord)
		), checked AS (
		 SELECT count(*)::int AS total, coalesce(bool_and(e.id IS NOT NULL AND e.recorded_at = m.recorded_at AND e.recorded_at >= clock_timestamp() - interval '14 days'), true) AS valid
		 FROM members m LEFT JOIN internal_log_entries e ON e.id = m.id AND e.organization_id = $2
		), page AS (
		 SELECT e.id, to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
		 e.severity, e.source, e.message, e.context, m.ord
		 FROM members m JOIN internal_log_entries e ON e.id = m.id AND e.organization_id = $2
		 WHERE m.ord > $5 AND m.ord <= $5 + $6 ORDER BY m.ord
		)
		 SELECT checked.valid, checked.total, page.* FROM snap CROSS JOIN checked LEFT JOIN page ON true ORDER BY page.ord`,
		[
			snapshot.id,
			scope.organizationId,
			scope.actorId,
			filterHash,
			offset,
			filters.limit,
		],
	);
	const first = result.rows[0];
	if (!first || !first.valid || (offset > 0 && offset >= first.total))
		throw new InternalLogSnapshotInvalidError();
	const items = result.rows
		.filter((row) => row.id !== null)
		.map((row) => ({
			id: row.id!,
			recorded_at: row.recorded_at!,
			severity: row.severity!,
			source: row.source!,
			message: row.message!,
			context: row.context!,
		}));
	const nextOffset = offset + items.length;
	// A continuation can be retried if its response was lost. Keep its snapshot
	// until expiry; one-page results have no cursor and need no retained state.
	if (!filters.cursor && nextOffset >= first.total)
		await client.query("DELETE FROM internal_log_snapshots WHERE id = $1", [
			snapshot.id,
		]);
	return {
		items,
		total: first.total,
		...(nextOffset < first.total
			? {
					nextCursor: makeCursor(snapshot.id, nextOffset, snapshot.signing_key),
				}
			: {}),
	};
}
