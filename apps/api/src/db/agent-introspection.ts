import type { Pool, PoolClient } from "pg";
import {
	lockActiveAuthorizedProject,
	withLockPhaseTransaction,
	type ProjectAuthorization,
} from "./project-authorization.js";
import {
	AgentIntrospectionReportV1,
	agentIntrospectionValidationCategory,
	canonicalAgentIntrospectionRequestHash,
	type AgentIntrospectionReport,
} from "../schemas/agent-introspection.js";

type Transactional = Pick<Pool, "connect">;
type Row = Record<string, unknown>;

export class AgentIntrospectionRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 413 | 422 | 500;
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "NOT_FOUND"
			| "CONFLICT"
			| "PAYLOAD_TOO_LARGE"
			| "CONTRACT_VIOLATION"
			| "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "AgentIntrospectionRepositoryError";
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "CONTRACT_VIOLATION"
					? 422
					: code === "NOT_FOUND"
						? 404
						: code === "CONFLICT"
							? 409
							: code === "PAYLOAD_TOO_LARGE"
								? 413
								: 500;
	}
}

export type AgentIntrospectionIdentity = {
	project_id: string;
	run_id: string;
	task_id: string;
	invocation_id: string;
	authorization: ProjectAuthorization;
};
export type StoredAgentIntrospectionReport = {
	id: string;
	organization_id: string;
	project_id: string;
	evaluation_run_id: string;
	evaluation_run_item_id: string;
	task_id: string;
	invocation_id: string;
	reported_by_actor_id: string;
	source: "client_reported";
	contract_version: "agent-introspection.v1";
	request_hash: string;
	outcome: AgentIntrospectionReport["outcome"];
	completeness: AgentIntrospectionReport["completeness"];
	received_at: string;
	report: AgentIntrospectionReport;
};

function text(row: Row, field: string): string {
	if (typeof row[field] !== "string" || !row[field])
		throw new AgentIntrospectionRepositoryError(
			"INTERNAL",
			"Stored report is invalid",
		);
	return row[field] as string;
}

function timestamp(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	throw new AgentIntrospectionRepositoryError(
		"INTERNAL",
		"Stored report is invalid",
	);
}

function reportFromRow(row: Row): StoredAgentIntrospectionReport {
	const raw =
		typeof row.report === "string" ? JSON.parse(row.report) : row.report;
	const parsed = AgentIntrospectionReportV1.safeParse(raw);
	if (!parsed.success)
		throw new AgentIntrospectionRepositoryError(
			"INTERNAL",
			"Stored report is invalid",
		);
	return {
		id: text(row, "id"),
		organization_id: text(row, "organization_id"),
		project_id: text(row, "project_id"),
		evaluation_run_id: text(row, "evaluation_run_id"),
		evaluation_run_item_id: text(row, "evaluation_run_item_id"),
		task_id: text(row, "task_id"),
		invocation_id: text(row, "invocation_id"),
		reported_by_actor_id: text(row, "reported_by_actor_id"),
		source: "client_reported",
		contract_version: "agent-introspection.v1",
		request_hash: text(row, "request_hash"),
		outcome: parsed.data.outcome,
		completeness: parsed.data.completeness,
		received_at: timestamp(row.received_at),
		report: parsed.data,
	};
}

async function scopedTask(
	client: Pick<PoolClient, "query">,
	identity: AgentIntrospectionIdentity,
): Promise<{ evaluation_run_item_id: string }> {
	const result = await client.query(
		"SELECT task.evaluation_run_item_id FROM experiment_tasks task JOIN evaluation_runs run ON run.id = task.evaluation_run_id AND run.project_id = task.project_id JOIN evaluation_run_items item ON item.id = task.evaluation_run_item_id AND item.project_id = task.project_id AND item.run_id = task.evaluation_run_id WHERE task.id = $1 AND task.project_id = $2 AND task.evaluation_run_id = $3 AND run.organization_id = $4",
		[
			identity.task_id,
			identity.project_id,
			identity.run_id,
			identity.authorization.organization_id,
		],
	);
	const row = result.rows[0] as Row | undefined;
	if (!row)
		throw new AgentIntrospectionRepositoryError(
			"NOT_FOUND",
			"Report target is not available",
		);
	return { evaluation_run_item_id: text(row, "evaluation_run_item_id") };
}

async function authorize(
	client: Pick<PoolClient, "query">,
	identity: AgentIntrospectionIdentity,
) {
	if (
		!(await lockActiveAuthorizedProject(
			client,
			identity.project_id,
			identity.authorization,
		))
	)
		throw new AgentIntrospectionRepositoryError(
			"NOT_FOUND",
			"Report target is not available",
		);
}

export async function storeAgentIntrospectionReport(
	db: Transactional,
	identity: AgentIntrospectionIdentity,
	report: AgentIntrospectionReport,
): Promise<{
	report: StoredAgentIntrospectionReport;
	replayed: boolean;
	created: boolean;
}> {
	const parsed = AgentIntrospectionReportV1.safeParse(report);
	if (!parsed.success) {
		const category = agentIntrospectionValidationCategory(parsed.error.issues);
		throw new AgentIntrospectionRepositoryError(
			category === "normalized_size"
				? "PAYLOAD_TOO_LARGE"
				: category === "semantic"
					? "CONTRACT_VIOLATION"
					: "BAD_REQUEST",
			"Report validation failed",
		);
	}
	return withLockPhaseTransaction(
		db,
		async (client) => authorize(client, identity),
		async (client) => {
			const task = await scopedTask(client, identity);
			const requestHash = canonicalAgentIntrospectionRequestHash(parsed.data, {
				organization_id: identity.authorization.organization_id,
				project_id: identity.project_id,
				actor_id: identity.authorization.actor_id,
				run_id: identity.run_id,
				task_id: identity.task_id,
				invocation_id: identity.invocation_id,
			});
			const existing = await client.query(
				"SELECT * FROM agent_introspection_reports WHERE project_id = $1 AND evaluation_run_id = $2 AND task_id = $3 AND invocation_id = $4 FOR UPDATE",
				[
					identity.project_id,
					identity.run_id,
					identity.task_id,
					identity.invocation_id,
				],
			);
			if (existing.rows[0]) {
				const stored = reportFromRow(existing.rows[0] as Row);
				if (stored.request_hash !== requestHash)
					throw new AgentIntrospectionRepositoryError(
						"CONFLICT",
						"Report identity is already bound to immutable content",
					);
				return { report: stored, replayed: true, created: false };
			}
			const inserted = await client.query(
				"INSERT INTO agent_introspection_reports (organization_id, project_id, evaluation_run_id, evaluation_run_item_id, task_id, invocation_id, reported_by_actor_id, contract_version, source, outcome, completeness, request_hash, report) VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent-introspection.v1', 'client_reported', $8, $9, $10, $11::jsonb) ON CONFLICT (project_id, evaluation_run_id, task_id, invocation_id) DO NOTHING RETURNING *",
				[
					identity.authorization.organization_id,
					identity.project_id,
					identity.run_id,
					task.evaluation_run_item_id,
					identity.task_id,
					identity.invocation_id,
					identity.authorization.actor_id,
					parsed.data.outcome,
					parsed.data.completeness,
					requestHash,
					JSON.stringify(parsed.data),
				],
			);
			if (inserted.rows[0])
				return {
					report: reportFromRow(inserted.rows[0] as Row),
					replayed: false,
					created: true,
				};
			const raced = await client.query(
				"SELECT * FROM agent_introspection_reports WHERE project_id = $1 AND evaluation_run_id = $2 AND task_id = $3 AND invocation_id = $4 FOR UPDATE",
				[
					identity.project_id,
					identity.run_id,
					identity.task_id,
					identity.invocation_id,
				],
			);
			if (!raced.rows[0])
				throw new AgentIntrospectionRepositoryError(
					"INTERNAL",
					"Report persistence did not return a stored report",
				);
			const stored = reportFromRow(raced.rows[0] as Row);
			if (stored.request_hash !== requestHash)
				throw new AgentIntrospectionRepositoryError(
					"CONFLICT",
					"Report identity is already bound to immutable content",
				);
			return { report: stored, replayed: true, created: false };
		},
	);
}

export async function getAgentIntrospectionReport(
	db: Transactional,
	identity: AgentIntrospectionIdentity,
): Promise<StoredAgentIntrospectionReport> {
	return withLockPhaseTransaction(
		db,
		async (client) => authorize(client, identity),
		async (client) => {
			await scopedTask(client, identity);
			const result = await client.query(
				"SELECT * FROM agent_introspection_reports WHERE project_id = $1 AND evaluation_run_id = $2 AND task_id = $3 AND invocation_id = $4",
				[
					identity.project_id,
					identity.run_id,
					identity.task_id,
					identity.invocation_id,
				],
			);
			if (!result.rows[0])
				throw new AgentIntrospectionRepositoryError(
					"NOT_FOUND",
					"Report target is not available",
				);
			return reportFromRow(result.rows[0] as Row);
		},
	);
}
