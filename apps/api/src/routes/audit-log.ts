import { createRoute } from "@hono/zod-openapi";
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

type Cursor = { created_at: string; id: string; source: string };
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

function decodeCursor(value: string | undefined): Cursor | undefined {
	if (!value) return undefined;
	try {
		const decoded = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<Cursor>;
		if (
			typeof decoded.created_at !== "string" ||
			Number.isNaN(Date.parse(decoded.created_at)) ||
			typeof decoded.id !== "string" ||
			decoded.id.length === 0 ||
			typeof decoded.source !== "string" ||
			decoded.source.length === 0
		)
			return undefined;
		return decoded as Cursor;
	} catch {
		return undefined;
	}
}

function encodeCursor(row: AuditRow): string {
	return Buffer.from(
		JSON.stringify({
			created_at: row.created_at,
			id: row.id,
			source: row.source,
		}),
	).toString("base64url");
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
), visible_events AS (
  SELECT e.event_id, e.source,
    COALESCE(e.actor_subject, credential.username, identity.canonical_subject, 'Unavailable') AS actor,
    e.action, e.resource_type, e.resource_id, e.outcome, e.created_at
  FROM audit_events e
  LEFT JOIN local_credentials credential ON credential.organization_id = e.organization_id AND credential.actor_id = e.actor_id
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
      OR (e.project_id IS NOT NULL AND authorization_allows_project($1, e.project_id, $2, 'audit_read'))
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
SELECT e.event_id AS id, e.source, e.actor, e.action, e.resource_type, e.resource_id, e.outcome,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM filtered_events e
WHERE ($10::timestamptz IS NULL OR (e.created_at, e.event_id, e.source) < ($10::timestamptz, $11::text, $12::text))
ORDER BY e.created_at DESC, e.event_id DESC, e.source DESC
LIMIT $13`;

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
		const rows = await pgPool().query<AuditRow>(auditEventsSql, [
			tenant.organizationId,
			tenant.actorId,
			input.from ?? null,
			input.to ?? null,
			input.actor ?? null,
			input.action ?? null,
			input.resource ?? null,
			input.outcome ?? null,
			input.search ?? null,
			cursor?.created_at ?? null,
			cursor?.id ?? null,
			cursor?.source ?? null,
			input.limit + 1,
		]);
		const page = rows.rows.slice(0, input.limit);
		const last = page.at(-1);
		return c.json({
			items: page.map((row) => ({
				...row,
				actor: row.actor ?? "Unavailable",
				created_at: row.created_at,
				details: { source: row.source },
			})),
			...(rows.rows.length > input.limit && last
				? { next_cursor: encodeCursor(last) }
				: {}),
		});
	} catch (cause) {
		logger.error("audit_log.list_failed", cause);
		return c.json(
			{ code: "INTERNAL", message: "Audit events could not be loaded" },
			500,
		);
	}
}
