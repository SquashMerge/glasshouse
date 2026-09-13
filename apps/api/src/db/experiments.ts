import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	lockActiveAuthorizedProject,
	lockAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";
import {
	createExecutionAdmission,
	claimExecutionAdmission,
	executionOperationKey,
	executionAdmissionIsActive,
	type ExecutionAdmissionClaim,
	type ExecutionAdmissionEffect,
	type ExecutionAdmission,
} from "./execution-admissions.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Transactional = Pick<Pool, "connect">;
type Row = Record<string, unknown>;
export type ExperimentStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";
export type JsonObject = Record<string, unknown>;
export type ExperimentTaskStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";
export type ClaimedExperimentTask = {
	id: string;
	dataset_item_id: string | null;
	dataset_version_item_id?: string | null;
	evaluation_run_item_id?: string | null;
	evaluation_run_id?: string | null;
	attempt_count: number;
	last_error_classification?: string | null;
	cost_reservation_usd?: number | null;
	lease_token: string;
	input: JsonObject;
	expected_output: unknown;
};
export type RecoverableExperiment = {
	id: string;
	project_id: string;
	dataset_id: string;
	config: JsonObject;
	evaluation_run_id?: string;
};

export type ExperimentCostReservation =
	| { reserved: true; amount: number }
	| {
			reserved: false;
			reason: "not_configured" | "cost_limit_exceeded" | "snapshot_missing";
	  };

export type ExperimentProviderCallReservation =
	| { reserved: true; used: number; limit: number }
	| {
			reserved: false;
			reason:
				| "not_configured"
				| "provider_call_limit_exceeded"
				| "snapshot_missing";
	  };

export class ExperimentRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: "NOT_FOUND" | "CONFLICT" | "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "ExperimentRepositoryError";
		this.status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500;
	}
}

function normalize(value: unknown): ExperimentRepositoryError {
	if (value instanceof ExperimentRepositoryError) return value;
	if (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		value.code === "23505"
	)
		return new ExperimentRepositoryError(
			"CONFLICT",
			"Experiment already exists",
			value,
		);
	return new ExperimentRepositoryError(
		"INTERNAL",
		"Experiment repository operation failed",
		value,
	);
}
function text(row: Row, key: string): string {
	if (typeof row[key] !== "string")
		throw new ExperimentRepositoryError("INTERNAL", `Invalid ${key}`);
	return row[key] as string;
}
function nullableText(row: Row, key: string): string | null {
	return row[key] == null ? null : text(row, key);
}
function json(row: Row, key: string): JsonObject {
	const value =
		typeof row[key] === "string" ? JSON.parse(row[key] as string) : row[key];
	return (
		value && typeof value === "object" && !Array.isArray(value) ? value : {}
	) as JsonObject;
}
function time(row: Row, key: string): string {
	return row[key] instanceof Date
		? (row[key] as Date).toISOString()
		: text(row, key);
}
function experiment(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		agent_id: nullableText(row, "agent_id"),
		dataset_id: text(row, "dataset_id"),
		resolved_dataset_version_id: nullableText(
			row,
			"resolved_dataset_version_id",
		),
		dataset_input_binding:
			row.dataset_input_binding === "versioned"
				? ("versioned" as const)
				: ("legacy_unversioned" as const),
		name: nullableText(row, "name"),
		status: text(row, "status") as ExperimentStatus,
		config: json(row, "config"),
		created_at: time(row, "created_at"),
		updated_at: time(row, "updated_at"),
	};
}
function result(row: Row) {
	return {
		id: text(row, "id"),
		experiment_id: text(row, "experiment_id"),
		dataset_item_id: text(
			row,
			row.dataset_version_item_id
				? "dataset_version_item_id"
				: "dataset_item_id",
		),
		agent_version: nullableText(row, "agent_version"),
		output: row.output == null ? null : json(row, "output"),
		scores: json(row, "scores") as Record<string, number>,
		duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
		cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
		error_classification: nullableText(row, "error_classification"),
		error_message: nullableText(row, "error_message"),
		evaluator_rationale:
			row.evaluator_rationale == null ? null : json(row, "evaluator_rationale"),
		trace_id: nullableText(row, "trace_id"),
		status: text(row, "status") as ExperimentStatus,
		created_at: time(row, "created_at"),
	};
}

async function withTransaction<T>(
	db: Transactional,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const value = await callback(client);
		await client.query("COMMIT");
		return value;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}

async function lockExperimentExecution(
	client: PoolClient,
	input: { project_id?: string; id: string },
): Promise<{
	row: Row;
	authorized: boolean;
	project_id: string;
	organization_id: string;
	requester_actor_id: string | null;
} | null> {
	const project = await client.query<
		Row & {
			authorization_project_id: string;
			organization_id: string;
			requested_by_actor_id: string | null;
		}
	>(
		"SELECT p.id AS authorization_project_id, p.organization_id, e.* FROM projects p JOIN experiments e ON e.project_id = p.id WHERE e.id = $1 AND ($2::uuid IS NULL OR e.project_id = $2) AND p.status = 'active'",
		[input.id, input.project_id ?? null],
	);
	if (!project.rows[0]) return null;
	const requestedBy = project.rows[0].requested_by_actor_id;
	if (typeof requestedBy !== "string")
		return {
			row: project.rows[0],
			authorized: false,
			project_id: project.rows[0].authorization_project_id,
			organization_id: project.rows[0].organization_id,
			requester_actor_id: null,
		};
	const authorized = await lockAuthorizedProject(
		client,
		project.rows[0].authorization_project_id,
		{
			organization_id: project.rows[0].organization_id,
			actor_id: requestedBy,
			operation: "execute",
		},
		["active"],
	);
	const experiment = await client.query(
		"SELECT e.* FROM experiments e WHERE e.id = $1 AND e.project_id = $2 FOR UPDATE OF e",
		[input.id, project.rows[0].authorization_project_id],
	);
	const row = experiment.rows[0] as Row | undefined;
	if (!row) return null;
	return {
		row,
		authorized,
		project_id: project.rows[0].authorization_project_id,
		organization_id: project.rows[0].organization_id,
		requester_actor_id: requestedBy,
	};
}

async function cancelRevokedExperiment(client: PoolClient, id: string) {
	const run = await client.query(
		"SELECT evaluation_run_id FROM experiments WHERE id=$1 FOR UPDATE",
		[id],
	);
	const runId = run.rows[0]?.evaluation_run_id;
	if (typeof runId === "string")
		await client.query(
			"UPDATE evaluation_runs SET status='cancelled', terminal_reason='authorization_revoked', updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
			[runId],
		);
	await sweepExperimentWork(
		client,
		id,
		null,
		"cancelled",
		"authorization_revoked",
		"execution authorization revoked",
	);
	return client.query(
		"UPDATE experiments SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING *",
		[id],
	);
}

async function sweepExperimentWork(
	client: PoolClient,
	experimentId: string,
	projectId: string | null,
	status: "failed" | "cancelled",
	classification: string,
	message: string,
) {
	const projectClause = projectId == null ? "" : " AND project_id=$2";
	const values = projectId == null ? [experimentId] : [experimentId, projectId];
	await client.query(
		`UPDATE execution_admissions SET status='cancelled', cancelled_at=now() WHERE work_kind='experiment_task' AND status='active' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id=$1${projectClause})`,
		values,
	);
	await client.query(
		`UPDATE experiment_tasks SET status=$${projectId == null ? 2 : 3}, cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification=$${projectId == null ? 3 : 4}, last_error_message=$${projectId == null ? 4 : 5}, updated_at=now() WHERE experiment_id=$1${projectClause} AND status IN ('pending','running')`,
		projectId == null
			? [experimentId, status, classification, message]
			: [experimentId, projectId, status, classification, message],
	);
}

export async function createExperiment(
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
		name?: string | null;
		config: JsonObject;
		agent_id?: string | null;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const r = await client.query(
				`INSERT INTO experiments (id, project_id, agent_id, dataset_id, resolved_dataset_version_id, dataset_input_binding, name, config, status, requested_by_actor_id) SELECT $1, $2, $3, dataset.id, version.id, 'versioned', $5, $6::jsonb, 'pending', $7 FROM datasets dataset JOIN dataset_versions version ON version.project_id = dataset.project_id AND version.dataset_id = dataset.id AND version.version = dataset.latest_published_version WHERE dataset.id = $4 AND dataset.project_id = $2 AND dataset.archived_at IS NULL AND ($3 IS NULL OR EXISTS (SELECT 1 FROM agents WHERE id = $3 AND project_id = $2)) AND EXISTS (SELECT 1 FROM dataset_version_items item WHERE item.project_id = version.project_id AND item.dataset_version_id = version.id) AND NOT EXISTS (SELECT 1 FROM dataset_version_items item WHERE item.project_id = version.project_id AND item.dataset_version_id = version.id AND item.expected_output IS NULL) RETURNING *`,
				[
					randomUUID(),
					input.project_id,
					input.agent_id ?? null,
					input.dataset_id,
					input.name ?? null,
					JSON.stringify(input.config),
					input.authorization.actor_id,
				],
			);
			if (!r.rows[0])
				throw new ExperimentRepositoryError("NOT_FOUND", "Agent not found");
			return experiment(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listExperiments(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const r = await client.query(
				"SELECT e.* FROM experiments e WHERE e.project_id=$1 ORDER BY e.created_at DESC",
				[input.project_id],
			);
			return {
				items: r.rows.map(experiment),
				total: r.rowCount ?? r.rows.length,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getExperiment(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			const r = await client.query(
				"SELECT e.* FROM experiments e WHERE e.id=$1 AND e.project_id=$2",
				[input.id, input.project_id],
			);
			if (!r.rows[0])
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			return experiment(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function updateExperiment(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		status: ExperimentStatus;
		/** Apply only when the persisted state is one of these values. */
		if_status?: ExperimentStatus | ExperimentStatus[];
		terminal_reason?: string | null;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, input);
			if (!access)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			if (!access.authorized) {
				const cancelled = await cancelRevokedExperiment(client, input.id);
				return experiment(cancelled.rows[0] ?? access.row);
			}
			const expected = input.if_status
				? Array.isArray(input.if_status)
					? input.if_status
					: [input.if_status]
				: null;
			if (expected && !expected.includes(access.row.status as ExperimentStatus))
				return experiment(access.row);
			const evaluationRunId = access.row.evaluation_run_id;
			if (evaluationRunId && input.status !== "pending") {
				const reason =
					input.terminal_reason ??
					(input.status === "cancelled"
						? "cancelled"
						: input.status === "failed"
							? "execution_failed"
							: null);
				await client.query(
					"UPDATE evaluation_runs SET status=$1, terminal_reason=COALESCE($4, terminal_reason), updated_at=now() WHERE id=$2 AND project_id=$3 AND status IN ('pending','running')",
					[input.status, evaluationRunId, access.project_id, reason],
				);
			}
			const r = await client.query(
				"UPDATE experiments SET status=$1, updated_at=now() WHERE id=$2 RETURNING *",
				[input.status, input.id],
			);
			if (!r.rows[0])
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			if (input.status === "failed" || input.status === "cancelled")
				await sweepExperimentWork(
					client,
					input.id,
					access.project_id,
					input.status,
					input.terminal_reason ??
						(input.status === "cancelled" ? "cancelled" : "execution_failed"),
					input.status === "cancelled"
						? "evaluation cancelled"
						: "evaluation terminated",
				);
			return experiment(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listRecoverableExperiments(db: Transactional) {
	try {
		return await withTransaction(db, async (client) => {
			const candidates = await client.query(
				"SELECT experiment.*, inputs.target AS run_target, inputs.evaluator AS run_evaluator, inputs.execution_defaults AS run_execution_defaults, inputs.limits AS run_limits FROM experiments experiment LEFT JOIN evaluation_run_inputs inputs ON inputs.run_id = experiment.evaluation_run_id AND inputs.project_id = experiment.project_id WHERE experiment.status IN ('pending', 'running') ORDER BY experiment.created_at ASC",
			);
			const recoverable: RecoverableExperiment[] = [];
			for (const candidate of candidates.rows) {
				const access = await lockExperimentExecution(client, {
					id: text(candidate, "id"),
					project_id: text(candidate, "project_id"),
				});
				if (!access?.authorized) {
					if (access)
						await cancelRevokedExperiment(client, text(candidate, "id"));
					continue;
				}
				if (!["pending", "running"].includes(text(access.row, "status")))
					continue;
				if (
					typeof access.row.evaluation_run_id === "string" &&
					candidate.run_target == null
				)
					continue;
				let config = json(access.row, "config");
				if (typeof access.row.evaluation_run_id === "string") {
					const inputs = await client.query(
						"SELECT target, evaluator, execution_defaults, limits FROM evaluation_run_inputs WHERE run_id=$1 AND project_id=$2",
						[access.row.evaluation_run_id, access.project_id],
					);
					const snapshot = inputs.rows[0] as Row | undefined;
					if (snapshot) {
						config = {
							model: json(snapshot, "target").model,
							system_prompt: json(snapshot, "target").system_prompt,
							evaluator: json(snapshot, "evaluator").kind,
							...json(snapshot, "execution_defaults"),
							limits: json(snapshot, "limits"),
						};
					}
				}
				const recoverableExperiment: RecoverableExperiment = {
					id: text(access.row, "id"),
					project_id: text(access.row, "project_id"),
					dataset_id: text(access.row, "dataset_id"),
					config,
				};
				if (typeof access.row.evaluation_run_id === "string")
					recoverableExperiment.evaluation_run_id =
						access.row.evaluation_run_id;
				recoverable.push(recoverableExperiment);
			}
			return recoverable;
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function claimExperimentTask(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		lease_seconds?: number;
		lease_token?: string;
	},
): Promise<ClaimedExperimentTask | null> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access) return null;
			if (!access.authorized) {
				await cancelRevokedExperiment(client, input.experiment_id);
				return null;
			}
			if (access.row.status !== "running") return null;
			const candidate = await client.query(
				"SELECT t.id, t.dataset_item_id, t.dataset_version_item_id, t.evaluation_run_item_id, t.evaluation_run_id, t.attempt_count, t.last_error_classification, t.cost_reservation_usd, t.status FROM experiment_tasks t WHERE t.experiment_id=$1 AND t.project_id=$2 AND t.attempt_count < t.max_attempts AND (t.status='pending' AND t.next_attempt_at <= now() OR t.status='running' AND t.lease_expires_at <= now()) ORDER BY t.created_at ASC FOR UPDATE OF t SKIP LOCKED LIMIT 1",
				[input.experiment_id, access.project_id],
			);
			const task = candidate.rows[0] as Row | undefined;
			if (!task) {
				await client.query(
					"UPDATE execution_admissions SET status='cancelled', cancelled_at=now() WHERE status='active' AND work_kind='experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id=$1 AND project_id=$2 AND status='running' AND lease_expires_at <= now() AND attempt_count >= max_attempts AND cost_reservation_usd IS NOT NULL)",
					[input.experiment_id, access.project_id],
				);
				const unknown = await client.query(
					"UPDATE experiment_tasks SET status='failed', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification='unknown_dispatch', last_error_message='provider dispatch outcome is unknown', updated_at=now() WHERE experiment_id=$1 AND project_id=$2 AND status='running' AND lease_expires_at <= now() AND attempt_count >= max_attempts AND cost_reservation_usd IS NOT NULL RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id",
					[input.experiment_id, access.project_id],
				);
				for (const recoveredTask of unknown.rows as Row[])
					await client.query(
						"INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, output, scores, status, error_classification, error_message) VALUES (gen_random_uuid(), (SELECT project_id FROM experiments WHERE id=$1), $1, $2, $3, $4, $5, NULL, '{}'::jsonb, 'failed', 'unknown_dispatch', 'provider dispatch outcome is unknown') ON CONFLICT DO NOTHING",
						[
							text(recoveredTask, "experiment_id"),
							recoveredTask.dataset_item_id ?? null,
							recoveredTask.dataset_version_item_id ?? null,
							recoveredTask.evaluation_run_item_id ?? null,
							recoveredTask.evaluation_run_id ?? null,
						],
					);
				await client.query(
					"UPDATE experiment_tasks SET status='failed', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification='retry_exhausted', last_error_message='maximum attempts exhausted', updated_at=now() WHERE experiment_id=$1 AND project_id=$2 AND status='running' AND lease_expires_at <= now() AND attempt_count >= max_attempts AND cost_reservation_usd IS NULL",
					[input.experiment_id, access.project_id],
				);
				return null;
			}
			if (task.cost_reservation_usd != null) {
				await client.query(
					"UPDATE execution_admissions SET status='cancelled', cancelled_at=now() WHERE status='active' AND work_kind='experiment_task' AND work_id=$1",
					[text(task, "id")],
				);
				const recovered = await client.query(
					"UPDATE experiment_tasks SET status='failed', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification='unknown_dispatch', last_error_message='provider dispatch outcome is unknown', updated_at=now() WHERE id=$1 AND experiment_id=$2 AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id",
					[text(task, "id"), input.experiment_id],
				);
				const recoveredTask = recovered.rows[0] as Row | undefined;
				if (recoveredTask)
					await client.query(
						"INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, output, scores, status, error_classification, error_message) VALUES (gen_random_uuid(), (SELECT project_id FROM experiments WHERE id=$1), $1, $2, $3, $4, $5, NULL, '{}'::jsonb, 'failed', 'unknown_dispatch', 'provider dispatch outcome is unknown') ON CONFLICT DO NOTHING",
						[
							text(recoveredTask, "experiment_id"),
							recoveredTask.dataset_item_id ?? null,
							recoveredTask.dataset_version_item_id ?? null,
							recoveredTask.evaluation_run_item_id ?? null,
							recoveredTask.evaluation_run_id ?? null,
						],
					);
				return null;
			}
			const leaseToken = input.lease_token ?? randomUUID();
			const claimed = await client.query(
				"UPDATE experiment_tasks SET status='running', lease_token=$2::uuid, lease_expires_at=now() + ($3::integer * interval '1 second'), claimed_at=coalesce(claimed_at,now()), started_at=coalesce(started_at,now()), heartbeat_at=now(), attempt_count=attempt_count+1, updated_at=now() WHERE id=$1 AND project_id=$4 RETURNING id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, attempt_count, last_error_classification, cost_reservation_usd, lease_token",
				[
					text(task, "id"),
					leaseToken,
					input.lease_seconds ?? 60,
					access.project_id,
				],
			);
			const claimedTask = claimed.rows[0] as Row | undefined;
			if (!claimedTask) return null;
			const item = claimedTask.evaluation_run_id
				? await client.query(
						"SELECT input, expected_output FROM evaluation_run_items WHERE id=$1 AND run_id=$2 AND project_id=$3",
						[
							claimedTask.evaluation_run_item_id,
							claimedTask.evaluation_run_id,
							access.project_id,
						],
					)
				: await client.query(
						"SELECT CASE WHEN run_item.id IS NOT NULL THEN run_item.input ELSE item.input END AS input, CASE WHEN run_item.id IS NOT NULL THEN run_item.expected_output ELSE item.expected_output END AS expected_output FROM experiment_tasks task JOIN experiments experiment ON experiment.id = task.experiment_id AND experiment.project_id = task.project_id LEFT JOIN evaluation_run_items run_item ON run_item.id = task.evaluation_run_item_id AND run_item.run_id = experiment.evaluation_run_id AND run_item.project_id = task.project_id LEFT JOIN dataset_version_items item ON item.id = task.dataset_version_item_id AND item.project_id = task.project_id AND item.dataset_version_id = experiment.resolved_dataset_version_id WHERE task.id = $1 AND task.project_id = $3 AND experiment.dataset_input_binding = 'versioned' UNION ALL SELECT input, expected_output FROM dataset_items WHERE id = $2 AND project_id = $3",
						[
							text(claimedTask, "id"),
							claimedTask.dataset_item_id ?? null,
							access.project_id,
						],
					);
			const datasetItem = item.rows[0] as Row | undefined;
			if (!datasetItem)
				throw new ExperimentRepositoryError(
					"INTERNAL",
					"Dataset item not found",
				);
			return {
				id: text(claimedTask, "id"),
				dataset_item_id: text(
					claimedTask,
					claimedTask.dataset_version_item_id
						? "dataset_version_item_id"
						: "dataset_item_id",
				),
				dataset_version_item_id:
					claimedTask.dataset_version_item_id == null
						? null
						: text(claimedTask, "dataset_version_item_id"),
				evaluation_run_item_id:
					claimedTask.evaluation_run_item_id == null
						? null
						: text(claimedTask, "evaluation_run_item_id"),
				evaluation_run_id:
					claimedTask.evaluation_run_id == null
						? null
						: text(claimedTask, "evaluation_run_id"),
				attempt_count: Number(claimedTask.attempt_count),
				last_error_classification:
					claimedTask.last_error_classification == null
						? null
						: text(claimedTask, "last_error_classification"),
				cost_reservation_usd:
					claimedTask.cost_reservation_usd == null
						? null
						: Number(claimedTask.cost_reservation_usd),
				lease_token: text(claimedTask, "lease_token"),
				input: json(datasetItem, "input"),
				expected_output: datasetItem.expected_output,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function reserveExperimentTaskCost(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		lease_token: string;
	},
): Promise<ExperimentCostReservation> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access?.authorized)
				return { reserved: false, reason: "snapshot_missing" };

			let limits: JsonObject;
			if (typeof access.row.evaluation_run_id === "string") {
				const snapshot = await client.query(
					"SELECT inputs.limits FROM evaluation_runs run LEFT JOIN evaluation_run_inputs inputs ON inputs.run_id=run.id AND inputs.project_id=run.project_id WHERE run.id=$1 AND run.project_id=$2 FOR UPDATE OF run",
					[access.row.evaluation_run_id, access.project_id],
				);
				if (!snapshot.rows[0] || snapshot.rows[0].limits == null)
					return { reserved: false, reason: "snapshot_missing" };
				limits = json(snapshot.rows[0] as Row, "limits");
			} else {
				const config = json(access.row, "config");
				limits = json({ limits: config.limits }, "limits");
			}
			const maxCost = Number(limits.max_cost_usd);
			if (!Number.isFinite(maxCost) || maxCost < 0)
				return { reserved: false, reason: "not_configured" };

			const budget = await client.query(
				"SELECT COALESCE((SELECT SUM(result.cost_usd) FROM experiment_results result WHERE result.experiment_id=$1 AND result.project_id=$2 AND result.cost_usd IS NOT NULL), 0)::numeric AS spent_cost_usd, COALESCE((SELECT SUM(task.cost_reservation_usd) FROM experiment_tasks task WHERE task.experiment_id=$1 AND task.project_id=$2 AND task.cost_reservation_usd IS NOT NULL), 0)::numeric AS reserved_cost_usd",
				[input.experiment_id, access.project_id],
			);
			const row = budget.rows[0] as Row | undefined;
			const available =
				maxCost -
				Number(row?.spent_cost_usd ?? 0) -
				Number(row?.reserved_cost_usd ?? 0);
			if (!(available > 0))
				return { reserved: false, reason: "cost_limit_exceeded" };
			const claimed = await client.query(
				"UPDATE experiment_tasks SET cost_reservation_usd=$5::numeric, updated_at=now() WHERE id=$1 AND experiment_id=$2 AND project_id=$3 AND lease_token=$4::uuid AND status='running' AND cost_reservation_usd IS NULL RETURNING id",
				[
					input.task_id,
					input.experiment_id,
					access.project_id,
					input.lease_token,
					available,
				],
			);
			return claimed.rows[0]
				? { reserved: true, amount: available }
				: { reserved: false, reason: "cost_limit_exceeded" };
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function reserveExperimentTaskProviderCall(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
	},
): Promise<ExperimentProviderCallReservation> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access?.authorized)
				return { reserved: false, reason: "snapshot_missing" };
			if (typeof access.row.evaluation_run_id !== "string")
				return { reserved: false, reason: "not_configured" };
			const charged = await client.query(
				`UPDATE evaluation_runs run
				 SET provider_call_count=run.provider_call_count+1, updated_at=now()
				FROM evaluation_run_inputs inputs
				WHERE run.id=$1 AND run.project_id=$2
				  AND inputs.run_id=run.id AND inputs.project_id=run.project_id
				  AND run.status IN ('pending','running')
				  AND run.provider_call_count < (inputs.execution_bounds->>'max_provider_calls')::integer
				RETURNING run.provider_call_count, (inputs.execution_bounds->>'max_provider_calls')::integer AS max_provider_calls`,
				[access.row.evaluation_run_id, access.project_id],
			);
			const row = charged.rows[0] as Row | undefined;
			if (!row)
				return { reserved: false, reason: "provider_call_limit_exceeded" };
			return {
				reserved: true,
				used: Number(row.provider_call_count),
				limit: Number(row.max_provider_calls),
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function nextExperimentTaskRetryDelay(
	db: Queryable,
	input: { project_id: string; experiment_id: string },
): Promise<number | null> {
	try {
		const r = await db.query(
			`SELECT ceil(extract(epoch FROM min(CASE WHEN t.status = 'pending' THEN t.next_attempt_at ELSE t.lease_expires_at END) - now()) * 1000)::int AS delay_ms
			FROM experiment_tasks t JOIN experiments e ON e.id = t.experiment_id JOIN projects p ON p.id=e.project_id
			WHERE t.experiment_id = $1 AND e.project_id = $2 AND e.status = 'running' AND p.status = 'active'
				AND e.requested_by_actor_id IS NOT NULL AND authorization_allows_project(p.organization_id, p.id, e.requested_by_actor_id, 'execute')
				AND ((t.status = 'running' AND t.lease_expires_at > now()) OR (t.status = 'pending' AND t.next_attempt_at > now()))`,
			[input.experiment_id, input.project_id],
		);
		const delay = r.rows[0]?.delay_ms;
		return typeof delay === "number" ? Math.max(0, delay) : null;
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function heartbeatExperimentTask(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		lease_token: string;
		lease_seconds?: number;
	},
): Promise<boolean> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access?.authorized) {
				if (access) await cancelRevokedExperiment(client, input.experiment_id);
				return false;
			}
			const heartbeat = await client.query(
				"UPDATE experiment_tasks SET lease_expires_at=now() + ($5::integer * interval '1 second'), heartbeat_at=now(), updated_at=now() WHERE id=$1 AND experiment_id=$2 AND project_id=$3 AND lease_token=$4::uuid AND status='running' RETURNING id",
				[
					input.task_id,
					input.experiment_id,
					access.project_id,
					input.lease_token,
					input.lease_seconds ?? 60,
				],
			);
			return Boolean(heartbeat.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function finalizeExperimentTask(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		lease_token: string;
		status: Extract<ExperimentTaskStatus, "completed" | "failed" | "cancelled">;
		retryable?: boolean;
		admission_id?: string;
		agent_version?: string | null;
		output?: JsonObject | null;
		scores: Record<string, number>;
		duration_ms?: number | null;
		cost_usd?: number | null;
		error_classification?: string | null;
		error_message?: string | null;
		evaluator_rationale?: JsonObject | null;
		trace_id?: string | null;
	},
): Promise<boolean> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access) return false;
			if (!access.authorized) {
				await cancelRevokedExperiment(client, input.experiment_id);
				return false;
			}
			if (access.row.status !== "running") return false;
			const budget = await client.query(
				"SELECT CASE WHEN experiment.evaluation_run_id IS NOT NULL THEN (inputs.limits->>'max_cost_usd')::numeric ELSE (experiment.config->'limits'->>'max_cost_usd')::numeric END AS max_cost_usd, COALESCE((SELECT SUM(result.cost_usd) FROM experiment_results result WHERE result.experiment_id=$1 AND result.project_id=$2 AND result.cost_usd IS NOT NULL), 0)::numeric AS spent_cost_usd, task.cost_reservation_usd, task.attempt_count, task.max_attempts FROM experiments experiment LEFT JOIN evaluation_run_inputs inputs ON inputs.run_id=experiment.evaluation_run_id AND inputs.project_id=experiment.project_id LEFT JOIN experiment_tasks task ON task.id=$3 AND task.experiment_id=experiment.id AND task.project_id=experiment.project_id WHERE experiment.id=$1 AND experiment.project_id=$2",
				[input.experiment_id, access.project_id, input.task_id],
			);
			const budgetRow = budget.rows[0] as Row | undefined;
			const maxCost =
				budgetRow?.max_cost_usd == null ? null : Number(budgetRow.max_cost_usd);
			const spentCost = Number(budgetRow?.spent_cost_usd ?? 0);
			const costUnknown =
				maxCost !== null &&
				input.status === "completed" &&
				(typeof input.cost_usd !== "number" ||
					!Number.isFinite(input.cost_usd) ||
					input.cost_usd < 0);
			const costExceeded =
				maxCost !== null &&
				typeof input.cost_usd === "number" &&
				Number.isFinite(input.cost_usd) &&
				input.cost_usd >= 0 &&
				spentCost + input.cost_usd >= maxCost;
			const budgetFailure = costUnknown || costExceeded;
			const finalStatus = budgetFailure ? "failed" : input.status;
			const finalClassification = costUnknown
				? "cost_unknown"
				: costExceeded
					? "cost_limit_exceeded"
					: (input.error_classification ?? null);
			const finalMessage = costUnknown
				? "provider did not return billable cost"
				: costExceeded
					? "evaluation cost limit exceeded"
					: (input.error_message ?? null);
			const retryable = (input.retryable ?? false) && !budgetFailure;
			const retriesTask =
				retryable &&
				Number(budgetRow?.attempt_count ?? 0) <
					Number(budgetRow?.max_attempts ?? 0);
			if (!retriesTask && input.admission_id) {
				const resultClaim = await claimExecutionAdmission(client, {
					id: input.admission_id,
					project_id: access.project_id,
					effect: "result_write",
					effect_key: executionOperationKey("result_write", 1),
				});
				if (resultClaim.status === "unavailable") {
					const terminalized = await client.query(
						"UPDATE experiment_tasks SET status='failed', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification='execution_timeout', last_error_message='execution admission expired before result persistence', updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING id",
						[input.task_id, input.experiment_id, input.lease_token],
					);
					return Boolean(terminalized.rows[0]);
				}
			}
			const finalized = await client.query(
				retryable
					? "UPDATE experiment_tasks SET status=CASE WHEN $5::boolean AND attempt_count < max_attempts THEN 'pending' ELSE $4 END, next_attempt_at=CASE WHEN $5::boolean AND attempt_count < max_attempts THEN now() + (least(300, power(2, greatest(attempt_count - 1, 0)))::integer * interval '1 second') ELSE now() END, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, cost_reservation_usd=NULL, completed_at=CASE WHEN $5::boolean AND attempt_count < max_attempts THEN NULL ELSE now() END, last_error_classification=$6, last_error_message=$7, updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, status AS final_status"
					: "UPDATE experiment_tasks SET status=$4, cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification=$5, last_error_message=$6, updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, status AS final_status",
				retryable
					? [
							input.task_id,
							input.experiment_id,
							input.lease_token,
							finalStatus,
							true,
							finalClassification,
							finalMessage,
						]
					: [
							input.task_id,
							input.experiment_id,
							input.lease_token,
							finalStatus,
							finalClassification,
							finalMessage,
						],
			);
			const task = finalized.rows[0] as Row | undefined;
			if (!task) return false;
			if (task.final_status === "pending") return true;
			const resultConflict =
				task.dataset_version_item_id != null
					? "ON CONFLICT (experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL"
					: "ON CONFLICT (experiment_id, dataset_item_id)";
			await client.query(
				`INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, agent_version, output, scores, duration_ms, status, trace_id, cost_usd, error_classification, error_message, evaluator_rationale) VALUES (gen_random_uuid(),(SELECT project_id FROM experiments WHERE id=$1),$1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb) ${resultConflict} DO UPDATE SET evaluation_run_id=excluded.evaluation_run_id, agent_version=excluded.agent_version, output=excluded.output, scores=excluded.scores, duration_ms=excluded.duration_ms, status=excluded.status, trace_id=excluded.trace_id, cost_usd=excluded.cost_usd, error_classification=excluded.error_classification, error_message=excluded.error_message, evaluator_rationale=excluded.evaluator_rationale`,
				[
					text(task, "experiment_id"),
					task.dataset_item_id ?? null,
					task.dataset_version_item_id ?? null,
					task.evaluation_run_item_id ?? null,
					task.evaluation_run_id ?? null,
					input.agent_version ?? null,
					input.output == null ? null : JSON.stringify(input.output),
					JSON.stringify(input.scores),
					input.duration_ms ?? null,
					finalStatus,
					input.trace_id ?? null,
					input.cost_usd ?? null,
					finalClassification,
					finalMessage,
					input.evaluator_rationale == null
						? null
						: JSON.stringify(input.evaluator_rationale),
				],
			);
			return true;
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function recordExperimentResultTrace(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		trace_id: string;
		admission_id: string;
	},
): Promise<void> {
	try {
		await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access?.authorized) return;
			if (
				!(await executionAdmissionIsActive(client, {
					id: input.admission_id,
					project_id: access.project_id,
				}))
			)
				return;
			await client.query(
				"UPDATE experiment_results result SET trace_id=$4 WHERE result.project_id=$1 AND result.experiment_id=$2 AND (result.evaluation_run_item_id=(SELECT evaluation_run_item_id FROM experiment_tasks WHERE id=$3 AND project_id=$1) OR result.dataset_version_item_id=(SELECT dataset_version_item_id FROM experiment_tasks WHERE id=$3 AND project_id=$1))",
				[input.project_id, input.experiment_id, input.task_id, input.trace_id],
			);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function reconcileUnknownExperimentTaskProviderDispatch(
	db: Transactional,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		lease_token: string;
	},
): Promise<boolean> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
				project_id: input.project_id,
			});
			if (!access?.authorized) {
				if (access) await cancelRevokedExperiment(client, input.experiment_id);
				return false;
			}
			const failed = await client.query(
				"UPDATE experiment_tasks SET status='failed', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, completed_at=now(), last_error_classification='unknown_dispatch', last_error_message='provider dispatch outcome is unknown', updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id",
				[input.task_id, input.experiment_id, input.lease_token],
			);
			const task = failed.rows[0] as Row | undefined;
			if (!task) return false;
			await client.query(
				`INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, evaluation_run_id, output, scores, status, error_classification, error_message) VALUES (gen_random_uuid(), (SELECT project_id FROM experiments WHERE id=$1), $1, $2, $3, $4, $5, NULL, '{}'::jsonb, 'failed', 'unknown_dispatch', 'provider dispatch outcome is unknown') ${task.dataset_version_item_id != null ? "ON CONFLICT (experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL" : "ON CONFLICT (experiment_id, dataset_item_id)"} DO UPDATE SET evaluation_run_id=excluded.evaluation_run_id, output=excluded.output, scores=excluded.scores, status=excluded.status, error_classification=excluded.error_classification, error_message=excluded.error_message`,
				[
					text(task, "experiment_id"),
					task.dataset_item_id ?? null,
					task.dataset_version_item_id ?? null,
					task.evaluation_run_item_id ?? null,
					task.evaluation_run_id ?? null,
				],
			);
			return true;
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function completeExperimentIfTasksFinished(
	db: Transactional,
	input: { project_id: string; id: string; admission_id?: string },
): Promise<boolean> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, input);
			if (!access) return false;
			if (!access.authorized) {
				await cancelRevokedExperiment(client, input.id);
				return false;
			}
			if (
				input.admission_id &&
				!(await executionAdmissionIsActive(client, {
					id: input.admission_id,
					project_id: access.project_id,
				}))
			) {
				await cancelRevokedExperiment(client, input.id);
				return false;
			}
			const r = await client.query(
				"UPDATE experiments e SET status=CASE WHEN EXISTS (SELECT 1 FROM experiment_tasks t WHERE t.experiment_id=e.id AND t.status='failed') THEN 'failed' ELSE 'completed' END, updated_at=now() WHERE e.id=$1 AND e.status='running' AND NOT EXISTS (SELECT 1 FROM experiment_tasks t WHERE t.experiment_id=e.id AND t.status IN ('pending','running')) RETURNING e.id, e.evaluation_run_id",
				[input.id],
			);
			if (r.rows[0]?.evaluation_run_id) {
				await client.query(
					"UPDATE evaluation_runs SET status=CASE WHEN EXISTS (SELECT 1 FROM experiment_tasks WHERE evaluation_run_id=evaluation_runs.id AND status='failed') THEN 'failed' ELSE 'completed' END, terminal_reason=CASE WHEN EXISTS (SELECT 1 FROM experiment_tasks WHERE evaluation_run_id=evaluation_runs.id AND status='failed') THEN 'task_failed' ELSE 'all_items_completed' END, updated_at=now() WHERE id=$1 AND project_id=$2 AND status='running'",
					[r.rows[0].evaluation_run_id, access.project_id],
				);
			}
			return Boolean(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function cancelExperiment(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const current = await client.query(
				"SELECT evaluation_run_id FROM experiments WHERE id=$1 AND project_id=$2 FOR UPDATE",
				[input.id, input.project_id],
			);
			const evaluationRunId = current.rows[0]?.evaluation_run_id;
			if (typeof evaluationRunId === "string")
				await client.query(
					"UPDATE evaluation_runs SET status='cancelled', terminal_reason='cancelled_by_request', updated_at=now() WHERE id=$1 AND project_id=$2 AND status IN ('pending','running')",
					[evaluationRunId, input.project_id],
				);
			const r = await client.query(
				"UPDATE experiments SET status='cancelled', updated_at=now() WHERE id=$1 AND project_id=$2 AND status IN ('pending','running') RETURNING *",
				[input.id, input.project_id],
			);
			if (!r.rows[0]) {
				const existing = await client.query(
					"SELECT e.* FROM experiments e WHERE e.id=$1 AND e.project_id=$2",
					[input.id, input.project_id],
				);
				if (!existing.rows[0])
					throw new ExperimentRepositoryError(
						"NOT_FOUND",
						"Experiment not found",
					);
				throw new ExperimentRepositoryError(
					"CONFLICT",
					`Evaluation is already ${experiment(existing.rows[0]!).status}`,
				);
			}
			await sweepExperimentWork(
				client,
				input.id,
				input.project_id,
				"cancelled",
				"cancelled_by_request",
				"evaluation cancelled",
			);
			return experiment(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function insertExperimentResult(
	db: Transactional,
	input: {
		experiment_id: string;
		dataset_item_id: string;
		agent_version?: string | null;
		output?: JsonObject | null;
		scores: Record<string, number>;
		duration_ms?: number | null;
		status: ExperimentStatus;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, {
				id: input.experiment_id,
			});
			if (!access?.authorized)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment is not available",
				);
			const r = await client.query(
				"INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, agent_version, output, scores, duration_ms, status) VALUES ($1,(SELECT project_id FROM experiments WHERE id=$2),$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *",
				[
					randomUUID(),
					input.experiment_id,
					input.dataset_item_id,
					input.agent_version ?? null,
					input.output == null ? null : JSON.stringify(input.output),
					JSON.stringify(input.scores),
					input.duration_ms ?? null,
					input.status,
				],
			);
			return result(r.rows[0]!);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function admitExperimentExecution(
	db: Transactional,
	input: {
		project_id?: string;
		id: string;
		work_id: string;
		timeout_ms: number;
	},
): Promise<ExecutionAdmission | null> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, input);
			if (!access?.authorized) {
				if (access) await cancelRevokedExperiment(client, input.id);
				return null;
			}
			if (!access.requester_actor_id) return null;
			return createExecutionAdmission(client, {
				organization_id: access.organization_id,
				project_id: access.project_id,
				requester_actor_id: access.requester_actor_id,
				work_kind: "experiment_task",
				work_id: input.work_id,
				timeout_ms: input.timeout_ms,
			});
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function experimentExecutionAdmissionIsActive(
	db: Transactional,
	input: { project_id: string; id: string; admission_id: string },
): Promise<boolean> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, input);
			if (!access?.authorized) {
				if (access) await cancelRevokedExperiment(client, input.id);
				return false;
			}
			return executionAdmissionIsActive(client, {
				id: input.admission_id,
				project_id: access.project_id,
			});
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function claimExperimentExecution(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		admission_id: string;
		effect: ExecutionAdmissionEffect;
		effect_key: string;
	},
): Promise<ExecutionAdmissionClaim> {
	try {
		return await withTransaction(db, async (client) => {
			const access = await lockExperimentExecution(client, input);
			if (!access?.authorized) {
				if (access) await cancelRevokedExperiment(client, input.id);
				return { status: "unavailable" };
			}
			return claimExecutionAdmission(client, {
				id: input.admission_id,
				project_id: access.project_id,
				effect: input.effect,
				effect_key: input.effect_key,
			});
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listExperimentResults(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		const parent = await getExperiment(db, input);
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					parent.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			const r = await client.query(
				"SELECT r.* FROM experiment_results r WHERE r.experiment_id=$1 AND r.project_id=$2 ORDER BY r.created_at ASC",
				[input.id, parent.project_id],
			);
			return { experiment_id: input.id, items: r.rows.map(result) };
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function experimentSummary(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		const parent = await getExperiment(db, input);
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					parent.project_id,
					input.authorization,
				))
			)
				throw new ExperimentRepositoryError(
					"NOT_FOUND",
					"Experiment not found",
				);
			const r = await client.query(
				"SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='completed')::int AS passed, COUNT(*) FILTER (WHERE status='failed')::int AS failed, AVG(duration_ms)::float AS avg_duration_ms FROM experiment_results WHERE experiment_id=$1 AND project_id=$2",
				[input.id, parent.project_id],
			);
			const row = r.rows[0] ?? {};
			const total = Number(row.total ?? 0);
			return {
				experiment_id: input.id,
				total,
				passed: Number(row.passed ?? 0),
				failed: Number(row.failed ?? 0),
				pass_rate: total === 0 ? 0 : Number(row.passed ?? 0) / total,
				avg_duration_ms:
					row.avg_duration_ms == null ? null : Number(row.avg_duration_ms),
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
