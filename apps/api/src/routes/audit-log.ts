import { createRoute } from "@hono/zod-openapi";
import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import {
	lockLocalActor,
	lockSessionPrincipal,
	AuthenticationError,
} from "../db/local-sessions.js";
import { withLockPhaseTransaction } from "../db/project-authorization.js";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { logger } from "../lib/logger.js";
import { trustedTenant } from "../tenancy.js";
import {
	AuditEventList,
	AuditLogErrorResponses,
	AuditLogQuery,
} from "../schemas/audit-log.js";

export const auditLogRoute = createRoute({
	method: "get",
	path: "/v1/audit-events",
	tags: ["audit"],
	security: [{ basicAuth: [] }],
	request: { query: AuditLogQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: AuditEventList } },
		},
		...AuditLogErrorResponses,
	},
});

type AuditFilters = {
	from: string | null;
	to: string | null;
	actor: string | null;
	action: string | null;
	resource: string | null;
	outcome: string | null;
	search: string | null;
};
type Cursor = { id: string; offset: number; signature: string };
type AuditRow = {
	id: string;
	source: string;
	actor: string | null;
	action: string;
	resource_type: string;
	resource_id: string | null;
	outcome: string | null;
	created_at: string;
};

const MAX_ROWS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;

function filterDigest(filters: AuditFilters): string {
	return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
	if (!value) return undefined;
	const match =
		/^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]{0,3})\.([A-Za-z0-9_-]{43})$/.exec(
			value,
		);
	if (!match || Number(match[2]) >= MAX_ROWS) return undefined;
	return { id: match[1]!, offset: Number(match[2]), signature: match[3]! };
}
function signature(id: string, offset: number, key: Buffer): string {
	return createHmac("sha256", key)
		.update(`${id}.${offset}`)
		.digest("base64url");
}
function encodeCursor(id: string, offset: number, key: Buffer): string {
	return `v1.${id}.${offset}.${signature(id, offset, key)}`;
}

function canonicalFilters(input: {
	from?: string;
	to?: string;
	actor?: string;
	action?: string;
	resource?: string;
	outcome?: string;
	search?: string;
}): AuditFilters {
	return {
		from: input.from ?? null,
		to: input.to ?? null,
		actor: input.actor ?? null,
		action: input.action ?? null,
		resource: input.resource ?? null,
		outcome: input.outcome ?? null,
		search: input.search ?? null,
	};
}

const auditEventsSql = `
WITH audit_events AS (
  SELECT e.id::text AS event_id, 'project_authorization'::text AS source,
    e.organization_id, e.project_id, e.actor_subject AS actor_subject, NULL::uuid AS actor_id,
    e.event_type AS action, 'project'::text AS resource_type, e.project_id::text AS resource_id,
    NULL::text AS outcome, e.created_at
  FROM project_authorization_audit_events e
  UNION ALL
  SELECT e.id::text, 'project_lifecycle', e.organization_id, e.project_id, e.actor_subject, NULL::uuid,
    e.event_type, 'project', e.project_id::text,
    CASE WHEN e.event_type = 'deletion_completed' THEN 'success' WHEN e.event_type = 'deletion_failed' THEN 'failed' ELSE NULL END, e.created_at
  FROM project_lifecycle_audit_events e
  UNION ALL
  SELECT e.id::text, 'dataset_lifecycle', e.organization_id, e.project_id, NULL::text, e.actor_id,
    e.event_type, 'dataset', e.dataset_id::text, NULL::text, e.created_at
  FROM dataset_lifecycle_audit_events e
  UNION ALL
  SELECT e.id::text, 'evaluation', e.organization_id, e.project_id, NULL::text, e.actor_id,
    e.event_type, 'evaluation', e.evaluation_id::text, NULL::text, e.created_at
  FROM evaluation_audit_events e
  UNION ALL
  SELECT e.id::text, 'evaluation_gate', e.organization_id, e.project_id, NULL::text, e.actor_id,
    e.event_type, 'evaluation_gate', COALESCE(e.approval_id, e.gate_run_id, e.evaluation_run_id)::text, e.outcome_status, e.created_at
  FROM evaluation_gate_audit_events e
  UNION ALL
  SELECT e.id::text, 'governance', e.organization_id, e.project_id, e.actor_subject, NULL::uuid,
    e.event_type, 'governance_policy', e.policy_version_id::text, NULL::text, e.created_at
  FROM governance_audit_events e
  UNION ALL
  SELECT e.id::text, 'admin_access', e.organization_id, e.project_id, NULL::text, e.actor_id,
    e.action, CASE WHEN e.project_id IS NULL THEN 'organization' ELSE 'project' END,
    e.project_id::text,
    CASE WHEN e.action = 'recovery_succeeded' THEN 'success' WHEN e.action IN ('recovery_denied', 'recovery_rate_limited') THEN 'denied' ELSE NULL END,
    e.created_at
  FROM admin_access_audit_events e
  UNION ALL
  SELECT e.id::text, 'local_auth', e.organization_id, NULL::uuid, NULL::text, e.actor_id,
    e.action, 'account', e.actor_id::text,
    CASE WHEN e.action = 'login_succeeded' THEN 'success' WHEN e.action IN ('login_failed', 'login_limited') THEN 'denied' ELSE NULL END,
    e.created_at
  FROM local_auth_audit_events e
  UNION ALL
  SELECT concat(e.project_id::text, ':', e.prompt_id::text), 'prompt_deletion', p.organization_id, e.project_id, e.deleted_by, NULL::uuid,
    'deleted', 'prompt', e.prompt_id::text, 'success', e.deleted_at
  FROM prompt_deletion_audit e
  JOIN projects p ON p.id = e.project_id
  UNION ALL
  SELECT e.id::text, 'user_action', e.organization_id, e.project_id, NULL::text, e.actor_id,
    e.action, CASE WHEN e.prompt_id IS NULL THEN 'feedback' ELSE 'prompt' END,
    COALESCE(e.prompt_id, e.feedback_score_id)::text, NULL::text, e.created_at
  FROM user_action_audit_events e
), visible_events AS (
  SELECT e.event_id, e.source, e.project_id,
    CASE WHEN e.actor_id IS NULL AND credential.actor_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM actor_identities basic_identity
      WHERE basic_identity.organization_id = e.organization_id
        AND basic_identity.provider_namespace = 'basic:v1'
        AND basic_identity.canonical_subject = e.actor_subject
        AND basic_identity.actor_id <> credential.actor_id
    ) THEN 'Unavailable'
    ELSE COALESCE(credential.username, e.actor_subject, identity.canonical_subject, 'Unavailable') END AS actor,
    e.action, e.resource_type, e.resource_id, e.outcome, e.created_at
  FROM audit_events e
  LEFT JOIN local_credentials credential ON credential.organization_id = e.organization_id
    AND (credential.actor_id = e.actor_id OR (e.actor_id IS NULL AND e.actor_subject = 'actor:' || credential.actor_id::text))
  LEFT JOIN LATERAL (
    SELECT ai.canonical_subject FROM actor_identities ai
    WHERE ai.organization_id = e.organization_id AND ai.actor_id = e.actor_id
      AND ai.provider_namespace IN ('local:v1', 'basic:v1')
    ORDER BY ai.provider_namespace LIMIT 1
  ) identity ON true
  WHERE e.organization_id = $1
    AND (
      (e.project_id IS NULL AND EXISTS (
        SELECT 1 FROM organization_actor_roles role
        WHERE role.organization_id = $1 AND role.actor_id = $2
      ))
      OR (e.project_id IS NOT NULL AND e.project_id = ANY($10::uuid[]) AND authorization_allows_project($1, e.project_id, $2, 'audit_read'))
    )
), filtered_events AS (
  SELECT * FROM visible_events e
  WHERE ($3::timestamptz IS NULL OR e.created_at >= $3)
    AND ($4::timestamptz IS NULL OR e.created_at <= $4)
    AND ($5::text IS NULL OR e.actor ILIKE '%' || $5 || '%')
    AND ($6::text IS NULL OR e.action ILIKE '%' || $6 || '%')
    AND ($7::text IS NULL OR e.resource_type ILIKE '%' || $7 || '%' OR COALESCE(e.resource_id, '') ILIKE '%' || $7 || '%')
    AND ($8::text IS NULL OR COALESCE(e.outcome, '') ILIKE '%' || $8 || '%')
    AND ($9::text IS NULL OR concat_ws(' ', e.actor, e.action, e.resource_type, e.resource_id, e.outcome) ILIKE '%' || $9 || '%')
)
SELECT e.event_id AS id, e.source, e.project_id, e.actor, e.action, e.resource_type, e.resource_id, e.outcome,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM filtered_events e
ORDER BY e.created_at DESC, e.event_id DESC, e.source DESC
LIMIT 5001`;

export async function handleListAuditEvents(c: Context) {
	c.header("Cache-Control", "no-store");
	const input = (c.req as any).valid("query") as {
		limit: number;
		cursor?: string;
		from?: string;
		to?: string;
		actor?: string;
		action?: string;
		resource?: string;
		outcome?: string;
		search?: string;
	};
	const cursor = decodeCursor(input.cursor);
	if (input.cursor && !cursor)
		return c.json(
			{ code: "BAD_REQUEST", message: "Request validation failed" },
			400,
		);
	try {
		const tenant = trustedTenant(c);
		const filters = canonicalFilters(input);
		let projectIds: string[] = [];
		const result = await withLockPhaseTransaction(
			pgPool(),
			async (client) => {
				await client.query(
					"SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'",
				);
				if (tenant.sessionId)
					await lockSessionPrincipal(client, {
						...tenant,
						sessionId: tenant.sessionId,
					});
				else if (
					!(await lockLocalActor(client, tenant.organizationId, tenant.actorId))
				)
					throw new AuthenticationError();
				await client.query(
					"SELECT actor_subject FROM organization_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $2) FOR SHARE",
					[tenant.organizationId, tenant.actorId],
				);
				const role = await client.query(
					"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR SHARE",
					[tenant.organizationId, tenant.actorId],
				);
				if (!role.rowCount) throw new AuthenticationError();
				await client.query(
					"SELECT project_id FROM project_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $2) ORDER BY project_id, actor_subject FOR SHARE",
					[tenant.organizationId, tenant.actorId],
				);
				await client.query(
					"SELECT project_id FROM project_actor_grants WHERE organization_id = $1 AND actor_id = $2 ORDER BY project_id FOR SHARE",
					[tenant.organizationId, tenant.actorId],
				);
				const projects = await client.query<{ id: string }>(
					"SELECT id FROM projects WHERE organization_id = $1 ORDER BY id LIMIT 5001 FOR SHARE",
					[tenant.organizationId],
				);
				if (projects.rows.length > MAX_ROWS) throw new AuditCapacityError();
				projectIds = projects.rows.map((project) => project.id);
			},
			async (client) =>
				listSnapshot(client, tenant, filters, input.limit, cursor, projectIds),
		);
		return c.json(result);
	} catch (cause) {
		if (cause instanceof AuditSnapshotError)
			return c.json(
				{
					code: "BAD_REQUEST",
					message: "Audit results expired or changed. Refresh to restart.",
				},
				400,
			);
		if (cause instanceof AuthenticationError)
			return c.json(
				{ code: "UNAUTHORIZED", message: "Authentication required" },
				401,
			);
		if (cause instanceof AuditCapacityError)
			return c.json(
				{
					code: "SERVICE_UNAVAILABLE",
					message:
						"Audit snapshot capacity reached. Narrow your filters or try again later.",
				},
				503,
			);
		logger.error("audit_log.list_failed", cause);
		return c.json(
			{ code: "INTERNAL", message: "Audit events could not be loaded" },
			500,
		);
	}
}

class AuditSnapshotError extends Error {}
class AuditCapacityError extends Error {}

type SnapshotRow = AuditRow & { project_id: string | null };
async function listSnapshot(
	client: PoolClient,
	tenant: { organizationId: string; actorId: string },
	filters: AuditFilters,
	limit: number,
	cursor: Cursor | undefined,
	projectIds: string[],
) {
	let entries: SnapshotRow[];
	let id: string;
	let key: Buffer;
	let offset = 0;
	if (cursor) {
		const found = await client.query<{
			entries: SnapshotRow[];
			signing_key: Buffer;
			authorized: boolean;
		}>(
			`SELECT entries, signing_key,
			NOT EXISTS (SELECT 1 FROM jsonb_array_elements(entries) e WHERE e->>'project_id' IS NOT NULL AND NOT authorization_allows_project($2, (e->>'project_id')::uuid, $3, 'audit_read')) AS authorized
			FROM audit_log_snapshots WHERE id = $1 AND organization_id = $2 AND actor_id = $3 AND filter_hash = $4 AND expires_at > clock_timestamp()`,
			[cursor.id, tenant.organizationId, tenant.actorId, filterDigest(filters)],
		);
		const snap = found.rows[0];
		if (!snap || !snap.authorized || cursor.offset >= snap.entries.length)
			throw new AuditSnapshotError();
		const expected = Buffer.from(
			signature(cursor.id, cursor.offset, snap.signing_key),
		);
		const received = Buffer.from(cursor.signature);
		if (
			expected.length !== received.length ||
			!timingSafeEqual(expected, received)
		)
			throw new AuditSnapshotError();
		entries = snap.entries;
		key = snap.signing_key;
		id = cursor.id;
		offset = cursor.offset;
	} else {
		const rows = await client.query<SnapshotRow>(auditEventsSql, [
			tenant.organizationId,
			tenant.actorId,
			filters.from,
			filters.to,
			filters.actor,
			filters.action,
			filters.resource,
			filters.outcome,
			filters.search,
			projectIds,
		]);
		// A Project created while the authorization locks were acquired was not
		// locked and must not be silently omitted from the admitted snapshot.
		const added = await client.query(
			"SELECT 1 FROM projects WHERE organization_id = $1 AND id <> ALL($2::uuid[]) LIMIT 1",
			[tenant.organizationId, projectIds],
		);
		if (added.rowCount) throw new AuditCapacityError();
		entries = rows.rows;
		if (
			entries.length > MAX_ROWS ||
			Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES / 2
		)
			throw new AuditCapacityError();
		id = randomUUID();
		key = randomBytes(32);
		if (entries.length > limit) {
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('glasshouse.audit_log_snapshots'))",
			);
			await client.query(
				"DELETE FROM audit_log_snapshots WHERE expires_at <= clock_timestamp()",
			);
			const quota = await client.query<{
				total: number;
				org: number;
				actor: number;
			}>(
				`SELECT count(*)::int AS total, count(*) FILTER (WHERE organization_id = $1)::int AS org, count(*) FILTER (WHERE organization_id = $1 AND actor_id = $2)::int AS actor FROM audit_log_snapshots`,
				[tenant.organizationId, tenant.actorId],
			);
			const counts = quota.rows[0]!;
			if (counts.total >= 128 || counts.org >= 32 || counts.actor >= 8)
				throw new AuditCapacityError();
			await client.query(
				"INSERT INTO audit_log_snapshots(id, organization_id, actor_id, filter_hash, signing_key, entries, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp() + interval '5 minutes')",
				[
					id,
					tenant.organizationId,
					tenant.actorId,
					filterDigest(filters),
					key,
					JSON.stringify(entries),
				],
			);
		}
	}
	const page = entries.slice(offset, offset + limit);
	const next = offset + page.length;
	return {
		items: page.map(({ project_id: _projectId, ...row }) => ({
			...row,
			actor: row.actor ?? "Unavailable",
			details: { source: row.source },
		})),
		...(next < entries.length
			? { next_cursor: encodeCursor(id, next, key) }
			: {}),
	};
}
