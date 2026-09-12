import { Pool } from "pg";

const requiredColumns = [
	["experiment_tasks", "evaluation_run_id"],
	["experiment_tasks", "evaluation_run_item_id"],
	["experiment_tasks", "dataset_version_item_id"],
	["experiment_results", "evaluation_run_id"],
	["experiment_results", "evaluation_run_item_id"],
	["experiment_results", "dataset_version_item_id"],
	["evaluation_run_items", "run_id"],
	["evaluation_run_items", "dataset_version_item_id"],
] as const;

export async function prepare0091RunItemRemediation(
	env: NodeJS.ProcessEnv = process.env,
	pool = new Pool({ connectionString: env.DATABASE_URL }),
): Promise<void> {
	const client = await pool.connect();
	try {
		const columns = await client.query<{ ready: boolean }>(
			"SELECT count(*) = $1 AS ready FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('experiment_tasks', 'evaluation_run_id'), ('experiment_tasks', 'evaluation_run_item_id'), ('experiment_tasks', 'dataset_version_item_id'), ('experiment_results', 'evaluation_run_id'), ('experiment_results', 'evaluation_run_item_id'), ('experiment_results', 'dataset_version_item_id'), ('evaluation_run_items', 'run_id'), ('evaluation_run_items', 'dataset_version_item_id'))",
			[requiredColumns.length],
		);
		const scopeConstraint = await client.query<{ exists: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.experiment_tasks') AND conname = 'experiment_tasks_evaluation_run_item_run_fkey') AS exists",
		);
		if (!columns.rows[0]?.ready || scopeConstraint.rows[0]?.exists) return;

		await client.query("BEGIN");
		await client.query(`CREATE TABLE IF NOT EXISTS experiment_task_run_item_mismatch_quarantine (
            task_id UUID PRIMARY KEY,
            project_id UUID NOT NULL,
            evaluation_run_id UUID,
            evaluation_run_item_id UUID,
            remediated_evaluation_run_item_id UUID,
            reason TEXT NOT NULL,
            quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
        )`);
		await client.query(`CREATE TABLE IF NOT EXISTS agent_introspection_report_scope_quarantine (
            report_id UUID PRIMARY KEY,
            organization_id UUID NOT NULL,
            project_id UUID NOT NULL,
            evaluation_run_id UUID NOT NULL,
            task_id UUID NOT NULL,
            invocation_id UUID NOT NULL,
            request_hash TEXT NOT NULL,
            reason TEXT NOT NULL,
            quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
            FOREIGN KEY (project_id, organization_id)
                REFERENCES projects(id, organization_id) ON DELETE RESTRICT
        )`);
		await client.query(`WITH planned_remaps AS (
            SELECT task.id, task.project_id, task.evaluation_run_id,
                   task.evaluation_run_item_id, candidate.id AS candidate_id,
                   EXISTS (
                       SELECT 1
                       FROM experiment_tasks AS occupied_task
                       WHERE occupied_task.project_id = task.project_id
                         AND occupied_task.evaluation_run_id = task.evaluation_run_id
                         AND occupied_task.evaluation_run_item_id = candidate.id
                         AND occupied_task.id <> task.id
                   ) AS candidate_occupied
            FROM experiment_tasks AS task
            JOIN LATERAL (
                SELECT item.id
                FROM evaluation_run_items AS item
                WHERE item.project_id = task.project_id
                  AND item.run_id = task.evaluation_run_id
                  AND item.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
                ORDER BY item.id
                LIMIT 1
            ) AS candidate ON true
            WHERE task.evaluation_run_id IS NOT NULL
              AND (
                  task.evaluation_run_item_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1
                      FROM evaluation_run_items AS item
                      WHERE item.id = task.evaluation_run_item_id
                        AND item.project_id = task.project_id
                        AND item.run_id = task.evaluation_run_id
                  )
              )
        ), conflicting_remaps AS (
            SELECT planned_remaps.*,
                   count(*) OVER (PARTITION BY candidate_id) AS candidate_remap_count
            FROM planned_remaps
        )
        INSERT INTO experiment_task_run_item_mismatch_quarantine (
            task_id, project_id, evaluation_run_id, evaluation_run_item_id,
            remediated_evaluation_run_item_id, reason
        )
        SELECT id, project_id, evaluation_run_id, evaluation_run_item_id, NULL,
               CASE
                   WHEN candidate_occupied THEN 'deterministic_run_item_occupied'
                   ELSE 'deterministic_run_item_remap_collision'
               END
        FROM conflicting_remaps
        WHERE candidate_occupied OR candidate_remap_count > 1
        ON CONFLICT (task_id) DO NOTHING`);

		const reports = await client.query<{ exists: boolean }>(
			"SELECT to_regclass('public.agent_introspection_reports') IS NOT NULL AS exists",
		);
		if (reports.rows[0]?.exists) {
			await client.query(`INSERT INTO agent_introspection_report_scope_quarantine (
                report_id, organization_id, project_id, evaluation_run_id, task_id,
                invocation_id, request_hash, reason
            )
            SELECT report.id, report.organization_id, report.project_id,
                   report.evaluation_run_id, report.task_id, report.invocation_id,
                   report.request_hash, quarantine.reason
            FROM agent_introspection_reports AS report
            JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
              ON quarantine.task_id = report.task_id
             AND quarantine.project_id = report.project_id
             AND quarantine.evaluation_run_id = report.evaluation_run_id
             WHERE quarantine.reason IN (
                 'deterministic_run_item_occupied',
                 'deterministic_run_item_remap_collision'
             )
            ON CONFLICT (report_id) DO NOTHING`);
			await client.query(
				"ALTER TABLE agent_introspection_reports DISABLE TRIGGER agent_introspection_reports_immutable",
			);
			await client.query(`DELETE FROM agent_introspection_reports AS report
                USING experiment_task_run_item_mismatch_quarantine AS quarantine
                WHERE quarantine.task_id = report.task_id
                  AND quarantine.project_id = report.project_id
                  AND quarantine.evaluation_run_id = report.evaluation_run_id
                   AND quarantine.reason IN (
                       'deterministic_run_item_occupied',
                       'deterministic_run_item_remap_collision'
                   )`);
			await client.query(
				"ALTER TABLE agent_introspection_reports ENABLE TRIGGER agent_introspection_reports_immutable",
			);
		}
		await client.query(`UPDATE experiment_results AS result
            SET evaluation_run_id = NULL,
                evaluation_run_item_id = NULL
            FROM experiment_tasks AS task
            JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
              ON quarantine.task_id = task.id
             WHERE quarantine.reason IN (
                 'deterministic_run_item_occupied',
                 'deterministic_run_item_remap_collision'
             )
              AND result.experiment_id = task.experiment_id
              AND result.project_id = task.project_id
              AND result.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
              AND (
                  result.evaluation_run_id IS NOT DISTINCT FROM quarantine.evaluation_run_id
                  OR result.evaluation_run_item_id IS NOT DISTINCT FROM quarantine.evaluation_run_item_id
              )`);
		await client.query(`UPDATE experiment_tasks AS task
            SET evaluation_run_id = NULL,
                evaluation_run_item_id = NULL
            FROM experiment_task_run_item_mismatch_quarantine AS quarantine
            WHERE quarantine.task_id = task.id
               AND quarantine.reason IN (
                   'deterministic_run_item_occupied',
                   'deterministic_run_item_remap_collision'
               )`);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

if (import.meta.main) await prepare0091RunItemRemediation();
