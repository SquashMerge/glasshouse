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
	dataset_item_id: string;
	lease_token: string;
	input: JsonObject;
	expected_output: unknown;
};
export type RecoverableExperiment = {
	id: string;
	project_id: string;
	dataset_id: string;
	config: JsonObject;
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
	await client.query(
		"UPDATE execution_admissions SET status = 'cancelled', cancelled_at = now() WHERE work_kind = 'experiment_task' AND status = 'active' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $1)",
		[id],
	);
	await client.query(
		"UPDATE experiment_tasks SET status='cancelled', lease_token=NULL, lease_expires_at=NULL, updated_at=now() WHERE experiment_id=$1 AND status IN ('pending','running')",
		[id],
	);
	return client.query(
		"UPDATE experiments SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING *",
		[id],
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
			const r = await client.query(
				"UPDATE experiments SET status=$1, updated_at=now() WHERE id=$2 RETURNING *",
				[input.status, input.id],
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
export async function listRecoverableExperiments(db: Transactional) {
	try {
		return await withTransaction(db, async (client) => {
			const candidates = await client.query(
				"SELECT id, project_id FROM experiments WHERE status IN ('pending', 'running') ORDER BY created_at ASC",
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
				recoverable.push({
					id: text(access.row, "id"),
					project_id: text(access.row, "project_id"),
					dataset_id: text(access.row, "dataset_id"),
					config: json(access.row, "config"),
				});
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
				"SELECT t.id, t.dataset_item_id, t.dataset_version_item_id, t.evaluation_run_item_id FROM experiment_tasks t WHERE t.experiment_id=$1 AND t.project_id=$2 AND (t.status='pending' OR (t.status='running' AND t.lease_expires_at <= now())) ORDER BY t.created_at ASC FOR UPDATE OF t SKIP LOCKED LIMIT 1",
				[input.experiment_id, access.project_id],
			);
			const task = candidate.rows[0] as Row | undefined;
			if (!task) return null;
			const leaseToken = input.lease_token ?? randomUUID();
			const claimed = await client.query(
				"UPDATE experiment_tasks SET status='running', lease_token=$2::uuid, lease_expires_at=now() + ($3::integer * interval '1 second'), claimed_at=coalesce(claimed_at,now()), attempt_count=attempt_count+1, updated_at=now() WHERE id=$1 AND project_id=$4 RETURNING id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, lease_token",
				[
					text(task, "id"),
					leaseToken,
					input.lease_seconds ?? 60,
					access.project_id,
				],
			);
			const claimedTask = claimed.rows[0] as Row | undefined;
			if (!claimedTask) return null;
			const item = await client.query(
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
				lease_token: text(claimedTask, "lease_token"),
				input: json(datasetItem, "input"),
				expected_output: datasetItem.expected_output,
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
			`SELECT ceil(extract(epoch FROM min(t.lease_expires_at) - now()) * 1000)::int AS delay_ms
			FROM experiment_tasks t JOIN experiments e ON e.id = t.experiment_id JOIN projects p ON p.id=e.project_id
			WHERE t.experiment_id = $1 AND e.project_id = $2 AND e.status = 'running' AND p.status = 'active'
				AND e.requested_by_actor_id IS NOT NULL AND authorization_allows_project(p.organization_id, p.id, e.requested_by_actor_id, 'execute')
				AND t.status = 'running' AND t.lease_expires_at > now()`,
			[input.experiment_id, input.project_id],
		);
		const delay = r.rows[0]?.delay_ms;
		return typeof delay === "number" ? Math.max(0, delay) : null;
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
		status: Extract<ExperimentTaskStatus, "completed" | "failed">;
		admission_id?: string;
		agent_version?: string | null;
		output?: JsonObject | null;
		scores: Record<string, number>;
		duration_ms?: number | null;
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
			if (
				input.admission_id &&
				(
					await claimExecutionAdmission(client, {
						id: input.admission_id,
						project_id: access.project_id,
						effect: "result_write",
						effect_key: executionOperationKey("result_write", 1),
					})
				).status !== "created"
			) {
				return false;
			}
			if (access.row.status !== "running") return false;
			const finalized = await client.query(
				"UPDATE experiment_tasks SET status=$4, lease_token=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id",
				[input.task_id, input.experiment_id, input.lease_token, input.status],
			);
			const task = finalized.rows[0] as Row | undefined;
			if (!task) return false;
			await client.query(
				"INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, agent_version, output, scores, duration_ms, status) VALUES (gen_random_uuid(),(SELECT project_id FROM experiments WHERE id=$1),$1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING",
				[
					text(task, "experiment_id"),
					task.dataset_item_id ?? null,
					task.dataset_version_item_id ?? null,
					task.evaluation_run_item_id ?? null,
					input.agent_version ?? null,
					input.output == null ? null : JSON.stringify(input.output),
					JSON.stringify(input.scores),
					input.duration_ms ?? null,
					input.status,
				],
			);
			return true;
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
				"UPDATE experiment_tasks SET status='failed', lease_token=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now() WHERE id=$1 AND experiment_id=$2 AND lease_token=$3::uuid AND status='running' RETURNING experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id",
				[input.task_id, input.experiment_id, input.lease_token],
			);
			const task = failed.rows[0] as Row | undefined;
			if (!task) return false;
			await client.query(
				"INSERT INTO experiment_results (id, project_id, experiment_id, dataset_item_id, dataset_version_item_id, evaluation_run_item_id, output, scores, status) VALUES (gen_random_uuid(), (SELECT project_id FROM experiments WHERE id=$1), $1, $2, $3, $4, NULL, '{}'::jsonb, 'failed') ON CONFLICT DO NOTHING",
				[
					text(task, "experiment_id"),
					task.dataset_item_id ?? null,
					task.dataset_version_item_id ?? null,
					task.evaluation_run_item_id ?? null,
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
				"UPDATE experiments e SET status='completed', updated_at=now() WHERE e.id=$1 AND e.status='running' AND NOT EXISTS (SELECT 1 FROM experiment_tasks t WHERE t.experiment_id=e.id AND t.status IN ('pending','running')) RETURNING e.id",
				[input.id],
			);
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
			await client.query(
				"UPDATE experiment_tasks SET status='cancelled', lease_token=NULL, lease_expires_at=NULL, updated_at=now() WHERE experiment_id=$1 AND status IN ('pending','running')",
				[input.id],
			);
			await client.query(
				"UPDATE execution_admissions SET status = 'cancelled', cancelled_at = now() WHERE work_kind = 'experiment_task' AND status = 'active' AND work_id IN (SELECT id FROM experiment_tasks WHERE experiment_id = $1)",
				[input.id],
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
